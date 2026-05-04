# 🌉 DevRelay

> [English version](README.md)

> どのメッセージアプリからでも、どのAI CLIにでも繋がる、リモート開発ハブ

LINE、Discord、TelegramからClaude Code、Gemini CLI、Devin CLI等を操作できるSaaS。
外出先からスマホで自宅PCの開発環境を制御できます。

## ✨ Features

- **マルチマシン**: ubuntu01, ubuntu02, windows01... 複数マシンを登録・切り替え
- **マルチプロジェクト**: 各マシン内の複数プロジェクトを管理
- **マルチAI**: Claude Code, Gemini CLI, Devin CLI, Aider に対応
- **マルチプラットフォーム**: Discord, Telegram から操作（LINE 対応予定）
- **自然言語コマンド**: 「前の接続を復元して」→ 自動で `c` コマンド実行（OpenAI API 使用）
- **プランモード / 実行モード**: プラン立案→承認→実行のワークフロー
- **DevRelay Agreement**: CLAUDE.md に統合するプロジェクト設定
- **リアルタイム進捗表示**: AI の処理状況をリアルタイムで表示
- **双方向ファイル転送**: Discord/Telegram ↔ 開発マシン間のファイル送受信
- **履歴エクスポート**: 会話履歴を日別に ZIP でダウンロード可能
- **プロキシ対応**: HTTP/HTTPS/SOCKS5 プロキシ経由での接続
- **PWA + プッシュ通知**: アプリとしてインストール可能、タブを閉じていても AI 完了通知を受信
- **通知音**: AI 応答完了時に Discord 風の通知音を再生（カスタム mp3 対応）
- **マルチブラウザ同期**: 異なるブラウザ間でチャットがリアルタイム同期

## 💡 トークン効率について

DevRelay は Claude Code の `--resume` オプションを活用してセッションを継続するため、**通常の CLI 利用と同等のトークン効率**を実現しています。

- **オーバーヘッド**: プランモード/実行モード指示で約200トークン/プロンプト
- **セッション継続**: `--resume` により会話コンテキストが Claude Code 側で管理されるため、履歴の再送信は不要
- **コンテキスト表示**: 使用量を Discord/Telegram で確認可能（`📊 Context: 131K / 200K tokens (66%)`）

## 🏗 Architecture

```
📱 Messaging Apps          ☁️ Center Server           🖥️ Work Machines
┌──────────────┐          ┌──────────────┐          ┌──────────────┐
│ Discord      │          │              │          │ ubuntu01     │
│ Telegram     │ ←──────→ │ DevRelay    │ ←──────→ │ ubuntu02     │
│ LINE         │  HTTPS   │ Server       │    WS    │ windows01    │
└──────────────┘          └──────────────┘          └──────────────┘
                                │                         │
                         ┌──────┴──────┐         ┌───────┴────────┐
                         │ PostgreSQL  │         │ Claude Code    │
                         │ Redis       │         │ Gemini CLI     │
                         └─────────────┘         │ Aider          │
                                                 └────────────────┘
```

## 📦 Packages

```
devrelay/
├── apps/
│   ├── server/           # 中央サーバー (Fastify + WebSocket + Discord.js)
│   ├── web/              # Web UI (Vite + React)
│   └── landing/          # ランディングページ (devrelay.io)
├── packages/
│   └── shared/           # 共通型・定数
├── agents/
│   ├── linux/            # Linux Agent (Node.js CLI)
│   └── windows/          # Windows Agent (Electron タスクトレイアプリ)
└── scripts/
    └── update-version.js # バージョン一括更新スクリプト
```

## 🚀 Quick Start

### 1. Agent のインストール（開発マシン側）

#### Linux Agent

```bash
# リポジトリをクローン
git clone https://github.com/murata1215/devrelay.git
cd devrelay

# 依存関係をインストール
pnpm install

# Prisma クライアント生成（初回ビルドに必要）
cd apps/server && npx prisma generate && cd ../..

# 全パッケージをビルド
pnpm build
```

#### Windows Agent

Windows では Electron タスクトレイアプリとして動作します。

**インストール方法:**
1. リリースページからインストーラー（`DevRelay-Agent-Setup-x.x.x.exe`）をダウンロード
2. インストーラーを実行
3. タスクトレイアイコンをクリックして設定画面を開く
4. トークンを入力し、プロジェクトディレクトリを追加

**機能:**
- タスクトレイ常駐（接続状態をアイコン色で表示：緑=接続中、グレー=切断）
- 設定画面（トークン、プロジェクトディレクトリ管理）
- 自動起動設定（Windows ログイン時に自動起動）
- スリープ防止機能（接続中は Modern Standby を抑制）

**開発:**
```powershell
cd agents/windows
pnpm build
npx electron .

# 配布用インストーラー作成
pnpm dist
```

### 2. セットアップ (Linux)

```bash
# セットアップ実行（トークンのみ - マシン名とURLは自動設定）
cd agents/linux
pnpm run setup  # 注意: "pnpm setup" ではなく "pnpm run setup"

# プロンプトに従って接続トークンを入力
# トークンはダッシュボードで取得するか手動で生成
```

### 3. Agent の起動 (Linux)

```bash
# 手動起動
cd agents/linux
pnpm run start

# PM2 でサービス起動
pm2 start /opt/devrelay/agents/linux/dist/index.js --name devrelay-agent

# ステータス確認
pm2 status devrelay-agent

# ログ確認
pm2 logs devrelay-agent

# アンインストール（サービス、設定、プロジェクトデータを削除）
pnpm run uninstall
```

### 4. Discord/Telegram から接続

```
You: m
Bot: 📡 マシン一覧
     1. ubuntu01 🟢
     2. ubuntu02 🟢

You: 1
Bot: ✅ ubuntu01 に接続

You: p
Bot: 📁 プロジェクト
     1. my-app
     2. another-project

You: 1
Bot: 🚀 my-app に接続 / Claude Code 起動完了

You: CSSのバグを直して
Bot: 🤖 了解、修正中...
```

## 📋 Commands

| Command | Description |
|---------|-------------|
| `m` | マシン一覧 |
| `p` | プロジェクト一覧 |
| `c` | 前回の接続先に再接続 |
| `e` / `exec` | 実行モードに切り替え（プラン承認） |
| `e, 〜` / `exec, 〜` | 実行モードでカスタム指示を直接実行 |
| `w` | ドキュメント更新＋コミット＋プッシュ（wrap up） |
| `se` / `session` | セッション情報表示 |
| `ag` / `agreement` | DevRelay Agreement を CLAUDE.md に適用 |
| `link` | Discord/Telegram アカウントを WebUI とリンク |
| `1`, `2`, `3`... | 一覧から選択 |
| `x` | 会話履歴をクリア（2回連続で実行） |
| `q` | 切断 |
| `h` | ヘルプ |

それ以外のメッセージはAIへの指示として処理されます。

## 🛠 Development

### Prerequisites

- Node.js 20+
- pnpm 8+
- Discord Bot Token (for testing)

### Setup

```bash
# Clone
git clone https://github.com/murata1215/devrelay.git
cd devrelay

# Install dependencies
pnpm install

# Setup environment
cp apps/server/.env.example apps/server/.env
# Edit .env with your tokens

# Initialize database
cd apps/server
pnpm db:push

# Start development
pnpm dev:server   # Start server
pnpm dev:agent    # Start agent (in another terminal)
```

### PM2 サービス（Production）

PM2 でサービス管理すると自動起動・自動再起動が有効になります。

```bash
# Server
pm2 start /opt/devrelay/apps/server/dist/index.js --name devrelay-server

# Agent
pm2 start /opt/devrelay/agents/linux/dist/index.js --name devrelay-agent

# 管理コマンド
pm2 status                                    # ステータス確認
pm2 restart devrelay-server devrelay-agent     # 再起動
pm2 logs devrelay-server                       # ログ確認

# 自動起動設定
pm2 save
pm2 startup
```

### プロキシ設定

Agent がプロキシ経由でサーバーに接続する場合は、`~/.devrelay/config.yaml` に設定を追加します。

```yaml
proxy:
  url: http://proxy.example.com:8080  # または socks5://proxy:1080
  username: user  # オプション
  password: pass  # オプション
```

### バージョン管理

全パッケージのバージョンを一括更新:
```bash
pnpm version:update 0.2.0
```

### Project Structure

```
apps/server/
├── src/
│   ├── index.ts              # Entry point
│   ├── db/client.ts          # Prisma client
│   ├── platforms/
│   │   ├── discord.ts        # Discord bot
│   │   └── telegram.ts       # Telegram bot
│   └── services/
│       ├── agent-manager.ts  # WebSocket connections
│       ├── session-manager.ts # Active sessions
│       ├── command-parser.ts # Parse user input
│       └── command-handler.ts # Execute commands
└── prisma/
    └── schema.prisma         # Database schema

agents/linux/
├── src/
│   ├── index.ts              # Agent entry
│   ├── cli/                  # CLI commands
│   │   └── commands/
│   │       ├── setup.ts      # セットアップ（トークンのみ）
│   │       ├── uninstall.ts  # アンインストール
│   │       ├── status.ts
│   │       └── projects.ts
│   └── services/
│       ├── config.ts         # Config management
│       ├── connection.ts     # WebSocket to server
│       ├── projects.ts       # Project management
│       ├── ai-runner.ts      # AI CLI execution
│       └── session-store.ts  # Session ID persistence

agents/windows/
├── src/
│   ├── electron/
│   │   └── main.ts           # Electron main process, tray, IPC
│   └── services/
│       ├── config.ts         # Config management (%APPDATA%\devrelay\)
│       ├── connection.ts     # WebSocket to server
│       ├── ai-runner.ts      # AI CLI execution
│       └── sleep-preventer.ts # Modern Standby prevention
└── assets/
    ├── settings.html         # Settings UI
    └── preload.js            # IPC bridge
```

## 🔐 Security

- 接続トークンによるマシン認証
- APIキーは暗号化保存（AES-256-CBC）
- 全通信TLS暗号化
- プロンプトは stdin 経由（`ps aux` に表示されない）

## 🗺 Roadmap

- [x] Discord Bot
- [x] Telegram Bot
- [x] Linux Agent
- [x] Windows Agent
- [x] Web UI
- [x] Conversation Persistence (file-based)
- [x] Quick Reconnect (`c` command)
- [x] Real-time Progress Display
- [x] Natural Language Commands (OpenAI API)
- [x] Plan Mode / Exec Mode
- [x] DevRelay Agreement 機能
- [x] プロキシ対応
- [x] 履歴エクスポート機能
- [x] 会話履歴アーカイブ（クリア時に自動退避）
- [x] exec カスタムプロンプト（`exec, コミットして` で直接実行）
- [x] 出力ファイル履歴保存（`.devrelay-output-history/` に自動コピー）
- [x] `w` コマンド（wrap up: ドキュメント更新＋コミット＋プッシュ）
- [x] ランディングページ（devrelay.io）
- [ ] LINE Bot
- [ ] AI Summary
- [ ] Team Features
- [ ] AI 切り替え機能（Gemini/Aider）

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
