# Changelog

> CLAUDE.md から移行した実装履歴（#1-#85）

---

## 実装済み機能

### #151: PWA + Web Push 通知 (2026-03-13)

#### 概要
WebUI を PWA（Progressive Web App）化し、タブを閉じていても AI 応答完了の Push 通知を受信できるようにした。

#### 変更内容
- `vite-plugin-pwa` + `injectManifest` 方式でサービスワーカーを導入
- VAPID キーによる Web Push API 対応（サーバー側 `push-notification-service.ts`）
- マニフェスト + アイコン（192x192, 512x512）追加
- `finalizeProgress` 完了時にプッシュ通知送信（fire-and-forget）

#### 変更ファイル

| ファイル | 変更内容 |
|---------|---------|
| `apps/web/src/sw.ts` | Service Worker（push イベントハンドラ） |
| `apps/web/vite.config.ts` | vite-plugin-pwa 設定 |
| `apps/web/public/icons/` | PWA アイコン |
| `apps/server/src/services/push-notification-service.ts` | VAPID + Push 送信 |
| `apps/server/src/routes/api.ts` | Push subscription CRUD API |
| `apps/server/src/services/user-settings.ts` | VAPID/subscription 設定管理 |
| `packages/shared/src/types.ts` | Push 関連型定義 |

### #152: チャットページスクロール修正 (2026-03-13)

#### 問題
- チャットページを開くとメッセージがページ上部（最古）に表示される
- タブ切り替え時にスムーズスクロールのアニメーションが視認できる

#### 修正内容
- `historyJustLoadedRef` フラグ導入: 履歴ロード完了時は `behavior: 'instant'`、通常メッセージ追加時は `behavior: 'smooth'` で区別
- タブ切り替え時も `behavior: 'instant'` に統一

#### 変更ファイル

| ファイル | 変更内容 |
|---------|---------|
| `apps/web/src/pages/ChatPage.tsx` | `historyJustLoadedRef` 追加、スクロール動作の使い分け |

### #153: モバイルキーボード修正 (2026-03-13)

#### 問題
スマホでタブ切り替え時にキーボードがポップアップしてしまう。

#### 修正内容
- タッチデバイス検出（`'ontouchstart' in window`）を追加し、タッチデバイスでは `inputRef.current?.focus()` をスキップ

#### 変更ファイル

| ファイル | 変更内容 |
|---------|---------|
| `apps/web/src/pages/ChatPage.tsx` | タブ切り替え時のフォーカス制御 |

### #154: 通知音 (2026-03-13)

#### 概要
AI 応答完了時・メッセージ送信時に Discord 風の通知音を再生する。

#### 変更内容
- `new Audio('/sounds/notification.mp3')` による音声再生
- Settings ページにトグル追加（`devrelay-notification-sound` localStorage キー）
- トグル ON 時にプレビュー再生

#### 変更ファイル

| ファイル | 変更内容 |
|---------|---------|
| `apps/web/src/utils/notification-sound.ts` | 通知音ユーティリティ（再生・設定管理） |
| `apps/web/public/sounds/notification.mp3` | 通知音ファイル |
| `apps/web/src/pages/ChatPage.tsx` | 応答完了時・送信時に `playNotificationSound()` |
| `apps/web/src/pages/SettingsPage.tsx` | Completion Sound トグル追加 |

### #155: 複数ブラウザ間チャット同期 (2026-03-14)

#### 概要
家と会社など異なるマシンのブラウザで同じプロジェクトを開いている場合、片方でのメッセージ送信・AI 応答がもう片方にもリアルタイムで反映される。

#### 実装内容
- `web:user_message` メッセージタイプ追加（サーバー → Web クライアント）
- AI プロンプト送信時、同セッションの他 Web 参加者にユーザーメッセージをブロードキャスト
- `getSessionIdByChatId()` / `getSessionParticipants()` ヘルパー追加
- AI レスポンスは既存の `finalizeProgress` で全参加者に配信

#### バグ修正: Agent 再起動時の参加者マイグレーション
- **問題**: Agent がブラウザより遅く再接続すると、`needsSessionRestart` フラグが `clearAgentRestarted` の後にセットされ、`handleAiPrompt` が新セッションを送信者のみで作成 → 他ブラウザに AI レスポンスが届かない
- **修正**: `handleAiPrompt` の Agent 再起動パスで旧セッションの全参加者を新セッションにマイグレーション

#### 変更ファイル

| ファイル | 変更内容 |
|---------|---------|
| `packages/shared/src/types.ts` | `web:user_message` 型追加 |
| `apps/server/src/platforms/web.ts` | ユーザーメッセージブロードキャスト + projectId 付与 |
| `apps/server/src/services/session-manager.ts` | `getSessionParticipants()`, `getSessionIdByChatId()` 追加 |
| `apps/server/src/services/command-handler.ts` | Agent 再起動時の参加者マイグレーション |
| `apps/web/src/hooks/useWebSocket.ts` | `web:user_message` ハンドラ追加 |

### Phase 1: 基本機能 (2026-01-17)

#### 1. Discord Bot 連携
- Discord からのメッセージ受信・送信
- DM およびメンション対応
- コマンドパーサー（`m`, `p`, `q`, `h` など）

#### 2. Linux Agent
- WebSocket でサーバーに接続
- Claude Code の `-p` モードで非対話実行
- `--dangerously-skip-permissions` で権限プロンプトをスキップ

#### 3. セッション管理
- マシン・プロジェクト選択
- セッション開始・終了
- 会話履歴の管理（DevRelay 側で管理、プロンプトに含める）

#### 4. 双方向ファイル転送

##### Claude Code → Discord
- `.devrelay-output/` ディレクトリを監視
- プロンプトに自動で指示を追加：「ユーザーに渡すファイルは `.devrelay-output/` に保存してください」
- 実行完了後にディレクトリからファイルを収集し、Discord に添付

##### Discord → Claude Code
- Discord の添付ファイルをダウンロード
- `.devrelay-files/` ディレクトリに保存
- プロンプトにファイルパスを含めて Claude Code に渡す

#### 5. プロジェクト自動検出
- `CLAUDE.md` ファイルの存在でプロジェクトを自動検出
- 複数ディレクトリのスキャン対応（`projectsDirs` 配列）
- 最大5階層まで再帰検索

#### 6. リアルタイム進捗表示
- `--output-format stream-json --include-partial-messages --verbose` オプション使用
- Claude Code の出力をリアルタイムでパース
- Discord メッセージを8秒ごとに編集して進捗表示
- ツール使用時は「🔧 Readを使用中...」のように表示

#### 7. セキュアなプロセス管理
- プロンプトを stdin 経由で渡す（`ps aux` に表示されない）
- `devrelay-claude` シンボリックリンクでプロセス識別
- 環境変数による識別:
  - `DEVRELAY=1`
  - `DEVRELAY_SESSION_ID=xxx`
  - `DEVRELAY_PROJECT=/path/to/project`

### Phase 1.1: 追加機能 (2026-01-18)

#### 8. クイックコマンド追加
- `c` - 前回の接続先に再接続（Continue）
  - `lastProjectId` を DB（ChannelSession テーブル）に**チャンネルごとに保存**
  - オフラインのマシンには接続不可のエラー表示
- `x` - 会話履歴をクリア（Clear）
  - Agent に `server:conversation:clear` メッセージを送信
  - ファイルとメモリ両方をクリア

#### 9. 会話履歴の永続化
- メモリ管理から**ファイル保存**に変更
- 保存先: `プロジェクト/.devrelay/conversation.json`
- 保存内容:
  ```json
  {
    "projectPath": "/path/to/project",
    "lastUpdated": "2026-01-18T...",
    "history": [
      { "role": "user", "content": "...", "timestamp": "..." },
      { "role": "assistant", "content": "...", "timestamp": "..." }
    ]
  }
  ```
- 保存は無制限、Claude に送るのは直近20件のみ（トークン節約）
- Agent 起動時に自動ロード

#### 10. 進捗表示の改善
- プロンプト送信時に進捗メッセージを先に送信
- 8秒ごとにメッセージを編集して経過時間と出力を表示
- 完了時に進捗メッセージを最終結果で置き換え

#### 11. プロジェクト名変更 (DevBridge → DevRelay)
- 既存企業「Devbridge」（Cognizant傘下）との混同を避けるためリネーム
- 変更内容:
  - パッケージ名: `@devbridge/*` → `@devrelay/*`
  - 設定ディレクトリ: `~/.devbridge/` → `~/.devrelay/`
  - 環境変数: `DEVBRIDGE_*` → `DEVRELAY_*`
  - CLI コマンド: `devbridge` → `devrelay`
  - シンボリックリンク: `devbridge-claude` → `devrelay-claude`
  - 出力ディレクトリ: `.devbridge-output/` → `.devrelay-output/`
  - ファイルディレクトリ: `.devbridge-files/` → `.devrelay-files/`
- GitHub リポジトリも `devrelay` にリネーム済み

#### 12. チャンネルごとのセッション分離
- Discord のチャンネルごとに独立したセッションを持てるように変更
- 変更前: `${platform}:${userId}` でセッション管理（ユーザーごと）
- 変更後: `${platform}:${chatId}` でセッション管理（チャンネルごと）
- 使用例:
  - チャンネルA で `p` → AnimeChaosMap に接続
  - チャンネルB で `p` → devrelay に接続
  - 同時並行で作業可能
- `lastProjectId`（`c` コマンド用）も**チャンネルごとに DB 保存**
  - DB テーブル: `ChannelSession`（`platform` + `chatId` で一意）
  - Discord、Telegram、LINE 全て対応

#### 13. Systemd サービス化サポート

##### Agent 側
- `devrelay setup` 実行時にサービスインストールの選択肢を表示
- **ユーザーサービス（推奨）**: `~/.config/systemd/user/devrelay-agent.service`
  - sudo 不要
  - `systemctl --user start/stop/status devrelay-agent`
  - `loginctl enable-linger` で自動起動対応
- **システムサービス**: `/etc/systemd/system/devrelay-agent.service`
  - sudo 必要
  - `sudo systemctl start/stop/status devrelay-agent`
- セットアップ完了後に適切なコマンドを案内

##### Server 側
- `apps/server/scripts/setup-service.sh` でサービス化
- 実行方法: `cd apps/server && pnpm setup:service`
- ユーザーサービスとして `~/.config/systemd/user/devrelay-server.service` を作成

## アーキテクチャ

### ディレクトリ構造
```
devrelay/
├── apps/
│   ├── server/          # Center Server (Fastify + WebSocket)
│   └── web/             # WebUI (Vite + React)
├── agents/
│   ├── linux/           # Linux Agent
│   └── windows/         # Windows Agent (Electron タスクトレイアプリ)
├── packages/
│   └── shared/          # 共通型定義
└── CLAUDE.md
```

### 主要ファイル

#### Server
- `apps/server/src/platforms/discord.ts` - Discord Bot
- `apps/server/src/platforms/telegram.ts` - Telegram Bot
- `apps/server/src/services/agent-manager.ts` - Agent 通信管理
- `apps/server/src/services/session-manager.ts` - セッション管理
- `apps/server/src/services/command-handler.ts` - コマンド処理

#### Agent (Linux)
- `agents/linux/src/services/connection.ts` - サーバー接続・メッセージ処理
- `agents/linux/src/services/ai-runner.ts` - Claude Code 実行
- `agents/linux/src/services/output-collector.ts` - 出力ファイル収集
- `agents/linux/src/services/file-handler.ts` - 受信ファイル保存
- `agents/linux/src/services/conversation-store.ts` - 会話履歴の永続化

#### Agent (Windows)
- `agents/windows/src/electron/main.ts` - Electron メインプロセス、タスクトレイ、IPC
- `agents/windows/src/services/connection.ts` - サーバー接続（Linux版と同等）
- `agents/windows/src/services/config.ts` - 設定管理（%APPDATA%\devrelay\）
- `agents/windows/assets/settings.html` - 設定画面 UI
- `agents/windows/assets/preload.js` - IPC ブリッジ（CommonJS）

#### Shared
- `packages/shared/src/types.ts` - 共通型定義（FileAttachment など）

## 設定ファイル

### Agent 設定
- Linux: `~/.devrelay/config.yaml`
- Windows: `%APPDATA%\devrelay\config.yaml`

```yaml
machineName: ubuntu-dev
machineId: ""
serverUrl: wss://devrelay.io/ws/agent
token: machine_xxxxx
projectsDirs:      # 複数ディレクトリ対応
  - /home/user         # Linux
  - C:\Users\username  # Windows
aiTools:
  default: claude
  claude:
    command: claude
logLevel: debug

# プロキシ設定（オプション）
proxy:
  url: http://proxy.example.com:8080      # または socks5://proxy:1080
  # 認証が必要な場合（オプション）
  username: user
  password: pass
```

### プロキシ設定
Agent がプロキシ経由でサーバーに接続する場合は、`~/.devrelay/config.yaml`（Linux）または `%APPDATA%\devrelay\config.yaml`（Windows）に `proxy` セクションを追加します。

**サポートするプロキシタイプ**:
- HTTP/HTTPS: `http://proxy:8080`, `https://proxy:8080`
- SOCKS5: `socks5://proxy:1080`
- SOCKS4: `socks4://proxy:1080`

**認証付きプロキシ**:
```yaml
proxy:
  url: http://proxy.example.com:8080
  username: myuser
  password: mypassword
```

または URL に直接埋め込む形式も対応:
```yaml
proxy:
  url: http://myuser:mypassword@proxy.example.com:8080
```

### プロジェクト設定 (`~/.devrelay/projects.yaml`)
```yaml
projects:
  - name: devrelay
    path: /home/user/devrelay
    defaultAi: claude
```

## 起動方法

### 開発時（手動起動）
```bash
# Server
cd apps/server && pnpm start

# Linux Agent
cd agents/linux && pnpm start

# Windows Agent (Electron)
cd agents/windows && pnpm build && npx electron .
```

### 本番（PM2 でサービス起動）

#### Linux
```bash
# Server
pm2 start /opt/devrelay/apps/server/dist/index.js --name devrelay-server

# Agent
pm2 start /opt/devrelay/agents/linux/dist/index.js --name devrelay-agent

# 管理コマンド
pm2 status
pm2 restart devrelay-server devrelay-agent
pm2 logs devrelay-server
pm2 logs devrelay-agent

# 自動起動設定（サーバー再起動後にも復活）
pm2 save
pm2 startup
```

#### Windows
```powershell
# 開発時
cd agents/windows && pnpm build && npx electron .

# 配布用インストーラー作成
cd agents/windows && pnpm dist

# 自動起動は設定画面の「Start automatically when Windows starts」で有効化
```

### Phase 1.2: 追加機能（続き）

#### 14. Agent の自動再接続改善
- エクスポネンシャルバックオフを実装
- 再接続間隔: 1秒 → 2秒 → 4秒 → 8秒 → ... → 最大60秒
- ジッター（0-1秒のランダム遅延）で接続の集中を回避
- 最大15回のリトライ後に停止（サービス再起動を促すメッセージ表示）
- 接続成功時にリトライカウンターをリセット

#### 15. Telegram Bot 対応
- `node-telegram-bot-api` ライブラリ使用
- ポーリングモード（Webhook 不要）
- 実装機能:
  - メッセージ受信・送信
  - ファイル添付（ドキュメント・写真）
  - タイピングインジケーター
  - 進捗メッセージの編集
  - 長いメッセージの自動分割（4096文字制限対応）
- 環境変数: `TELEGRAM_BOT_TOKEN`
- Bot 作成: @BotFather で `/newbot` コマンド

#### 16. 自然言語コマンド対応
- OpenAI API を使って自然言語をコマンドに変換
- ユーザーごとに OpenAI API キーを設定可能
- **DB スキーマ**: `UserSettings` テーブル（汎用 Key-Value 形式）
  ```sql
  UserSettings: id, userId, key, value, encrypted, createdAt, updatedAt
  -- key 例: openai_api_key, natural_language_enabled, theme, language
  ```
- **暗号化**: API キーなどの機密情報は AES-256-CBC で暗号化して保存
- **対応コマンド**:
  - 「バグ直して」→ `m バグ直して`
  - 「AnimeChaosMapに接続」→ `p` → プロジェクト選択
  - 「前回の続き」→ `c`
  - 「履歴クリア」→ `x`
- **フォールバック**: API キーがない場合は従来のコマンド形式のみ
- **主要ファイル**:
  - `apps/server/src/services/user-settings.ts` - 設定の保存・取得・暗号化
  - `apps/server/src/services/natural-language-parser.ts` - OpenAI API 連携
  - `apps/server/src/services/command-parser.ts` - NLP 統合

#### 17. プランモード / 実行モード
- **目的**: Claude がいきなりコードを書き換えるのを防ぎ、プラン立案→承認→実装のフローを強制
- **動作**:
  1. 通常は「プランモード」で、Claude はコード変更をせず調査・プラン立案のみ
  2. プラン完了時、Claude は「このプランでよければ `e` または `exec` を送信してください」と促す
  3. ユーザーが `e` または `exec` を送信すると「実行モード」に切り替わり、コード変更を開始
- **会話履歴の管理**:
  - `exec` 送信時に履歴にマーカーを記録
  - 以降の Claude への送信は、`exec` マーカー以降の直近20件のみ（プラン会話は送らない）
  - これによりトークン消費を抑えつつ、実装に必要なコンテキストを維持
- **コマンド**: `e` または `exec`
- **会話履歴フォーマット**:
  ```json
  {
    "history": [
      { "role": "user", "content": "...", "timestamp": "..." },
      { "role": "assistant", "content": "...", "timestamp": "..." },
      { "role": "exec", "content": "--- EXEC: Implementation Started ---", "timestamp": "..." },
      { "role": "user", "content": "...", "timestamp": "..." }
    ]
  }
  ```
- **主要ファイル**:
  - `packages/shared/src/types.ts` - `exec` コマンド型、`server:conversation:exec` メッセージ型
  - `packages/shared/src/constants.ts` - `e`, `exec` ショートカット
  - `apps/server/src/services/command-handler.ts` - `handleExec()` 関数
  - `apps/server/src/services/agent-manager.ts` - `execConversation()` 関数
  - `agents/linux/src/services/conversation-store.ts` - `markExecPoint()`, exec マーカー対応の `getConversationContext()`
  - `agents/linux/src/services/connection.ts` - `handleConversationExec()`, プランモード指示の追加
  - `agents/linux/src/services/output-collector.ts` - `PLAN_MODE_INSTRUCTION`, `EXEC_MODE_INSTRUCTION`

#### 18. Agent アンインストールコマンド
- `devrelay uninstall` でクリーンアンインストール
- **削除内容**:
  - Systemd サービス（ユーザー/システム両方）の停止・無効化・削除
  - `~/.devrelay/` 設定ディレクトリの削除
  - 各プロジェクトの `.devrelay/` ディレクトリの削除（オプション）
- **主要ファイル**:
  - `agents/linux/src/cli/commands/uninstall.ts`

#### 19. セットアップ簡素化
- `devrelay setup` は**トークンのみ**を入力
- 以下は自動設定（後から `~/.devrelay/config.yaml` で変更可能）:
  - マシン名: ホスト名を使用
  - サーバーURL: `ws://localhost:3000/ws/agent`
  - プロジェクトディレクトリ: ホームディレクトリ
- ESM 対応: `__dirname` → `import.meta.url` を使用するよう修正

#### 20. サーバー起動時マシン状態リセット
- サーバー起動時に全マシンの status を `offline` にリセット
- サーバーがクラッシュした場合などに、DB上でオンラインのまま残る問題を解決
- `apps/server/src/index.ts` の `main()` 関数冒頭で `prisma.machine.updateMany()` を実行

#### 21. デフォルト serverUrl 変更
- `ws://localhost:3000/ws/agent` → `wss://devrelay.io/ws/agent`
- 外部マシンからも Agent を接続可能に
- `agents/linux/src/services/config.ts` で設定

#### 22. Setup 後のサービス自動起動
- `devrelay setup` 完了時にサービスを自動的に `start`
- ユーザーサービス/システムサービス両方に対応
- `agents/linux/src/cli/commands/setup.ts` で実装

#### 23. WebUI ポーリングエラー改善
- ポーリング中のエラーは無視（次のポーリングで回復）
- 初回ロード時のみエラー表示
- Agent 切断時の「Unknown error」表示を解消
- `apps/web/src/pages/MachinesPage.tsx` で実装

#### 24. Agent 切断時のエラーハンドリング
- `handleAgentDisconnect` で DB 更新エラーをキャッチ
- マシンが DB に存在しない場合でもサーバーがクラッシュしない
- `apps/server/src/services/agent-manager.ts` で実装

#### 25. WebUI サービス化サポート
- `apps/web/scripts/setup-service.sh` でサービス化
- 実行方法: `cd apps/web && pnpm setup:service`
- ユーザーサービスとして `~/.config/systemd/user/devrelay-web.service` を作成
- Vite 開発サーバー（HMR 付き）を systemd で管理
- **注意**: 本番では Caddy + 静的ファイル配信を推奨

#### 26. プラットフォームアカウント連携
- Discord/Telegram ユーザーと WebUI ユーザーをリンク
- **問題**: Discord から接続するとユーザーが自動作成されるが、WebUI で登録したマシンにアクセスできない
- **解決方法**: リンクコード方式
  1. Discord/Telegram で `link` コマンド → 6桁のコードを生成
  2. WebUI Settings ページでコードを入力 → アカウントをリンク
  3. 既存の Discord ユーザーのデータを WebUI ユーザーにマージ
- **コード仕様**:
  - 6桁英数字（紛らわしい文字 0,O,I,1 を除外）
  - 有効期限: 5分
  - 使用後は自動削除
- **DB スキーマ**:
  - `PlatformLinkCode` テーブル追加（一時コード保存）
  - `PlatformLink` テーブルに `platformName`, `linkedAt` フィールド追加
- **主要ファイル**:
  - `apps/server/prisma/schema.prisma` - DB スキーマ
  - `apps/server/src/services/platform-link.ts` - リンクコード生成・検証・マージ
  - `apps/server/src/routes/api.ts` - `/api/platforms/*` エンドポイント
  - `apps/server/src/services/command-handler.ts` - `link` コマンド、linked user 検証
  - `apps/web/src/pages/SettingsPage.tsx` - Connected Platforms UI
  - `apps/web/src/lib/api.ts` - platforms API クライアント

#### 27. Windows Agent (2026-01-18)
- Linux Agent をベースに Windows 対応版を実装
- **Electron タスクトレイアプリ**として常駐
- 設定ディレクトリ: `%APPDATA%\devrelay\`
- サーバーURL: `wss://devrelay.io/ws/agent`（固定）
- **タスクトレイ機能**:
  - 接続状態をアイコン色で表示（緑=接続中、グレー=切断）
  - 右クリックメニュー: Connect/Disconnect, Settings, Open Config Folder, Quit
  - 左クリック: 設定画面を開く
- **設定画面（3タブ）**:
  - **Connection**: トークン入力、自動起動ON/OFF（マシン名・サーバーURLは読み取り専用）
  - **Directories**: プロジェクトスキャン対象ディレクトリの追加/削除
  - **Projects**: 検出されたプロジェクト一覧、手動スキャン
- **自動起動**: `app.setLoginItemSettings()` でWindowsログイン項目に登録
  - 開発環境では `args` パラメータでアプリパスを渡す（`electron.exe` 単体起動を回避）
  - `getLoginItemSettings()` も同じ `args` を指定しないと状態を取得できない
  - `getLoginItemOptions()` ヘルパー関数で設定・取得時のオプションを統一
- **主要ファイル**:
  - `agents/windows/src/electron/main.ts` - Electron メインプロセス
  - `agents/windows/assets/settings.html` - 設定画面 UI
  - `agents/windows/assets/preload.js` - IPC ブリッジ（CommonJS必須）
- 詳細は `agents/windows/DEVELOPMENT.md` 参照

```powershell
# 開発時
cd agents/windows && pnpm build && npx electron .

# 配布用ビルド
cd agents/windows && pnpm dist  # release/ にインストーラー生成
```

#### 28. AI プロンプト送信時の自動再接続
- **問題**: サーバー再起動後、セッションが切断され、AI プロンプト送信時に「接続されていません」エラー
- **解決**: 未接続状態で AI プロンプトを送信した際、`lastProjectId` があれば自動的に再接続
- **動作フロー**:
  1. ユーザーが AI プロンプト（例: 「バグ直して」）を送信
  2. 未接続を検出 → `lastProjectId` を DB から取得
  3. `handleContinue()` を内部実行して再接続
  4. 成功時: 再接続メッセージを**先に送信**してから AI 処理を開始
  5. 失敗時（オフライン等）: エラーメッセージを返す
- **メッセージ順序**:
  ```
  1. 🔄 前回の接続先（ubuntu-dev / devrelay）に再接続しました
  2. 🤖 AI Status: running
  3. [Claude Code の応答...]
  ```
- **主要ファイル**:
  - `apps/server/src/services/command-handler.ts` - `handleAiPrompt()` に自動再接続ロジック追加

#### 29. Proxy 対応 (2026-01-19)
- Agent がプロキシ経由でサーバーに接続可能に
- **サポートするプロキシタイプ**:
  - HTTP/HTTPS プロキシ: `https-proxy-agent` ライブラリ使用
  - SOCKS4/SOCKS5 プロキシ: `socks-proxy-agent` ライブラリ使用
- **設定方法**: `~/.devrelay/config.yaml` に `proxy` セクションを追加
- **認証対応**: `username`/`password` フィールドまたは URL 埋め込み形式
- **主要ファイル**:
  - `packages/shared/src/types.ts` - `ProxyConfig` 型定義
  - `agents/linux/src/services/config.ts` - プロキシ設定読み込み
  - `agents/linux/src/services/connection.ts` - `createProxyAgent()` 関数、プロキシ経由接続
  - `agents/windows/src/services/config.ts` - プロキシ設定読み込み
  - `agents/windows/src/services/connection.ts` - `createProxyAgent()` 関数、プロキシ経由接続

#### 30. DevRelay Agreement 機能 (2026-01-19)
- プロジェクト接続時に CLAUDE.md の DevRelay Agreement 対応状況を表示
- **目的**: プランモード / ファイル出力指示が CLAUDE.md に含まれているか確認
- **動作**:
  1. プロジェクト接続時に CLAUDE.md をチェック
  2. `<!-- DevRelay Agreement v1 -->` マーカーの有無を確認
  3. 接続メッセージに対応状況を表示:
     - 対応済み: `✅ DevRelay Agreement 対応済み`
     - 未対応: `⚠️ DevRelay Agreement 未対応 - \`a\` または \`agreement\` で対応できます`
- **コマンド**: `a` または `agreement` で CLAUDE.md に Agreement を追加
  - Claude Code が自動的に CLAUDE.md を確認・更新
- **Agreement 内容**:
  - `.devrelay-output/` ディレクトリへのファイル出力指示
  - プランモード / 実行モードの切り替え指示
- **主要ファイル**:
  - `packages/shared/src/types.ts` - `AgreementApplyPayload` 型、`agreement` コマンド追加
  - `packages/shared/src/constants.ts` - `a`, `agreement` ショートカット
  - `agents/*/src/services/output-collector.ts` - `DEVRELAY_AGREEMENT_MARKER`, `AGREEMENT_APPLY_PROMPT`
  - `agents/*/src/services/connection.ts` - `checkAgreementStatus()`, `handleAgreementApply()`
  - `apps/server/src/services/command-handler.ts` - `handleAgreement()`
  - `apps/server/src/services/agent-manager.ts` - `applyAgreement()`

#### 31. Windows Agent 改善 (2026-01-19)
- **自動起動パスのクォート対応**
  - スペースを含むパス（例: `D:\My Programs\...`）でも自動起動が動作するように修正
  - `getLoginItemOptions()` でパスをダブルクォートで囲む
- **ディレクトリ追加時の自動スキャン**
  - Directories タブでディレクトリ追加後、即座にプロジェクトスキャンを実行
  - 手動で「Scan」ボタンを押す必要がなくなった
- **リアルタイム進捗表示の修正**
  - Windows での stdout バッファリング問題を解決
  - `spawn` の `shell: true` オプションでリアルタイム出力を実現
  - これにより Discord/Telegram でリアルタイムに進捗が表示されるように
- **主要ファイル**:
  - `agents/windows/src/electron/main.ts` - `getLoginItemOptions()` パスクォート、`add-projects-dir` 自動スキャン
  - `agents/windows/src/services/ai-runner.ts` - `shell: true` 追加

#### 32. Windows Agent スリープ防止機能 (2026-01-19, 修正 2026-01-20)
- **問題**: Windows の Modern Standby (S0 Low Power Idle) により、画面オフ後にシステムがスリープ状態に入り、WebSocket 接続が切断される
- **解決**: Windows API `PowerCreateRequest` / `PowerSetRequest` を使用してスリープを防止
  - 注: `SetThreadExecutionState` は Modern Standby には効果がないため、`PowerSetRequest` API を採用
- **動作**:
  - 接続時に `PowerSetRequest(PowerRequestSystemRequired)` でスリープを防止
  - 切断時に `PowerClearRequest` + `CloseHandle` で電源要求を解除
  - **画面オフは許可**（システムスリープのみ防止）
  - `powercfg /requests` コマンドの SYSTEM セクションに「DevRelay Agent: Maintaining server connection」と表示される
- **設定方法**:
  - 設定画面 > Connection タブ > 「Prevent sleep while connected」チェックボックス
  - または `%APPDATA%\devrelay\config.yaml` に `preventSleep: true` を追加
- **実装**:
  - `koffi` パッケージで Windows API (kernel32.dll) を呼び出し
  - ネイティブモジュール不要（pure JavaScript FFI）
  - `POWER_REQUEST_TYPE` 定数: `PowerRequestDisplayRequired=0`, `PowerRequestSystemRequired=1`
- **主要ファイル**:
  - `agents/windows/src/services/sleep-preventer.ts` - `enableSleepPrevention()`, `disableSleepPrevention()`
  - `agents/windows/src/services/config.ts` - `preventSleep` 設定
  - `agents/windows/src/services/connection.ts` - 接続/切断時のスリープ防止制御
  - `agents/windows/assets/settings.html` - 設定画面 UI

#### 33. セッション情報表示コマンド (2026-01-21)
- `se` または `session` コマンドで現在のセッション情報を表示
- **表示内容**:
  - マシン名、プロジェクト名、AI ツール
  - セッションステータス（アクティブ/アイドル）
  - 会話履歴の件数
  - セッション継続時間
  - 最終メッセージからの経過時間
- **未接続時**:
  - 前回の接続先情報（`lastProjectId` がある場合）
  - `c` コマンドで再接続可能であることを案内
- **主要ファイル**:
  - `packages/shared/src/types.ts` - `UserCommand` 型に `{ type: 'session' }` を追加
  - `packages/shared/src/constants.ts` - `SHORTCUTS` に `se`, `session` を追加
  - `apps/server/src/services/command-parser.ts` - `parseShortcut()` と `getHelpText()` を更新
  - `apps/server/src/services/command-handler.ts` - `handleSession()` 関数を実装

#### 34. Heartbeat 機能（Agent 生存確認）(2026-01-21)
- **問題**: Agent がクラッシュ/切断しても DB 上は `online` のまま残り続ける
- **解決**: アプリケーションレベルの ping/pong と定期監視で正確なオンライン状態を維持
- **動作**:
  1. Agent は 30 秒ごとに `agent:ping` メッセージを送信
  2. Server は `server:pong` を返信し、`lastSeenAt` を更新
  3. Server は 60 秒ごとに全マシンをチェック
  4. `lastSeenAt` が 60 秒以上前の Agent を自動的に `offline` に更新
- **追加機能**:
  - Agent 側でも pong タイムアウト検出（45秒以上 pong がなければ再接続）
  - 接続時に即座に ping を送信（初回 lastSeenAt 更新）
- **machineId 修正** (2026-01-21):
  - Agent の設定ファイル (`config.yaml`) の `machineId` と DB 上の `machineId` が不一致の場合があった
  - サーバーが `server:connect:ack` で正しい `machineId` を返すように修正
  - Agent は受け取った `machineId` を使って ping を送信
  - `ServerConnectAckPayload` に `machineId?: string` フィールドを追加
- **主要ファイル**:
  - `packages/shared/src/types.ts` - `AgentPingPayload`, `ServerPongPayload`, `ServerConnectAckPayload` 型
  - `agents/linux/src/services/connection.ts` - `startAppPing()`, `stopAppPing()` 関数、`currentMachineId` 管理
  - `agents/windows/src/services/connection.ts` - 同上
  - `apps/server/src/services/agent-manager.ts` - `handleAgentPing()`, `startHeartbeatMonitor()`, `stopHeartbeatMonitor()`, 認証時に `machineId` を返す
  - `apps/server/src/index.ts` - サーバー起動時に heartbeat monitor を開始

#### 35. WebUI サービス再起動機能 (2026-01-22)
- WebUI 設定ページに「Service Management」セクションを追加
- **機能**:
  - サーバーと Agent の再起動ボタン
  - サービスステータス表示（active/inactive）
  - 確認ダイアログ付き（サーバー再起動後は自動リロード）
- **API エンドポイント**:
  - `GET /api/services/status` - サービスステータス取得
  - `POST /api/services/restart/server` - サーバー再起動
  - `POST /api/services/restart/agent` - Agent 再起動
- **実装**: `pm2 restart` コマンドを使用
- **主要ファイル**:
  - `apps/server/src/routes/api.ts` - サービス管理 API エンドポイント
  - `apps/web/src/lib/api.ts` - services API クライアント
  - `apps/web/src/pages/SettingsPage.tsx` - Service Management UI

#### 36. WebUI モバイル対応 (2026-01-22)
- スマートフォンでも操作しやすいレスポンシブデザインに改善
- **Layout.tsx**:
  - ハンバーガーメニューを追加（モバイル時）
  - デスクトップ: 横並びナビゲーション
  - モバイル: ドロップダウンメニュー
- **SettingsPage.tsx**:
  - フォームを縦並び/横並びで切り替え
  - ボタン幅を自動調整
- **ProjectsPage.tsx**:
  - テーブル表示（デスクトップ）とカード表示（モバイル）を切り替え
- **DashboardPage.tsx / MachinesPage.tsx**:
  - グリッドレイアウトをモバイル対応に調整
- **主要ファイル**:
  - `apps/web/src/components/Layout.tsx` - ハンバーガーメニュー実装
  - `apps/web/src/pages/*.tsx` - 各ページのレスポンシブ対応

#### 37. セッション表示改善 (2026-01-22)
- `s` / `session` コマンドの表示をシンプルな1行形式に変更
- **改善点**:
  - 冗長な情報を削除し、1行で表示
  - DB のセッションではなく、メモリ内のアクティブセッション（`getActiveSessions()`）を使用
  - 同じマシン+プロジェクトの重複を排除
  - オンラインだがセッションなしのマシンは `(idle)` と表示
- **表示例**:
  ```
  📍 ubuntu-dev / devrelay (5分30秒)
  • windows-hp-dev / devrelay (3分15秒)
  ```
- **主要ファイル**:
  - `apps/server/src/services/command-handler.ts` - `handleSession()` 関数を改善

#### 38. セッション管理改善 - Claude Code --resume 対応 (2026-01-22)
- Claude Code の `--resume` オプションを使用してセッション継続
- `--permission-mode plan` でプランモード、`--dangerously-skip-permissions` で実行モードを切り替え
- **機能**:
  - プロジェクトごとに Claude Code のセッション ID を保存（`.devrelay/claude-session-id`）
  - 2回目以降のプロンプトで `--resume <session_id>` を使用してコンテキスト継続
  - `x` コマンドでセッション ID もクリア（新規セッション開始）
- **主要ファイル**:
  - `agents/*/src/services/session-store.ts` - セッション ID の保存/読み込み
  - `agents/*/src/services/ai-runner.ts` - `--resume`, `--permission-mode` 対応
  - `agents/*/src/services/connection.ts` - モード切り替え対応

#### 39. コンテキスト使用量表示 (2026-01-22)
- プロンプト送信時に前回のコンテキスト使用量を Discord/Telegram の先頭に表示
- **動作**:
  1. Claude Code の `result` メッセージから `modelUsage` の `inputTokens` + `cacheReadInputTokens` を取得
  2. `contextWindow`（200K）との比率を計算
  3. `.devrelay/context-usage.json` に保存
  4. 次回プロンプト送信時に先頭に表示
- **表示例**:
  ```
  📊 Context: 131K / 200K tokens (66%)

  [Claude の応答...]
  ```
- **警告**:
  - 70% 超で警告メッセージを表示
  - `x` コマンドで履歴をクリアすることを推奨
- **主要ファイル**:
  - `agents/*/src/services/output-parser.ts` - usage 情報抽出、コンテキスト表示フォーマット
  - `agents/*/src/services/session-store.ts` - `loadContextUsage()`, `saveContextUsage()` 追加
  - `agents/*/src/services/connection.ts` - プロンプト送信時に前回のコンテキストを先に送信
  - `apps/server/src/services/session-manager.ts` - `contextInfo` を最終メッセージの先頭に追加

#### 40. プランモード/実行モードの改善 (2026-01-22)
- **問題1**: 一度 `exec` を送信すると、以降のすべてのプロンプトが実行モードで実行され続ける
- **問題2**: `exec` 送信後、ユーザーが手動でプロンプトを送信しないと実装が開始されない
- **解決策1**: exec マーカーの**直後のプロンプトのみ**実行モードで実行。その後はプランモードに戻る
- **解決策2**: `exec` 送信時に自動的に「プランに従って実装を開始してください。」で AI を実行
- **動作フロー**:
  1. ユーザー: プロンプト送信 → プランモード（`--permission-mode plan`）
  2. Claude: プラン作成
  3. ユーザー: `e` / `exec` 送信
  4. → 自動的に実行モード（`--dangerously-skip-permissions`）で実装開始
  5. Claude: 実装完了
  6. ユーザー: 次のプロンプト → プランモードに戻る
- **主要ファイル**:
  - `agents/*/src/services/connection.ts` - `handleConversationExec()` で自動実行、`handleAiPrompt()` でモード判定修正

#### 41. サーバー再起動後のセッション復元 (2026-01-22)
- **問題**: サーバー再起動後、`q` で切断してから `c` で再接続しないと会話ができない
- **原因**: `sessionParticipants` マップがメモリ内のみで管理されていた
- **解決策**:
  1. `ChannelSession` テーブルに `currentSessionId` と `currentMachineId` フィールドを追加
  2. セッション開始時にこれらを DB に保存
  3. サーバー起動時に `restoreSessionParticipants()` で復元
  4. `getUserContext()` で `currentSessionId` と `currentMachineId` を復元
- **動作**: サーバー再起動後も `q` なしで会話継続可能
- **主要ファイル**:
  - `apps/server/prisma/schema.prisma` - `ChannelSession` スキーマ変更
  - `apps/server/src/services/session-manager.ts` - `restoreSessionParticipants()` 追加
  - `apps/server/src/services/command-handler.ts` - `getUserContext()`, `updateUserContext()` 修正
  - `apps/server/src/index.ts` - サーバー起動時に復元処理を呼び出し

#### 42. メンション前会話の復元修正 (2026-01-22)
- **問題**: `--resume` 使用時にメンション前の会話（missedMessages）がコンテキストとして拾われない
- **原因**: `claudeResumeSessionId` がある場合、会話履歴をプロンプトに含めないようにしていた
- **解決策**: `missedMessages` がある場合は、`--resume` 使用時でも履歴を含めるように修正
- **主要ファイル**:
  - `agents/*/src/services/connection.ts` - `handleAiPrompt()` の履歴包含条件を修正

#### 43. Windows Agent 機能追加 - Linux Agent との機能パリティ (2026-01-23)
- **目的**: Linux Agent で実装済みの機能を Windows Agent にも追加
- **追加機能**:
  1. **Missed Messages 対応** - Discord でメンション前のメッセージをコンテキストとして拾える
     - `handleAiPrompt` で `missedMessages` パラメータを処理し、履歴に追加
  2. **Storage Context 対応** - 永続的なプロンプトコンテキスト管理
     - `loadStorageContext()` - ストレージコンテキストの読み込み
     - `saveStorageContext()` - ストレージコンテキストの保存
     - `clearStorageContext()` - ストレージコンテキストのクリア
     - `handleStorageSave()` - サーバーからの保存リクエスト処理
     - `handleStorageClear()` - サーバーからのクリアリクエスト処理
- **主要ファイル**:
  - `agents/windows/src/services/connection.ts` - 全機能の実装

#### 44. 会話履歴エクスポート機能 (2026-01-24)
- WebUI から会話履歴を日別に ZIP でダウンロード可能に
- **機能**:
  - Projects ページでプロジェクト名クリック → 日付一覧モーダル表示
  - 日付クリック → その日の会話履歴を ZIP でダウンロード
- **ZIP 内容**:
  - `conversation.md` - 会話履歴（Markdown形式）
  - `images/` - その日に添付された画像
- **ファイル名フォーマット**:
  - 添付ファイルに日時プレフィックスを追加: `YYYYMMDD_HHmmss_filename.png`
  - これにより日付でファイルを特定可能
- **API エンドポイント**:
  - `GET /api/projects/:projectId/history/dates` - 日付一覧取得
  - `GET /api/projects/:projectId/history/:date/download` - ZIP ダウンロード
- **主要ファイル**:
  - `apps/server/src/routes/api.ts` - History Export API エンドポイント
  - `apps/server/src/services/agent-manager.ts` - Agent へのリクエスト送信
  - `agents/linux/src/services/connection.ts` - handleHistoryDates, handleHistoryExport
  - `agents/linux/src/services/file-handler.ts` - 日時プレフィックス付きファイル保存
  - `agents/windows/src/services/connection.ts` - 同上（Windows版）
  - `agents/windows/src/services/file-handler.ts` - 同上（Windows版）
  - `apps/web/src/pages/ProjectsPage.tsx` - History Export モーダル UI
  - `packages/shared/src/types.ts` - HistoryDatesRequestPayload, HistoryExportPayload 型

#### 45. エラーハンドリング改善とログ強化 (2026-02-05)
- **"Prompt is too long" エラー検知と通知**
  - Claude Code の stderr から "Prompt is too long" エラーを検知
  - ユーザーに「⚠️ プロンプトが長すぎます。`x` コマンドで会話履歴をクリアしてください。」と通知
  - **主要ファイル**: `agents/*/src/services/ai-runner.ts`
- **プロンプトサイズ詳細ログ出力**
  - プロンプト送信時に各コンポーネントのサイズをログ出力
    - Mode instruction, User prompt, Work state, Storage context, Output instruction, History context
    - 合計サイズと推定トークン数（`📦 TOTAL: xxx chars (~xxx tokens)`）
  - **主要ファイル**: `agents/*/src/services/connection.ts`
- **devrelay-claude シンボリックリンク自動作成**
  - `devrelay setup` 実行時に `~/.devrelay/bin/devrelay-claude` シンボリックリンクを自動作成
  - `which claude` で実際の claude パスを取得してリンク
  - **主要ファイル**: `agents/linux/src/cli/commands/setup.ts`
- **ExitPlanMode ツール使用禁止の警告**
  - PLAN_MODE_INSTRUCTION に警告を追加
  - Claude が `ExitPlanMode` ツールを使ってプランモードを解除することを防止
  - 「`ExitPlanMode` ツールは使用しないでください。DevRelay のプランモード解除はユーザーが `e` / `exec` を送信することで行います。」
  - **主要ファイル**: `agents/*/src/services/output-collector.ts`
- **Windows Agent 日本語統一**
  - PLAN_MODE_INSTRUCTION, EXEC_MODE_INSTRUCTION を英語から日本語に変更
  - Linux Agent と同じ指示内容に統一
  - **主要ファイル**: `agents/windows/src/services/output-collector.ts`
- **Windows Agent ファイルログ出力**
  - `electron-log` パッケージを使用
  - ログ出力先: `%APPDATA%\devrelay\logs\agent.log`
  - 1MB でローテーション（古いログは自動削除）
  - `config.yaml` の `logLevel` 設定に対応
  - **主要ファイル**:
    - `agents/windows/src/services/logger.ts` (新規)
    - `agents/windows/src/electron/main.ts`
    - `agents/windows/src/services/connection.ts`
    - `agents/windows/src/services/ai-runner.ts`
    - `agents/windows/package.json` (`electron-log` 依存追加)

#### 46. 会話履歴件数表示 (2026-02-05)
- プロンプト送信時に会話履歴件数を Discord/Telegram の先頭に表示
- **表示例**: `📝 History: 47 messages`
- **実装**: `contextInfo` として検出され、最終メッセージの先頭に追加
- **主要ファイル**:
  - `agents/linux/src/services/connection.ts` - 履歴件数表示ロジック追加
  - `agents/windows/src/services/connection.ts` - 同上

#### 47. 会話履歴アーカイブ機能 (2026-02-06)
- `x` コマンドで履歴クリア時、削除せずにアーカイブ保存
- **目的**: 過去の会話を後から振り返れるようにする
- **保存先**: `.devrelay/conversation-archive/conversation_YYYYMMDD_HHmmss.json`
- **保存形式**:
  ```json
  {
    "archivedAt": "2026-02-06T11:45:30.123Z",
    "messageCount": 127,
    "firstMessageAt": "2026-01-30T01:18:12.842Z",
    "lastMessageAt": "2026-02-06T02:50:58.479Z",
    "projectPath": "/home/user/devrelay",
    "history": [...]
  }
  ```
- **動作**: 履歴が1件以上ある場合のみアーカイブ。空の場合はスキップ
- **主要ファイル**:
  - `agents/linux/src/services/conversation-store.ts` - `archiveConversation()` 関数追加
  - `agents/linux/src/services/connection.ts` - `handleConversationClear()` でアーカイブ呼び出し
  - `agents/windows/src/services/conversation-store.ts` - 同上
  - `agents/windows/src/services/connection.ts` - 同上

#### 48. Agent再接続時のセッション復元 (2026-02-12)
- **問題**: Agentのみ再起動するとDiscordからのメッセージに応答しなくなる
- **原因**: Agent切断時に `clearSessionsForMachine()` で `sessionParticipants` が削除されるが、Agent再接続時に復元されない
- **解決策**: `handleAgentConnect()` 内で `restoreSessionParticipantsForMachine()` を呼び出し、ChannelSessionからセッションを復元
- **動作フロー**:
  1. Agent切断 → `sessionParticipants` 削除、Session status を `ended` に
  2. Agent再接続 → `restoreSessionParticipantsForMachine()` で ChannelSession から復元
  3. `ended` のセッションを `active` に戻す
  4. ユーザーは `q` → `c` なしでそのまま会話継続可能
- **主要ファイル**:
  - `apps/server/src/services/session-manager.ts` - `restoreSessionParticipantsForMachine()` 追加
  - `apps/server/src/services/agent-manager.ts` - `handleAgentConnect()` にセッション復元呼び出し追加

#### 49. x コマンドの2回連続確認 (2026-02-13)
- **問題**: `e`（exec）と `x`（クリア）を押し間違えると、会話履歴が即座にクリアされる
- **解決策**: `x` コマンドを2回連続で送信しないとクリアされない確認機能を追加
- **動作**:
  1. 1回目の `x`: `⚠️ 会話履歴をクリアしますか？ もう一度 x を送信してください。` と表示
  2. 2回目の `x`: 実際にクリア処理を実行（アーカイブ → クリア）
  3. `x` 以外のコマンドを送信すると、確認状態がリセットされる
- **実装**: `pendingClear` Set（chatKey ベース）で確認状態を管理
- **主要ファイル**:
  - `apps/server/src/services/command-handler.ts` - `pendingClear` Set、`handleClear()` の確認ロジック

#### 50. exec コマンドにカスタムプロンプト対応 (2026-02-13)
- **目的**: `exec, コミットしてプッシュして` のように、exec と同時に指示を渡せるようにする
- **問題**: プラン→exec→次のプロンプト、の3ステップが煩雑。特にコミット・プッシュのような単純な操作では非効率
- **解決策**: `e,` / `exec,` の後にカンマ＋テキストがあれば、そのテキストをカスタムプロンプトとして実行モードで直接実行
- **動作**:
  - `exec` → 従来通り「プランに従って実装を開始してください。」で自動実行
  - `exec, コミットしてプッシュして` → 実行モードで「コミットしてプッシュして」を直接実行
  - `e, テスト実行して` → 実行モードで「テスト実行して」を直接実行
- **実装フロー**:
  1. コマンドパーサーが `e,`/`exec,` パターンを検出 → `{ type: 'exec', prompt: '...' }` を返す
  2. `handleExec()` が `customPrompt` を `execConversation()` に渡す
  3. `ConversationExecPayload` に `prompt` フィールドを追加して Agent に送信
  4. Agent の `handleConversationExec()` でカスタムプロンプトがあればそれを使用
- **主要ファイル**:
  - `packages/shared/src/types.ts` - `ConversationExecPayload` と `UserCommand` に `prompt?` 追加
  - `apps/server/src/services/natural-language-parser.ts` - `isTraditionalCommand()` に `e,`/`exec,` パターン追加
  - `apps/server/src/services/command-parser.ts` - `parseCommand()` に `e,`/`exec,` パース処理追加
  - `apps/server/src/services/command-handler.ts` - `handleExec()` に `customPrompt` パラメータ追加
  - `apps/server/src/services/agent-manager.ts` - `execConversation()` に `prompt` パラメータ追加
  - `agents/linux/src/services/connection.ts` - `handleConversationExec()` でカスタムプロンプト対応
  - `agents/windows/src/services/connection.ts` - 同上

#### 51. Machines ページ テーブル形式化 + 名前順ソート (2026-02-13)
- **問題1**: カードグリッド形式で一覧性が悪い
- **問題2**: 5秒ポーリングのたびにAPIレスポンスの順序が変わり、マシンの並びがシャッフルされる
- **解決策**:
  1. デスクトップ: テーブル（明細一覧）形式に変更（Name, Status, Projects, Last Seen, 削除ボタン）
  2. モバイル: カード形式を維持（レスポンシブ対応）
  3. 名前順（`localeCompare` 昇順）でソート → ポーリングしても順番が安定
- **主要ファイル**:
  - `apps/web/src/pages/MachinesPage.tsx` - テーブル形式化、名前順ソート追加

#### 52. ヘルプテキスト更新 (2026-02-13)
- `h` コマンドのヘルプテキストを最新機能に合わせて更新
- **変更内容**:
  - `e` / `exec` の説明を改善、`e, <指示>` でプランスキップ＆直接実行の説明を追加
  - `x` コマンドに「2回連続で実行」の注記を追加
- **主要ファイル**:
  - `apps/server/src/services/command-parser.ts` - `getHelpText()` 関数を更新

#### 53. 出力ファイル履歴保存機能 (2026-02-15)
- `.devrelay-output/` のクリア前に、既存ファイルを `.devrelay-output-history/` にコピーして保存
- **目的**: 出力ファイルがプロンプト実行ごとにクリアされて消えてしまう問題を解決
- **動作**:
  1. 新しいプロンプト実行前に `clearOutputDir()` が呼ばれる
  2. `.devrelay-output/` 内にファイルがあれば `.devrelay-output-history/` にコピー
  3. ファイル名に日時プレフィックスを付与: `YYYYMMDD_HHmmss_filename`
  4. その後 `.devrelay-output/` を削除→再作成
- **例**:
  - `.devrelay-output/plan.md` → `.devrelay-output-history/20260215_120000_plan.md`
- **主要ファイル**:
  - `agents/linux/src/services/output-collector.ts` - `clearOutputDir()` 修正、`archiveOutputFiles()` 追加
  - `agents/windows/src/services/output-collector.ts` - 同上

#### 54. w コマンド（wrap up）(2026-02-15)
- `w` コマンドで CLAUDE.md/README.md 更新＋コミット＋プッシュをワンショットで実行
- **目的**: 作業完了時の定型操作（ドキュメント更新→コミット→プッシュ）を1文字で実行
- **動作**: `w` を送信すると内部的に `exec` コマンドとして以下のプロンプトを実行：
  - 「CLAUDE.mdとREADME.mdを今回の変更内容で更新してください。更新後、変更内容を簡潔にまとめたコミットメッセージでコミットしてプッシュしてください。」
- **主要ファイル**:
  - `packages/shared/src/constants.ts` - `SHORTCUTS` に `w` 追加
  - `apps/server/src/services/command-parser.ts` - `parseCommand()` に `w` 処理追加、`getHelpText()` 更新
  - `apps/server/src/services/natural-language-parser.ts` - `isTraditionalCommand()` に `w` 追加

#### 55. ドメイン移行・インフラ整備 (2026-02-19)
- `ribbon-re.jp` → `devrelay.io` へのドメイン移行
- Apache2 → Caddy へのリバースプロキシ移行
- SQLite → PostgreSQL へのDB移行
- PM2 でのプロセス管理に統一
- WebUI (`app.devrelay.io`) に `/api/*`, `/ws/*` のリバースプロキシ追加
- **変更ファイル**:
  - `agents/*/src/services/config.ts` - serverUrl を `wss://devrelay.io/ws/agent` に変更
  - `agents/*/src/cli/commands/setup.ts` - ダッシュボード URL 変更
  - `agents/windows/package.json` - appId を `io.devrelay.agent` に変更
  - `apps/web/src/lib/api.ts` - API_BASE を `/api`（相対パス）に変更
  - `apps/web/vite.config.ts` - allowedHosts 変更
  - `apps/server/.env.example` - PostgreSQL 接続文字列に変更
  - `apps/server/src/routes/api.ts` - サービス管理を PM2 コマンドに変更
  - `/etc/caddy/Caddyfile` - `app.devrelay.io` に API/WS プロキシ追加

#### 56. ランディングページ + README 英語化 (2026-02-19)
- `devrelay.io` にアクセスしたときにランディングページを表示
- **ランディングページ**: `apps/landing/index.html`
  - ダークテーマ、ASCII アート風タイトル（各文字が異なるアクセントカラー）
  - Hero + Architecture 図 + Features + Demo + CTA
  - 単一 HTML ファイル（外部依存なし）
- **Caddyfile 変更**: `devrelay.io` のルーティングを変更
  - `/api/*`, `/ws/*`, `/health` → `localhost:3005`（バックエンド）
  - それ以外 → `apps/landing/` の静的ファイル配信
- **README 英語化**:
  - `README.md` → 英語版に書き換え
  - `README_JA.md` → 日本語版として新規作成（旧 README.md の内容を移動）
  - 相互リンク付き（`README_JA.md` は ISO 639-1 言語コードに準拠）
  - systemd の記述を PM2 に更新
- **主要ファイル**:
  - `apps/landing/index.html` - 新規作成
  - `/etc/caddy/Caddyfile` - ルーティング変更（`.devrelay-output/Caddyfile` 経由で適用）
  - `README.md` - 英語版に書き換え
  - `README_JA.md` - 新規作成（日本語版）

#### 57. トークンにサーバーURL埋め込み (2026-02-19)
- **目的**: セルフホスト環境でトークンを貼るだけで正しいサーバーに自動接続
- **トークンフォーマット**:
  - 新形式: `drl_<serverUrl_base64url>_<random64hex>`
  - 旧形式: `machine_<random64hex>`（後方互換のためサポート継続）
- **動作**:
  1. WebUI でマシン追加時、サーバーの Host ヘッダーから WebSocket URL を構築
  2. URL を Base64URL エンコードしてトークンに埋め込み
  3. Agent の `devrelay setup` でトークン入力時に URL を自動抽出
  4. 旧形式トークンの場合はデフォルト URL（`wss://devrelay.io/ws/agent`）を使用
- **Base64URL**: 標準 Base64 の `+` → `-`, `/` → `_`, パディング `=` を除去
- **主要ファイル**:
  - `packages/shared/src/token.ts` - `encodeToken()`, `decodeTokenUrl()`, `isNewFormatToken()`, `isLegacyToken()`
  - `packages/shared/src/index.ts` - token.ts エクスポート追加
  - `apps/server/src/routes/api.ts` - トークン生成を新フォーマットに変更
  - `agents/linux/src/cli/commands/setup.ts` - トークンからURL自動抽出
  - `agents/windows/src/cli/commands/setup.ts` - 同上

#### 58. devrelay-claude シンボリックリンクのフォールバック (2026-02-19)
- **問題**: `devrelay setup` 後に Claude Code をインストールすると、シンボリックリンクが存在せず ENOENT エラー
- **解決**: `resolveClaudePath()` 関数で段階的に解決
  1. `~/.devrelay/bin/devrelay-claude` が存在すればそのまま使用
  2. 存在しなければ `which claude` でフォールバック
  3. 見つかったらシンボリックリンクも自動作成（次回以降は高速に）
  4. claude が見つからない場合は明確なエラーメッセージ
- **主要ファイル**:
  - `agents/linux/src/services/ai-runner.ts` - `resolveClaudePath()` 関数追加

#### 59. Heartbeat DB バッチ更新 + machineName デフォルト変更 (2026-02-21)
- **Heartbeat DB バッチ更新**:
  - Agent の ping ごとに DB 更新していたのを、メモリ内 Map で管理し 60 秒ごとにバッチ書き込みに変更
  - `lastSeenMap` で最終確認時刻を保持、heartbeat monitor のループでまとめて flush
  - DB 負荷を大幅に削減（100 Agent で 200 writes/min → 100 writes/min）
- **machineName デフォルト変更**:
  - `os.hostname()` → `${os.hostname()}/{os.userInfo().username}` に変更
  - 1 Agent = 1 User モデルに対応（同一マシン上の複数ユーザーを区別）
- **主要ファイル**:
  - `apps/server/src/services/agent-manager.ts` - `lastSeenMap`、`handleAgentPing()` バッチ化、`startHeartbeatMonitor()` flush 追加
  - `agents/linux/src/services/config.ts` - machineName デフォルト変更
  - `agents/linux/src/cli/commands/setup.ts` - machineName デフォルト変更
  - `agents/windows/src/services/config.ts` - machineName デフォルト変更

#### 60. Agent ワンライナーインストール (2026-02-21)
- `curl | bash` 形式のワンライナーで Agent をインストール可能に
- **スクリプト**: `scripts/install-agent.sh`
  - 引数: `--token`（必須）、`--server`（オプション）
  - 処理: 依存チェック → clone → pnpm install → build → config.yaml 生成 → systemd サービス登録・起動
- **WebUI**: トークンモーダルにワンライナー表示を追加
  - トークン埋め込み済みのコマンドをコピー可能
- **使い方**:
  ```bash
  curl -fsSL https://raw.githubusercontent.com/murata1215/devrelay/main/scripts/install-agent.sh | bash -s -- --token YOUR_TOKEN
  ```
- **主要ファイル**:
  - `scripts/install-agent.sh` - ワンライナーインストールスクリプト（新規）
  - `apps/web/src/pages/MachinesPage.tsx` - トークンモーダルにワンライナー表示追加

#### 61. Machine→Agent 表記変更 + machineName スラッシュ区切り (2026-02-21)
- **machineName フォーマット変更**:
  - `hostname-username` → `hostname/username` に変更
  - ホスト名にハイフンがよく使われるため（例: `ubuntu-dev`）、スラッシュ区切りで明確に区別
  - 例: `ubuntu-dev/pixblog`、`ubuntu-prod/pixdraft`
- **WebUI 表記変更**（表示ラベルのみ、DB・API・変数名は変更なし）:
  - ナビゲーション: `Machines` → `Agents`
  - MachinesPage: タイトル・ボタン・モーダル全て `Machine` → `Agent`
  - DashboardPage: 統計カード `Machines` → `Agents`
- **Discord/Telegram メッセージ**:
  - `マシン` → `エージェント`（ユーザー向けメッセージ）
  - `Machine:` → `Agent:`（ステータス表示）
  - ヘルプテキスト: `マシン一覧` → `エージェント一覧`
- **変更しないもの**: ファイル名、URL パス (`/machines`)、API パス、DB モデル名、TypeScript 型名、変数名
- **主要ファイル**:
  - `agents/linux/src/services/config.ts` - machineName スラッシュ区切り
  - `agents/linux/src/cli/commands/setup.ts` - 同上 + ヘルプテキスト更新
  - `agents/windows/src/services/config.ts` - 同上
  - `scripts/install-agent.sh` - 同上 + 表記更新
  - `apps/web/src/components/Layout.tsx` - ナビ「Agents」
  - `apps/web/src/pages/MachinesPage.tsx` - 全ラベル「Agent」
  - `apps/web/src/pages/DashboardPage.tsx` - 統計カード「Agents」
  - `apps/server/src/services/command-handler.ts` - 日本語メッセージ「エージェント」
  - `apps/server/src/services/command-parser.ts` - ヘルプテキスト「エージェント一覧」

#### 62. ワンライナーインストール改善 (2026-02-21)
- **install-agent.sh の複数改善**:
  - **serverUrl 自動抽出**: `drl_` 形式トークンから Base64URL デコードでサーバーURL を自動取得
  - **projectsDirs に `/opt` 追加**: デフォルトスキャン対象にホームディレクトリと `/opt` を含める
  - **systemd 失敗時の nohup 自動起動**: D-Bus 未対応環境でも Agent を自動でバックグラウンド起動
  - **crontab @reboot 自動登録**: systemd 不可環境で OS 再起動後も自動起動
  - **メッセージ改善**: 黄色警告を削除、「nohup + crontab で起動します」とポジティブ表示
- **agents/linux/src/services/config.ts**: デフォルト projectsDirs に `/opt` を追加
- **主要ファイル**:
  - `scripts/install-agent.sh` - ワンライナーインストーラー全般改善
  - `agents/linux/src/services/config.ts` - デフォルト projectsDirs 変更

#### 63. Agent 追加 UX 改善 - 名前入力スキップ + 自動命名 (2026-02-21)
- **目的**: Agent 追加時の名前入力ステップを省略し、Agent 接続時に自動で hostname/username を設定
- **新フロー**:
  1. WebUI で「+ Add Agent」クリック → 即座にトークン＋ワンライナー表示（名前入力なし）
  2. サーバーが仮名（`agent-1`, `agent-2`, ...）を自動生成して DB に登録
  3. ユーザーがワンライナーを実行して Agent をインストール
  4. Agent 接続時、DB の名前が仮名（`agent-` で始まる）なら Agent の `machineName`（hostname/username）で上書き
  5. 手動設定した名前は上書きしない（ユーザー設定を尊重）
- **仮名の自動生成**: 同一ユーザーの `agent-N` を検索し、最大 N+1 で連番採番
- **重複防止**: 同名の Agent が既にある場合は仮名を維持
- **主要ファイル**:
  - `apps/web/src/pages/MachinesPage.tsx` - 名前入力モーダル削除、即座にトークン表示
  - `apps/web/src/lib/api.ts` - `machines.create()` の name パラメータを任意に
  - `apps/server/src/routes/api.ts` - POST /api/machines に仮名自動生成を追加
  - `apps/server/src/services/agent-manager.ts` - `handleAgentConnect()` に仮名→正式名の自動更新を追加

#### 64. Agent 再起動後のセッション継続修正 (2026-02-21)
- **問題**: Agent を `pm2 restart` で再起動すると、Discord からのメッセージに応答が返らなくなる
- **根本原因（4つの問題）**:
  1. **Race Condition**: 旧 WebSocket の `close` イベントが新接続の後に遅延発火し、`clearSessionsForMachine()` で復元済みセッションを破壊
  2. **sessionInfoMap 消失**: Agent 再起動後、サーバーが `server:session:start` を送らず直接 `server:ai:prompt` を送るため、Agent 側で `sessionInfoMap` が空で処理不能
  3. **userId 不整合**: セッション再開始コードで `context.userId`（Discord プラットフォーム ID）を `createSession()` に渡しており、DB の `User.id`（CUID 形式）との外部キー制約違反
  4. **二重セッション作成**: 自動再接続（`handleProjectConnect`）後に `isAgentRestarted()` フラグがクリアされず、`handleAiPrompt()` で再度セッション作成
- **修正内容**:
  - `handleAgentDisconnect()`: 切断された WebSocket が現在の接続と同一か判定し、stale 接続の切断をスキップ
  - `handleAgentConnect()`: `needsSessionRestart` Set に machineId を記録
  - `handleAiPrompt()` / `handleExec()`: Agent 再接続フラグがある場合、新セッション作成 + `server:session:start` 再送してからプロンプト送信
  - `createSession()` に渡す userId を `oldSession.userId` に修正
  - `handleProjectConnect()` で `clearAgentRestarted()` を呼び二重作成を防止
- **主要ファイル**:
  - `apps/server/src/services/agent-manager.ts` - stale 接続判定、`needsSessionRestart` Set、`isAgentRestarted()` / `clearAgentRestarted()` API
  - `apps/server/src/services/command-handler.ts` - セッション再開始ロジック、userId 修正、フラグクリア

#### 65. ワンライナーインストーラー依存チェック改善 (2026-02-21)
- **問題**: 依存ツール不足時に1つ目で `exit 1` して止まるため、全ての不足を把握できない
- **改善内容**:
  - 全依存（Node.js 20+, git, pnpm）をまとめてチェックし、不足分を全て表示してから終了
  - 各ツールにインストール方法のワンライナーを案内
    - Node.js: `curl -fsSL https://fnm.vercel.app/install | bash && fnm install 20`
    - git: `sudo apt install git` または `sudo yum install git`
    - pnpm: `npm install -g pnpm`
  - pnpm の自動インストール（`npm install -g pnpm` / `corepack`）を廃止 → 事前チェックに変更
- **主要ファイル**:
  - `scripts/install-agent.sh` - Step 1 依存チェック全面改善、Step 3 自動インストール削除

#### 66. Windows CLI Agent - クロスプラットフォーム化 (2026-02-21)
- **目的**: Linux Agent (`agents/linux/`) を Windows でも動作するクロスプラットフォームコードベースに拡張
- **方針**: 新しいディレクトリを作らず、既存 `agents/linux/` に `process.platform === 'win32'` 分岐を追加
- **パッケージリネーム**: `@devrelay/agent-linux` → `@devrelay/agent`
- **主な変更**:
  - **config.ts**: Windows は `%APPDATA%\devrelay`、Linux は `~/.devrelay`。`getBinDir()` 追加
  - **ai-runner.ts**: `resolveClaudePath()` が Windows `.cmd` ラッパー / Linux シンボリックリンクを自動作成。`shell: true`（Windows）、PATH区切り `;`/`:` 分岐
  - **index.ts**: `ensureDevrelaySymlinks()` が Windows `.cmd` / Linux symlink を切り替え
  - **setup.ts**: Windows はタスクスケジューラ (`schtasks`)、Linux は systemd。`.cmd` バッチファイルラッパー作成
  - **uninstall.ts**: Windows はタスクスケジューラ削除 + `taskkill`、Linux は systemd 停止
  - **status.ts**: Windows は `schtasks /Query` + `tasklist`、Linux は `systemctl`
  - **logs.ts**: Windows は `PowerShell Get-Content -Tail -Wait`、Linux は `tail -f`
  - **cli/index.ts**: `config` コマンドが `getConfigDir()` 使用、Windows デフォルトエディタ `notepad`
- **PowerShell ワンライナーインストーラー**: `scripts/install-agent.ps1`
  - `$env:DEVRELAY_TOKEN="..."; irm https://raw.githubusercontent.com/.../install-agent.ps1 | iex`
  - 依存チェック（Node.js 20+, git, pnpm）、`%APPDATA%\devrelay\agent\` にクローン・ビルド
  - `drl_` トークンから Base64URL デコードでサーバーURL 自動抽出
  - タスクスケジューラ登録 + バックグラウンド起動
- **WebUI**: トークンモーダルに Linux / Windows タブ切り替え追加
  - Linux タブ: `curl | bash` ワンライナー
  - Windows タブ: PowerShell ワンライナー
- **主要ファイル**:
  - `agents/linux/src/services/config.ts` - OS 別パス、`getConfigDir()`, `getBinDir()`, `getDefaultProjectsDirs()`
  - `agents/linux/src/services/agent-state.ts` - `getConfigDir()` インポートに変更
  - `agents/linux/src/services/ai-runner.ts` - `resolveClaudePath()` クロスプラットフォーム化
  - `agents/linux/src/index.ts` - `ensureDevrelaySymlinks()` クロスプラットフォーム化
  - `agents/linux/src/cli/commands/setup.ts` - タスクスケジューラ対応
  - `agents/linux/src/cli/commands/uninstall.ts` - Windows クリーンアップ
  - `agents/linux/src/cli/commands/status.ts` - Windows ステータス確認
  - `agents/linux/src/cli/commands/logs.ts` - Windows ログ表示
  - `agents/linux/src/cli/index.ts` - `getConfigDir()` 使用
  - `agents/linux/package.json` - `@devrelay/agent-linux` → `@devrelay/agent`
  - `package.json`（ルート）- filter 名更新
  - `scripts/install-agent.sh` - filter 名更新
  - `scripts/install-agent.ps1` - 新規 PowerShell インストーラー
  - `apps/web/src/pages/MachinesPage.tsx` - OS タブ切り替え

#### 67. PowerShell インストーラー ExecutionPolicy 自動設定 + pnpm 自動インストール (2026-02-21)
- **問題**: Windows デフォルトの ExecutionPolicy `Restricted` では `npm.ps1`/`pnpm.ps1` 等の PowerShell ラッパースクリプトがブロックされる
  - `irm ... | iex` 自体は文字列評価なので動作するが、スクリプト内で呼ぶ `npm`/`pnpm` コマンドが失敗
- **解決策1: ExecutionPolicy 自動設定**:
  - インストーラー冒頭で `Set-ExecutionPolicy RemoteSigned -Scope CurrentUser -Force` を自動実行
  - 現在のポリシーが `Restricted` または `Undefined` の場合のみ変更
  - `-Scope CurrentUser` なので管理者権限不要
  - `iex` 内から実行可能なので、ユーザーの手動操作は不要
- **解決策2: pnpm 自動インストール**:
  - pnpm が未インストールの場合、`cmd /c "npm install -g pnpm"` で自動インストール
  - `cmd /c` 経由で `npm.cmd` を直接呼ぶことで `.ps1` ラッパー問題も回避
  - Node.js がある場合のみ試行、失敗時は従来通りエラー表示
- **主要ファイル**:
  - `scripts/install-agent.ps1` - ExecutionPolicy 自動設定（冒頭）、pnpm 自動インストール（Step 1）

#### 68. Agent 設定モーダル + アンインストール用ワンライナー (2026-02-21)
- **目的**: Agent 作成直後しか表示されなかったトークンモーダルを、既存 Agent からも開けるようにする
- **Agent 設定モーダル**:
  - Agent 一覧でAgent 名をクリック → API でトークン取得 → 設定モーダル表示
  - Token 表示 + Copy
  - Quick Install（Linux/Windows タブ切り替え）+ Copy
  - Uninstall（`<details>` で折りたたみ、OS タブ連動）+ Copy
- **トークン取得 API**:
  - `GET /api/machines/:id/token` エンドポイント追加
  - ユーザーが所有するマシンのトークンのみ返す
- **アンインストールコマンド**:
  - Linux: `sudo systemctl stop devrelay-agent; ... rm -rf ~/.devrelay`
  - Windows: `Get-Process node ... | Stop-Process -Force; Remove-Item ... -Recurse -Force`
- **共通コンポーネント化**: `OsTabButtons`, `CommandBlock` を作成直後モーダルと設定モーダルで共有
- **主要ファイル**:
  - `apps/server/src/routes/api.ts` - `GET /api/machines/:id/token` エンドポイント
  - `apps/web/src/lib/api.ts` - `machines.getToken()` メソッド追加
  - `apps/web/src/pages/MachinesPage.tsx` - Agent 設定モーダル、アンインストールコマンド、共通コンポーネント

#### 69. ワンライナーインストーラー プロキシ対応 (2026-02-21)
- **目的**: プロキシ環境でもワンライナーだけで Agent セットアップを完了できるようにする
- **対話プロンプト方式**: インストール途中で「プロキシを使用しますか？」と聞き、必要なら URL を入力させる
- **Linux (`scripts/install-agent.sh`)**:
  - `--proxy URL` 引数追加（指定済みならプロンプトスキップ）
  - 依存チェック後に対話プロンプト: `read ... < /dev/tty` で `curl | bash` でも入力可能
  - config.yaml の新規作成・既存更新の両方で `proxy:` セクション対応
  - 完了メッセージにプロキシ URL 表示
- **Windows (`scripts/install-agent.ps1`)**:
  - `$env:DEVRELAY_PROXY` 環境変数で事前指定可能（指定済みならプロンプトスキップ）
  - 依存チェック後に `Read-Host` で対話プロンプト（`irm | iex` 中でもコンソールから読み取れる）
  - config.yaml の新規作成・既存更新の両方で `proxy:` セクション対応
  - 完了メッセージにプロキシ URL 表示、`$env:DEVRELAY_PROXY` クリーンアップ
- **プロキシ環境変数の自動設定**:
  - プロキシ URL 入力後、`HTTP_PROXY` / `HTTPS_PROXY` 環境変数を自動セット
  - `git clone`, `pnpm install`, Electron バイナリダウンロード等が全てプロキシ経由に
  - 問題: config.yaml にのみ書き込み、環境変数未設定だと `pnpm install` がプロキシを通さず ECONNRESET で失敗していた
- **pnpm 自動インストール後の PATH リフレッシュ**:
  - `npm install -g pnpm` 成功後に `$env:Path` をレジストリから再読み込み
  - 問題: PowerShell が PATH をキャッシュするため、インストール直後の `Get-Command pnpm` が失敗していた
- **WebUI (`apps/web/src/pages/MachinesPage.tsx`)**:
  - 作成直後モーダル・設定モーダルのヒントテキストにプロキシ対応の案内追加
- **使用例**:
  ```bash
  # Linux: 対話的（インストール中にプロンプトが表示される）
  curl -fsSL ... | bash -s -- --token YOUR_TOKEN

  # Linux: 非対話（CI/CD 向け、プロンプトスキップ）
  curl -fsSL ... | bash -s -- --token YOUR_TOKEN --proxy http://proxy:8080

  # Windows: 対話的
  $env:DEVRELAY_TOKEN="YOUR_TOKEN"; irm ... | iex

  # Windows: 非対話
  $env:DEVRELAY_TOKEN="YOUR_TOKEN"; $env:DEVRELAY_PROXY="http://proxy:8080"; irm ... | iex
  ```
- **`--ignore-scripts` によるビルド改善**:
  - `pnpm install` に `--ignore-scripts` フラグを追加（Linux / Windows 共通）
  - Electron postinstall（GitHub からバイナリダウンロード）をスキップ
  - CLI Agent は Electron を一切使わないため、postinstall スキップによる影響なし
  - 企業ネットワークでの `ECONNRESET` → `ELIFECYCLE` → `tsc` 不在の連鎖障害を回避
- **再インストール時の既存プロセス自動停止**:
  - インストーラーの Step 6（Agent 起動）で、既存の Agent プロセスを自動停止してから新プロセスを起動
  - Windows: `Get-Process node | Where-Object { $_.CommandLine -like '*devrelay*' } | Stop-Process`
  - Linux（nohup パス）: `pgrep -f "node.*devrelay.*index.js"` → `kill`
  - systemd パスは `systemctl --user restart` で元々対応済み
- **主要ファイル**:
  - `scripts/install-agent.sh` - `--proxy` 引数パース、対話プロンプト、config.yaml プロキシ書き込み、`--ignore-scripts`、既存プロセス停止
  - `scripts/install-agent.ps1` - `$env:DEVRELAY_PROXY` 読み取り、対話プロンプト、config.yaml プロキシ書き込み、`--ignore-scripts`、既存プロセス停止
  - `apps/web/src/pages/MachinesPage.tsx` - プロキシヒントテキスト追加

#### 70. Linux インストーラー Node.js + pnpm 自動インストール (2026-02-21)
- **目的**: Node.js 未インストールの Linux マシンでもワンライナーだけで Agent セットアップを完了できるようにする
- **問題**: 従来は「fnm でインストールしてください」と案内して終了していたが、fnm 自体が `unzip` を要求し、最小構成 Linux には `unzip` もないためインストールに辿り着けない
- **解決策: Node.js 公式バイナリ直接ダウンロード**:
  - `~/.devrelay/node/` に Node.js 20 LTS（v20.20.0）バイナリを展開
  - アーキテクチャ自動検出: `uname -m` → x64 / arm64 / armv7l
  - `curl` + `tar` のみ使用（`sudo` 不要、`unzip` 不要）
  - PATH の先頭に `~/.devrelay/node/bin` を追加
- **pnpm 自動インストール**: `npm install -g pnpm`（npm は Node.js に同梱）
- **git のみハード依存**: git だけは従来通り必須前提条件として残す
- **依存チェックフローの変更**:
  - 変更前: Node.js なし → エラー表示 → 終了、pnpm なし → エラー表示 → 終了
  - 変更後: Node.js なし → 自動ダウンロード → 続行、pnpm なし → `npm install -g pnpm` → 続行
- **主要ファイル**:
  - `scripts/install-agent.sh` - Step 1 の依存チェックを自動インストールに全面改修

#### 71. AI実行エラーのハンドリング改善 (2026-02-21)
- **問題**: Claude Code 未インストールの Agent にプロンプトを送ると、`resolveClaudePath()` の例外がキャッチされず Node.js プロセスがクラッシュ → Agent が OFFLINE になる
- **解決策1: try/catch 追加**:
  - `handleAiPrompt()` 内の `sendPromptToAi()` + リトライ処理全体を `try/catch` で囲む
  - `catch` ブロックでエラーメッセージを `agent:ai:output`（`isComplete: true`）で Discord/Telegram に送信
  - Agent プロセスはクラッシュせず ONLINE のまま維持される
- **解決策2: エラーメッセージ更新**:
  - `resolveClaudePath()` のインストール案内に Linux/Windows 両方のコマンドとセットアップガイド URL を追加
- **表示例**（Discord/Telegram）:
  ```
  ❌ エラー: Claude Code が見つかりません。以下を確認してください:
    セットアップガイド: https://code.claude.com/docs/ja/setup
    Linux:   curl -fsSL https://claude.ai/install.sh | bash
    Windows: irm https://claude.ai/install.ps1 | iex
    インストール後、Agent を再起動してください
  ```
- **主要ファイル**:
  - `agents/linux/src/services/connection.ts` - `handleAiPrompt()` に try/catch 追加
  - `agents/linux/src/services/ai-runner.ts` - `resolveClaudePath()` エラーメッセージ変更
- **Linux インストーラー追加修正**:
  - **nohup stdin fix**: `curl|bash` で nohup 起動時に `< /dev/null` を追加（バックグラウンドプロセスが stdin を消費してスクリプト後半が実行されない問題を修正）
  - **pgrep パターン修正**: `node.*devrelay.*index.js` → `\.devrelay.*index\.js` に変更（`~/.devrelay/node/bin/node agents/linux/dist/index.js` のように node パスに devrelay が含まれる場合にマッチしなかった問題を修正）
  - **kill || true**: `set -e` 環境下で kill 失敗時にスクリプトが停止しないように `|| true` を追加
  - **node 絶対パス使用**: nohup/crontab で `node` → `$(which node)` の絶対パスを使用（`~/.devrelay/node/` にインストールされた Node.js が PATH にない環境で `Exit 127` になる問題を修正）
  - **crontab/再起動コマンドも絶対パス化**: `dist/index.js` → `$AGENT_DIR/agents/linux/dist/index.js` に変更
- **Windows インストーラー追加修正**:
  - **プロセス検出を Get-CimInstance に変更**: `Get-Process` では VBS→CMD→node の間接起動時に `CommandLine` が空になるため、`Get-CimInstance Win32_Process` を使用して WMI 経由でフルコマンドラインを取得
  - WebUI アンインストールコマンドも同様に修正
- **主要ファイル（追加修正）**:
  - `scripts/install-agent.sh` - nohup stdin fix、pgrep パターン修正、kill || true、node 絶対パス
  - `scripts/install-agent.ps1` - Get-CimInstance によるプロセス検出
  - `apps/web/src/pages/MachinesPage.tsx` - アンインストールコマンド修正

#### 72. インストール時のトークン事前検証 (2026-02-22)
- **目的**: 別のマシン用のトークンを誤って使ってインストールするのを防止
- **問題**: マシンAのトークンでマシンBにインストールすると、DBにマシンAの名前で2つ目のエントリが作成されてしまう
- **解決策: インストール時のサーバー問い合わせ**:
  1. パブリック API `POST /api/public/validate-token` を新設（認証不要）
  2. インストーラーがビルド前にトークンを検証
  3. トークンのマシン名が仮名（`agent-*`）でなく、現在の `hostname/username` と異なれば中断
  4. `--force`（Linux）/ `$env:DEVRELAY_FORCE`（Windows）で強制続行可能
- **API レスポンス**:
  ```json
  { "valid": true, "provisional": false, "machineName": "mouse01/user01" }
  ```
- **インストーラーの判定ロジック**:
  - `valid: false` → 無効なトークン → 中断
  - `provisional: true` → 仮名（新規Agent）→ 検証スキップ、続行
  - `machineName !== hostname/username` → 別マシン用トークン → 中断（`--force` で回避）
- **主要ファイル**:
  - `apps/server/src/routes/public-api.ts` - **新規**: パブリック API エンドポイント
  - `apps/server/src/index.ts` - publicApiRoutes の登録
  - `scripts/install-agent.sh` - `--force` フラグ、トークン検証ステップ追加
  - `scripts/install-agent.ps1` - `$env:DEVRELAY_FORCE`、トークン検証ステップ追加

#### 73. サーバー接続不可時のインストール停止 (2026-02-22)
- **目的**: プロキシ設定ミスなどでサーバーに接続できない場合、インストールを中断して原因を明示
- **変更前**: トークン検証 API に接続できない場合は「スキップして続行」
- **変更後**: 接続不可 → エラーメッセージ表示 → インストール停止
- **エラーメッセージ**: プロキシ設定がある場合はプロキシ URL も表示し、設定ミスの診断を支援
- **主要ファイル**:
  - `scripts/install-agent.sh` - サーバー接続エラー時の停止処理
  - `scripts/install-agent.ps1` - 同上

#### 74. Windows アンインストールコマンド修正 (2026-02-22)
- **問題**: プロセス kill 直後にファイル削除すると「file in use」エラー
- **原因**: `Stop-Process -Force` 後もプロセス終了に時間がかかり、ファイルロックが残る
- **解決**: `Start-Sleep -Seconds 2` をプロセス kill と `Remove-Item` の間に追加
- **修正箇所**: WebUI Agent 設定モーダルのアンインストールコマンド
- **主要ファイル**:
  - `apps/web/src/pages/MachinesPage.tsx` - Windows アンインストールコマンドに `Start-Sleep` 追加

#### 75. Linux インストーラー nohup 起動パスの pgrep 修正 (2026-02-22)
- **問題**: nohup + crontab パスの Step 6 で、既存プロセス検出の `pgrep` がマッチなし（終了コード 1）を返した時に `set -e` によりスクリプトが即座に終了。nohup 起動・crontab 登録・完了メッセージが一切表示されない
- **原因**: `EXISTING_PID=$(pgrep ...)` で `pgrep` がマッチなしの場合に終了コード 1 を返し、`set -e` がスクリプトを中断
- **解決**: `pgrep` コマンドに `|| true` を追加して、マッチなしでも終了コード 0 を返すように修正
- **変更前**: `EXISTING_PID=$(pgrep -u "$(whoami)" -f "\.devrelay.*index\.js" 2>/dev/null)`
- **変更後**: `EXISTING_PID=$(pgrep -u "$(whoami)" -f "\.devrelay.*index\.js" 2>/dev/null || true)`
- **主要ファイル**:
  - `scripts/install-agent.sh` - Step 6 の pgrep に `|| true` 追加

#### 76. WebUI に Agent 管理コマンド表示 (2026-02-22)
- **目的**: インストール後にターミナルに表示される管理コマンド（ログ確認、停止、再起動など）を WebUI から確認できるようにする
- **問題**: ターミナルを閉じるとコマンドが見えなくなる。コマンドにはマシン依存のパスが含まれる
- **アプローチ**: Agent が `agent:connect` 時に環境固有の管理コマンドを生成 → DB に JSON 保存 → WebUI で表示
- **環境自動検出**:
  - **systemd**: `systemctl --user is-enabled devrelay-agent` で判定
  - **PM2**: `process.env.pm_id` の存在で判定。`process.env.name` でプロセス名を取得
  - **nohup**: 上記以外のフォールバック。`process.execPath` と `import.meta.url` で絶対パスを取得
  - **Windows**: Startup フォルダの VBS ランチャー有無で自動起動解除コマンドを制御
- **DB スキーマ**: Machine モデルに `managementInfo Json?` フィールドを追加
- **WebUI**: Agent 設定モーダルに Management Commands セクションを追加
  - 各コマンドにラベル + コード表示 + Copy ボタン
  - Agent 未接続の場合は「Agent が接続すると管理コマンドが表示されます」のフォールバック
  - OS 種別とインストール方式を表示（例: `Linux / pm2`）
- **後方互換性**: `managementInfo` は全てオプショナル。旧バージョン Agent は送信しない → DB は null → WebUI はフォールバック表示
- **主要ファイル**:
  - `packages/shared/src/types.ts` - `ManagementInfo`, `ManagementCommand` 型追加、`AgentConnectPayload` に `managementInfo?` 追加
  - `apps/server/prisma/schema.prisma` - Machine に `managementInfo Json?` 追加
  - `agents/linux/src/services/management-info.ts` - **新規**: 環境検出 + コマンド生成（systemd/PM2/nohup/Windows）
  - `agents/linux/src/services/connection.ts` - `agent:connect` に `managementInfo` を含めて送信
  - `apps/server/src/services/agent-manager.ts` - `handleAgentConnect()` で managementInfo を DB 保存
  - `apps/server/src/routes/api.ts` - GET /api/machines レスポンスに `managementInfo` 追加
  - `apps/web/src/lib/api.ts` - `ManagementInfo` / `ManagementCommand` 型、`Machine` に追加
  - `apps/web/src/pages/MachinesPage.tsx` - Agent 設定モーダルに Management Commands セクション追加

#### 77. 再インストール時に serverUrl も更新 (2026-02-22)
- **問題**: 既存の `config.yaml` がある環境でインストーラーを再実行すると、トークンのみ更新され `serverUrl` が古いまま残る
- **発見経緯**: `ribbon-re.jp` → `devrelay.io` のサーバー移行後、Windows Electron Agent が古い URL で接続を試みて失敗
- **原因**: `install-agent.sh` と `install-agent.ps1` の Step 4 で、既存 config.yaml がある場合に `token` のみ書き換え、`serverUrl` は放置していた
- **解決策**: 既存 config.yaml の更新処理に `serverUrl` の書き換えを追加
  - `drl_` 形式トークンから抽出した URL、またはデフォルト `wss://devrelay.io/ws/agent` で上書き
- **主要ファイル**:
  - `scripts/install-agent.sh` - Step 4 に `serverUrl` の sed 置換を追加
  - `scripts/install-agent.ps1` - Step 4 に `serverUrl` の正規表現置換を追加

#### 78. Machine Hostname Alias（表示名エイリアス）(2026-02-23)
- **目的**: ホスト名ベースのエイリアスで Agent の表示名を変更可能にする
- **例**: `x220-158-18-103/pixblog` → `ubuntu-prod/pixblog` のように分かりやすい名前で表示
- **要件**: 「１個設定すれば他に反映」- 同じホスト名を持つ全 Agent に一括適用
- **DB スキーマ**: Machine モデルに `displayName String?` フィールドを追加
  - マイグレーション: `20260222130228_add_machine_display_name`
- **表示名の計算**: `displayName ?? name`（displayName が設定されていれば displayName、なければ name）
- **ホスト名レベルエイリアス**:
  - `PUT /api/machines/hostname-alias` で `{ hostname, alias }` を送信
  - 同じホスト名の全 Agent の displayName を一括更新
  - 例: hostname=`x220` + alias=`ubuntu-prod` → `x220/user1` は `ubuntu-prod/user1` に
  - alias を空にすると displayName を null に戻す（元の名前に復帰）
- **自動計算**: 新しい Agent 接続時、兄弟マシンの displayName からエイリアスを自動計算
  - 例: `x220/user1` に `ubuntu-prod/user1` が設定済み → `x220/user2` 接続時に `ubuntu-prod/user2` を自動設定
- **表示更新箇所**: Discord/Telegram メッセージ、WebUI の全ページ（約15箇所）
  - `handleMachineList`, `handleMachineConnect`, `handleProjectConnect`, `handleContinue`, `handleExec`, `handleSession`, `handleAiPrompt`, `handleRecent`, `handleRecentConnect` 等
- **WebUI**: Agent 設定モーダルに Hostname Alias 入力フィールドを追加
  - 元のホスト名を表示、エイリアスを入力して Save
  - エイリアス設定済みの場合は元の名前を小さく表示
- **主要ファイル**:
  - `apps/server/prisma/schema.prisma` - Machine に `displayName String?` 追加
  - `packages/shared/src/types.ts` - Machine に `displayName?: string | null` 追加
  - `apps/server/src/routes/api.ts` - `PUT /api/machines/hostname-alias`、各 GET に displayName 追加
  - `apps/server/src/services/agent-manager.ts` - 自動計算ロジック、`getMachineDisplayName()` ヘルパー
  - `apps/server/src/services/command-handler.ts` - 全表示箇所で `displayName ?? name` 使用
  - `apps/server/src/services/session-manager.ts` - `getActiveSessions()` に `machineDisplayName` 追加
  - `apps/web/src/lib/api.ts` - `displayName` 型追加、`machines.setHostnameAlias()` メソッド
  - `apps/web/src/pages/MachinesPage.tsx` - エイリアス編集 UI
  - `apps/web/src/pages/ProjectsPage.tsx` - 表示名対応
  - `apps/web/src/pages/DashboardPage.tsx` - 表示名対応

#### 79. machineName 旧形式からの自動マイグレーション (2026-02-23)
- **問題**: 再インストール時に `config.yaml` の `machineName` が旧形式（hostname のみ、`/username` なし）のまま残り、Agent が旧形式の名前でサーバーに接続する
- **発見経緯**: WebUI で `agent-1` → `DESKTOP-Q43QT7L` になるべきところが `/fwjg2` なしで表示された
- **原因**: インストーラーが既存 `config.yaml` の `token` と `serverUrl` のみ更新し、`machineName` を更新していなかった
- **修正1: サーバー側自動マイグレーション** (`agent-manager.ts`):
  - `handleAgentConnect()` の名前更新条件を拡張
  - 従来: `agent-` で始まる仮名のみ更新
  - 追加: Agent が `hostname/username` で接続し、DB の名前が hostname 部分と一致する場合も更新
  - 例: DB `DESKTOP-Q43QT7L` + Agent `DESKTOP-Q43QT7L/fwjg2` → 自動的に `DESKTOP-Q43QT7L/fwjg2` に更新
  - ユーザーが手動で別名を設定した場合は hostname が一致しないため上書きしない
- **修正2: インストーラーで machineName も更新** (`install-agent.sh` / `install-agent.ps1`):
  - 既存 `config.yaml` の更新時に `machineName` も最新の `hostname/username` 形式に書き換え
  - #77 の `serverUrl` 更新と同じパターンで `machineName` も追加
- **主要ファイル**:
  - `apps/server/src/services/agent-manager.ts` - 名前更新条件の拡張（`isProvisional || isOldFormat`）
  - `scripts/install-agent.sh` - Step 4 に machineName の sed 置換を追加
  - `scripts/install-agent.ps1` - Step 4 に machineName の正規表現置換を追加

#### 80. Message Usage Data Storage (2026-02-27)
- **目的**: AI 実行ごとのトークン使用量をDBに保存し、後から分析・表示できるようにする
- **DB スキーマ**: Message モデルに `usageData Json?` フィールドを追加
  - マイグレーション: `20260226213926_add_message_usage_data`
- **保存データ**:
  ```json
  {
    "usage": {
      "input_tokens": 12345,
      "output_tokens": 678,
      "cache_read_input_tokens": 9000,
      "cache_creation_input_tokens": 500
    },
    "modelUsage": { "contextWindow": 200000 },
    "duration_ms": 15000,
    "model": "claude-opus-4-6"
  }
  ```
- **実装**: Claude Code の `result` メッセージの JSON から usage 情報を抽出、DB に保存
- **主要ファイル**:
  - `apps/server/prisma/schema.prisma` - Message に `usageData Json?` 追加
  - `agents/linux/src/services/output-parser.ts` - `usageData` 抽出ロジック追加
  - `apps/server/src/services/agent-manager.ts` - `handleAiOutput()` で usageData を DB 保存

#### 81. Conversations ページ（使用量分析）(2026-02-27)
- **目的**: 全 AI 会話を一覧表示し、トークン使用量を可視化
- **新ページ**: `apps/web/src/pages/ConversationsPage.tsx`
- **API エンドポイント**: `GET /api/conversations?offset=0&limit=50`
  - ユーザー→AI のメッセージペアをフラットに一覧化
  - `usageData` のある AI メッセージのみ対象
  - N+1 回避: バッチフェッチ＋メモリ内ジョイン
- **UI 機能**:
  - **デスクトップ**: テーブル形式（日付、プロジェクト、ユーザーメッセージ、AI応答、モデル、実行時間、トークン数）
  - **モバイル**: カード形式
  - **展開表示**: 行クリックで詳細表示（フルメッセージ、トークン内訳: input/output/cache read/cache creation）
  - **ページネーション**: 50件ごと、prev/next ナビゲーション
  - **フォーマット**: トークン数を「20.0K」形式、実行時間を「5.2s」/「1.5m」形式、モデル名を短縮
- **主要ファイル**:
  - `apps/web/src/pages/ConversationsPage.tsx` - 新規ページ
  - `apps/web/src/App.tsx` - `/conversations` ルート追加
  - `apps/web/src/components/Layout.tsx` - ナビゲーションに追加
  - `apps/web/src/lib/api.ts` - `ConversationItem`, `ConversationsResponse` 型、`conversations.list()` メソッド
  - `apps/server/src/routes/api.ts` - Conversations API 実装

#### 82. BuildLog（ビルド履歴）(2026-02-27)
- **目的**: `exec` コマンド実行ごとにビルド履歴を自動記録
- **DB スキーマ**: 新モデル `BuildLog` を追加
  - マイグレーション: `20260226225852_add_build_log`
  - フィールド: `buildNumber`（プロジェクトスコープの連番）、`projectName`、`summary`、`prompt`
  - 外部キー: Project, Machine, Session, User
  - ユニーク制約: `(projectName, buildNumber)`
- **自動採番**: トランザクション内で `buildNumber` をインクリメント、リトライ 3 回
- **サマリー生成**:
  - 即時: 出力の先頭200文字をフォールバック要約として保存
  - 非同期: AI で要約生成後に DB 更新（fire-and-forget パターン）
- **API エンドポイント**: `GET /api/projects/:projectId/builds`（最大50件）
- **主要ファイル**:
  - `apps/server/prisma/schema.prisma` - BuildLog モデル
  - `apps/server/src/services/agent-manager.ts` - `createBuildLog()`, `updateBuildLogSummaryAsync()`
  - `apps/server/src/routes/api.ts` - builds API

#### 83. Projects ページ LATEST BUILD 表示 + BuildHistoryModal (2026-02-27)
- **目的**: Projects 一覧で直近のビルド情報を表示、クリックでビルド履歴を確認
- **変更内容**:
  - LAST USED 列 → LATEST BUILD 列に変更
  - 最新ビルドの番号・サマリー・日時を表示
  - プロジェクト名クリック → BuildHistoryModal を表示
- **BuildHistoryModal**:
  - ビルド一覧（番号、日時、Agent 名、サマリー）
  - 各ビルドの展開/折りたたみ（サマリー全文表示）
  - モバイル対応
- **API 拡張**: `GET /api/projects` のレスポンスに `latestBuild` を追加
  - `distinct: ['projectId']` + `orderBy: { buildNumber: 'desc' }` で N+1 回避
- **主要ファイル**:
  - `apps/web/src/pages/ProjectsPage.tsx` - LATEST BUILD 列、BuildHistoryModal
  - `apps/web/src/lib/api.ts` - `BuildLog` 型、`projects.getBuildLogs()` メソッド
  - `apps/server/src/routes/api.ts` - latestBuild 追加、builds API

#### 84. マルチプロバイダー AI キー管理 + BuildLog AI 要約 (2026-02-27)
- **目的**: OpenAI / Anthropic / Gemini の 3 社 API キーを WebUI で登録し、機能ごとにプロバイダーを選択可能にする
- **API キー管理**:
  - WebUI Settings に 3 つの API キー入力欄（OpenAI, Anthropic, Gemini）
  - 全キー AES-256-CBC 暗号化で DB 保存（既存の暗号化パターンを踏襲）
  - キーのマスク表示（`sk-***...abc`）
- **プロバイダー選択**:
  - 「Build Summary Provider」: ビルド要約に使う AI を選択
  - 「Chat AI Provider」: 自然言語コマンド解析に使う AI を選択
  - プロバイダー変更は即時保存（`onChange`）
- **対応モデル**:
  - OpenAI: `gpt-4o-mini`
  - Anthropic: `claude-haiku-4-5-20251001`
  - Gemini: `gemini-2.0-flash`
- **BuildLog AI 要約**:
  - `build-summarizer.ts`: マルチプロバイダー対応の要約サービス（新規）
  - システムプロンプト: 出力から1-2文の日本語要約を生成（200文字制限）
  - `execPrompt`（exec 時のカスタムプロンプト）を追加コンテキストとして利用
  - 入力上限 8000 文字で切り詰め
- **自然言語コマンド解析の拡張**:
  - `natural-language-parser.ts` を OpenAI 固定からマルチプロバイダー対応に全面書き換え
  - `parseWithOpenAI()`, `parseWithAnthropic()`, `parseWithGemini()` の 3 関数
  - 後方互換: `CHAT_AI_PROVIDER` 未設定 → OpenAI キーがあれば OpenAI を使用
- **Agent 側変更**: `execPrompt` の伝搬
  - `handleConversationExec()` で exec 時のプロンプトを `handleAiPrompt()` に渡す
  - `agent:ai:output` ペイロードに `execPrompt` を含めてサーバーに送信
  - サーバーが AI 要約時にコンテキストとして利用
- **SDK 追加**: `@anthropic-ai/sdk`, `@google/generative-ai`
- **主要ファイル**:
  - `packages/shared/src/types.ts` - `AiProvider` 型追加、`AiOutputPayload` に `execPrompt` 追加
  - `apps/server/package.json` - Anthropic / Gemini SDK 追加
  - `apps/server/src/services/user-settings.ts` - SettingKeys 拡張、`getApiKeyForBuildSummary()`, `getApiKeyForChatAi()` ヘルパー
  - `apps/server/src/services/build-summarizer.ts` - **新規**: マルチプロバイダー AI 要約サービス
  - `apps/server/src/services/agent-manager.ts` - fire-and-forget AI 要約呼び出し
  - `apps/server/src/services/natural-language-parser.ts` - マルチプロバイダー NLP 対応に全面書き換え
  - `agents/linux/src/services/connection.ts` - `execPrompt` 伝搬
  - `apps/server/src/routes/api.ts` - `gemini_api_key` マスク処理
  - `apps/web/src/pages/SettingsPage.tsx` - API キー 3 欄 + プロバイダー選択 2 つ

#### 85. Projects ページ Latest Build 降順ソート (2026-02-27)
- **目的**: Projects 一覧を最近ビルドしたプロジェクト順に表示
- **変更前**: `lastUsedAt` の降順（サーバー側ソート）
- **変更後**: `latestBuild.createdAt` の降順（クライアント側ソート）
- **ソートルール**:
  - latestBuild がある → `createdAt` の新しい順
  - latestBuild がない → 末尾に配置
- **主要ファイル**:
  - `apps/web/src/pages/ProjectsPage.tsx` - `projects.list()` の結果を `latestBuild.createdAt` でソート

#### 86. DevRelay Agreement v4 + CLAUDE.md マイグレーション

CLAUDE.md の肥大化（1,576行→63行）を解消し、Agreement v4 システムを実装。

- **Agreement v4 アーキテクチャ**:
  - Agreement ルール本体を `rules/devrelay.md` に分離（CLAUDE.md には軽量マーカーのみ）
  - `getAgreementStatusType()` が `rules/devrelay.md` を優先チェック → CLAUDE.md にフォールバック
  - `AGREEMENT_APPLY_PROMPT` をマルチファイル作成プロンプトに書き換え（rules/devrelay.md + doc/ + rules/project.md）
  - 旧バージョン（v1/v2/v3）は `DEVRELAY_AGREEMENT_OLD_MARKERS` で 'outdated' 検出

- **CLAUDE.md マイグレーション**:
  - 実装履歴（#1-#85）→ `doc/changelog.md` に移動
  - 設計判断・注意事項 → `rules/project.md` に移動
  - CLAUDE.md は軽量ハブ（63行、技術スタック・環境変数・DB概要のみ）

- **ディレクトリ統合**:
  - `docs/` → `doc/` に統合（6ファイル移動）
  - `doc/devrelay-claudemd-migration.md` を追加（他プロジェクト向けガイド）

- **バグ修正**:
  - `agent-manager.ts` の Agreement ステータスメッセージ: "v2" ハードコード → バージョン番号なし

- **`w` コマンド更新**:
  - v4 対応: `doc/changelog.md` → `rules/project.md` → CLAUDE.md（最小限のみ）の順で更新
  - ヘルプテキスト: `ag` コマンドの説明を v4 対応に更新

- **変更ファイル**:
  - `agents/linux/src/services/output-collector.ts` - v4 定数・テンプレート・APPLY_PROMPT
  - `agents/linux/src/services/connection.ts` - `getAgreementStatusType()` rules/ 優先チェック
  - `agents/windows/src/services/output-collector.ts` - 同上
  - `agents/windows/src/services/connection.ts` - 同上
  - `apps/server/src/services/agent-manager.ts` - v2 バグ修正
  - `apps/server/src/services/command-parser.ts` - w コマンド・ヘルプテキスト更新
  - `rules/devrelay.md` - v4 Agreement ルール（新規）
  - `rules/project.md` - プロジェクト固有設計判断（新規）
  - `doc/changelog.md` - 実装履歴移行（新規）
  - `doc/devrelay-claudemd-migration.md` - マイグレーションガイド（新規）
  - `CLAUDE.md` - 軽量ハブに書き換え

#### 87. MEMORY.md ルール追加 + マイグレーションガイド更新

MEMORY.md の肥大化防止ルールを Agreement v4 に追加。

- **MEMORY.md 圧縮**: 128行 → 72行（`rules/project.md` と重複する詳細セクションを削除）
- **rules/devrelay.md**: MEMORY.md 更新ルールセクションを追加（80行上限、書いてよいもの/いけないもの、`w` コマンド時の手順）
- **doc/devrelay-claudemd-migration.md**: Step 6 に MEMORY.md マイグレーション手順を追加、分類フローチャートにも反映
- **output-collector.ts**: Linux/Windows 両方の `DEVRELAY_RULES_TEMPLATE` を `rules/devrelay.md` と同期
- Agreement バージョンは v4 のまま（マイナー拡張のためバージョン変更なし）
- **変更ファイル**:
  - `rules/devrelay.md` - MEMORY.md 更新ルール + `w` コマンド手順に MEMORY.md 追加
  - `doc/devrelay-claudemd-migration.md` - Step 6 追加 + フローチャート更新
  - `agents/linux/src/services/output-collector.ts` - DEVRELAY_RULES_TEMPLATE 同期
  - `agents/windows/src/services/output-collector.ts` - DEVRELAY_RULES_TEMPLATE 同期

#### 88. Agreement テンプレート Server 配信

Agreement テンプレートを Agent ハードコードから Server 配信方式に変更。
Server を更新するだけで全 Agent のテンプレートが最新になる。

- **Server 側**:
  - `apps/server/src/services/agreement-template.ts` 新規作成（テンプレート全文 + プロンプト生成関数）
  - `agent-manager.ts` の `applyAgreement()` で `buildAgreementApplyPrompt()` を呼び、payload に `agreementPrompt` を含める
- **Agent 側**:
  - `payload.agreementPrompt` があれば Server 配信プロンプトを使用
  - なければローカルの `AGREEMENT_APPLY_PROMPT` にフォールバック（旧 Server 互換）
- **shared/types.ts**: `AgreementApplyPayload` に `agreementPrompt?: string` フィールド追加
- **後方互換**: 旧 Server → 新 Agent = ローカルフォールバック、新 Server → 旧 Agent = `agreementPrompt` フィールドは無視される
- **変更ファイル**:
  - `apps/server/src/services/agreement-template.ts` - 新規
  - `apps/server/src/services/agent-manager.ts` - import + applyAgreement 更新
  - `packages/shared/src/types.ts` - AgreementApplyPayload 拡張
  - `agents/linux/src/services/connection.ts` - handleAgreementApply 更新
  - `agents/windows/src/services/connection.ts` - handleAgreementApply 更新

#### 89. exec コマンドのユーザーメッセージ保存 (2026-02-28)

`e`/`exec` 実行時に WebUI Conversations ページで User Message が `(empty)` と表示される問題を修正。
`handleExec()` が Message テーブルに user メッセージを保存していなかったため、AI レスポンスとマッチする user メッセージが存在しなかった。

- `handleExec()` 内で exec 実行前に user メッセージを保存するように変更
  - カスタムプロンプトあり: `[exec] <prompt>`
  - カスタムプロンプトなし: `[exec]`
- **変更ファイル**: `apps/server/src/services/command-handler.ts`

#### 90. wrapUpDone 判定条件の修正 (2026-02-28)

`w` 実行後に `x` で会話クリアしようとすると「w コマンドを実行していません」と警告が出る問題を修正。
#86 で `w` コマンドのプロンプトを変更した際、`wrapUpDone` の `startsWith` 判定条件を更新し忘れていた。

- `command.prompt?.startsWith('CLAUDE.mdとREADME.md')` → `startsWith('doc/changelog.md があれば')` に修正
- **変更ファイル**: `apps/server/src/services/command-handler.ts`

#### 91. Settings ページに Agreement テンプレート編集機能 (2026-02-28)

WebUI の Settings ページから Agreement テンプレートを閲覧・編集できるようにした。
カスタムテンプレートは UserSettings（key-value ストア）に保存され、`ag` コマンド実行時に適用される。

- **Server**: `SettingKeys.AGREEMENT_TEMPLATE` 追加、`buildAgreementApplyPrompt(customTemplate?)` にカスタムテンプレート引数追加
- **API**: Agreement 専用エンドポイント 3 つ（GET/PUT/DELETE `/api/agreement-template`）
- **WebUI**: Settings ページに textarea + Save + Reset to Default ボタン
- **変更ファイル**:
  - `apps/server/src/services/user-settings.ts` - AGREEMENT_TEMPLATE キー追加
  - `apps/server/src/services/agreement-template.ts` - DEFAULT_RULES_TEMPLATE エクスポート、customTemplate 引数
  - `apps/server/src/services/agent-manager.ts` - applyAgreement でカスタムテンプレート取得
  - `apps/server/src/routes/api.ts` - Agreement 専用 API + GET /api/settings から除外
  - `apps/web/src/lib/api.ts` - agreementTemplate API クライアント
  - `apps/web/src/pages/SettingsPage.tsx` - Agreement Template セクション

#### 92. メッセージファイル BLOB 保存 + Conversations 表示 (2026-02-28)

Discord/Telegram から送信した添付ファイル（`.devrelay-files`）と AI の出力ファイル（`.devrelay-output-history`）を
DB に BLOB（PostgreSQL bytea）で保存し、Conversations ページで表示できるようにした。

- **DB**: `MessageFile` モデル追加（Bytes 型で bytea、direction: 'input'|'output'）
- **Server**: ファイル中継時に MessageFile レコードを同時保存
- **API**: `GET /api/files/:id` でバイナリ配信（認証 + オーナーチェック付き）
- **WebUI**: `FileList` コンポーネントで画像プレビュー・ダウンロードリンク表示
- **変更ファイル**:
  - `apps/server/prisma/schema.prisma` - MessageFile モデル
  - `apps/server/src/services/command-handler.ts` - 入力ファイル保存
  - `apps/server/src/services/agent-manager.ts` - 出力ファイル保存
  - `apps/server/src/routes/api.ts` - ファイル配信 API + Conversations API にファイルメタデータ
  - `apps/web/src/lib/api.ts` - MessageFileMeta 型、ConversationItem にファイルフィールド
  - `apps/web/src/pages/ConversationsPage.tsx` - FileList コンポーネント

#### 93. Machine ソフトデリート (2026-02-28)

Machine 削除時に関連データ（Session/Message/BuildLog/Project）がカスケード物理削除される問題を修正。
`deletedAt` カラムを追加し、削除は論理削除（ソフトデリート）に変更。

- **スキーマ**: Machine に `deletedAt DateTime?` 追加
- **DELETE エンドポイント**: 物理削除 → `deletedAt` 設定 + name/token リネーム（unique 制約回避）
- **全 Machine クエリ**: 約20箇所に `deletedAt: null` フィルタ追加
- **`findUnique` → `findFirst`**: 6箇所（deletedAt 条件追加のため Prisma の制約で変更必要）
- **関連データ保持**: Session/Message/BuildLog/Project は削除せず、relation 経由で引き続きアクセス可能
- **変更ファイル**:
  - `apps/server/prisma/schema.prisma` - deletedAt カラム
  - `apps/server/src/index.ts` - startup reset フィルタ
  - `apps/server/src/routes/api.ts` - soft delete 化 + 全クエリフィルタ
  - `apps/server/src/routes/public-api.ts` - トークン検証フィルタ
  - `apps/server/src/services/agent-manager.ts` - token 認証・heartbeat フィルタ
  - `apps/server/src/services/command-handler.ts` - Machine クエリフィルタ
  - `apps/server/src/services/platform-link.ts` - マージ時フィルタ

#### 94. Conversations 画像ライトボックス (2026-02-28)

Conversations ページの添付画像をクリックでフルスクリーン表示できるようにした。

- **FileList**: インラインプレビュー廃止 → サムネイル（64x64）+ クリックでライトボックス
- **ライトボックス**: 黒半透明オーバーレイ + `max-w-[90vw] max-h-[90vh]` の大きな画像
- **閉じる**: 背景クリック or Escape キー
- **変更ファイル**: `apps/web/src/pages/ConversationsPage.tsx`

#### 95. Kill コマンド (2026-02-28)

実行中の AI プロセスを途中でキャンセルできる `k` / `kill` コマンドを追加。
長時間実行中の Claude Code セッションを Discord/Telegram から中断できるようになった。

- **ショートカット**: `k` → `kill` コマンド
- **Agent**: `cancelAiSession` で子プロセスを SIGTERM で停止
- **Server**: `server:ai:cancel` → Agent → `agent:ai:cancelled` の往復
- **Discord/Telegram**: キャンセル完了メッセージを表示
- **変更ファイル**:
  - `packages/shared/src/constants.ts` - `k` ショートカット追加
  - `packages/shared/src/types.ts` - `AiCancelPayload`, `AiCancelledPayload`, メッセージ型追加
  - `agents/linux/src/services/ai-runner.ts` - `cancelAiSession` 関数
  - `agents/linux/src/services/connection.ts` - `handleAiCancel` ハンドラ
  - `apps/server/src/services/agent-manager.ts` - `cancelAiProcess`, `handleAiCancelled`
  - `apps/server/src/services/command-handler.ts` - `kill` コマンド処理
  - `apps/server/src/services/command-parser.ts` - `kill` コマンドパーサー

#### 96. Server 管理プロジェクト検索パス (2026-02-28)

Agent のプロジェクト検索パス（`projectsDirs`）を WebUI から設定・同期する機能を追加。
従来は Agent の `~/.devrelay/config.yaml` を手動編集する必要があったが、
WebUI の Agent Settings モーダルからタグ UI でパスを追加・削除できるようになった。

- **DB**: Machine テーブルに `projectsDirs Json?` カラム追加
- **API**: `GET/PUT /api/machines/:id/projects-dirs`（DB 値 + Agent ローカル値の両方を返す）
- **WebUI**: Agent Settings モーダルにタグ UI（追加・削除・Save & Apply ボタン）
- **リアルタイム配信**: `pushConfigUpdate` → `server:config:update` メッセージで Agent に即時配信
- **ping リトライ機構**: WebSocket 送信失敗に備え `pendingConfigUpdates` Map で管理、
  Agent の `agent:ping` 受信時にリトライ送信（最大5回）。`agent:config:ack` で確認。
- **Agent 側**: `handleProjectsDirsUpdate` で config.yaml 更新 + プロジェクト再スキャン + ack 送信
- **接続時同期**: `server:connect:ack` で DB の最新値を配信（Agent 再接続時にも自動反映）
- **変更ファイル**:
  - `packages/shared/src/types.ts` - `ServerConfigUpdatePayload`, `agent:config:ack` 型追加
  - `apps/server/prisma/schema.prisma` - `projectsDirs Json?`
  - `apps/server/src/services/agent-manager.ts` - `pendingConfigUpdates`, ping リトライ, config:ack
  - `apps/server/src/routes/api.ts` - projects-dirs API
  - `apps/web/src/lib/api.ts` - `getProjectsDirs`, `setProjectsDirs`
  - `apps/web/src/pages/MachinesPage.tsx` - Project Search Paths UI
  - `agents/linux/src/services/connection.ts` - `handleProjectsDirsUpdate`, config:ack, デバッグログ

#### 97. プランモード読み取り専用コマンド許可 + deploy-agent スクリプト (2026-02-28)

プランモード中に読み取り専用の Bash コマンド（pm2 logs, git status, journalctl 等）を実行できるようにした。
Claude Code の `--allowedTools` フラグと `--permission-mode plan` を組み合わせることで、
セキュリティを維持しつつ調査・ログ確認が可能になった。

- **PLAN_MODE_ALLOWED_TOOLS**: 26個の読み取り専用 Bash コマンドパターンを定義
  - PM2: `pm2 logs`, `pm2 log`, `pm2 status`, `pm2 list`, `pm2 show`, `pm2 describe`
  - systemd: `journalctl`, `systemctl status`, `systemctl is-active`
  - Git: `git log`, `git status`, `git diff`, `git show`, `git branch`
  - システム: `ps`, `free`, `df`, `du`, `ss`, `netstat`
  - Docker: `docker ps`, `docker logs`, `docker compose ps`, `docker compose logs`
- **セキュリティ**: `Bash(pm2 logs)` パターンで細粒度制御（pm2 logs は許可、pm2 restart はブロック）
- **PLAN_MODE_INSTRUCTION**: ログ確認コマンドが実行可能であることを AI に通知する文言を追加
- **deploy-agent スクリプト**: `pnpm deploy-agent` で開発リポからインストール済み Agent にビルド成果物をコピー
  - `/opt/devrelay/agents/linux/dist/*` → `~/.devrelay/agent/agents/linux/dist/`
  - `pnpm build` + `cp -r` を一括実行
- **変更ファイル**:
  - `agents/linux/src/services/ai-runner.ts` - `PLAN_MODE_ALLOWED_TOOLS` 定数、`allowedTools` オプション、`--allowedTools` 引数構築
  - `agents/linux/src/services/connection.ts` - `PLAN_MODE_ALLOWED_TOOLS` の import と `sendOptions` への設定
  - `agents/linux/src/services/output-collector.ts` - `PLAN_MODE_INSTRUCTION` にログ確認の記述追加
  - `package.json` - `deploy-agent` スクリプト追加

#### 98. allowedTools フォーマット修正 (2026-02-28)

`--allowedTools` のフォーマットを実機テストで確認した正しい形式に修正。

- **修正前**: ツールごとに `--allowedTools "Bash(pm2 logs *)"` を26回繰り返し
- **修正後**: `--allowedTools "Bash(pm2 logs),Bash(pm2 log),..."` とカンマ区切りで1回
- **ワイルドカード削除**: `Bash(pm2 logs *)` → `Bash(pm2 logs)`（`*` 不要）
- **変更ファイル**:
  - `agents/linux/src/services/ai-runner.ts` - `PLAN_MODE_ALLOWED_TOOLS` から `*` 削除、`join(',')` でカンマ区切り結合

#### 99. allowedTools を Server DB + WebUI 管理に移行 (2026-02-28)

ハードコードされていた `PLAN_MODE_ALLOWED_TOOLS` 定数を Server の UserSettings DB に移行し、
WebUI の Settings ページから Linux / Windows 別に編集可能にした。
ツール追加のたびに Agent 再デプロイが不要になった。

- **デフォルト定数を shared に移動**:
  - `DEFAULT_ALLOWED_TOOLS_LINUX`: 33 コマンド（pm2, systemd, git, system, docker, tail/head/wc, curl/lsof/uptime, caddy）
  - `DEFAULT_ALLOWED_TOOLS_WINDOWS`: 27 コマンド（pm2, git, PowerShell, docker, Get-Content/type, curl/Invoke-WebRequest）
- **UserSettings キー**: `allowedTools:linux`, `allowedTools:windows`（JSON 文字列配列）
- **専用 API エンドポイント**:
  - `GET /api/settings/allowed-tools` — 両 OS のカスタム値 + デフォルト値を返す
  - `PUT /api/settings/allowed-tools` — 保存 + 該当 OS のオンライン Agent にリアルタイム配信
- **Agent 配信**: `server:connect:ack` の `allowedTools` フィールド + `server:config:update` で動的更新
  - `managementInfo.os` で Agent の OS を判定し、対応する OS の設定を配信
  - `pendingConfigUpdates` で `projectsDirs` と `allowedTools` のマージ対応
- **Agent 側**: メモリ変数 `serverAllowedTools` で保持、`null` の場合は `DEFAULT_ALLOWED_TOOLS_LINUX` にフォールバック
- **WebUI**: Settings ページに Allowed Tools セクション追加
  - Linux / Windows を横並び（CSS grid `lg:grid-cols-2`）で表示
  - 各 OS ごとに独立したテキストエリア（1行1コマンド）+ Save / Reset to Default ボタン
  - Custom / Default ステータスバッジ表示
- **変更ファイル**:
  - `packages/shared/src/constants.ts` - `DEFAULT_ALLOWED_TOOLS_LINUX/WINDOWS` 追加
  - `packages/shared/src/types.ts` - `ServerConnectAckPayload`, `ServerConfigUpdatePayload` に `allowedTools` 追加
  - `apps/server/src/services/user-settings.ts` - `ALLOWED_TOOLS_LINUX/WINDOWS` キー追加
  - `apps/server/src/routes/api.ts` - allowed-tools 専用 GET/PUT エンドポイント
  - `apps/server/src/services/agent-manager.ts` - connect:ack に allowedTools 含める + OS 別配信 + `pushAllowedToolsToAgents()`
  - `agents/linux/src/services/ai-runner.ts` - ハードコード定数削除 → shared の re-export
  - `agents/linux/src/services/connection.ts` - `serverAllowedTools` 受信・保持・適用
  - `apps/web/src/lib/api.ts` - `allowedTools` API クライアント追加
  - `apps/web/src/pages/SettingsPage.tsx` - Allowed Tools エディタ UI

#### 100. allowedTools ワイルドカード修正 (2026-02-28)

`--allowedTools` パターンに `*` ワイルドカードを復元。
#98 で `*` を削除していたが、Claude Code の仕様上 `Bash(pm2 logs)` は完全一致のみで、
`pm2 logs devrelay-agent --lines 10` のような引数付きコマンドがブロックされていた。

- **修正前**: `Bash(pm2 logs)` → `pm2 logs` のみ許可（引数付きはブロック）
- **修正後**: `Bash(pm2 logs *)` → `pm2 logs` + 任意の引数を許可
- **全パターンに `*` を追加**: 引数付きコマンドのプレフィックスマッチ
- **引数なし完全一致も追加**: `pm2 status`, `git status`, `free`, `df` 等のよく引数なしで使うコマンド
  - `Bash(pm2 status *)` だけでは `pm2 status`（引数なし）がブロックされる
  - `Bash(pm2 status)` + `Bash(pm2 status *)` の両方が必要
- **最終パターン数**: Linux 46（33→46）、Windows 38（27→38）
- **セキュリティ**: Claude Code はコマンドチェーン（`&&`, `||`）を自動検出してブロックするため `*` があっても安全
- **変更ファイル**:
  - `packages/shared/src/constants.ts` - `*` 追加 + 引数なし完全一致パターン追加
  - `rules/project.md` - allowedTools フォーマット注意点を修正

#### 101. Agent リモート更新コマンド (`u` / `update`) (2026-03-01)

Discord/Telegram から Agent のバージョン確認・リモート更新を実行するコマンドを追加。
SSH なしで Agent を最新版に更新可能にした。

- **コマンドフロー**:
  - 1回目の `u`: git fetch → ローカル/リモートのコミット比較 → バージョン情報表示
  - 更新なし: `✅ Agent は最新です` で終了
  - 更新あり: `📦 更新があります。もう一度 u を送信すると更新を実行します。`
  - 2回目の `u`: detached プロセスで git pull + ビルド + 再起動
- **2回連続確認パターン**: `x`（clear）コマンドと同じ `pendingUpdate` Set 方式
- **Agent 側処理**:
  - `handleVersionCheck()`: `git log` + `git fetch` + `git log origin/main` でバージョン比較
  - `handleAgentUpdate()`: detached 子プロセスで更新スクリプトを実行（親の再起動に影響されない）
  - 開発リポジトリ検出: `~/.devrelay/agent/` 配下でなければ開発リポとみなし更新拒否
  - 管理コマンド（PM2/systemd/nohup）を `managementInfo` から取得して再起動
- **Linux/Windows 両対応**: bash / PowerShell で分岐
- **プロキシ対応**: `config.yaml` のプロキシ設定を git/pnpm に自動適用
- **エラー通知**: `agent:update:status` で失敗時にリクエスト元のチャットに通知
- **WebSocket メッセージ**:
  - `server:agent:version-check` → `agent:version:info`（Promise パターン、30秒タイムアウト）
  - `server:agent:update` → `agent:update:status`（started/error）
- **変更ファイル**:
  - `packages/shared/src/constants.ts` - `u`/`update` ショートカット追加
  - `packages/shared/src/types.ts` - `AgentVersionInfoPayload`, `AgentUpdateStatusPayload` + メッセージ型追加
  - `apps/server/src/services/command-parser.ts` - `u`/`update` パース + ヘルプテキスト追加
  - `apps/server/src/services/command-handler.ts` - `handleUpdate()` + `pendingUpdate` Set
  - `apps/server/src/services/agent-manager.ts` - `checkAgentVersion()`, `updateAgent()` + ハンドラ追加
  - `agents/linux/src/services/connection.ts` - `handleVersionCheck()`, `handleAgentUpdate()` 追加

#### 102. isTraditionalCommand を SHORTCUTS 参照に変更 (2026-03-01)

`isTraditionalCommand()` がハードコードの正規表現を持っていたため、#101 で追加した `u`/`update` や
#95 の `k`/`kill` がセッション接続中に AI プロンプトとして処理されるバグを修正。

- **根本原因**: コマンド定義が2箇所に分散（`SHORTCUTS` 定数 vs `isTraditionalCommand` の正規表現）
- **修正方針**: `isTraditionalCommand()` を `SHORTCUTS` 定数（単一ソース・オブ・トゥルース）を参照するように書き換え
- **SHORTCUTS 参照**: `trimmed in SHORTCUTS` で即判定 → 新コマンド追加時に `isTraditionalCommand` の修正が不要に
- **動的パターン**: 数字選択、`e, <prompt>`、`ai:*`、`a <arg>`、`log\d+`、`sum\d+d?` は個別チェックを残す
- **変更ファイル**:
  - `apps/server/src/services/natural-language-parser.ts` - `SHORTCUTS` import + `isTraditionalCommand()` 書き換え

#### 103. agreement コマンドの User Message 保存 (2026-03-01)

`ag` コマンド実行時に Conversations ページで User Message が `(empty)` と表示されるバグを修正。

- **根本原因**: `handleAgreement()` に `prisma.message.create()` がなく、ユーザーメッセージが DB に保存されていなかった
- **修正**: `handleExec()` と同パターンで `[agreement]` マーカーを保存してから Agent に送信
- **変更ファイル**:
  - `apps/server/src/services/command-handler.ts` - `handleAgreement()` にメッセージ保存を追加

#### 104. ビルド・再起動案内の条件付き化 (2026-03-01)

「ビルド完了。以下のコマンドで再起動してください」のメッセージがドキュメント変更のみの場合にも
出力されていた問題を改善。ルール文書を条件付きに書き換え。

- **問題**: `CLAUDE.md` / `rules/project.md` のルールが無条件で再起動案内を出すよう指示していた
- **改善**: `.ts` ファイル変更 + `pnpm build` 実行時のみ案内、`.md` のみの変更では案内不要と明記
- **変更ファイル**:
  - `CLAUDE.md` - DevRelay 自身の開発時の注意セクション
  - `rules/project.md` - サービス再起動禁止セクション

#### 105. Agent 更新完了通知メッセージ (2026-03-01)

`u` コマンドで Agent を更新した際、「🔄 Agent を更新中...」の後に更新完了メッセージが出ない問題を修正。

- **問題**: Agent 再起動→再接続後に「更新が完了した」ことがユーザーに通知されなかった
- **修正**: `handleAgentConnect()` で `pendingUpdateNotify` Map をチェックし、更新後の再接続なら完了メッセージを送信
- **メッセージ**: `✅ **マシン名** の更新が完了しました`
- **変更ファイル**:
  - `apps/server/src/services/agent-manager.ts` - `handleAgentConnect()` 末尾に完了通知を追加、コメント修正

#### 106. サーバー再起動時に currentMachineId が失われるバグ修正 (2026-03-01)

サーバー再起動後に `u` 等のコマンドを送ると「エージェントに接続されていません」と表示され、
`c` を押して再接続しないと使えない問題を修正。

- **根本原因**: サーバー起動時に全マシンを `offline` に設定した後、`restoreSessionParticipants()` がオフラインマシンの ChannelSession をクリアしていた。全マシンが offline なので全セッション情報が消失
- **修正**: マシンがオフラインの場合に ChannelSession をクリアせず保持。Agent 再接続時に `restoreSessionParticipantsForMachine()` がセッション参加者を復元
- **変更ファイル**:
  - `apps/server/src/services/session-manager.ts` - `restoreSessionParticipants()` のオフライン分岐を修正

#### 107. Dev Reports（AI 開発レポート生成）(2026-03-01)

会話履歴から AI で開発レポートを自動生成する機能を追加。

- **概要**: 指定日付範囲の exec 会話を分析し、マークダウン形式のレポートを生成
- **レポート構成**: タイトル、サマリー、詳細エントリ（各 exec の要約・変更ファイル・影響度）
- **マルチプロバイダー**: OpenAI / Anthropic / Gemini から選択可能
- **DB モデル**: `DevReport`（レポート全体）+ `DevReportEntry`（各 exec のエントリ）
- **WebUI**: Dev Reports ページ（プロジェクト・日付選択 → 生成 → 一覧・詳細・ダウンロード）
- **API エンドポイント**: `GET /api/dev-reports/projects`, `GET /api/dev-reports`, `GET /api/dev-reports/:id`, `POST /api/dev-reports`, `GET /api/dev-reports/:id/download`, `DELETE /api/dev-reports/:id`
- **変更ファイル**:
  - `apps/server/prisma/schema.prisma` - DevReport / DevReportEntry モデル追加
  - `apps/server/src/services/dev-report-generator.ts` - レポート生成サービス（新規）
  - `apps/server/src/services/user-settings.ts` - `DEV_REPORT_PROVIDER` キー追加
  - `apps/server/src/routes/api.ts` - Dev Reports API エンドポイント追加
  - `apps/web/src/pages/DevReportsPage.tsx` - Dev Reports ページ（新規）
  - `apps/web/src/pages/SettingsPage.tsx` - Dev Report プロバイダー選択追加
  - `apps/web/src/components/Layout.tsx` - ナビゲーション追加
  - `apps/web/src/App.tsx` - ルート追加

#### 107.1. Dev Reports 独立 AI プロバイダー設定 (2026-03-01)

Dev Reports の AI プロバイダーを他機能（ビルド要約・チャット AI）と独立して設定可能に。

- **変更**: `DEV_REPORT_PROVIDER` を SettingKeys に追加、`getApiKeyForDevReport()` で独立取得
- **WebUI**: Settings ページの PROVIDER_SELECTS に「Dev Report」行を追加

#### 107.2. Conversations ページの表示修正 (2026-03-01)

Conversations ページに一部のメッセージが表示されない問題を修正。

- **バグ1: userId フィルタ不正**: `(request as any).userId` を使っていたが、`request.user.id` が正しい参照。`request.userId` は `undefined` → Prisma が条件を無視 → 全ユーザーのデータが返却される状態だった
- **バグ2: usageData 必須フィルタ**: `usageData: { not: Prisma.DbNull }` フィルタにより、usageData がないメッセージ（旧 Agent・Agreement 実行等）が除外されていた
- **修正**:
  - `(request as any).userId` → `(request as any).user.id` に修正（2箇所）
  - `usageData: { not: Prisma.DbNull }` フィルタを削除（一覧・件数の両方）
  - `aiMsg.usageData as any` → `(aiMsg.usageData as any) || {}` でnull安全に
  - `hasUsageData()` ヘルパー関数で usageData の有無を判定し、ない場合は `-` / `N/A` を表示
- **変更ファイル**:
  - `apps/server/src/routes/api.ts` - userId 修正 + usageData フィルタ削除 + null 安全化
  - `apps/web/src/pages/ConversationsPage.tsx` - `hasUsageData()` 追加 + 表示分岐

#### 107.3. Agent 更新時の旧プロセス残留バグ修正 (2026-03-01)

`u` コマンドで Agent を更新した際、nohup 起動の Agent で旧プロセスが kill されず、
複数インスタンスが同時稼働するバグを修正。

- **問題**: nohup の restart コマンドが新プロセス起動のみで、旧プロセスの停止ステップがなかった。systemd/PM2 は restart が自動的に旧プロセスを停止するため nohup のみ影響
- **影響**: 同一 machineId で複数 WebSocket 接続 → 重複メッセージが DB に保存 → Conversations に同じ exec が2行表示
- **修正**: nohup の restart コマンドに `pgrep | xargs kill` を追加して旧プロセスを停止してから新プロセスを起動
  ```bash
  pgrep -u $(whoami) -f "\\.devrelay.*index\\.js" | xargs kill 2>/dev/null || true; sleep 1; cd <dir> && nohup <node> <index.js> ...
  ```
- **変更ファイル**:
  - `agents/linux/src/services/management-info.ts` - nohup restart コマンドに旧プロセス停止を追加

---

### #108: macOS Agent（Phase 1） (2026-03-02)

agents/linux をフォークして macOS 専用の Agent を作成。launchd（LaunchAgent）によるプロセス管理、
macOS 固有のパス・コマンドに対応。install-agent.sh を Linux/macOS クロスプラットフォーム対応に拡張。
WebUI の Agent Settings に macOS タブを追加。

#### 変更概要

**新規: agents/macos/**
- `agents/linux/` をフォークして macOS 専用 Agent として独立
- パッケージ名: `@devrelay/agent-macos`
- プロセス管理: launchd（LaunchAgent plist）で自動起動・管理
- plist パス: `~/Library/LaunchAgents/io.devrelay.agent.plist`

**management-info.ts（完全書き換え）**
- `generateDarwinInfo()`: launchd / PM2 / nohup を自動検出
- `os: 'darwin'`, `installType: 'launchd'`
- launchctl コマンド（start/stop/restart/logs）を生成

**config.ts**
- `getDefaultProjectsDirs()`: macOS はホームディレクトリのみ（`/opt` なし）

**setup.ts（完全書き換え）**
- `installLaunchAgent()`: plist XML 生成 + `launchctl load -w`
- PATH に `/opt/homebrew/bin` を含む（Apple Silicon の Homebrew パス）
- `KeepAlive`, `RunAtLoad` 有効

**status.ts（完全書き換え）**
- `launchctl list io.devrelay.agent` でステータス確認
- 非 launchd 環境は pgrep にフォールバック

**uninstall.ts（完全書き換え）**
- `launchctl unload` + plist ファイル削除
- 非 launchd 環境は pgrep でプロセス停止

**connection.ts**
- ビルドフィルタを `@devrelay/agent-macos` に変更

**packages/shared/src/types.ts**
- `ManagementInfo.installType` に `'launchd'` を追加

**scripts/install-agent.sh（大幅拡張）**
- `uname -s` で OS 自動判定（Darwin / Linux）
- macOS: `base64 -D`, `sed -i ''`, Node.js URL `darwin-arm64`
- `sed_inplace()` ラッパー関数で macOS/Linux 互換
- Step 6: macOS は launchd 登録（plist 生成 + `launchctl load -w`）
- macOS の git エラー: `xcode-select --install` を案内
- `AGENT_PKG` / `AGENT_SUBDIR` で macOS/Linux のパッケージを切り替え

**apps/web/src/pages/MachinesPage.tsx**
- OS タブを Linux / macOS / Windows の3タブに拡張
- `getInstallCommand()`: macOS は Linux と同じ curl コマンド（install-agent.sh が自動判定）
- `getUninstallCommand()`: macOS 用に launchctl unload コマンドを追加
- ヘルプテキスト: macOS は「Requires: Node.js 20+, git, Xcode CLT」
- アンインストールヘルプ: macOS は「Stops agent, removes LaunchAgent」
- Management Commands ラベル: `darwin` → `macOS` 表示に対応

---

### #111: インストーラー プロキシ早期判定 + pnpm 自動インストール復活 + サービス環境変数修正 (2026-03-03)

プロキシ環境（企業ネットワーク等）でのインストーラー実行に関する複数の問題を修正。

#### 1. プロキシ判定の早期化（問題A）
- `scripts/install-agent.sh`: プロキシ設定プロンプトを依存ツールチェック（Step 1）の**前**に移動
- `scripts/install-agent.ps1`: 同様にプロキシ設定プロンプトを Step 1 前に移動
- これにより Node.js ダウンロード・pnpm インストール・トークン検証すべてでプロキシが有効になる

#### 2. pnpm 自動インストール復活（問題A）
- `scripts/install-agent.sh`: #110 で廃止した pnpm 自動インストールを復活
- `npm install -g pnpm` → 失敗なら `sudo npm install -g pnpm` にフォールバック
- プロキシ環境変数が事前にセットされた状態で実行されるため、プロキシ経由での自動インストールが可能

#### 3. systemd / LaunchAgent / crontab のサービス環境変数修正（問題B,C）
- **PATH 問題**: systemd サービスは `.bashrc` を読まないため `~/.local/bin`（claude CLI）が PATH にない → サービスファイルに PATH を明示指定
  - `~/.local/bin`（claude CLI の一般的なインストール先）
  - `~/.devrelay/bin`（devrelay-claude シンボリックリンク）
  - Node.js のバイナリディレクトリ
- **プロキシ問題**: systemd サービスにプロキシ環境変数がなく claude CLI が API に接続できない（ECONNRESET） → `HTTP_PROXY`/`HTTPS_PROXY`/`http_proxy`/`https_proxy` を設定
- macOS LaunchAgent: PATH に `~/.local/bin` と `~/.devrelay/bin` を追加、プロキシ設定を追加
- nohup + crontab: @reboot エントリに PATH とプロキシ環境変数を埋め込み

### #110: インストーラー pnpm 自動インストール廃止 (2026-03-02)

- `scripts/install-agent.sh`: pnpm が未インストールの場合、自動インストールを試みず即エラー終了するよう変更
- pnpm は git と同様の必須前提条件として扱い、手動インストールを促すメッセージを表示

### #109: Agent 二重完了メッセージ防止 & マシン名重複解決 & インストーラー改善 (2026-03-02)

3つの改善を実施。

#### 1. AI 応答の二重 Message 作成防止

**問題**: Conversations ページで同じ AI 応答が2行に分かれて表示されることがあった（1行目に usageData あり、2行目に usageData なし）

**原因**:
- `ai-runner.ts` の `close` ハンドラーで `resumeFailed` 設定後に `return` がなく、`onOutput(true)` が呼ばれた後に retry でも `onOutput(true)` が呼ばれて2つの Message が作成された
- `error` + `close` イベントの競合で `onOutput(true)` が2回呼ばれる可能性があった

**修正**:
- `agents/linux/src/services/ai-runner.ts`: `completionSent` ガード変数を追加し、`onOutput(true)` の二重呼び出しを防止。`resumeFailed` 設定後に `resolve + return` を追加
- `agents/linux/src/services/connection.ts`: コールバックに `completionSent` ガードを追加し、`isComplete=true` の二重送信を防止
- `agents/macos/` にも同じ修正を適用

#### 2. マシン名重複時の自動リネーム

**問題**: 別サーバーに接続していた Agent を再インストールすると、DB に旧マシン名が残っており、仮名（`agent-N`）から正式名への自動更新が重複チェックに引っかかってスキップされた

**修正**:
- `apps/server/src/services/agent-manager.ts`: 重複マシンが **offline** の場合、旧マシン名に `(old)` を付与してリネームし、新マシンに名前を譲るロジックを追加

#### 3. インストーラーの pnpm 権限エラー対策

**問題**: `npm install -g pnpm` がグローバルインストール権限不足（EACCES）で失敗し、`set -e` によりスクリプトが即終了していた

**修正**:
- `scripts/install-agent.sh`: `npm install -g pnpm` 失敗時に `sudo npm install -g pnpm` へ自動フォールバック

---

### #112: "Prompt is too long" stdout 検出修正 & インストーラー Claude Code 必須チェック (2026-03-03)

#### 1. "Prompt is too long" stdout 検出修正

**問題**: Claude Code が "Prompt is too long" を stderr ではなく stdout の通常アシスタント応答（JSON）として出力するケースがあり、既存の stderr ベースの検出が効かず、英語エラーメッセージがそのまま Discord/Telegram に表示されていた。

**修正（3 Agent 共通）**:
- `agents/linux/src/services/ai-runner.ts`: stdout パースで "Prompt is too long" を検出・抑制、close ハンドラで統合検出
- `agents/macos/src/services/ai-runner.ts`: 同上
- `agents/windows/src/services/ai-runner.ts`: 同上

**動作**:
- `promptTooLong` フラグで stdout 出力を検出・ストリーミング抑制
- `--resume` あり → `resumeFailed` で新規セッション retry
- `--resume` なし → 日本語警告「⚠️ プロンプトが長すぎます。`x` コマンドで会話履歴をクリアしてください。」を送信

#### 2. インストーラー Claude Code 必須チェック

**変更**: Claude Code をオプションから**必須依存**に変更。未インストール時はインストールを停止してユーザーにインストール方法を案内する。

**修正**:
- `scripts/install-agent.sh`: Step 1 に Claude Code 必須チェックを追加（git と同じ `exit 1` パターン）。`~/.local/bin/claude` がある場合は自動 PATH 追加で救済
- `scripts/install-agent.ps1`: Step 1 に Claude Code チェックを追加（`$Missing++` パターン）

---

### #113: MessageFile ベクトル検索 + Claude Code スキル (2026-03-04)

既存の `MessageFile` テーブルに pgvector ベクトル埋め込みを追加し、Claude Code のスキル機能で過去のファイルをプロジェクト横断でセマンティック検索できるようにした。

#### 1. pgvector + DB スキーマ変更

- `MessageFile` モデルに `textContent`（テキスト抽出結果）、`embeddingStatus`（none/processing/done/failed/skipped）を追加
- raw SQL で `embedding vector(1536)` カラム + ivfflat インデックスを追加
- PostgreSQL の pgvector 拡張を有効化（`CREATE EXTENSION vector`）

#### 2. 埋め込み生成サービス

- **新規**: `apps/server/src/services/embedding-service.ts`
- テキスト系ファイル（text/*, json, yaml 等）を自動でテキスト抽出 → OpenAI `text-embedding-3-small` で 1536 次元ベクトル生成
- `command-handler.ts`（input）と `agent-manager.ts`（output）の MessageFile 作成後に fire-and-forget で非同期実行
- OpenAI API キーがない場合は `embeddingStatus = 'skipped'`（ファイル保存は正常に行われる）
- バイナリファイル（画像, PDF, ZIP）は自動スキップ

#### 3. 検索 API

- **新規**: `apps/server/src/routes/document-api.ts`
- `POST /api/agent/documents/search`: ベクトル類似検索（マシントークン認証）
- `GET /api/agent/documents/:id`: ファイルテキスト内容取得（マシントークン認証）
- `Authorization: Bearer <machine_token>` でマシン → ユーザー ID を解決、ユーザーの全ファイルを横断検索

#### 4. Claude Code スキル

- **新規**: `agents/linux/src/services/skill-manager.ts`（macOS Agent も同一）
- Agent 接続成功時に `~/.claude/skills/devrelay-docs/` にスキルファイルを自動配置
  - `SKILL.md`: スキル定義（description で自動発火、「〜を参照して」系で発動）
  - `scripts/search.sh`: config.yaml の serverUrl/token を使ってサーバー API を呼び出す検索スクリプト
- Claude Code が「さっきのマニュアルを参照して」のような発言を検出するとスキルが自動発火し、セマンティック検索で関連ファイルを取得

#### 変更ファイル

| ファイル | 操作 |
|---------|------|
| `apps/server/prisma/schema.prisma` | 修正（MessageFile に textContent, embeddingStatus 追加） |
| `apps/server/src/services/embedding-service.ts` | **新規**（埋め込み生成 + 類似検索） |
| `apps/server/src/routes/document-api.ts` | **新規**（検索 API） |
| `apps/server/src/index.ts` | 修正（ルート登録） |
| `apps/server/src/services/command-handler.ts` | 修正（input ファイル embedding フック） |
| `apps/server/src/services/agent-manager.ts` | 修正（output ファイル embedding フック） |
| `agents/linux/src/services/skill-manager.ts` | **新規**（スキル自動配置） |
| `agents/linux/src/services/connection.ts` | 修正（接続時スキル初期化） |
| `agents/macos/src/services/skill-manager.ts` | **新規**（スキル自動配置） |
| `agents/macos/src/services/connection.ts` | 修正（接続時スキル初期化） |

### #114: u コマンド後の WebSocket stale 参照修正 (2026-03-04)

`u` コマンドで Agent を更新した後、Server が古い WebSocket 参照（readyState=3 CLOSED）を保持し続け、Agent への全メッセージ送信が失敗する問題を修正。

#### 原因

Agent 再起動時の WebSocket close/reconnect タイミングにより、`connectedAgents` Map に CLOSED 状態の WebSocket が残る場合があった。

#### 修正内容

1. **`sendToAgent` 自己修復**: readyState !== OPEN の WebSocket を検出した場合、stale エントリを `connectedAgents` から自動削除し、マシンを offline にマーク
2. **`handleAgentConnect` で旧 WS 強制クローズ**: Agent 再接続時に同じ machineId の古い WebSocket が残っていれば明示的に close

#### 変更ファイル

| ファイル | 操作 |
|---------|------|
| `apps/server/src/services/agent-manager.ts` | 修正（sendToAgent 自己修復 + handleAgentConnect 旧 WS クローズ） |

### #115: u コマンド更新スクリプト堅牢化 (2026-03-04)

nohup 方式の Agent で `u` コマンド実行後、ビルド失敗時にリスタートが実行されず Agent が停止したままになる問題を修正。

#### 原因

更新スクリプトの全ステップが `&&` で連結されていたため、ビルドが1つでも失敗するとリスタートコマンドが実行されなかった。
また `stdio: 'ignore'` でスクリプト出力が破棄されており、障害時の原因特定が困難だった。

#### 修正内容

1. **リスタートを `&&` チェーンから分離**: ビルド成否に関わらず必ずリスタートを実行（旧 dist/ コードで復帰）
2. **更新ログ出力**: `~/.devrelay/logs/update.log` にスクリプトの全出力を記録
3. **Node.js パスフォールバック**: nohup リスタートで `process.execPath` が存在しない場合、PATH 上の `node` にフォールバック
4. Linux Agent + macOS Agent の両方に適用

#### 変更ファイル

| ファイル | 操作 |
|---------|------|
| `agents/linux/src/services/connection.ts` | 修正（更新スクリプト堅牢化 + ログ出力） |
| `agents/linux/src/services/management-info.ts` | 修正（nohup リスタート Node.js パスフォールバック） |
| `agents/macos/src/services/connection.ts` | 修正（同上） |
| `agents/macos/src/services/management-info.ts` | 修正（同上） |

### #116: u コマンド更新スクリプト自殺防止 (2026-03-04)

nohup 方式の Agent で `u` コマンド実行後、Agent が復帰しない問題を修正。

#### 根本原因

更新スクリプトは `spawn('bash', ['-c', script])` で起動される。
スクリプト内のリスタートコマンドで `pgrep -f "\.devrelay.*index\.js"` を実行するが、
bash プロセス自身の cmdline（`bash -c ".../.devrelay/agent/agents/linux/dist/index.js..."`）が
このパターンにマッチし、`xargs kill` でスクリプト自身が kill される。
結果、後続の `nohup node index.js &` が実行されず Agent が停止したままになる。

PM2/systemd の restart コマンドには `pgrep` パターンが含まれないため影響なし。

#### 修正内容

1. **connection.ts: nohup 専用リスタートコマンド構築**
   - `restartCmd.command`（management-info.ts 由来）をそのまま使わず、更新スクリプト専用のリスタートを構築
   - `grep -v "^$$\$"` で自身の PID を pgrep 結果から除外して自殺を防止
   - `node` を PATH 経由で解決（スクリプト冒頭で `~/.devrelay/node/bin` を PATH に追加済み）
   - `process.execPath` のハードコードによる鶏と卵問題を回避
2. **management-info.ts: stop/restart コマンドにも PID 除外追加**
   - WebUI からの手動実行時も安全に動作するよう `grep -v "^$$\$"` を追加
   - `agent.log` を `>`（上書き）→ `>>`（追記）に変更
3. Linux Agent + macOS Agent の両方に適用

#### 変更ファイル

| ファイル | 操作 |
|---------|------|
| `agents/linux/src/services/connection.ts` | 修正（nohup 専用リスタートコマンド構築） |
| `agents/linux/src/services/management-info.ts` | 修正（PID 除外 + ログ追記モード） |
| `agents/macos/src/services/connection.ts` | 修正（同上） |
| `agents/macos/src/services/management-info.ts` | 修正（同上） |

**追加修正**:
- ESM モジュール（connection.ts）で `__dirname` が未定義のため `ReferenceError` でクラッシュしていた問題を修正。`fileURLToPath(import.meta.url)` + `dirname()` に置き換え。
- 堅牢化: spawn エラーハンドリング（`.on('error')`）、ログディレクトリ事前作成（`mkdirSync`）、二重更新防止フラグ、ステップ別 exit code ログ記録、5分タイムアウト通知
- Windows PowerShell 更新スクリプトにステップ別 `$LASTEXITCODE` ログ記録を追加（bash の `runAndLog` と同等の `psRunAndLog` ヘルパー）
- Windows Agent の `isInstalledAgent()` パス判定バグ修正: `homedir() + '.devrelay/agent'` を `getConfigDir() + 'agent'` に変更。Windows は `%APPDATA%\devrelay\agent\` にインストールされるが、Linux パスとの不一致で常に devRepo と判定され `u` コマンドが拒否されていた
- Windows Agent `u` コマンド動作確認済み（2026-03-05）: ワンライナーインストール環境でバージョンチェック + リモート更新が正常動作
- Windows `logsDir` パス修正: `homedir() + '.devrelay/logs'` → `getConfigDir() + 'logs'`。`update.log` が `%APPDATA%\devrelay\logs\` に正しく書き込まれるように修正
- Windows 更新スクリプトに stop コマンド追加: restart の前に `Get-CimInstance Win32_Process` で旧 Agent プロセスを kill。Linux nohup の `pgrep | xargs kill` と同等の処理。旧プロセスが生き続けて更新が反映されない問題を修正
- `updateInProgress` boolean → `updateStartedAt` タイムスタンプに変更: 60秒以内の連打のみブロックし、それ以降は自動解除。永久ロック問題を構造的に解決（5分タイムアウトとバージョンチェックリセットは不要になり削除）
- **Windows PowerShell 更新スクリプトをファイル実行方式に変更**: `spawn('powershell', ['-Command', script])` → `update.ps1` ファイルに書き出して `-File` で実行。`-Command` では二重引用符の競合で構文エラー
- **Windows PowerShell spawn を VBS ラッパー経由に変更**: `spawn('powershell', [...], { detached: true })` は Windows で `DETACHED_PROCESS` フラグを使いコンソールなしでプロセスを作成する。PowerShell 5.1 はコンソールなしだとサイレントに即終了するため、Agent 起動で実績のある `wscript.exe` + VBS パターン（`.Run "...", 0, False`）で起動するように変更。手動で `powershell -File update.ps1` を実行すると全ステップ成功することで spawn が原因と確定

### #117: pongCheckInterval リーク + machineId 空文字バグ修正 (2026-03-05)

重複 Agent プロセスが同じトークンで接続 → サーバーが stale としてクローズ → 即再接続 → 無限ループが発生する問題の根本原因を修正。

#### Bug 1: Agent `pongCheckInterval` リーク

`ws.on('close')` で `pongCheckInterval` がクリアされていなかった。`disconnect()` 関数にはクリア処理があるが、WebSocket の close イベントハンドラには無かった。再接続のたびに新しい `setInterval` が作られ、古いものが残り続けてリークする。

**修正**: `ws.on('close')` に `pongCheckInterval` のクリア処理を追加（Linux Agent + macOS Agent の両方）。

#### Bug 2: Server `machineId` 空文字バグ

`setupAgentWebSocket` で `machineId = message.payload.machineId` を設定していたが、Agent は config.yaml の `machineId`（空文字 `""`）を送信する。`machineId` が falsy なため、`ws.on('close')` で `handleAgentDisconnect` が呼ばれず、stale エントリが `connectedAgents` に残る。

**修正**: `handleAgentConnect` が DB の `machine.id` を返すように変更し、close handler でそれを使用する。

#### 変更ファイル

| ファイル | 操作 |
|---------|------|
| `agents/linux/src/services/connection.ts` | 修正（pongCheckInterval クリア追加 + nohup 後に disown 追加） |
| `agents/macos/src/services/connection.ts` | 修正（同上） |
| `apps/server/src/services/agent-manager.ts` | 修正（handleAgentConnect が DB machineId を返すように変更） |

**追加修正 1**: nohup 更新スクリプトの bash プロセスが `&` 後も終了しない問題を修正。`nohup node ... &` の後に `disown` を追加。

**追加修正 2**: `disown` を追加しても bash が終了しない問題を修正。原因はシェル演算子優先順位で、`cd X && nohup node Y & disown` は `(cd X && nohup node Y) &` と解釈され、サブシェル内で node がフォアグラウンド実行されてしまっていた。`&&` を `;` に変更して `nohup node ... &` だけがバックグラウンドになるよう修正（Linux + macOS）。

> **検証**: 手動再インストール → 軽微コミット → `u` で bash プロセスが即終了することを確認。

### #118: WebSocket 再接続ループ修正 (2026-03-06)

全エージェント（pixdraft/pixnews/pixshelf）が毎秒1-2回の WebSocket 再接続ループに陥っていた問題を修正。サーバーログで 5000行中 698回の "Closing stale WebSocket" に対し "Agent disconnected" が 0回 — サーバー側の close イベントが一切発火していなかった。

#### 根本原因

サーバーの `handleAgentConnect` で `existingWs.close()` を使用していたが、`close()` はクローズハンドシェイク完了を待つため、相手（Agent 側の旧 WS）が既に切断済みだと応答が来ず close イベントが永遠に発火しない。さらに Agent 側で旧 WS の close ハンドラが新 WS のタイマーを破壊し、不要な再接続をスケジュールしていた。

#### 修正 1: サーバー側 `close()` → `terminate()`

`existingWs.close()` を `existingWs.terminate()` に変更。`terminate()` は即座にソケットを破棄して close イベントを同期的に発火する。ハンドシェイク不要なので CLOSING 状態で stuck しない。

#### 修正 2: Agent 側 旧 WS クリーンアップ

新 WebSocket 作成前に旧 WS を `removeAllListeners()` + `terminate()` でクリーンアップ。close ハンドラの誤発火を防止。

#### 修正 3: Agent 側 close ハンドラガード

close ハンドラで `thisWs` 参照をキャプチャし、`ws !== thisWs`（既に新しい接続に置き換えられた）場合は再接続をスキップ。

#### 変更ファイル

| ファイル | 操作 |
|---------|------|
| `apps/server/src/services/agent-manager.ts` | 修正（`existingWs.close()` → `existingWs.terminate()`） |
| `agents/linux/src/services/connection.ts` | 修正（旧 WS クリーンアップ + close ハンドラガード） |
| `agents/macos/src/services/connection.ts` | 修正（同上） |

### #119: WebSocket 再接続バックオフ改善 (2026-03-06)

接続→即切断ループ時にバックオフが効かない問題を修正。`reconnectAttempts` が `ws.on('open')` で毎回 0 にリセットされるため、常に初回遅延（0.5-1.0s）で再接続していた。

#### 修正 1: 安定接続判定によるバックオフリセット制御

`reconnectAttempts = 0` を `ws.on('open')` から `scheduleReconnect` に移動。前回接続が 60秒以上安定していた場合のみリセットする。即切断ループ時はバックオフカウンタが積み上がり、遅延が増加する。

#### 修正 2: 再接続定数の調整

| 項目 | 変更前 | 変更後 |
|------|--------|--------|
| baseDelay | 500ms | 2000ms |
| maxDelay | 10000ms | 30000ms |
| jitterRange | 500ms | 1000ms |

ループ時のバックオフ推移: 2-3s → 4-5s → 8-9s → 16-17s → 30-31s（上限）

#### 変更ファイル

| ファイル | 操作 |
|---------|------|
| `packages/shared/src/constants.ts` | 修正（再接続定数調整 + `reconnectStableThreshold` 追加） |
| `agents/linux/src/services/connection.ts` | 修正（`lastConnectedAt` 追加、バックオフリセット制御） |
| `agents/macos/src/services/connection.ts` | 修正（同上） |

> **検証**: サーバー再起動 + Agent 再インストール後、重複プロセスが解消され再接続ループが停止。バックオフが正しく動作し、maxAttempts 到達で新プロセスが自主終了することも確認。

#### 修正 3: pgrep パターン拡張（相対パス起動の Agent 検出）

`u` コマンドの更新スクリプトで旧プロセスを kill する際、`pgrep -f "\.devrelay.*index\.js"` パターンだけでは `node index.js`（相対パス起動）のプロセスにマッチしない問題を修正。2つの pgrep パターンを組み合わせて検出：
- `pgrep -f "\.devrelay.*index\.js"` — 絶対パス起動（新コード）
- `pgrep -fx "node index\.js"` — 相対パス起動（旧コード）

| ファイル | 操作 |
|---------|------|
| `agents/linux/src/services/management-info.ts` | 修正（stop/restart の pgrep パターン拡張） |
| `agents/linux/src/services/connection.ts` | 修正（`u` コマンド更新スクリプトの pgrep パターン拡張） |
| `agents/macos/src/services/management-info.ts` | 修正（同上） |
| `agents/macos/src/services/connection.ts` | 修正（同上） |

---

### #120: サービス追加手順書の作成 (2026-03-07)

本番サーバーに新しいサービスを追加する際の汎用手順書を `doc/service-setup-guide.md` に作成。
既存サービス（pixshelf, pixdraft, pixnews, pixblog）のセットアップパターンを調査し、再利用可能な9ステップの手順書としてまとめた。

#### 手順書の構成（9ステップ）

1. Linux ユーザー作成
2. Git SSH 鍵設定 + GitHub Deploy Key 登録
3. リポジトリ clone & ビルド
4. Claude Code インストール + 認証
5. DevRelay Agent インストール（ワンライナー）
6. Caddy リバースプロキシ設定（開発ドメイン / 本番移行の2パターン）
7. サービス起動設定（PM2 / systemd）
8. Git テストプッシュ
9. 動作確認チェックリスト

#### 開発ドメイン方式

- 開発用個人ドメイン（例: `murata1215.jp`）でワイルドカード DNS を設定
- `*.murata1215.jp` → サーバー IP の A レコード1つで全サブドメインが使える
- 新サービスは Caddyfile にエントリ追加 + reload だけで公開可能
- 本番ドメイン取得後は Caddyfile のドメイン差し替えで移行

#### 変更ファイル

| ファイル | 操作 |
|---------|------|
| `doc/service-setup-guide.md` | 新規作成 |

---

### #121-#127: WebUI チャット機能強化 (2026-03-07 ~ 2026-03-08)

#### #127: チャット履歴永続化 & タブ復元

- ページ遷移・リロード・別ブラウザでも会話履歴を復元
- `GET /api/sessions/active` — アクティブセッション一覧 API
- `GET /api/sessions/:id/messages` — カーソルベースページネーション（初回30件、無限スクロール）
- `web:session_info` WebSocket メッセージで sessionId をクライアントに通知
- セッション再利用: 既存アクティブセッションがあれば新規作成せず再接続
- バグ修正: 再利用時の「Session already exists」エラー（`startAgentSession()` を `if (!isResumed)` で制御）
- スクロール修正: タブ切替時は `behavior: 'instant'`、新メッセージのみ `behavior: 'smooth'`
- プログレスタイムアウト修正: 「開始から5分」→「最後のoutputから5分」にリセット

#### #128: Discord 風チャットレイアウト + 表示設定

- `MessageBubble` → `MessageRow`: 全メッセージ左寄せ、バブル廃止
- Discord 風レイアウト: アバター（色付き丸＋頭文字）+ 色付き名前 + タイムスタンプ
- `ProgressIndicator` も同じ Discord 風レイアウトに統一
- チャット表示設定（localStorage `devrelay-chat-display`）:
  - ユーザー表示名 / カラー / アバター画像
  - AI 表示名 / カラー / アバター画像
  - Settings ページに「Chat Display」セクション追加（カラーピッカー + プレビュー）
  - `storage` イベントで他タブと同期
- アバター画像: Settings から画像アップロード → data URL で localStorage 保存

#### #129: 添付画像プレビュー + ライトボックス + 履歴画像表示

- MessageRow: 画像添付ファイルをインラインプレビュー（`max-w-xs max-h-60`）
- AttachmentPreview（送信前）: `h-16 w-16` → `max-h-40 max-w-xs` に拡大
- ImageLightbox コンポーネント: クリックで全画面表示（背景クリック / × / Escape で閉じる）
- `handleSend()` にファイルをユーザーメッセージに含めるよう修正
- 履歴メッセージの画像表示:
  - `loadHistory()` / 無限スクロールで `files` メタデータをマッピング
  - `ChatMessage.files` 型に `id?` / `content?` を追加
  - MessageRow: `content` あり → blob URL、`id` のみ → `/api/files/:id?token=` で表示
  - 認証: `<img>` タグは Bearer ヘッダーを送れないため `?token=` クエリパラメータ方式

#### 変更ファイル

| ファイル | 変更内容 |
|---------|---------|
| `apps/web/src/pages/ChatPage.tsx` | Discord 風レイアウト、画像プレビュー、ライトボックス、チャット表示設定 |
| `apps/web/src/pages/SettingsPage.tsx` | Chat Display セクション（名前・色・アバター設定） |
| `apps/web/src/hooks/useWebSocket.ts` | ChatMessage.files 型拡張（id?, content?） |
| `apps/web/src/lib/api.ts` | sessions API（getActive, getMessages） |
| `apps/server/src/routes/api.ts` | セッション・メッセージ履歴 API |
| `apps/server/src/platforms/web.ts` | web:session_info メッセージ |
| `apps/server/src/services/command-handler.ts` | セッション再利用ロジック |
| `apps/server/src/services/session-manager.ts` | プログレスタイムアウトリセット |
| `packages/shared/src/types.ts` | web:session_info 型追加 |

### #130-#133: WebUI チャット改善 & スクロールバック修正 (2026-03-08)

#### #130: ChatPage 常時マウント + ダークモード CSS セマンティックカラー

- `ProtectedContent` コンポーネント: ChatPage を常時マウントし `display:none` で表示切替
  - 画面遷移時に WebSocket 接続・メッセージ state が維持される
- Layout: ChatPage 時はフル幅、他ページは `max-w-7xl` で表示
- CSS セマンティックカラー追加（`--text-success`, `--text-danger`, `--text-link`, `--bg-danger`, `--border-danger`）
- チャット最大化時の `body.chat-maximized nav { display: none }` ルール追加
- 全ページの CSS をハードコード色 → CSS 変数に移行（ダークモード対応）

#### #131: ピン止めタブのサーバー永続化

- `UserSettings.PINNED_TABS` キー追加（`pinned_tabs`）
- `GET/PUT /api/settings/pinned_tabs` でサーバーに保存
- タブ復元時: サーバー → localStorage フォールバックの優先順序
- ピン止め/解除時にサーバーに自動同期

#### #132: Agents サイドバー一括開閉

- 「Agents」ヘッダーをクリックで全マシン展開/折りたたみ切替
- 1つでも開いていれば全閉じ、全閉じなら全開き

#### #133: チャット履歴クロスセッションスクロールバック

**問題**: セッション単位でしかメッセージを取得していなかったため、サーバー再起動で新セッションが作成されると旧セッションのメッセージに遡れなかった。

**修正**:
- 新 API: `GET /api/projects/:projectId/messages?before=<id>&limit=30`
  - 全セッションを横断してプロジェクトのメッセージをカーソルベースページネーションで取得
- `loadHistory()` / `loadOlderMessages()`: `sessionsApi.getMessages(sessionId)` → `projectsApi.getMessages(projectId)` に変更
- ページネーションロジックを `loadOlderMessages` に抽出して再利用可能に
- コンテナ非スクロール時（メッセージ少）の自動追加読み込み `useEffect` 追加
- `shouldAutoScrollRef` 制御: ユーザーが下端から離れたら `false` に設定（Agent 実行中の snap-back 防止）

#### 変更ファイル

| ファイル | 変更内容 |
|---------|---------|
| `apps/web/src/App.tsx` | ChatPage 常時マウント（ProtectedContent） |
| `apps/web/src/components/Layout.tsx` | ChatPage 時フル幅レイアウト |
| `apps/web/src/index.css` | セマンティックカラー + chat-maximized ルール |
| `apps/web/src/pages/ChatPage.tsx` | Agents 一括開閉、loadOlderMessages 抽出、クロスセッション読み込み、auto-scroll 制御 |
| `apps/web/src/lib/api.ts` | `projects.getMessages()` 追加 |
| `apps/server/src/routes/api.ts` | `GET /api/projects/:projectId/messages` 追加、claude-session API |
| `apps/server/src/services/user-settings.ts` | `PINNED_TABS`, `CHAT_DISPLAY` キー追加 |
| `apps/web/src/pages/*` | 全ページ CSS 変数移行（ダークモード対応） |

### #134-#143: WebUI 改善 & Agent 安定性修正 (2026-03-10)

#### #134: ファビコン変更
- DevRelay ロゴのファビコンに更新

#### #135: 自動スクロール修正
- `scrollIntoView({ behavior: 'smooth' })` のアニメーション中に発火する scroll イベントが auto-scroll を無効化する問題を修正
- `autoScrollingUntilRef` で 500ms のガード期間を設定

#### #136: Agent レースコンディション修正
- WebSocket 接続の競合状態を修正

#### #137: タブリネーム機能
- タブ名をダブルクリックでインライン編集可能に
- `customName` をタブ状態に追加、ヘッダー表示にも反映

#### #138: Discord 風ファイルプレビューカード
- `TextPreviewCard`: テキストファイルの最初の18行をプレビュー表示（展開可能）
- `BinaryFileCard`: バイナリファイルのダウンロードカード
- `FilePreviewCard`: ファイル種別（画像/テキスト/バイナリ）に応じたルーティングコンポーネント
- `formatBytes()`, `isTextPreviewable()` ユーティリティ追加

#### #139: ドラッグ&ドロップファイル添付
- チャットエリア全体へのドラッグ&ドロップでファイル添付
- 青い破線ボーダー + オーバーレイの視覚フィードバック
- `dragCounter` パターンで子要素の enter/leave フリッカー防止

#### #140: タブ順序・カスタム名のサーバー永続化
- `UserSettings.TAB_ORDER`, `UserSettings.TAB_NAMES` キー追加
- タブの並び順とカスタム名をサーバーに保存（クロスブラウザ同期）

#### #141: スムーズスクロール時の自動スクロール無効化修正
- `scrollIntoView({ behavior: 'smooth' })` アニメーション中の scroll イベントで `shouldAutoScrollRef` が false になる問題
- `autoScrollingUntilRef` で 500ms ガード期間を追加

#### #142: 初回チャット表示時のスクロール位置修正
- `loadHistory` 完了時に `shouldAutoScrollRef = true` を `requestAnimationFrame` 内で設定していたため、React の auto-scroll useEffect より後に実行されていた
- 同期的に設定するよう修正

#### #143: Windows Agent を Linux 版と同期（安定性修正）

**問題**: Windows Agent で「AI Status: running」は出るがメッセージに応答しない不具合。Agent 停止・開始で復旧。

**原因**: Windows Agent の `connection.ts` と `ai-runner.ts` が Linux 版と大幅に乖離しており、複数の重大バグが存在。

**修正内容**:
- `ai-runner.ts`:
  - `completionSent` ガード追加（error + close イベント二重 fire 防止）
  - `--resume` 失敗時の早期 return（フォールスルーで二重完了を防止）
  - SIGTERM キャンセル検出
  - `usageData` キャプチャ・送信対応
  - `allowedTools` プランモード対応
  - `cancelAiSession()` 関数追加
- `connection.ts`:
  - `handleAiPrompt` に try/catch 追加（エラー時にセッションがハングしなくなる）
  - `completionSent` ガード追加
  - `serverAllowedTools` 受信・適用
  - `isExec`/`execPrompt` メタデータ送信
  - `server:ai:cancel` ハンドラ追加
- `output-parser.ts`:
  - `usageData`（AI 使用量データ）の抽出を追加

#### 変更ファイル

| ファイル | 変更内容 |
|---------|---------|
| `agents/windows/src/services/ai-runner.ts` | completionSent ガード、SIGTERM 検出、usageData、allowedTools、cancelAiSession |
| `agents/windows/src/services/connection.ts` | try/catch、completionSent、serverAllowedTools、isExec/execPrompt、ai:cancel |
| `agents/windows/src/services/output-parser.ts` | usageData 抽出追加 |
| `apps/web/src/pages/ChatPage.tsx` | #137-#142 の各種修正 |
| `apps/web/src/hooks/useWebSocket.ts` | ChatMessage.files に size 追加 |
| `apps/web/src/lib/api.ts` | settings API（TAB_ORDER, TAB_NAMES）追加 |

### #144: `w` コマンド実行済み判定のDB永続化 (2026-03-10)

#### 問題
`w` コマンドを実行済みなのに、`x` 送信時に「w コマンドを実行していません」と誤警告が表示される。

#### 原因
`wrapUpDone` がインメモリ `Set` で管理されており、サーバー再起動で状態が消失していた。

#### 修正内容
- インメモリ `wrapUpDone` Set を廃止
- `handleClear` で BuildLog テーブルから現在セッションの `w` コマンド実行有無を DB クエリで判定するように変更
- サーバー再起動しても `w` 実行済み状態が保持される

#### 変更ファイル

| ファイル | 変更内容 |
|---------|---------|
| `apps/server/src/services/command-handler.ts` | `wrapUpDone` Set 廃止 → BuildLog DB クエリに置き換え |

### #145-#147: testflight コマンド (2026-03-11)

自動サービスセットアップコマンド。詳細は別コミットで実装済み。

### #148: Agent Doc Folder — ドキュメントファイル同期 (2026-03-12)

#### 概要
WebUI の DocPanel にアップロードしたファイルを、対象 Agent のローカルファイルシステムにも同期する機能。

#### 問題
DocPanel にアップロードしたファイルは DB（AgentDocument テーブル）に保存されるが、Agent のローカルディスク（`~/.devrelay/docs/`）には配置されなかった。

#### 修正内容
- WebSocket メッセージ `server:doc:sync`（ファイル追加）と `server:doc:delete`（ファイル削除）を追加
- Server 側: POST/DELETE API でDB操作後、対象 Agent に WebSocket でファイルを送信
- Agent 側: 受信したファイルを `~/.devrelay/docs/` に保存/削除
- bodyLimit を 50MB に引き上げ（Fastify デフォルト 1MB では不足）
- Embedding の MAX_TEXT_LENGTH を 30000 → 6000 に修正（text-embedding-3-small の 8192 トークン制限対応）

#### 変更ファイル

| ファイル | 変更内容 |
|---------|---------|
| `packages/shared/src/types.ts` | `DocSyncPayload`, `DocDeletePayload` 型、`server:doc:sync`/`server:doc:delete` メッセージ追加 |
| `apps/server/src/routes/agent-document-api.ts` | WS 同期送信 + bodyLimit 50MB |
| `apps/server/src/services/embedding-service.ts` | MAX_TEXT_LENGTH 30000 → 6000 |
| `agents/linux/src/services/connection.ts` | `handleDocSync()`, `handleDocDelete()` ハンドラ追加 |

### #149: --resume スタートアップタイムアウト (2026-03-12)

#### 問題
Pixblog プロジェクトで AI 応答が無限にハングする事象。`--resume` で古い/巨大な Claude セッションを再開しようとすると、Claude Code プロセスが一切の出力なしにハングする。

#### 原因
既存の `resumeFailed` メカニズムは exit code 1（明示的な失敗）のみ対応しており、プロセスがハングして何も出力しないケースに対応できていなかった。

#### 修正内容
- `--resume` 使用時に 60 秒のスタートアップタイムアウトを追加
- 60 秒以内に stdout 出力がなければ `resumeFailed = true` を設定し SIGTERM で kill
- 既存のリトライロジック（`handleAiPrompt`）が `--resume` なしで自動リトライ
- タイマーは stdout データ受信・close・error イベントで適切にクリア

#### 変更ファイル

| ファイル | 変更内容 |
|---------|---------|
| `agents/linux/src/services/ai-runner.ts` | 60 秒スタートアップタイムアウト追加 |

### #150: `u` コマンド origin/main ハードコード修正 (2026-03-12)

#### 問題
`u` コマンド（Agent リモート更新）でバージョン確認が失敗。`origin/main` が存在しないリモート Agent でエラー。

```
fatal: ambiguous argument 'origin/main': unknown revision or path not in the working tree.
```

#### 原因
`connection.ts` の 3 箇所で `origin/main` がハードコードされていた。

#### 修正内容
- `detectRemoteBranch()` ヘルパー関数を追加
  - `git symbolic-ref refs/remotes/origin/HEAD` → `origin/main` → `origin/master` の順で動的検出
- `handleVersionCheck()`: 動的ブランチ使用
- `handleAgentUpdate()` Linux bash: `REMOTE_BRANCH` 変数で動的検出
- `handleAgentUpdate()` Windows PowerShell: `$remoteBranch` 変数で動的検出

#### 変更ファイル

| ファイル | 変更内容 |
|---------|---------|
| `agents/linux/src/services/connection.ts` | `detectRemoteBranch()` 追加、3 箇所の `origin/main` を動的検出に置換 |
