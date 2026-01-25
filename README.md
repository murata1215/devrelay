# 🌉 DevRelay

> どのメッセージアプリからでも、どのAI CLIにでも繋がる、リモート開発ハブ

LINE、Discord、TelegramからClaude Code、Gemini CLI等を操作できるSaaS。
外出先からスマホで自宅PCの開発環境を制御できます。

## ✨ Features

- **マルチマシン**: ubuntu01, ubuntu02, windows01... 複数マシンを登録・切り替え
- **マルチプロジェクト**: 各マシン内の複数プロジェクトを管理
- **マルチAI**: Claude Code, Gemini CLI, Codex, Aider に対応
- **マルチプラットフォーム**: Discord, Telegram, LINE, Slack から操作
- **自然言語コマンド**: 「前の接続を復元して」→ 自動で `c` コマンド実行
- **プランモード / 実行モード**: プラン立案→承認→実行のワークフロー
- **チーム機能**: 複数人で同じセッションに参加可能
- **履歴・要約**: 全会話履歴を保存、AI要約機能

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
                          └─────────────┘         │ Codex / Aider  │
                                                  └────────────────┘
```

## 📦 Packages

```
devrelay/
├── apps/
│   ├── server/           # 中央サーバー (Fastify + WebSocket + Discord.js)
│   └── web/              # Web UI (Next.js) - coming soon
├── packages/
│   └── shared/           # 共通型・定数
├── agents/
│   └── linux/            # Linux Agent (Node.js)
└── scripts/
    └── install.sh        # インストールスクリプト
```

## 🚀 Quick Start

### 1. Install Agent (on your dev machine)

```bash
# Clone repository
git clone https://github.com/your-org/devrelay.git
cd devrelay

# Install dependencies
pnpm install

# Build agent
cd agents/linux
pnpm build
```

### 2. Setup

```bash
# Run setup (token only - machine name and URL auto-configured)
node dist/cli/index.js setup

# Enter your connection token when prompted
# Token can be obtained from dashboard or generated manually
```

### 3. Start Agent

```bash
# Manual start
node dist/cli/index.js start
# or
pnpm start

# As systemd service (setup will ask to install)
systemctl --user start devrelay-agent    # User service (recommended)
sudo systemctl start devrelay-agent       # System service

# Check status
systemctl --user status devrelay-agent

# View logs
journalctl --user -u devrelay-agent -f

# Uninstall (removes service, config, optionally project data)
node dist/cli/index.js uninstall
```

### 4. Connect from Discord/Telegram

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
| `s` | ステータス |
| `r` | 直近の作業一覧 |
| `1`, `2`, `3`... | 一覧から選択 |
| `log` | 会話ログ |
| `x` | 会話履歴をクリア |
| `sum` | 要約 |
| `ai:claude` | Claude Code に切り替え |
| `ai:gemini` | Gemini CLI に切り替え |
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
git clone https://github.com/your-org/devrelay.git
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

### Systemd Service (Production)

サービス化すると自動起動・自動再起動が有効になります。

```bash
# Server
cd apps/server
pnpm setup:service
systemctl --user start devrelay-server

# Agent
cd agents/linux
node dist/cli/index.js setup  # Choose "User service" option
systemctl --user start devrelay-agent
```

管理コマンド:
```bash
systemctl --user status devrelay-server devrelay-agent  # 状態確認
systemctl --user restart devrelay-server devrelay-agent # 再起動
journalctl --user -u devrelay-server -f                 # ログ確認
```

### Project Structure

```
apps/server/
├── src/
│   ├── index.ts              # Entry point
│   ├── db/client.ts          # Prisma client
│   ├── platforms/
│   │   └── discord.ts        # Discord bot
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
│       └── conversation-store.ts # Conversation persistence
```

## 🔐 Security

- 接続トークンによるマシン認証
- APIキーは暗号化保存
- 危険コマンド確認機能（Pro以上）
- 全通信TLS暗号化

## 🗺 Roadmap

- [x] Discord Bot
- [x] Telegram Bot
- [x] Linux Agent
- [x] Conversation Persistence (file-based)
- [x] Quick Reconnect (`c` command)
- [x] Real-time Progress Display
- [x] Systemd Service Support
- [x] Natural Language Commands (OpenAI API)
- [x] Plan Mode / Exec Mode
- [x] Agent Uninstall Command
- [x] Simplified Setup (token only)
- [ ] LINE Bot
- [ ] Web UI
- [ ] Windows Agent
- [ ] AI Summary
- [ ] Team Features

## 📄 License

This project is licensed under the GNU General Public License v3.0 - see the [LICENSE](LICENSE) file for details.
