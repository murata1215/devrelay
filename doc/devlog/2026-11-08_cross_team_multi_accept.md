# クロスユーザー Team: 招待の複数プロジェクト選択 + 再招待の行き止まりバグ修正

## きっかけ

前サイクル（招待 UI 文言修正 + 「公開中のプロジェクト」可視化）をデプロイ・実機確認した
直後、ユーザーから画面のスクリーンショット付きで「プロジェクトの選択は一個だけ？複数選択
できない？」という指摘。調査したところ、実際に単一選択だっただけでなく、**組み合わせ事故
で永久に再招待できなくなるバグ**が見つかったため、まとめて直した。

## 調査で分かったこと

### 現状（修正前）
- `TeamPage.tsx:116` の `handleAcceptInvite(inviteId, projectId)` は、プロジェクトのチップを
  **クリックした瞬間に承認が確定**する単一選択
- サーバー側 `POST /api/teams/invites/:id/accept` も `projectId`（単数）しか受けず、
  `TeamMember` + `CrossTeamGrant` を 1 組だけ作って終わり

### 発見したバグ: 一度承認すると二度と招待できない
`CrossTeamInvite` は `@@unique([teamId, inviteeUserId])`（status を含まない）で、招待作成
エンドポイントに次のガードがあった:

```ts
if (existing && existing.status === 'accepted') {
  return reply.status(409).send({ error: 'This user already has an accepted invite for this team' });
}
```

一方、前サイクルで追加した「公開を停止」（`DELETE /api/teams/members/:memberId/grant`）は
`TeamMember` を削除するだけで `invite.status` を `'accepted'` のまま放置する
（`CrossTeamInvite.teamMemberId` は `@relation` を持たない素の `String?` のため Cascade も
効かず、宙ぶらりんの ID が残る）。

再現手順:
1. yahoo が承認 → `status='accepted'`
2. gmail が追加のプロジェクトで再招待 → 409
3. yahoo が「公開を停止」→ TeamMember は消えるが `status='accepted'` のまま
4. gmail が再招待 → まだ 409（**永久に復旧不能**）

前サイクルの devlog に書いた検証手順「確認後、必要なら再度招待して grant を戻す」は
実際には失敗する手順だったと判明。

## 実装内容

### ① 承認の複数選択化
- サーバー `POST /api/teams/invites/:id/accept`: ボディを `projectIds: string[]` に変更。
  **旧 `projectId`（単数）もフォールバックで受け付ける**
  （デプロイ直後に開きっぱなしのタブが旧 JS を使っているケースのため）
- 所有権チェックは全件に対して行い、1 件でも他人のプロジェクトが混ざっていたら
  全体を 404 で拒否（部分適用しない）
- 既にそのチームのメンバーになっている `projectId` はスキップし（バッチ全体を 409 で
  落とさない。再招待で「追加分だけ選ぶ」運用を成立させるため）、全件スキップのときのみ 409
- `$transaction` 内で N 組の `TeamMember` + `CrossTeamGrant` を作成。監査ログは
  プロジェクト 1 件につき 1 行記録
- `invite.projectId` / `teamMemberId` は複数件を保持できないため更新しない（null のまま）。
  両方とも書き込まれるだけでどこからも読まれていないことを `grep` で確認済み
  （監査は `CrossTeamAuditLog` 側が持つ）。カラム自体は残す。**DB マイグレーション不要**
- WebUI: 「クリック即確定」をやめ、チェックボックス方式 + 「選択した N 件を公開して承認」
  ボタンに変更（選択ゼロの状態から開始＝誤爆防止）。このチームに既に公開済みの自分の
  プロジェクトはピッカーから除外する（`sharedByMe` に `teamId`/`projectId` を追加して判定）

### ② 再招待の行き止まり修正
- `existing.status === 'accepted'` による 409 ガードを削除し、`declined`/`revoked` からの
  再招待と同形（常に `pending` へ戻す）にした
- **既存の `CrossTeamGrant` は revoke しない** — 権限の根拠は Grant の存在のみ、という
  設計原則（`decideCrossTeamAccess()`）は不変。招待はあくまで「追加依頼」
- これで「後からプロジェクトを追加」が「再招待 → 追加分だけチェック」で成立する

## 検証

`pnpm build` 全 6 workspace green。web バンドルに CJS `require(` 混入なしを確認。
`apps/server` の `node --test` 1458/1458（新規 4 ケース含む、既存含め非退行）。

## 変更ファイル

既存 `apps/server/src/routes/api.ts`、`apps/web/src/lib/api.ts`、
`apps/web/src/pages/TeamPage.tsx`、`apps/server/tests/cross-team-api-wiring.test.mjs`。
新規ファイルなし。DB スキーマ変更なし、新規キルスイッチなし（既存 `DEVRELAY_CROSS_TEAM`
の配下）。ソースコード変更ありのため `pnpm build` 実行済み、再起動が必要。

## 未解決（別サイクルで対応予定）

- 同名衝突の解決手段が弱い（`ask <project>@<machine>:` 形式や候補への採番などが必要。
  公開型を入れると他人のプロジェクトが大量に候補へ入るため必須級になる）
- 公開型（`Team.visibility` + `TeamSubscription`）本体は未実装
- プロジェクトのリネーム UI が Team ページにしか無い問題
