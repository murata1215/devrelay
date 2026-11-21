# スレッドタイトル自動命名（2026-11-21）

## 背景
左のスレッド一覧の表示名は `Session.title` が無いと「最初のユーザー発言」になる。そのため
1. 最初の一言で決まり、話が進んでも変わらない
2. 引継ぎスレッドは最初の入力 `n` がそのまま題名になる（WebUI のコマンド入力も `role='user'` で保存されるため）

手動リネーム（✏️）はあるが毎回は面倒。

## 変更
- DB: `Session.autoTitle` / `autoTitleAt` / `autoTitleTurns`（`apps/server/db/changes/0033_session_auto_title.sql`、本家連番）。
  `title`（ユーザー命名）とは別列。`thread-label-source.ts` の「自動値を title に書かない」不変条件を維持。
- 生成: `services/thread-auto-title.ts`（I/O）+ `thread-auto-title-rules.ts`（純関数・テスト付き）。
  - `agent-manager.ts` の `handleAiOutput()` で AI 応答保存後に fire-and-forget（クロスクエリ・`n make` は対象外）
  - AI 応答数が **1・3・8** のときだけ。`title` があるスレッドは生成しない。保存は `title IS NULL` 条件付き
  - 鍵は `DEVRELAY_ANSWER_API_KEY` / モデル `DEVRELAY_ANSWER_MODEL`（既定 `gpt-4o-mini`）。未設定なら何もしない
  - 材料: 引継ぎメモ（`handoverNote`）+ コマンドを除いたユーザー発言（先頭2・直近3）+ 直近 AI 応答の冒頭
- 一覧 API（`GET /api/threads`）: `autoTitle`・`handoverFromTitle`（引継ぎ元の title/autoTitle）を返す。
  `labelFromUser` はユーザー発言の先頭 8 件から `isTraditionalCommand` に当たる発言（`n` / `n 1` / `e` 等）を飛ばして選ぶ。
- WebUI: 表示優先 **title > autoTitle（✨ 付き）> ↪ 引継ぎ元の題名 > 最初の発言 > AI 応答 > 既定**。
  ✏️ の初期値は autoTitle。AI 応答受信の 8 秒後にスレッド一覧を 1 回取り直す（ChatPage の `handleWsMessage`）。
- キルスイッチ `DEVRELAY_THREAD_AUTO_TITLE`（既定 `1`）。`0` で生成停止・API も新フィールドを返さない。

## 費用
1 回あたり入力 1,000 字程度・出力 100 トークン以下 × 1 スレッド最大 3 回。`gpt-4o-mini` でほぼゼロ。

## 反映
- DB: `psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f apps/server/db/changes/0033_session_auto_title.sql`（アプリと同じロール）
- サーバー再起動（Agent の `u` は不要）
- 本家 VPS で AI 命名を使うには `.env` に `DEVRELAY_ANSWER_API_KEY` が必要（無くてもコマンド除外・↪ 表示は効く）

## テスト
- `apps/server/tests/thread-auto-title-rules.test.mjs`（節目判定・材料選択・整形・コマンド発言除外）
- `apps/web/tests/thread-list-rules.test.mjs`（表示優先順位）
- `knowledge-source-guards.test.mjs` の ChatPage 行数ピンを 4422 → 4439 に更新
