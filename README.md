# 🌉 DevBridge

> どのメッセージアプリからでも、どのAI CLIにでも繋がる、リモート開発ハブ

LINE、Discord、TelegramからClaude Code、Gemini CLI等を操作できるSaaS。
外出先からスマホで自宅PCの開発環境を制御できます。

## ✨ Features

- **マルチマシン**: ubuntu01, ubuntu02, windows01... 複数マシンを登録・切り替え
- **マルチプロジェクト**: 各マシン内の複数プロジェクトを管理
- **マルチAI**: Claude Code, Gemini CLI, Codex, Aider に対応
- **マルチプラットフォーム**: Discord, Telegram, LINE, Slack から操作
- **チーム機能**: 複数人で同じセッションに参加可能
- **履歴・要約**: 全会話履歴を保存、AI要約機能

## 🏗 Architecture

```
📱 Messaging Apps          ☁️ Center Server           🖥️ Work Machines
┌──────────────┐          ┌──────────────┐          ┌──────────────┐
│ Discord      │          │              │          │ ubuntu01     │
│ Telegram     │ ←──────→ │ DevBridge    │ ←──────→ │ ubuntu02     │
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
devbridge/
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
curl -fsSL https://devbridge.io/install.sh | bash
```

### 2. Setup

```bash
devbridge setup
# Enter your token from https://devbridge.io/dashboard
```

### 3. Add Projects

```bash
devbridge projects add ~/projects/my-app
```

### 4. Start Agent

```bash
devbridge start
# Or as a service: sudo systemctl start devbridge
```

### 5. Connect from Discord/Telegram

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
| `s` | ステータス |
| `r` | 直近の作業一覧 |
| `1`, `2`, `3`... | 一覧から選択 |
| `log` | 会話ログ |
| `sum` | 要約 |
| `ai:claude` | Claude Code に切り替え |
| `ai:gemini` | Gemini CLI に切り替え |
| `q` | 切断 |
| `h` | ヘルプ |

それ以外のメッセージはAIへの指示として処理されます。

## 💰 Pricing

| | Free | Pro | Team |
|--|------|-----|------|
| 料金 | $0 | $5/月 | $20/月 |
| マシン数 | 1 | 5 | 無制限 |
| プラットフォーム | 1つ | 全部 | 全部 |
| ログ保持 | 7日 | 30日 | 90日 |
| 要約機能 | ❌ | ✅ | ✅ |
| チーム機能 | ❌ | ❌ | ✅ |

## 🛠 Development

### Prerequisites

- Node.js 20+
- pnpm 8+
- Discord Bot Token (for testing)

### Setup

```bash
# Clone
git clone https://github.com/your-org/devbridge.git
cd devbridge

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
│   │       ├── setup.ts
│   │       ├── status.ts
│   │       └── projects.ts
│   └── services/
│       ├── config.ts         # Config management
│       ├── connection.ts     # WebSocket to server
│       ├── projects.ts       # Project management
│       └── ai-runner.ts      # AI CLI execution
```

## 🔐 Security

- 接続トークンによるマシン認証
- APIキーは暗号化保存
- 危険コマンド確認機能（Pro以上）
- 全通信TLS暗号化

## 🗺 Roadmap

- [x] Discord Bot
- [x] Linux Agent
- [ ] Telegram Bot
- [ ] LINE Bot
- [ ] Web UI
- [ ] Windows Agent
- [ ] AI Summary
- [ ] Team Features

## 📄 License

MIT
