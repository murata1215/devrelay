# 公開型クロスユーザー Team Phase B（WebUI: 操作画面）

## きっかけ

Phase A（サーバー + 認可）を実装・デプロイし、`DEVRELAY_CROSS_TEAM_PUBLISH=1` も
本番 `.env` に追加して SQL で又貸し防止を実データ確認したが、操作画面が無いため
実機検証にはブラウザコンソールへ JS スニペットを貼る必要があり、実用的ではなかった。
ユーザーから「操作する画面を用意して、こっちでやる」との要望を受けて着手。

## 実装内容

### UX の肝: 又貸し防止を画面に見せる

Phase A で実装済みの又貸し防止（`selectPublishableMembers()`）は、サーバー側の
認可には効いていたが、**操作する人の目には見えていなかった**。公開ボタンを押すと
確認ダイアログで何が公開され何が除外されるかを明示するようにした:

```
チーム「pixterm」を組織に公開しますか？
公開されるプロジェクト: 2 件（あなたが所有するもの）
他ユーザーから借りている 3 件は公開されません（又貸しになるため）
同じ組織のメンバーが購読すると、あなたの契約で AI が実行されます。
```

借りているプロジェクトが無いチームでは除外の注記を出さない（`borrowedCount === 0`
のとき行を省略）。

確認ダイアログの文言生成を新規 `apps/web/src/lib/cross-team-publish-rules.ts`
（外部 import ゼロの純関数、`cross-team-invite-rules.ts` と同じ流儀）に集約し、
テストで固定した。前サイクル（招待型の「公開を停止」確認文言が他チーム経由の grant が
残るのに断言してしまった事故）の教訓を踏まえ、文言ロジックを直書きしない設計にした。

### 実装中に見つけた退行の種

既存 `fetchCrossTeamData`（招待型）は `orgCandidates` / `listInvites` / `sharedByMe`
の 3 本を 1 つの `Promise.all` + 1 つの try/catch で囲んでおり、1 本でも 404 なら
クロスユーザー機能ごと非表示にする設計だった。ここに公開型の `/teams/published` を
混ぜると、**公開キルスイッチだけ OFF の環境で招待 UI まで巻き込んで消える退行**に
なることが実装前のコードリーディングで判明した。

→ 公開系データ取得（`fetchPublishedTeams`）を独立した関数・独立した try/catch・
独立した state（`crossTeamPublishEnabled`）にし、2 つのキルスイッチの効き方が
互いに干渉しないようにした。

### サーバー側の変更（最小限）

`GET /api/teams` に、公開キルスイッチ ON のときだけ `visibility` / `subscriberCount`
を追加。OFF 時はキーごと省略し旧レスポンスと構造的に同一を維持する（既存の
`isCrossUser` 条件スプレッドと同じ流儀）。購読者数の集計クエリ
（`teamSubscription.groupBy`）も ON のときだけ実行し、既定状態での負荷ゼロを保つ。

**Phase A の 6 ルート・認可まわり（`cross-team-guard.ts` / `cross-team-publish.ts` /
`cross-team-authz.ts`）は一切変更していない。**

### UI 構成

- チームヘッダーに公開トグル（`+ Invite` の隣）: `🔒 非公開` ⇄ `🌐 公開中 (N)`
  （N = 購読者数）。公開中のボタンを押すと購読者一覧が展開し、各行に「取り消し」、
  下部に「公開を停止」
- 新セクション「組織で公開中のチーム」（「公開中のプロジェクト」の直後）: 他ユーザーが
  公開したチームを一覧表示し、`購読する` / `購読中 + 解除`
- 公開可能件数・又貸し件数はクライアント側に追加クエリ不要。既存 `GET /api/teams` の
  `members[].crossUser` フラグで既に区別されているため、
  `team.members.filter(m => !m.crossUser).length`（公開可能）/
  `filter(m => m.crossUser).length`（又貸し）で算出するだけで済んだ

## 検証

`pnpm build` 全 6 workspace green。web バンドルに CJS `require(` 混入なしを確認
（過去の白画面事故の再発防止チェック）。`apps/web` の `node --test` 944/944
（新規 13 ケース含む非退行）。`apps/server` の `node --test` 1495/1495
（新規 2 ケース含む非退行）。`tracked-imports.test.mjs` も通過。

## 変更ファイル

新規 `apps/web/src/lib/cross-team-publish-rules.ts`、
`apps/web/tests/cross-team-publish-rules.test.mjs`。既存
`apps/web/tsconfig.test.json`、`apps/web/src/lib/api.ts`、
`apps/web/src/pages/TeamPage.tsx`、`apps/server/src/routes/api.ts`、
`apps/server/tests/cross-team-api-wiring.test.mjs`。DB スキーマ変更なし・
新規キルスイッチなし（既存 `DEVRELAY_CROSS_TEAM_PUBLISH` の配下）。ソースコード
変更ありのため `pnpm build` 実行済み、再起動が必要。

## 未解決（別サイクルで対応予定）

- 同名衝突の解決手段（`ask <project>@<machine>:` 形式や候補への採番）。公開型が
  実用段階に入ると必須級になる
- クロスユーザー teamexec（Phase 2）
- プロジェクトのリネーム UI が Team ページにしか無い問題
