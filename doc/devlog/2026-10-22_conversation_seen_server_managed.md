# 会話既読状態のサーバー管理化 + Notification.sessionId 追加 (2026-10-22)

## 依頼元
devrelay_flutter（モバイルクライアント）からの実装依頼（MCP submit_instruction 経由）。

## 背景
WebUI の「会話」タブ（ConversationRail）の未読判定が localStorage
（キー `devrelay-conversation-seen`）で行われていたため、端末・ブラウザをまたいで未読状態が
同期しなかった。Flutter（iPhone）にも同じ会話フィードを実装する計画があり、このままでは
「WebUI で読んだのに iPhone では未読」が常態化し未読マーク自体が信用できなくなる。
Session は1ユーザーに属するため中間テーブルは不要で、1列追加（`Session.lastSeenAiAt`）で
既読状態をサーバー管理に移行できると判断した。

あわせて、以前の調査で判明していた「`Notification` に `sessionId` が無いためアプリ内通知一覧の
タップがプロジェクトまでしか開けない」問題（FCM push の data には既に `sessionId` があり、
そちら経由は Flutter 側で deep link 実装済み）も同時に解消した。

## 依頼1: スレッド既読状態のサーバー管理

### 1-1. DB
- `Session.lastSeenAiAt`（`DateTime?`）を追加。
- マイグレーションは `npx prisma migrate dev` がシャドウ DB エラー（既存の
  `TestflightService` 未適用マイグレーションに起因、本件と無関係）で失敗したため、
  `rules/devrelay.md` の手順どおり `npx prisma db execute --stdin` で直接 SQL を適用した。
- バックフィル: `role='ai'` の `Message.createdAt` の `MAX()` を `sessionId` ごとに集約し、
  `Session.lastSeenAiAt` が null の行にのみ `UPDATE`。実測で 11672 行中 10445 行に適用、
  残り 1227 行は AI 応答が一度も無いスレッドで意図どおり null のまま。
- SQL でカラム存在を検証（`information_schema.columns`）、`npx prisma generate` で再生成。

### 1-2. `GET /api/threads` に `seenAt` を追加
`running`/`lastAiAt` と全く同じキルスイッチ（`DEVRELAY_CONVERSATION_RAIL`、既定 ON）・
同じ流儀を踏襲した: OFF のときは `seenAt` キー自体をレスポンスから省略する
（`undefined` が JSON シリアライズで消えるため、OFF 時のレスポンスが旧実装と構造的に同一になる）。
値は `Session.lastSeenAiAt?.toISOString() ?? null`。

### 1-3. `POST /api/sessions/:id/seen` を新設
- body 不要。
- クライアントから既読時刻の値を受け取らず、サーバー側で「このスレッドの現在の `lastAiAt`」を
  読んで書く設計にした。理由は2点:
  - クライアントから値を受け取る形にすると、古い値を送られて既読が巻き戻る事故が構造的にありうる
  - SELECT と UPDATE を分けず、相関サブクエリを使った 1 クエリ（`UPDATE ... SET x = (SELECT MAX(...))`）
    にまとめることで、「既読 API を叩いている最中に新しい AI 応答が届く」レースでも常に最新値を拾う
    （= チャットを開いている間に届いた応答が自動的に既読になる、という望ましい挙動になる）
- 他人のセッション／存在しない ID は 404（既存の `evaluateSessionOwnership` を再利用、
  `POST /api/sessions/:id/switch` と同じ規約）。
- 対象スレッドにまだ AI 応答が無い（`lastAiAt` が null）場合は `lastSeenAiAt` も null のまま
  書き込まれる（実質 no-op）。`resolveConversationStatus`（WebUI 側）は `lastAiAt === null` を
  無条件で `'seen'` 扱いにするため、null のままでも判定上の不整合は生じない。
- レスポンスは `{ seenAt: string | null }`（実際に書き込んだ値を返し、クライアントが即反映できるようにする）。

### 1-4. WebUI 側の切り替え
- `apps/web/src/lib/api.ts`: `ThreadSummary.seenAt` を追加、`sessions.markSeen(sessionId)` を新設
  （body は明示的に `{}` を送る。`undefined` にすると Content-Type: application/json ヘッダーだけが
  残り、Fastify の JSON パーサーが空ボディを 400 にする既知の事故パターン
  `POST /api/notifications/read-all` と同種を踏むため）。
- `apps/web/src/lib/conversation-rail-rules.ts`: `resolveConversationStatus()` の判定式は無変更
  （`seenAt` の出どころが localStorage から API に変わるだけ）。localStorage 永続化用だった
  `readSeenMap`/`serializeSeenMap`/`seedSeenMap`/`pruneSeenMap`/`CONVERSATION_SEEN_STORAGE_KEY`/
  `CONVERSATION_SEEN_MAX`/`SeenMapState`/`ConversationSeedItem` は不要になったため削除
  （サーバーが導入時に既存行をバックフィル済みのため、「初回起動時に全件シード」という
  特別扱いも不要になった）。`markSeen()` は「ポーリング間隔中の楽観的 UI 反映」用に用途を変えて存続。
  新設 `resolveEffectiveSeenAt(serverSeenAt, localOverride)`: サーバー値（複数端末間の真実の情報源）と
  ローカル上書き（`POST /api/sessions/:id/seen` 応答。次回ポーリングでサーバー値に追いつくまでの
  つなぎ）のうち新しい方を採用する（巻き戻さない）。
- `apps/web/src/hooks/useConversationFeed.ts`: localStorage 読み書き（`safeGetItem`/`safeSetItem`/
  `commitSeenMap`）を全廃し、`localSeenOverrides`（非永続・ポーリングごとに一覧に出てこなくなった
  sessionId は捨てる）に置き換え。`markConversationSeen(sessionId)` のシグネチャから
  `lastAiAt` 引数を削除（サーバーが自分で現在値を読むため不要になった）。
  行クリック時・アクティブスレッドの自動既読化はどちらも `markConversationSeen()` 経由で
  `POST /api/sessions/:id/seen` を叩く。
- `apps/web/src/pages/ChatPage.tsx`: `handleConversationSelect` の呼び出しを新シグネチャに追従。

## 依頼2: Notification.sessionId の追加
- `Notification.sessionId`（`String?`、FK は張らない。`KnowledgeChunk.sessionId` と同じ規約。
  Session 行は削除されない運用のため実務上孤児化の心配はないが、将来の仕様変更に備えて
  FK 制約には依存しない設計にした）を追加。
- `createNotification()` に第7引数 `sessionId?: string` を追加し、`data.sessionId` に書く。
- 呼び出し元2箇所を修正:
  - `session-manager.ts` の `finalizeProgress()`（AI 応答完了通知。'response'）
  - `agent-manager.ts` の `handleToolApprovalRequest()`（承認待ち通知。'approval'）
  いずれも関数スコープに `sessionId` が既にあったため、渡すだけで済んだ。
- `getNotifications()` のレスポンスに `sessionId: n.sessionId ?? null` を追加。
- WebUI 側（`apps/web/src/lib/api.ts`）に通知一覧の型・クライアントが無い（モバイルアプリ専用の
  REST であることを確認済み）ため、WebUI 側の追加変更は無し。

## 検証
- DB: SQL でカラム存在・バックフィル件数を検証（本文中の実測値のとおり）。
- `pnpm build`: 6 workspace 全て green（nvm 版 node 20.20.0 + 同梱 pnpm 10.30.0 を使用。
  サンドボックス環境に pnpm が PATH に無かったため `/home/devrelay/.nvm/versions/node/v20.20.0/bin`
  を明示的に PATH へ追加して実行した）。
- `apps/server` テスト: 1209/1209 green（既存テストのみ、本件向けの新規テストは追加していない。
  追加した2ルートハンドラは raw SQL ベースのため既存の route 層と同じく単体テスト対象外、
  ガード（`evaluateSessionOwnership`）・キルスイッチ（`isConversationRailEnabled`）は既存テストで担保済み）。
- `apps/web` テスト: 854/854 green（`conversation-rail-rules.test.mjs` から削除した関数の
  テスト 11 件を除去し、新設 `resolveEffectiveSeenAt()` のテスト 5 件を追加）。

## 影響範囲・引き継ぎ事項
- Agent 側（`agents/linux`/`agents/macos`/`agents/windows`）変更ゼロ、各機 `u` 不要。
- DB マイグレーション適用済み（本番相当の DB に直接 SQL 適用。カラム存在・バックフィル件数を検証済み）。
- pm2 restart 要（`apps/server`/`apps/web` を変更したため。未実施）。
- commit/push 未実施。
