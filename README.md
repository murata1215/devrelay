# 🌉 DevRelay

> [日本語版はこちら](README_JA.md)

> A remote development hub that connects any messaging app to any AI CLI tool

Control Claude Code, Gemini CLI, and more from Discord, Telegram, or LINE.
Turn your phone into a remote terminal for AI-powered development.

## ✨ Features

- **Multi-Agent**: Register and switch between ubuntu-dev/user1, ubuntu-prod/user2, windows01/dev...
- **Multi-Project**: Manage multiple projects on each agent
- **Multi-AI**: Support for Claude Code, Gemini CLI, Aider
- **Multi-Platform**: Operate from Discord, Telegram (LINE coming soon)
- **Natural Language Commands**: "reconnect to last project" auto-translates to the right command (OpenAI / Anthropic / Gemini)
- **Plan / Execute Mode**: AI plans first, you review, then it implements
- **DevRelay Agreement v4**: Rules in `rules/devrelay.md`, lightweight CLAUDE.md hub
- **Real-time Progress**: Watch AI's progress live on Discord/Telegram
- **Bidirectional File Transfer**: Send and receive files between chat and dev machines
- **History Export**: Download conversation history as daily ZIP files
- **Proxy Support**: Connect through HTTP/HTTPS/SOCKS5 proxies
- **Build Log**: Auto-track every exec with AI-generated summaries
- **Conversations Analytics**: View all AI interactions with token usage breakdown
- **Multi-Provider AI**: Register OpenAI, Anthropic, Gemini API keys with per-feature provider selection
- **Agreement Template Editor**: Customize AI rules from Settings page
- **Message File Storage**: Attached files stored in DB (PostgreSQL bytea) with image lightbox preview
- **Soft Delete**: Machine deletion preserves all conversation history
- **Kill Command**: Cancel running AI process mid-execution from chat
- **Remote Config**: Configure agent project search paths from WebUI (auto-sync via WebSocket)
- **Plan Mode Log Access**: Read-only Bash commands (pm2 logs, git status, journalctl, etc.) available during plan mode via `--allowedTools`
- **Allowed Tools Management**: Edit plan mode allowed tools from WebUI Settings page (Linux/Windows side-by-side, real-time sync to agents)

## 💡 Token Efficiency

DevRelay uses Claude Code's `--resume` option to continue sessions, achieving **the same token efficiency as direct CLI usage**.

- **Overhead**: ~200 tokens/prompt for plan/exec mode instructions
- **Session Continuity**: `--resume` keeps conversation context in Claude Code, no history re-sending
- **Context Display**: Monitor usage on Discord/Telegram (`📊 Context: 131K / 200K tokens (66%)`)

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
│   ├── server/           # Center server (Fastify + WebSocket + Discord.js)
│   ├── web/              # Web UI (Vite + React)
│   └── landing/          # Landing page (devrelay.io)
├── packages/
│   └── shared/           # Shared types & constants
├── agents/
│   ├── linux/            # Cross-platform CLI Agent (Linux + Windows)
│   └── windows/          # Windows Agent (Electron tray app)
├── rules/
│   ├── devrelay.md       # DevRelay Agreement v4 (shared rules)
│   └── project.md        # Project-specific design decisions
├── doc/
│   ├── changelog.md      # Implementation history (#1-#100)
│   └── ...               # Additional docs
└── scripts/
    ├── install-agent.sh    # Linux one-liner installer
    ├── install-agent.ps1   # Windows one-liner installer
    └── update-version.js   # Batch version update script
```

## 🚀 Quick Start

### 1. Install Agent (on your dev machine)

#### Linux Agent (One-liner)

```bash
curl -fsSL https://raw.githubusercontent.com/murata1215/devrelay/main/scripts/install-agent.sh | bash -s -- --token YOUR_TOKEN
```

Only `git` required. Node.js 20+ and pnpm are **auto-installed** if missing (downloaded to `~/.devrelay/node/`, no sudo needed). Get your token from the WebUI Agents page (click "+ Add Agent"). The agent name will be set automatically from your hostname.

#### Windows CLI Agent (One-liner)

```powershell
$env:DEVRELAY_TOKEN="YOUR_TOKEN"; irm https://raw.githubusercontent.com/murata1215/devrelay/main/scripts/install-agent.ps1 | iex
```

Node.js 20+ and git required (pnpm is auto-installed if missing). ExecutionPolicy is set automatically. Installs to `%APPDATA%\devrelay\agent\` with Startup folder auto-start.

#### Linux Agent (Manual)

```bash
# Clone repository
git clone https://github.com/murata1215/devrelay.git
cd devrelay

# Install dependencies
pnpm install

# Generate Prisma client (required for first build)
cd apps/server && npx prisma generate && cd ../..

# Build all packages
pnpm build
```

#### Windows Agent (Two Options)

**Option 1: CLI Agent (Recommended)** - Lightweight, same codebase as Linux agent
- Install via PowerShell one-liner (see above)
- Uses Task Scheduler for auto-start
- Config: `%APPDATA%\devrelay\config.yaml`
- CLI commands: `devrelay setup`, `devrelay status`, `devrelay logs`, `devrelay uninstall`

**Option 2: Electron Tray App** - GUI-based with system tray
- Download installer from releases page
- System tray icon (green = connected, gray = disconnected)
- Settings UI, sleep prevention (blocks Modern Standby)

```powershell
# Development (Electron)
cd agents/windows && pnpm build && npx electron .

# Build installer for distribution
cd agents/windows && pnpm dist
```

### 2. Setup (Linux)

```bash
# Run setup (token only - machine name and URL auto-configured)
cd agents/linux
pnpm run setup  # Note: use "pnpm run setup", not "pnpm setup"

# Enter your connection token when prompted
# Token can be obtained from dashboard or generated manually
```

### 3. Start Agent (Linux)

```bash
# Manual start
cd agents/linux
pnpm run start

# As PM2 service (recommended for production)
pm2 start /opt/devrelay/agents/linux/dist/index.js --name devrelay-agent

# Check status
pm2 status devrelay-agent

# View logs
pm2 logs devrelay-agent

# Uninstall (removes service, config, optionally project data)
pnpm run uninstall
```

### 4. Connect from Discord/Telegram

```
You: m
Bot: 📡 Agents
     1. ubuntu-dev/pixblog 🟢
     2. ubuntu-prod/pixdraft 🟢

You: 1
Bot: ✅ Connected to ubuntu-dev/pixblog

You: p
Bot: 📁 Projects
     1. my-app
     2. another-project

You: 1
Bot: 🚀 Connected to my-app / Claude Code ready

You: Fix the CSS bug on the login page
Bot: 🤖 Working on it...
```

## 📋 Commands

| Command | Description |
|---------|-------------|
| `m` | List agents |
| `p` | List projects |
| `c` | Reconnect to last project |
| `e` / `exec` | Switch to execute mode (approve plan) |
| `e, <instruction>` | Execute custom instruction directly |
| `w` | Wrap up: update docs + commit + push |
| `se` / `session` | Show session info |
| `ag` / `agreement` | Apply DevRelay Agreement v4 (creates `rules/devrelay.md`) |
| `link` | Link Discord/Telegram account to WebUI |
| `1`, `2`, `3`... | Select from list |
| `u` / `update` | Check agent version / remote update (requires double confirmation) |
| `k` / `kill` | Cancel running AI process |
| `x` | Clear conversation history (requires double confirmation) |
| `q` | Disconnect |
| `h` | Help |

Any other message is sent as an instruction to the AI.

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

### PM2 Service (Production)

PM2 provides auto-restart and process management for production.

```bash
# Server
pm2 start /opt/devrelay/apps/server/dist/index.js --name devrelay-server

# Agent
pm2 start /opt/devrelay/agents/linux/dist/index.js --name devrelay-agent

# Management
pm2 status                                    # Check status
pm2 restart devrelay-server devrelay-agent     # Restart
pm2 logs devrelay-server                       # View logs

# Auto-start on boot
pm2 save
pm2 startup
```

### Proxy Configuration

The one-liner installers prompt for proxy settings during installation. When a proxy is configured, `HTTP_PROXY`/`HTTPS_PROXY` are automatically set so that `git clone` and `pnpm install` also use the proxy. You can also specify proxy via CLI arguments or environment variables:

```bash
# Linux: interactive prompt during install (answer y/N when asked)
curl -fsSL ... | bash -s -- --token YOUR_TOKEN

# Linux: skip prompt with --proxy
curl -fsSL ... | bash -s -- --token YOUR_TOKEN --proxy http://proxy:8080

# Windows: skip prompt with $env:DEVRELAY_PROXY
$env:DEVRELAY_TOKEN="YOUR_TOKEN"; $env:DEVRELAY_PROXY="http://proxy:8080"; irm ... | iex
```

To configure proxy manually, add settings to `~/.devrelay/config.yaml`:

```yaml
proxy:
  url: http://proxy.example.com:8080  # or socks5://proxy:1080
  username: user  # optional
  password: pass  # optional
```

### Version Management

Update all package versions at once:
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
│       ├── command-handler.ts # Execute commands
│       ├── build-summarizer.ts # AI build summary (multi-provider)
│       └── natural-language-parser.ts # NLP commands (multi-provider)
└── prisma/
    └── schema.prisma         # Database schema

agents/linux/                    # Cross-platform CLI Agent (Linux + Windows)
├── src/
│   ├── index.ts              # Agent entry
│   ├── cli/                  # CLI commands
│   │   └── commands/
│   │       ├── setup.ts      # Setup (systemd / Task Scheduler)
│   │       ├── uninstall.ts  # Uninstall (cross-platform)
│   │       ├── status.ts     # Status (cross-platform)
│   │       └── projects.ts
│   └── services/
│       ├── config.ts         # Config management (cross-platform paths)
│       ├── connection.ts     # WebSocket to server
│       ├── projects.ts       # Project management
│       ├── ai-runner.ts      # AI CLI execution (cross-platform)
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

- Token-based machine authentication
- API keys encrypted with AES-256-CBC (OpenAI, Anthropic, Gemini)
- All communication over TLS
- Prompts sent via stdin (invisible to `ps aux`)

## 🗺 Roadmap

- [x] Discord Bot
- [x] Telegram Bot
- [x] Linux Agent
- [x] Windows Agent
- [x] Web UI
- [x] Conversation Persistence (file-based)
- [x] Quick Reconnect (`c` command)
- [x] Real-time Progress Display
- [x] Natural Language Commands (OpenAI / Anthropic / Gemini)
- [x] Plan Mode / Exec Mode
- [x] Agent Uninstall Command
- [x] Simplified Setup (token only)
- [x] DevRelay Agreement
- [x] Proxy Support
- [x] History Export
- [x] Conversation Archive (auto-backup on clear)
- [x] Custom exec prompt (`exec, commit and push`)
- [x] Output file history (`.devrelay-output-history/`)
- [x] `w` command (wrap up: update docs + commit + push)
- [x] Landing page (devrelay.io)
- [x] Token URL embedding (server URL auto-detected from token)
- [x] Heartbeat DB batch update (60s batch instead of per-ping writes)
- [x] One-liner agent install (`curl | bash`)
- [x] Machine->Agent rename + machineName slash format (`hostname/username`)
- [x] Installer improvements (auto serverUrl extraction, `/opt` scan, nohup+crontab fallback)
- [x] Agent auto-naming (skip name input, auto-set from hostname on connect)
- [x] Agent restart session continuity (seamless session recovery after agent restart)
- [x] Windows CLI Agent (cross-platform codebase + PowerShell one-liner installer)
- [x] PowerShell installer auto-setup (ExecutionPolicy + pnpm auto-install)
- [x] Agent settings modal (token re-display, install/uninstall commands)
- [x] Installer proxy support (interactive prompt + `--proxy` / `$env:DEVRELAY_PROXY`)
- [x] Linux installer auto-install Node.js + pnpm (direct binary download, no sudo/unzip needed)
- [x] `--ignore-scripts` for `pnpm install` (skip Electron postinstall in corporate networks)
- [x] Auto-restart agent on re-install (stop existing process before starting new one)
- [x] AI error handling improvement (catch errors, notify Discord/Telegram instead of crashing)
- [x] nohup stdin fix for `curl|bash` compatibility
- [x] Fix pgrep pattern for agent process detection on re-install
- [x] Use absolute node path in nohup/crontab for PATH-independent startup
- [x] Use Get-CimInstance for Windows agent process detection on re-install
- [x] Add Windows install command and setup guide URL to Claude Code error message
- [x] Pre-install token validation (prevent wrong-machine installs with `--force` override)
- [x] Stop installation when server is unreachable (proxy misconfiguration detection)
- [x] Windows uninstall fix (Start-Sleep between process kill and file removal)
- [x] Message usage data storage (token analytics per AI call)
- [x] Conversations page (usage analytics dashboard)
- [x] Build Log (auto-track exec with AI-generated summaries)
- [x] Multi-provider AI keys (OpenAI, Anthropic, Gemini with per-feature selection)
- [x] Projects page sorted by latest build date (most recently built first)
- [x] Agreement v4 + CLAUDE.md migration (rules separation, lightweight hub)
- [x] Server-side Agreement template delivery (update Server once, all Agents get latest)
- [x] Exec command user message in Conversations (show `[exec]` instead of `(empty)`)
- [x] Agreement template editor in Settings page (customize AI rules from WebUI)
- [x] Message file BLOB storage (attached files in DB with image lightbox preview)
- [x] Machine soft delete (preserve conversation history on agent removal)
- [x] Kill command (`k` / `kill` to cancel running AI process)
- [x] Server-managed project search paths (configure agent `projectsDirs` from WebUI)
- [x] Plan mode read-only commands (`--allowedTools` for pm2 logs, git status, etc.)
- [x] `deploy-agent` script (copy built agent to installed location)
- [x] Allowed tools WebUI management (Server DB + Settings page, Linux/Windows split, real-time agent sync)
- [x] Agent remote update (`u` / `update` command to check version and update agent from Discord/Telegram)
- [ ] Shared Documents (DevRelay Box) - Cross-project RAG with pgvector + OpenAI Embeddings
- [ ] LINE Bot
- [ ] Team Features
- [ ] AI tool switching (Gemini/Aider)

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
