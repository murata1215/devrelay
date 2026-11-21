# 公開型クロスユーザー Team Phase A（サーバー + 認可のみ）

## きっかけ

招待型（Phase 1）を実機でフル往復テストし、一連の UI バグも解消した後、当初から予定
していた公開型 —「特定ユーザーがチームを公開設定し、同一組織の利用者が選んで組み込む」
—に着手。公開する側が貸す側（＝自分の契約で AI が動き、課金を負担する）であることは
ユーザーに確認済み。

## 調査で見つかった設計上の課題

着手前に `decideCrossTeamAccess()` / `cross-team-authz.ts` / スキーマ / UI・テストの流儀を
3 本の Explore で並行調査し、以下を確認した。

### ① `callerQualified` が公開型の構造的な壁

認可の純関数 `decideCrossTeamAccess()`（`cross-team-guard.ts`）は `teamMemberId` に一切
依存せず、受け取るのは `CrossTeamCandidateGrant`（`teamId / grantId / granteeUserId /
askAllowed / execAllowed / revoked / callerQualified`）だけだった。

ただし `callerQualified` の計算（`cross-team-authz.ts` の `loadCrossTeamCandidates`）が
「Team オーナー本人であり、かつ発信マシンの自分のプロジェクトがその Team のメンバーで
あること」を要求していた。招待型は「借りる側が Team オーナー」だが、公開型は「貸す側が
Team オーナー」で関係が逆転するため、購読者を Team オーナーとして扱うことはできず、
素朴には全員 `callerNotQualified` で弾かれる。

→ **`decideCrossTeamAccess()` は 1 バイトも変更せず**、DB 側の資格計算だけを「購読が
あれば資格あり」に拡張する方式を採った（既存の「単一の拡張点」設計にそのまま乗る）。

さらに資格判定は Agent REST 経路とチャット経路で非対称（後者は `requesterUserId` 基準）
であることも確認済みで、両方に手当てが必要だった。

### ② 又貸しの危険（最重要の安全要件）

`Team` は招待型で受け入れた他人のプロジェクトも同じ `TeamMember` として保持する
（`GET /api/teams` は `machine.userId !== 自分` の行に `crossUser: true` を付けて区別
しているだけ）。素朴に「チームを公開」すると、招待で借りているプロジェクトが所有者の
同意なく組織全体に再公開され、所有者の契約で課金が走る事故になる。

→ 公開対象を「チームオーナー自身が所有するプロジェクト」に限定し、認可側でも
オーナー不一致を二重にチェックする設計にした。

### ③ 規模（実体化方式を避ける根拠）

TISA 組織は 8 名（admin 1 + member 7）、既存 Team は最大 13 プロジェクト。「購読時に
grant を実体化する」方式だと 13 × 7 = 91 行＋チーム編集のたびの同期処理が必要になり、
さらに `CrossTeamGrant.teamMemberId @unique` の撤廃まで必要になる。

→ **購読から認可入力をその場で合成する**方式を採用。`CrossTeamGrant` のスキーマは
一切変更しない。既存のクロスユーザー専用レート制限（`CROSS_USER_ASK_TARGET_LIMIT=4` 等）
は同じ経路を通るので自動的に効く。

## 設計判断: 購読に承認を挟むか

セルフサービス方式（承認なし）を採用。「公開」という行為自体が組織への同意であり、
ユーザーの指示「利用者は公開されているチームを選んで組み込む」とも一致する。歯止めは
「公開者はいつでも公開停止できる」「購読者一覧を見て個別に取り消せる」「既存のレート
制限が効く」の 3 つで足りると判断（ユーザー確認済み）。

## 実装内容

### スキーマ
`Team.visibility`（既定 `'private'`）+ `TeamSubscription`
（`@@unique([teamId, subscriberUserId])`、認可根拠は「行が存在し `revokedAt IS NULL`」
の 2 条件のみ、`CrossTeamGrant` と同じ設計原則）。

### 新規純関数 `cross-team-publish.ts`
`cross-team-guard.ts` と同じ流儀（外部 import ゼロ）:
- `selectPublishableMembers()`: 又貸し防止の核心。`ownerUserId !== teamOwnerUserId` の
  行を無条件で除外
- `buildSubscriptionCandidates()`: 購読から `CrossTeamCandidateGrant[]` を合成。
  他人の購読を捨てる・オーナー不一致を捨てる（二重防御）・`execAllowed` は常に false・
  `grantId` に `sub:` 接頭辞（実 grant と監査ログ上で区別できるように）

### DB ラッパの拡張
`loadCrossTeamCandidates()`（Agent REST 経路）と `listCrossTeamAskCandidateProjects()`
（チャット経路）の両方に、公開チームの購読から合成した候補を合流させる。招待型の
実 grant を優先し、既に grant がある projectId は上書きしない。

### 監査
`team_published / team_unpublished / subscribed / unsubscribed / subscription_revoked`
を追加。公開/購読は本人の単独操作が正規ケースのため、既存の「同一ユーザー経路は
1 行も増えない」不変性を崩さないよう `allowSelfAudit: true` を明示したときだけ記録
する（既存呼び出しは引数を足さないので挙動不変）。

### REST API（6 ルート）
`PATCH /api/teams/:teamId/visibility`（Team オーナーのみ、公開可能 0 件なら 400）、
`GET /api/teams/published`（同一組織・プロジェクト名は返さない）、
`POST/DELETE /api/teams/:teamId/subscribe`、
`GET /api/teams/:teamId/subscribers`（Team オーナーのみ）、
`DELETE /api/teams/:teamId/subscribers/:userId`（Team オーナーによる強制取消）。
他人の Team / 他組織は常に 404（存在を漏らさない）。

新キルスイッチ `DEVRELAY_CROSS_TEAM_PUBLISH`（既定 `0` = OFF、`DEVRELAY_CROSS_TEAM` と
AND）。

## 検証

`pnpm build` 全 6 workspace green。`apps/server` の `node --test` 1493/1493
（新規 35 ケース含む、既存含め非退行）。OFF 状態（現在の本番環境）で
`Team.visibility` が全て `'private'` のまま・`TeamSubscription` 行数 0 であることを
SQL で確認。

テストでは又貸し防止を最優先で固定（「招待で借りたプロジェクトを含むチームを公開
しても、借り物は `selectPublishableMembers()` に残らず、`decideCrossTeamAccess()` も
`denyReason: noGrant` になる」）、`cross-team-guard.ts` が購読・公開型の語を一切知らず
無改造のままであることを静的ガードで固定。

## 変更ファイル

新規 `apps/server/prisma/migrations/20261108000000_add_team_subscription/`、
`apps/server/src/services/cross-team-publish.ts`、
`apps/server/tests/cross-team-publish.test.mjs`。既存 `apps/server/prisma/schema.prisma`、
`apps/server/src/services/{cross-team-authz,cross-team-audit}.ts`、
`apps/server/src/routes/api.ts`、`apps/server/tests/cross-team-api-wiring.test.mjs`、
`CLAUDE.md`。**`cross-team-guard.ts` は変更なし。** WebUI なし（Phase B で対応）。
DB マイグレーション適用済み（`npx prisma db execute --stdin` で直接適用・SQL 検証・
`npx prisma generate` 実行済み）。ソースコード変更ありのため `pnpm build` 実行済み、
再起動が必要。

## 未解決（別サイクルで対応予定）

- **Phase B（WebUI）**: チーム行の「公開する」トグル、「公開中のチーム」ブラウズ &
  購読、購読者一覧 & 取り消し。Phase A をサーバー単体で検証してから着手する判断
  （又貸し防止が効いているかの切り分けを UI 抜きで行うため）
- 同名衝突の解決手段（`ask <project>@<machine>:` 形式や候補への採番）。公開型で
  他人のプロジェクトが大量に候補へ入ると必須級になる
- クロスユーザー teamexec（Phase 2）
- プロジェクトのリネーム UI が Team ページにしか無い問題
