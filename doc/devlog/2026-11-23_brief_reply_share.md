# 2026-11-23: AI 回答契約（人間向け本文と詳細を分ける）

## 設計の訂正（重要）

最初に「長文を折りたたむ UI」として着手したが、それはユーザーの意図ではなかった。
やり直しの経緯:

1. 当初案: Discord/Telegram 配信時に長文を切り詰め・WebUI は折りたたみ UI を追加
2. ユーザー指摘「折りたたみ機能が欲しいわけではない。AI 自身が、人間向けの簡潔な回答と
   技術的な詳細報告を分けて生成する仕組みが欲しい」→ AI の**出力契約**の問題だと判明
3. 訂正案（行数で振り分け）に対し再度訂正「行数や書式で振り分けないでください。
   短くすること自体が目的ではなく、人間が余計な情報を読まなくても仕事を進められることが目的」
4. 最終合意: 振り分け基準は **「それが無いと人間が仕事を進められるか」の一点のみ**。
   人間が実行する手順・コマンドは、長さに関わらず全部チャットに残す。

## やったこと

### AI への契約（プロンプト前置、暫定）

`apps/server/src/services/brief-reply-rules.ts`。`sendPromptToAgent()`（Backlog 行と同じ場所）が
プロンプト先頭に前置する。要点:

- 結論・判断してほしいこと・人間が実行する手順（省略しない、長くても全文）・注意点は本文に書く
- それ以外（調査過程・技術的背景・ファイル内訳・テスト結果の内訳）は、本文末尾に単独の1行で
  `<!-- devrelay:detail -->` を書いてから続ける
- 分ける必要が無い短い回答はそのまま返す（無理に2部構成にしない）
- 専門用語を避け、前提知識が無くても読める言葉で書く

恒久版（Agent 側 Agreement テンプレート統合）は別サイクルの follow-up。3 OS の
`output-collector.ts` byte-for-byte 同期・Agreement バージョン更新を伴うため、
本サイクルはサーバー側の前置のみ（Agent 更新 `u` 不要・即時全マシンへ反映）。
`rules/devrelay.md` にも同内容の「回答の書き方」節を追記した（ドキュメントとして。
Agreement テンプレートのバージョンは変えていない）。

### 境界行での分割（配信側）

- `apps/server/src/services/response-split-rules.ts`（純関数）: `splitAiResponse(raw)` が
  進捗ノイズ（🔧/📊）を除去した上で、コードフェンス外にある境界行を探し `{summary, detail}` に分ける。
  境界行が無ければ `detail: null`（全文が summary）。
- `apps/server/src/services/response-split.ts`（サービス）: `resolveLiveDeliveryContent()`
  （ライブ配信用、必要なら共有トークンを新規発行）と `resolveStoredDeliveryContent()`
  （REST 履歴用、既存トークンのみ参照・新規発行しない）。
  **情報を落とさない方針**: 詳細があっても `DEVRELAY_RESPONSE_SHARE=0`・`messageId` 無し・
  一時セッション・トークン発行失敗のいずれかで詳細ページへのリンクを作れない場合は、
  詳細を隠さず summary+detail を連結して返す。

### 配信（WebUI・Discord・Telegram 共通、プラットフォームで出し分けない）

`apps/server/src/services/session-manager.ts` の `finalizeProgress()`:

- `resolveLiveDeliveryContent()` の結果 `chatText`（人間向け本文）を全経路の基準にする
- Discord/Telegram: `chatText` + 案内行（`buildShareSuffix()`。Discord は `<url>` で埋め込みカード抑制）
- WebUI/Lite: `chatText` をそのまま本文に、`shareUrl` は**別フィールド**で渡し、
  クライアントがリンク/ボタンとして描画する（`platforms/web.ts: sendWebMessage()` に
  `shareUrl?` パラメータ追加、`packages/shared/src/types.ts` の `ServerToWebMessage['web:response']`
  に `shareUrl?: string` 追加）
- push 通知・FCM・`createNotification()` も `chatText` を使う（詳細の技術情報や進捗ノイズで
  通知本文が埋まらないようにする）

### リロード後も同じ見え方に（REST 履歴 API）

`apps/server/src/routes/api.ts` の `GET /api/sessions/:id/messages`・
`GET /api/projects/:projectId/messages`・`GET /api/cross-team/projects/:id/messages` に
`shareToken`/`shareExpiresAt` を select 追加し、`role==='ai'` の行にのみ
`resolveStoredDeliveryContent()` を適用（新規トークンは発行しない）。レスポンスに `shareUrl` を追加。

`Message.content` は**全文のまま保存**（境界行・詳細を含む）。DB 変更なし（列は前サイクルの
`shareToken`/`shareExpiresAt` のみ、本サイクルでの追加は無し）。

### 詳細ページ `/s/:token`

`apps/server/src/routes/response-share-api.ts`: `splitAiResponse()` で summary/detail に分け、
`${summary}\n\n---\n\n## 詳細\n\n${detail}` の形で全体を見せる（詳細が無ければ summary のみ）。

### クライアント側の変更

- `apps/web/src/hooks/useWebSocket.ts`: `ChatMessage`/`ServerToWebMessage['web:response']` に
  `shareUrl?: string` 追加
- `apps/web/src/lib/api.ts`: `SessionMessage` に `shareUrl?: string | null` 追加
- `apps/web/src/pages/ChatPage.tsx`: `MessageRow` が `message.shareUrl` があれば
  「📄 詳細を見る」リンク（新しいタブ）を描画。REST 履歴の2箇所のマッピングに `shareUrl` 追加
- `apps/web/src/lib/lite-message-log.ts` / `apps/web/src/pages/LitePage.tsx` /
  `apps/web/src/components/lite/LiteMessageList.tsx`: Lite 側も同様に対応
- i18n: `chat.detailLink`（en: "View details" / ja: "詳細を見る"）

## 既存の共有リンク基盤（前サイクル）との関係

`Message.shareToken`/`shareExpiresAt`（DB 0034）・`DEVRELAY_RESPONSE_SHARE`・`/s/:token`・
TTL 解決（個人設定 → `DEVRELAY_SHARE_TTL_DAYS` → 既定30日）・24時間ごとの期限切れ清掃は、
前サイクルでそのまま実装済みのものを再利用。変更したのは「いつトークンを発行し、何を
リンクの代わりに本文に出すか」の判断ロジックのみ（`isShareablePlatform()`＝discord/telegram限定
のゲートは撤廃し、「詳細があるかどうか」だけで判断するようにした）。

## テスト

- `apps/server/tests/response-split-rules.test.mjs`（新規）: 境界行の検出・コードフェンス内の
  境界行を無視・進捗ノイズ除去・detail が空白のみなら null 等
- `apps/server/tests/brief-reply-rules.test.mjs`（更新): 新しい契約文の内容を検証
- `apps/server/tests/response-share-rules.test.mjs`（更新）: `isShareablePlatform` 関連を削除

`cd apps/server && node --test tests/*.test.mjs` で確認。

## 検証手順（実機・第1〜2版の時点）

1. 既に `DEVRELAY_RESPONSE_SHARE=1` / `DEVRELAY_SHARE_TTL_DAYS=3` が設定済み・DB 適用済み
2. `pnpm build` → `pm2 restart devrelay-server`
3. 詳細が必要なターン（AI が境界行を書く）で、Discord/Telegram/WebUI/Lite いずれも
   人間向け本文のみが表示され、詳細ページへのリンクが付くこと
4. 詳細が不要な短いターンでは、従来どおりそのまま表示されリンクが付かないこと
5. `DEVRELAY_RESPONSE_SHARE=0` に戻すと、詳細があっても本文に全部インラインで出ること（情報は消えない）
6. 詳細ページを開くと、人間向け本文 + 詳細が1ページで読めること

---

## 第3版（同日、実機テストで発覚した2つの問題への対応）

### 問題1: モバイルアプリでリンクが消える

WebUI 用に `shareUrl` を本文とは別の JSON フィールドで渡す設計にしていたが、実機（スマホの
DevRelay アプリ）で確認したところ、本文だけが表示されリンクが一切出ていなかった。

原因: このリポジトリに含まれるのは `apps/web`（ブラウザ版）のみで、モバイルアプリは別の
コードベース。そちらは `shareUrl` フィールドの存在を知らないため、単に無視していた。

**対応**: リンクを本文の中に markdown 形式 `[詳細を見る（N日間有効）](URL)` で埋め込む方式に
変更。`buildShareSuffix()`（`response-share-rules.ts`）に `'markdown'` 形式を追加し、
`session-manager.ts` の web 配信・`api.ts` の REST 履歴の両方で本文に直接連結する。
`apps/web/src/pages/ChatPage.tsx`（`MessageRow`）・`apps/web/src/components/lite/LiteMessageList.tsx`
の専用リンクボタンは撤去（本文内リンクと二重になるため）。`shareUrl` フィールド自体は
将来の専用 UI 用に引き続き API に残す。

### 問題2: AI が境界行を書かない

このスレッド自体で「要約されていない」とユーザーから指摘があった。契約（プロンプト前置）は
「お願い」でしかなく、長い会話や Claude 以外のツール（Codex/Gemini/Devin）では遵守されない。
Agreement（全プロジェクトへのルール配布）での対応も検討したが、「各プロジェクトで `ag` を
実行してもらう必要がある」「読んで守るかは AI 次第」という弱点があり却下。

**対応**: 境界行が無かった場合の保険として、DevRelay 自身が受け取った返事を要約 AI に渡して
人間向け本文を作り直す機能を追加（`services/reply-summary.ts` / `reply-summary-rules.ts`）。

- 境界行があれば従来どおり無料・即時（AI 呼び出しなし）
- 無ければ、本文が `DEVRELAY_REPLY_SUMMARY_MIN_CHARS`（既定800文字）以上のときだけ要約 AI を呼ぶ
- 鍵は**本人（セッションの持ち主）の個人設定**（設定画面 AI Provider Settings に「返事の要約」を
  追加。未設定なら「Build Summary」の設定を流用、`getApiKeyForReplySummary()`）。組織共通キー
  （`DEVRELAY_ANSWER_API_KEY`）にはフォールバックしない（ユーザー判断: 「各自の作業は各自の
  財布で」。これは既存のナレッジ AI 回答・スレッド自動命名とは異なる使い分け）
- 要約に成功しても、共有リンクを作れない場合（キルスイッチ OFF 等）は**要約だけを見せない**
  （詳細が消えるため）。この場合は元の本文をそのまま出す
- 要約結果は `Message.summary`（DB 変更 0035）に保存し、履歴の再取得では再要約しない
  （課金・待ち時間の抑制）

### `response-split.ts` の分岐（第3版、最終形）

```
境界行あり → 無料で分割 → リンク作れれば summary+リンク、作れなければ summary+detail を連結
境界行なし → 長ければ要約AIを呼ぶ
              → 成功しリンク作れれば 要約+リンク
              → 成功してもリンク作れなければ 元の本文のまま（要約は捨てる）
              → 失敗/鍵なし/短い/一時セッション → 元の本文のまま
```

### 費用・設定の住み分け（ユーザーとの合意事項）

| | 個人キー（設定画面） | `DEVRELAY_ANSWER_API_KEY`（env、組織共通） |
|---|---|---|
| 対象 | 返事の要約・ビルド要約・Dev Report 等9箇所 | ナレッジ AI 回答・スレッド自動命名・ポータルニュース要約 |
| 設定場所 | Web 設定画面（再起動不要） | `.env`（再起動必要） |
| 今回の選択 | **採用**（返事の要約） | 不使用 |

既存の `getApiKeyForOrgSummary()`（未設定時に Build Summary へフォールバック）と全く同じ方式を
`getApiKeyForReplySummary()` として実装した。

## 新規ファイル（第3版で追加）

- `apps/server/src/services/reply-summary-rules.ts`（純関数）
- `apps/server/src/services/reply-summary.ts`（I/O）
- `apps/server/tests/reply-summary-rules.test.mjs`
- `apps/server/tests/response-split-service-wiring.test.mjs`（`resolveStoredDeliveryContent` が
  新規要約を呼ばないこと等の静的ガード）
- `apps/server/db/changes/0035_message_summary.sql`（`Message.summary` 追加）

## 検証手順（実機・第3版）

1. 設定画面 AI Provider Settings の「返事の要約」に OpenAI/Anthropic/Gemini のいずれかを選択
   （未選択なら Build Summary の設定を自動的に使う）
2. `psql` で 0035 を適用（手順は下記）→ `pm2 restart devrelay-server`
3. 長い返事（800文字以上）で境界行を書かないケースでも、人間向け本文＋詳細リンクになること
4. モバイルアプリで開いても、本文中のリンクが読めること（タップできなくても URL が見える）
5. `DEVRELAY_REPLY_SUMMARY=0` に戻すと要約を呼ばず元の本文のままになること
6. 「返事の要約」を「なし」に設定した人（Build Summary も未設定）は、要約されず元の本文のまま
   になること（課金なし）

## DB マイグレーション（0035）適用コマンド

```bash
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f apps/server/db/changes/0035_message_summary.sql
```
適用後の検証:
```bash
cd apps/server && npx prisma db execute --stdin <<< "SELECT column_name FROM information_schema.columns WHERE table_name='Message' AND column_name='summary';"
```
