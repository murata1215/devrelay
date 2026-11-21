# クロスユーザー Team（別ユーザーのエージェントと ask で連携）Phase 0 + Phase 1

## きっかけ

ユーザー要望: 「別のユーザーのエージェントとチームを組むみたいなことできるかな？」

## 調査結果（実装前）

既存の `ask` / `teamexec`（クロスプロジェクト連携）は宛先解決・Team ゲート・自己宛ガード・
ループ検出・レート制限・ホップ制限・human-text fence まで完成していたが、**全経路が同一
userId に構造的に閉じていた**:

- `TeamMember` を作る箇所は全リポジトリで `apps/server/src/routes/api.ts` の
  `POST /api/teams/:teamId/members` 1 箇所だけで、`project.machine.userId !== userId → 404`
- Agent REST（`document-api.ts` の ask-member/teamexec-member/messages、`raw-completion-api.ts`）
  も全て `targetProject.machine.userId !== auth.userId → 404`
- チャット（`command-handler.ts` の `resolveCrossTargetByName`）の宛先母集団も
  `machine: { userId: dbUserId }`
- MCP（`mcp/tools.ts`）は PAT/AuthSession → userId 1 本のクロージャ注入。teamexec 系ツールは存在しない
- Agent の身元は machine token 1 本 = その machine の所有者 1 人

一方で土台はほぼ揃っていた: 唯一の信頼境界 `OrganizationMember.organizationId`、クロスユーザー
**読み取り**の前例2系統（高辻ナレッジの `isTurnVisible()`、組織統制の `canViewMemberHistory()`）、
`Session.userId` と `Session.machineId` が独立 FK（「依頼者 ≠ 宛先マシン所有者」をマイグレーション
無しで表現可能）。足りないのは「実行権限の軸」と「受入側の同意」だけだった。

調査中に既存バグ 2 件を発見（Phase 0 で先に修正）:
1. `api.ts` の TeamMember 削除が `teamId` でスコープされておらず他ユーザーの行を削除できた
2. Discord/Telegram の共有チャンネルで `userContexts` が発言者変更時に `userId` を更新せず、
   最初の発言者に全員の操作が固定される（権限モデル・監査を一切通らない事実上のクロスユーザー実行）

## 実装内容

詳細は `doc/changelog.md` の「クロスユーザー Team（別ユーザーのエージェントと ask で連携）
Phase 0 + Phase 1」エントリ参照。要点のみ:

- Phase 0: 上記バグ2件 + `resolveDbUserId`/`resolveOrCreateUser` の platform 絞り漏れを修正
- Phase 1: `CrossTeamInvite`/`CrossTeamGrant`/`CrossTeamAuditLog` の3テーブル + `Session.requestedByUserId`
  列を追加。招待制（Team オーナーが同一組織内の別ユーザーを招待 → 受入側が自分のプロジェクトを
  選んで承認）でのみ `CrossTeamGrant` が生成される設計にし、`api.ts` の唯一の所有者チェックは
  無改造のまま残した（「2 キー方式」を経路で強制）
- `executorUserId`（宛先マシン所有者）/`requesterUserId`（依頼者）の2つの userId を分離し、
  AI 実行系（`sendPromptToAgent`）には executorUserId のみを渡す設計
- `checkCrossTargetAllowed()` を単一の拡張点にし、判定本体は新規純関数
  `cross-team-guard.ts` の `decideCrossTeamAccess()`（DB を一切見ない）に分離
- teamexec（exec）は Phase 1 では構造的に到達不可（`allowCrossUser: false` で呼ぶ）。
  Phase 2 で `DEVRELAY_CROSS_TEAM_EXEC` を解禁する際は、ツール承認カードの配信先を
  宛先所有者に向け直す対応が必須（依頼者が他人のマシンの承認を押せてしまう越権を防ぐため）

## 検証

- `pnpm build` 全 6 workspace green
- `apps/server` の `node --test` 1441/1441（新規 71 ケース含む、既存含め非退行）
- OFF 状態での不変性: `SELECT count(*) FROM "Session" WHERE "requestedByUserId" IS NOT NULL` 等が
  全て 0 であることを確認（新機能は何も書き込んでいない）
- `apps/web/dist` に CJS `require(` が混入していないことを確認（#309→#310 白画面事故の再発防止チェック）
- 実機での招待→承認→ask 往復は未実施（同一組織・複数ユーザーのテスト環境が無いため）。
  実装後の最初の実運用時に手動確認することを推奨
