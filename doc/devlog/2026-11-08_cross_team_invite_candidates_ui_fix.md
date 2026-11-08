# クロスユーザー Team: 再招待が WebUI から到達できないバグの修正（招待候補フィルタ）

## きっかけ

直前のサイクル（招待の複数プロジェクト選択 + サーバー側の再招待行き止まり修正）を
デプロイ・実機確認したところ、ユーザーから「一個追加していると再度 yahoo 招待できない
みたい」の指摘（`pixterm` チームの「+ Invite」で「招待できる組織メンバーがいません」）。

## 調査

サーバー側（直前のサイクルで修正済み）が本当に効いているかを切り分けた:

| 調べたもの | 結果 |
|---|---|
| 稼働 dist の `POST /api/teams/:teamId/invites` | ✅ `existing.status === 'accepted'` の 409 ガード無し、`status: 'pending'` へのリセットが入っている |
| `GET /api/teams/org-candidates` | ✅ チーム所属による除外なし。yahoo は候補として返っている |
| `TeamPage.tsx:183` `getInvitableCandidates()` | ❌ **ここで yahoo を隠していた** |

```ts
const existingOwnerIds = new Set(team.members.filter(m => m.crossUser).map(m => m.ownerUserId));
return orgCandidates.filter(c => !existingOwnerIds.has(c.userId) && !pendingInviteeIds.has(c.userId));
```

`existingOwnerIds` による除外は「1 招待 = 1 プロジェクト」だった旧モデルでは正しかった
（一度プロジェクトを出してもらったら、その人を再招待する意味が無かったため）。しかし
直前のサイクルで「再招待 = プロジェクト追加の唯一の導線」にサーバー側を変更したため、
この除外が**サーバー側で開けた道を UI が塞いでいる**状態になっていた。

`pixterm` チームには yahoo の `MyApplication` が既に公開済みで、同一組織の他メンバーが
yahoo しかいなかったため、候補がゼロ件になり「招待できる組織メンバーがいません」と
表示されていた。

## 実装内容

### 新規 `apps/web/src/lib/cross-team-invite-rules.ts`
既存の `push-device-rules.ts` 等 22 件と同じパターン（外部 import ゼロの純粋関数を
`tsconfig.test.json` 経由で `dist-test/` にコンパイルし `node --test` で検証）に合わせて
`selectInvitableCandidates()` を新設:
- `crossMemberOwnerIds`（既にそのチームへ公開済みの所有者）では**除外しない**。
  `alreadyContributing: true` の注釈を付けて候補に残す
- `pendingInviteeIds`（承認待ちの宛先）による除外は**維持**
  （同じ行を pending のまま上書きするだけで意味が無く、UI 上も紛らわしいため）

### `TeamPage.tsx`
- `getInvitableCandidates()` を上記純関数の呼び出しに置き換え
- 候補チップに **「（追加依頼）」** を補足表示し、新規招待か追加依頼かを判別できるように
- 空状態を「組織に他メンバーがいない」／「全員に依頼済み（承認待ち）」の 2 パターンに
  出し分け
- 招待ダイアログの説明文を「既に公開済みの相手は追加のプロジェクトを依頼できます」に調整

## 検証

`pnpm build` 全 6 workspace green。web バンドルに CJS `require(` 混入なしを確認。
`apps/web` の `node --test` 931/931（新規 7 ケース含む非退行）。
`apps/server` の `node --test` 1458/1458（サーバー変更なし・非退行）。

回帰テストには `cross-target-name-match.test.mjs` と同じ流儀で、旧ロジックを手元で
再現して新旧を直接比較するアサーション（旧 0 件 → 新 1 件）を入れた。

## 変更ファイル

新規 `apps/web/src/lib/cross-team-invite-rules.ts`、
`apps/web/tests/cross-team-invite-rules.test.mjs`。既存 `apps/web/tsconfig.test.json`
（include 追加）、`apps/web/src/pages/TeamPage.tsx`。**サーバー側の変更なし**
（既にある修正が UI から到達可能になるだけ）。DB スキーマ変更なし・新規キルスイッチなし。
ソースコード変更ありのため `pnpm build` 実行済み、再起動が必要。

## 教訓

サーバー側の権限モデルを変更したときは、**その変更を前提に書かれた UI 側の除外ロジック
がないか**を必ず確認する。今回は「1 対 1」から「1 対多（追加可能）」へモデルを広げた
サイクルで、サーバーだけ直して UI 側の対称な制約（同じ理由で書かれた別の除外条件）を
見落とした。

## 未解決（別サイクルで対応予定）

- 同名衝突の解決手段が弱い（`ask <project>@<machine>:` 形式や候補への採番などが必要。
  公開型を入れると他人のプロジェクトが大量に候補へ入るため必須級になる）
- 公開型本体（`Team.visibility` + `TeamSubscription`）は未実装
- プロジェクトのリネーム UI が Team ページにしか無い問題
