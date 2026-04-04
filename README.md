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
- **DevRelay Agreement v6**: Rules in `rules/devrelay.md`, lightweight CLAUDE.md hub, issue tracking, cross-project collaboration
- **Real-time Progress**: Watch AI's progress live on Discord/Telegram
- **Bidirectional File Transfer**: Send and receive files between chat and dev machines
- **History Export**: Download conversation history as daily ZIP files
- **Proxy Support**: Connect through HTTP/HTTPS/SOCKS5 proxies
- **Build Log**: Auto-track every exec with AI-generated summaries
- **Conversations Analytics**: View all AI interactions with token usage breakdown
- **Multi-Provider AI**: Register OpenAI, Anthropic, Gemini API keys with per-feature provider selection
- **Agreement Template Editor**: Customize AI rules from Settings page
- **Message File Storage**: Attached files stored in DB (PostgreSQL bytea) with inline image preview and lightbox
- **Agent Doc Folder**: Upload documents via DocPanel, auto-synced to agent filesystem via WebSocket
- **Soft Delete**: Machine deletion preserves all conversation history
- **Kill Command**: Cancel running AI process mid-execution from chat
- **Remote Config**: Configure agent project search paths from WebUI (auto-sync via WebSocket)
- **Plan Mode Log Access**: Read-only Bash commands (pm2 logs, git status, journalctl, etc.) available during plan mode via `--allowedTools`
- **Allowed Tools Management**: Edit plan mode allowed tools from WebUI Settings page (Linux/Windows side-by-side, real-time sync to agents)
- **Remote Agent Update**: Update agents remotely via `u` command with version check and completion notification
- **Dev Reports**: AI-generated development reports from conversation history (multi-provider, markdown export)
- **PWA + Push Notifications**: Install as app, receive push notifications when AI completes (even with tab closed)
- **Completion Sound**: Discord-like notification sound on AI response completion (customizable mp3)
- **Multi-Browser Sync**: Chat syncs across browsers in real-time via server-side WebSocket broadcast
- **Team Management**: Create named teams, add projects, and enable cross-project AI queries
- **Cross-Project Query**: Ask questions to other project's agents via `ask <project>: <question>` (Discord/Telegram/Claude Code skill)
- **Cross-Project Exec**: Send execution requests to other project's agents via `teamexec <project>: <instruction>` (Discord/Telegram/Claude Code skill `--exec` flag)
- **Issue Tracking**: `doc/issues.md` auto-created per project, status updates integrated into `w` command
- **Tool Approval History**: Real-time tool approval with persistent history (DB + Agent JSONL log), auto-approved tools shown with 🔓 icon, survives browser refresh
- **Discord/Telegram Tool Approval**: Approve or deny AI tool executions via Discord buttons or Telegram inline keyboards, with cross-platform sync (approve on Discord → WebUI buttons auto-disabled)
- **Per-Tool Permission Rules**: "Always allow this tool" button (📌) creates persistent rules (e.g., `Edit`, `Bash(git *)`) — auto-approves matching tools in future sessions without prompting, manageable from Settings page
- **AskUserQuestion Relay**: Claude Code's questions are relayed to WebUI/Discord/Telegram with selectable option buttons + free-text "Other" input, answers sent back via deny-with-answer pattern
- **Rate Limit Display**: Captures Claude Code's `rate_limit_event` from Agent SDK, displays `📊 Rate Limit: 5h: XX% | 7d: XX%` on completion
- **Protocol Version Enforcement**: Soft-rejection mechanism — outdated agents stay online (can receive `u` update command) but conversations are blocked until updated
- **Agent Log Rotation**: Daily copyTruncate rotation with 7-day retention for `agent.log`
- **Per-Agent Skip Permissions**: Toggle "自動承認" switch in chat header or Agent Settings to auto-approve all tools (like `--dangerously-skip-permissions`), AskUserQuestion still prompts
- **Disable AskUserQuestion**: Toggle "Ask無効" switch per agent — uses SDK `disallowedTools` to remove the tool from Claude's context entirely (no wasted turns), for autonomous execution without questions
- **Tool Approval/Question Card Recovery**: Pending approval cards and AskUserQuestion cards reliably survive browser reload and appear in new tabs — memory-based recovery (no DB dependency), `//connect`-triggered restoration, 12-hour timeout (forgetting ≠ rejecting)
- **Multi-Agent Routing Fix**: DB fallback for projectId resolution prevents messages from appearing in wrong project tabs
- **Xcode Project Detection**: `.xcodeproj` directories are detected as projects alongside `CLAUDE.md`
- **Plan File Viewer**: View Claude Code's plan files (`~/.claude/plans/*.md`) in the WebUI right panel — automatically shows the latest plan with Markdown rendering
- **Skip Permissions Realtime Sync**: Toggle now takes effect immediately even mid-session — dynamic getter replaces static snapshot
- **Per-Agent Remote Restart**: Restart individual agents from WebUI (table row icon + Settings modal button) via WebSocket `server:agent:restart` → `process.exit(0)` auto-restart
- **Google OAuth**: Sign in with Google on Login/Register pages — automatic account linking by email, no external library (pure fetch)
- **Google ID Token Auth**: `POST /api/auth/google/token` endpoint for Flutter/mobile native `google_sign_in` — verifies ID token server-side, returns session token
- **Cross-Project Source Display**: Cross-project queries (ask/teamexec) now show the source project name in WebUI chat (`🔗 devrelay-flutter`) and Conversations page (`🔗 devrelay-flutter → devrelay`)
- **Cross-Tab Message Routing Fix**: Command responses now include `projectId` to prevent messages from other projects leaking into the active tab
- **Phaser Audio Template**: `testflight create --phaser` now generates 2048 game with BGM (Tone.js chiptune) + SFX (jsfxr procedural), mobile-optimized (viewport-fit, dvh, safe-area), BGM/SFX mute buttons
- **TestFlight Copy**: `testflight cp <old> <new>` clones a service entirely (directory, PostgreSQL DB via pg_dump, Caddy config, PM2 process) — use with `testflight rm` for rename workflow
- **Safari SourceMap Fix**: Phaser template `vite.config.ts` includes `optimizeDeps.esbuildOptions.loader: { '.map': 'json' }` to prevent iOS Safari esbuild crash
- **Progress Box Split Fix**: Removed `suppressConnectRef` guard from `clearProgressOnTab` — fixes duplicate message boxes when AI completes during tab switch
- **WebSocket Reconnect Refresh**: `onReconnect` callback re-sends `//connect` and refreshes history on WS reconnection — fixes stale messages after network interruption
- **iOS Safari Visibility Refresh**: `visibilitychange` handler auto-refreshes chat history when returning from background tab — fixes stale display on iOS Safari
- **DB Cleanup**: Bulk cleanup of 384 stale active sessions → ended, 165 stale ChannelSession records, 6 expired AuthSessions + WS disconnect now removes DB records
- **TestFlight Hyphen Name Fix**: PostgreSQL user/DB names now double-quoted in `CREATE USER`, `createdb`, `dropuser`, `dropdb`, `GRANT`, `pg_dump` — fixes SQL syntax errors for names like `tf-2048`
- **Tab Switch Progress Fix**: `clearProgressOnTab` now skips when `suppressConnectRef` is active (i.e., `//connect` response) — fixes momentary ✅ checkmark flash when switching to a tab with active AI processing
- **Cross-Project Timeout Extension**: ask/teamexec timeout extended from 5 minutes to 12 hours — allows long-running cross-project executions with tool approval waits
- **Same-Machine Project Visibility**: Removed machine-level filter from `/api/agent/members` — projects on the same machine (e.g., devrelay and nim) now appear in team member list
- **Cross-Project Approval Relay**: Tool approval cards from teamexec/ask sessions now appear in both the target project tab AND the originator's tab — approve from either side
- **Crontab PATH Fix**: `@reboot` entries now use `export PATH=...; cd` instead of `PATH=... cd` — fixes Node.js `spawn('node')` ENOENT after OS reboot. Agent `u` command auto-fixes existing crontab entries
- **Project Description Ask**: "Ask 📋" button on Team page fetches project descriptions from all online agents in parallel — stored in `Project.description`, displayed under each member row
- **Cross-Project Loop Prevention**: Same-machine → same-target queries are rate-limited (3 per 5 minutes) to prevent infinite self-referencing loops. Member list shows `[自マシン]` marker
- **Tab Restore on Server Restart**: Tabs in TAB_ORDER are now restored even when sessions are cleaned up by server restart — uses `machinesApi.list()` fallback for project info
- **Chat Header Cleanup**: Removed "h: help" and "clear" labels, toggle switches use subtle slate colors instead of amber/red
- **Project Display Name**: Rename projects via Team page inline edit — `Project.displayName` column, `PUT /api/projects/:id/display-name`, ask.sh searches both displayName and original name
- **Skip Permissions Plan Mode Fix**: Auto-approve toggle now works in plan mode (2nd+ messages after exec) — plan mode `canUseTool` now checks `getServerSkipPermissions()`, added `find`/`ls`/`locate` to plan mode allowed tools
- **Cross-Project Timeout Unification**: ask.sh curl timeout split by mode — ask: 10min, teamexec: 60min (was 5min for both). Server detects HTTP disconnect (`request.raw.on('close')`) and cleans up stuck sessions
- **Windows Installer WMI Fix**: Replaced `Get-CimInstance Win32_Process` with `tasklist /FI` in `install-agent.ps1` — fixes infinite hang at step 6/6 in corporate proxy environments where WMI queries are blocked
- **Windows Installer Debug Logging**: Added DEBUG output to step 6/6 to identify remaining hang points — removed `/V` flag from tasklist, fixed stale `Get-CimInstance` in completion message

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
│   ├── macos/            # macOS CLI Agent (launchd management)
│   └── windows/          # Windows Agent (Electron tray app)
├── rules/
│   ├── devrelay.md       # DevRelay Agreement v6 (shared rules)
│   └── project.md        # Project-specific design decisions
├── doc/
│   ├── changelog.md      # Implementation history (#1-#183)
│   └── ...               # Additional docs
└── scripts/
    ├── install-agent.sh    # Linux/macOS one-liner installer
    ├── install-agent.ps1   # Windows one-liner installer
    └── update-version.js   # Batch version update script
```

## 🚀 Quick Start

### 1. Install Agent (on your dev machine)

#### Linux / macOS Agent (One-liner)

```bash
curl -fsSL https://raw.githubusercontent.com/murata1215/devrelay/main/scripts/install-agent.sh | bash -s -- --token YOUR_TOKEN
```

`git` and `claude` (Claude Code) required (macOS: Xcode Command Line Tools). Node.js 20+ and pnpm are **auto-installed** if missing (downloaded to `~/.devrelay/node/`, sudo fallback for global pnpm install). Get your token from the WebUI Agents page (click "+ Add Agent"). The agent name will be set automatically from your hostname. The installer auto-detects OS (Linux/macOS) and configures the appropriate process manager (systemd/launchd).

#### Windows CLI Agent (One-liner)

```powershell
$env:DEVRELAY_TOKEN="YOUR_TOKEN"; irm https://raw.githubusercontent.com/murata1215/devrelay/main/scripts/install-agent.ps1 | iex
```

Node.js 20+, git, and Claude Code required (pnpm is auto-installed if missing). ExecutionPolicy is set automatically. Installs to `%APPDATA%\devrelay\agent\` with Startup folder auto-start.

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
| `ag` / `agreement` | Apply DevRelay Agreement v6 (creates `rules/devrelay.md`) |
| `link` | Link Discord/Telegram account to WebUI |
| `1`, `2`, `3`... | Select from list |
| `u` / `update` | Check agent version / remote update (requires double confirmation) |
| `k` / `kill` | Cancel running AI process |
| `x` | Clear conversation history (requires double confirmation) |
| `q` | Disconnect |
| `ask <project>: <question>` | Ask another project's agent a question |
| `teamexec <project>: <instruction>` | Send exec request to another project's agent |
| `te <project>: <instruction>` | Short alias for teamexec |
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

The one-liner installers prompt for proxy settings **before** dependency checks, so that Node.js download and pnpm auto-install also use the proxy. When a proxy is configured, `HTTP_PROXY`/`HTTPS_PROXY` are set for all operations (`git clone`, `pnpm install`, token validation). The proxy settings are also written to the service configuration (systemd `Environment=`, macOS LaunchAgent `EnvironmentVariables`, crontab inline env) so that the claude CLI can reach Anthropic API through the proxy at runtime. You can also specify proxy via CLI arguments or environment variables:

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
│       ├── dev-report-generator.ts # AI dev reports (multi-provider)
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

agents/macos/                    # macOS CLI Agent (launchd management)
├── src/
│   ├── cli/commands/
│   │   ├── setup.ts          # LaunchAgent plist registration
│   │   ├── status.ts         # launchctl-based status
│   │   └── uninstall.ts      # launchctl unload + cleanup
│   └── services/
│       ├── config.ts         # macOS config (home dir only)
│       ├── connection.ts     # WebSocket to server
│       └── management-info.ts # launchd/PM2/nohup detection

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
- [x] Agreement v6 + CLAUDE.md migration (rules separation, lightweight hub, issue tracking, cross-project collaboration)
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
- [x] Dev Reports (AI-generated development reports from conversation history)
- [x] macOS Agent (launchd management, cross-platform installer, WebUI macOS tab)
- [x] Installer proxy early detection + pnpm auto-install restoration + service env vars (systemd/launchd/crontab PATH and proxy)
- [x] "Prompt is too long" stdout detection fix + Installer Claude Code mandatory check
- [x] Document Vector Search - MessageFile pgvector embeddings + Claude Code skill for cross-project semantic search
- [x] Agent update hardening - pgrep self-kill prevention, step-by-step exit code logging, spawn error handling, timeout, Windows `isInstalledAgent` path fix
- [x] Windows PowerShell VBS wrapper - `DETACHED_PROCESS` causes PowerShell 5.1 to silently exit; fixed with `wscript.exe` + VBS `.Run` pattern
- [x] Agent stability fixes - pongCheckInterval leak, machineId empty string bug, nohup `disown` + shell operator precedence fix
- [x] WebSocket reconnect backoff fix + service setup guide
- [x] Chat history persistence - session restoration across page reload, cursor-based pagination, infinite scroll
- [x] Discord-style chat layout - left-aligned messages, colored usernames, avatar images, chat display settings
- [x] Image attachment preview - inline preview with lightbox, history image display via `/api/files/:id`
- [x] Testflight command - automated service creation
- [x] Agent Doc Folder - file sync from DocPanel to agent local filesystem (`~/.devrelay/docs/`) via WebSocket
- [x] Resume startup timeout - auto-retry without `--resume` when Claude Code hangs on stale sessions
- [x] Dynamic remote branch detection - `u` command detects default branch instead of hardcoding `origin/main`
- [x] Team management + cross-project query (`ask <project>: <question>`)
- [x] Cross-project exec (`teamexec <project>: <instruction>`, Claude Code skill `--exec` flag)
- [x] Issue tracking (`doc/issues.md` per project, Agreement v6)
- [x] Discord/Telegram tool approval buttons (approve/deny/approve-all with cross-platform sync)
- [x] WebUI reload tool approval card restoration (pending approvals pushed on WS reconnect)
- [ ] LINE Bot
- [ ] AI tool switching (Gemini/Aider)

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
