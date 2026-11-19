# 2026-11-19 チャットの入力欄で案件タグを付ける・案件が空なら AI に送れなくする

## 背景
案件タグ（`Session.usageCase`）は /usage の明細でしか付けられず、気づきにくい。チャットのスレッド上・入力欄の近くで
付けたい、「付けないと会話できない」でもよい、という要望。

## 実装
| 内容 | ファイル |
|---|---|
| 案件欄（表示・保存・候補）と取得フック `useThreadCase(sessionId, { allowPending })` | `apps/web/src/components/CaseTagBar.tsx` |
| 送信を止める判定 `decideCaseGuard()`（純関数） | `apps/web/src/lib/usage-case-rules.ts`（+ `tests/usage-case-rules.test.mjs`） |
| ChatPage: 入力欄の上に欄、`handleSend` で判定 | `apps/web/src/pages/ChatPage.tsx` |
| Lite: `LiteComposer` の `caseSlot`、`handleSend` で判定、新規スレッド作成直後に保存 | `components/lite/LiteComposer.tsx` / `pages/LitePage.tsx` |
| スレッド一覧の案件ラベル | `components/ThreadList.tsx`、`GET /api/threads` に `usageCase` |
| API | `GET /api/usage/sessions/:sessionId/case`、`GET /api/usage/case-settings`（`routes/usage-api.ts`） |
| コマンド判定の共用 | `packages/shared/src/command-classify.ts`（server の `isTraditionalCommand` を移設、判定無変更） |
| 必須モード | `DEVRELAY_USAGE_CASE_REQUIRED`（既定 OFF、`'1'` で ON。`services/usage-rules.ts` `isUsageCaseRequired`） |

## 決めたこと
- 止めるのは WebUI（ChatPage・Lite）からの AI プロンプトだけ。コマンド・`//` 内部コマンド・空送信は通す。添付付きは AI に渡るので止める。
- 案件の状態がまだ読めていない（ChatPage でスレッド未確定）ときは止める（確実さを優先）。
- Discord / Telegram / MCP は止めない（入力欄が無いため）。
- 既定 OFF にしたのは、同じコードを使う他環境（個人 devrelay.io 等）の挙動を変えないため。このマシンは `.env` で ON。
- 案件の取得に失敗した（Usage 無効・旧サーバー）ときは欄を出さず、送信も止めない。

## 検証
- テスト: web 937/937、shared 122/122（command-classify 含む）、server は既存の Windows 由来失敗のみ
- 過去サイクルのトリップワイヤ（ChatPage/LitePage 行数ピン、`u force` の配線テスト）を実測値・移設先に更新
- devrelay-build.cmd で IIS 配置済み。`.env` に `DEVRELAY_USAGE_CASE_REQUIRED=1` を追加（要サーバー再起動）
