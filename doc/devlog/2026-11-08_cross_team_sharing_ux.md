# クロスユーザー Team: 招待 UI の文言修正 + 貸す側の「公開中」可視化

## きっかけ

2026-11-08 の実機テスト（Phase 1 実機テスト・バグ修正サイクル）の過程で見つかった 2 件の
UX 欠落を解消した。どちらも「次に実装したい公開型（Team を公開し同一組織内の利用者が選んで
組み込む）」の前提条件として塞いでおく必要があるもの。

## 背景

1. **招待 UI の文言が過剰共有を招く**: 「チームへの参加を依頼」という文言が、実際の意味
   （自分のプロジェクトを差し出し、相手の質問を自分の契約で実行する）を正しく伝えていない。
   実機テストでユーザー自身が「何かおかしい」と感じた箇所
2. **貸す側に「自分の何が誰に公開されているか」を見る UI が無い**: `DELETE /api/teams/
   members/:memberId/grant` は以前から grantee も呼べる実装だったが（`isOwner || isGrantee`、
   `api.ts:3312-3316`）、UI 導線が一切なかった

## 実装内容

### 招待 UI の文言（`apps/web/src/pages/TeamPage.tsx`）
- 受信側の見出し: 「チームへの参加を依頼」→「あなたのプロジェクトへの質問（ask）許可を
  求めています」（チーム名は補足表示に後退）
- 選択欄: 「公開するプロジェクトを選んでください」→「質問を受け付けるプロジェクトを
  選んでください」
- 新規警告（amber 系）: 「選んだプロジェクトの AI はあなたの契約で実行されます（質問の
  たびに利用枠を消費）。コードの変更はできません。あとから取り消せます」
- 送信側: 「招待を送信中」→「プロジェクトの公開を依頼中」

### 貸す側の「公開中のプロジェクト」セクション
- 新規 `GET /api/teams/shared-by-me`（`apps/server/src/routes/api.ts`）:
  `CrossTeamGrant.granteeUserId = 自分 AND revokedAt IS NULL` の行を返す。
  キルスイッチ OFF 時は 404 ではなく `{shares: []}` を返す（`/api/teams/invites` と同じ
  流儀。`crossTeamEnabled` の判定自体は `GET /api/teams/org-candidates` の 404 が担うため）
- サーバー側の取り消し処理は新規実装不要（既存の `DELETE /api/teams/members/:memberId/
  grant` をそのまま使う。`CrossTeamAuditLog` への `grant_revoked` 記録も既存のまま効く）
- WebUI: 「公開中のプロジェクト」セクションを「あなたへの招待」の直後に新設。
  相手の表示名・プロジェクト名・マシン名・ask/exec チップ・「公開を停止」ボタン（確認
  ダイアログ付き）を表示

## 検証

`pnpm build` 全 6 workspace green。web バンドルに CJS `require(` 混入なしを確認
（`grep -c 'require(' apps/web/dist/assets/index-*.js` が 0）。
`apps/server` の `node --test` 1454/1454（新規 3 ケース含む、既存含め非退行）。

## 変更ファイル

既存 `apps/server/src/routes/api.ts`、`apps/web/src/lib/api.ts`、
`apps/web/src/pages/TeamPage.tsx`、`apps/server/tests/cross-team-api-wiring.test.mjs`。
新規ファイルなし。DB スキーマ変更なし、新規キルスイッチなし（既存 `DEVRELAY_CROSS_TEAM`
の配下で動く）。ソースコード変更ありのため `pnpm build` 実行済み、再起動が必要。

## 未解決（別サイクルで対応予定）

- 公開型（`Team.visibility` + `TeamSubscription` を新設し、`decideCrossTeamAccess()` は
  無改造で candidates を増やすだけで実現できる見込み）
- 同名衝突の解決手段が弱い（`ask <project>@<machine>:` 形式や候補への採番などが必要。
  公開型を入れると他人のプロジェクトが大量に候補へ入るため必須級になる）
- プロジェクトのリネーム UI が Team ページにしか無い問題
