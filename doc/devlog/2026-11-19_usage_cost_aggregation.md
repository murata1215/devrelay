# 2026-11-19 Usage（コスト集計）とサイネージ画面

## 背景
Devin の請求画面は人別の合計しか出ず、グループ（CIT / BIT）・プロジェクト・案件単位で見たいという要望。
社内ディスプレイ（サイネージ）に常時大きく出したい。

## 決定事項（ユーザー承認）
- 閲覧は全員（組織所属なら組織全体。未所属なら本人のみ）
- 集計軸: グループ（人のタグ・1人1つ）→ 利用者 → プロジェクト（表示名。別マシンの同名はまとめる）→ 案件（スレッドのタグ）→ スレッド
- 案件タグはナレッジの `compartment` を流用せず、コスト集計専用の `Session.usageCase` を新設（閲覧制限に影響させない）
- 月は日本時間の暦月（Devin の請求期間 4日〜 とはずれる）
- 金額不明（「-」）のターンは 0 円で足し、「不明 n 件」を併記
- サイネージはグループごとのカード（中は案件別。`&by=user` で利用者別）

## 実装
| 層 | ファイル |
|---|---|
| 集計（共通） | `packages/shared/src/usage-aggregate.ts`（+ `tests/usage-aggregate.test.mjs` 11 件） |
| サーバー純関数 | `apps/server/src/services/usage-rules.ts`（+ `tests/usage-rules.test.mjs` 5 件） |
| DB 読み出し | `apps/server/src/services/usage-service.ts`（1 分キャッシュ。グループ・案件の変更で即破棄） |
| API | `apps/server/src/routes/usage-api.ts`（`usageApiRoutes` = 認証あり / `usagePublicRoutes` = 認証なし） |
| WebUI | `apps/web/src/pages/UsagePage.tsx`、`UsageSignagePage.tsx`、`App.tsx`、`Layout.tsx`、`lib/api.ts` |
| DB | `doc/migrations/usage_cost_aggregation.md`（適用済み） |

- 金額は `resolveMessageCost()`（会話履歴のコスト列と同じ）を AI 応答ごとに呼び、スレッド単位で合計
- 未命名スレッドは先頭の発言 40 文字 + 開始日（JST）を表示名にする（`DISTINCT ON` で 1 スレッド 1 行）
- サイネージ API が返すのは組織名・グループ名・案件名または利用者名・金額・回数のみ（スレッド名・メール・本文は返さない）。token は `randomBytes(24)` の base64url、形式不正は DB を引かずに 404
- 権限: グループ変更 = 本人 or 同組織 admin、案件変更 = スレッドの持ち主 or 同組織 admin、サイネージ URL = admin
- IIS: `/api/*` の中継と SPA フォールバックが既存設定で効くため web.config 変更なし

## 検証
- sa-makino の 11/4 0:00〜11/17 13:50（JST）: $53.03（92 ターン・不明 2）。前回の手計算 $53.04 は行ごとに丸めた値の合計で、差は丸めのみ
- 組織全体 2026-11: 199 スレッド・集計 0.2 秒
- shared 11/11、server usage-rules 5/5 green
