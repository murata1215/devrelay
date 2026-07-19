# 🌉 DevRelay

> [日本語版はこちら](README_JA.md)

> A remote development hub that connects any messaging app to any AI CLI tool

Control Claude Code, Gemini CLI, Devin CLI, and more from Discord, Telegram, or LINE.
Turn your phone into a remote terminal for AI-powered development.

## ✨ Features

- **Multi-Agent**: Register and switch between ubuntu-dev/user1, ubuntu-prod/user2, windows01/dev...
- **Multi-Project**: Manage multiple projects on each agent
- **Multi-AI**: Support for Claude Code, Gemini CLI, Devin CLI, Aider
- **Claude Model Selection**: Choose the Claude SDK model per Plan/Exec mode via the `l` command (`l sonnet`, `l plan:haiku`, `l exec:opus`) or the Settings page — both share the same `claude_model_plan` / `claude_model_exec` settings (last-write-wins). Full model IDs (`claude-opus-4-8`, `claude-fable-5`) bypass CLI alias resolution and hit the API directly, so newer models work without upgrading the CLI/Node.js. Applied via `sdkOptions.model` on **all Agent OSes** (Linux/Windows + macOS; #259 ported the plumbing to the macOS Agent, which previously ignored the `model` payload and fell back to the CLI default). Terminal-mode projects are out of scope (the Claude CLI manages its own model)
- **Multi-Platform**: Operate from Discord, Telegram (LINE coming soon)
- **Natural Language Commands**: "reconnect to last project" auto-translates to the right command (OpenAI / Anthropic / Gemini)
- **Plan / Execute Mode**: AI plans first, you review, then it implements
- **DevRelay Agreement v6**: Rules in `rules/devrelay.md`, lightweight CLAUDE.md hub, issue tracking, cross-project collaboration
- **Real-time Progress**: Watch AI's progress live on Discord/Telegram
- **Bidirectional File Transfer**: Send and receive files between chat and dev machines
- **History Export**: Download conversation history as daily ZIP files
- **Proxy Support**: Connect through HTTP/HTTPS/SOCKS5 proxies
- **Build Log**: Auto-track every exec with AI-generated summaries
- **Conversations Analytics**: View all AI interactions with token usage breakdown (Terminal Mode sessions show duration; SDK sessions include full token details)
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
- **Flutter Device Deploy**: Build & install a Flutter app to a USB-connected physical device straight from chat via the `devrelay-flutter-deploy` skill (e.g. "deploy mimamori to SE3", "install to the Android device"). No more typing `flutter run` over NoMachine. The agent runs `flutter devices --machine`, resolves the target by case-insensitive **partial name match** (se3 → iPhoneSE3, pixel → Pixel 7), then `flutter build ios|apk --release` → `flutter install -d <id>` (non-interactive). **iOS = macOS only; Android on all OSes** (Windows/macOS/Linux). `--debug` / `--flavor` / `--dart-define` pass through; `--list` enumerates connected real devices; emulators/desktop/web are excluded; wireless devices warn (USB recommended). Local-only skill (no server API), auto-distributed to Linux/macOS/Windows-CLI agents. USB connection + unlock (iOS Developer Mode / Android USB debugging) required
- **Agent Log Rotation**: Daily copyTruncate rotation with 7-day retention for `agent.log`
- **Per-Agent Skip Permissions**: Toggle "自動承認" switch in chat header or Agent Settings to auto-approve all tools (like `--dangerously-skip-permissions`), AskUserQuestion still prompts
- **Disable AskUserQuestion**: Toggle "Ask無効" switch per agent — uses SDK `disallowedTools` to remove the tool from Claude's context entirely (no wasted turns), for autonomous execution without questions
- **Tool Approval/Question Card Recovery**: Pending approval cards and AskUserQuestion cards reliably survive browser reload and appear in new tabs — memory-based recovery (no DB dependency), `//connect`-triggered restoration, 12-hour timeout (forgetting ≠ rejecting)
- **Multi-Agent Routing Fix**: DB fallback for projectId resolution prevents messages from appearing in wrong project tabs
- **Xcode Project Detection**: `.xcodeproj` directories are detected as projects alongside `CLAUDE.md`
- **Plan File Viewer**: View Claude Code's plan files (`~/.claude/plans/*.md`) in the WebUI right panel — automatically shows the latest plan with Markdown rendering
- **Skip Permissions Realtime Sync**: Toggle now takes effect immediately even mid-session — dynamic getter replaces static snapshot
- **Per-Agent Remote Restart**: Restart individual agents from WebUI (table row icon + Settings modal button) via WebSocket `server:agent:restart` → Linux/macOS rely on systemd/launchd auto-restart, Windows uses delayed restart (`cmd.exe /c "ping -n 3 ... & wscript.exe start-agent.vbs"`) to avoid log file locking — `start-agent.cmd`'s `>>` holds an exclusive write lock on `agent.log`, so the new CMD must wait for the old process to exit first. Server-side `connectedAgents` registration is done immediately after token verification (before async DB operations) to prevent race conditions where the old agent's disconnect event fires mid-`handleAgentConnect` and clobbers the new connection
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
- **Windows Installer PID-based Process Kill**: Fixed old agent process never being killed on reinstall — `tasklist /FO CSV` output doesn't contain command line, so `-match 'devrelay'` always failed. Now uses PID file (`agent.pid`) with WMI timeout fallback
- **macOS Agent Update Build Fix**: Fixed `u` command building Linux agent (`@devrelay/agent`) instead of macOS agent (`@devrelay/agent-macos`) — caused all post-#196 features (skipPermissions, disableAsk) to not work on macOS
- **Message Dedup with DB IDs**: Fixed message duplication on tab switch — server now sends DB messageId in WS payloads, client uses it for exact dedup. DB also stores contextInfo (📊 Rate Limit) with output
- **Windows Ask/TeamExec Fix**: Fixed 400 Content-Length mismatch on Windows Git Bash + proxy — strips CRLF from jq output, uses pipe-based curl body delivery
- **FCM Push Notifications**: Firebase Cloud Messaging for iOS/Android mobile push — `POST /api/push/fcm/subscribe`, session completion + tool approval triggers, auto-cleanup of invalid tokens
- **Notification API**: Server-side notification records for mobile app badge + notification list — `GET /api/notifications`, `POST /api/notifications/read-all`, `GET /api/notifications/unread-count`
- **Claude Code Optional at Install**: The agent installer (`install-agent.sh` / `install-agent.ps1`) no longer aborts when Claude Code is missing — a Devin-only (or Gemini/Codex/Aider-only) machine can now be onboarded. If `claude` is absent but another AI CLI is present, install continues with a warning; if none is present, it still installs and warns (the agent's startup auto-detection picks up whatever is installed later). The generated `config.yaml` now emits only the AI tools actually detected and sets `default` by priority (claude > devin > gemini > codex > aider), falling back to `claude` when none are found. Agent runtime already worked without Claude — only the installer's hard precondition was blocking it (#261)
- **Devin Plan Mode Read-Only Enforcement**: Devin plan mode now enforces true read-only at the tool level via `--agent-config`. Previously plan used `--permission-mode auto`, which only auto-approves tools Devin deems "safe" and is not a strict read-only mode. Plan mode now writes a temp JSON (`{"permissions":{"allow":["Read(**)"],"deny":["Write(**)","Exec(**)"]}}`) and passes it via `--agent-config`, denying all file writes and shell execution. Exec mode is unchanged (`--permission-mode dangerous`). The temp config is auto-deleted on process exit alongside the existing prompt temp file (#260)
- **Devin CLI Integration**: Devin for Terminal support via `--prompt-file` + `-r <session-id>` explicit session resume + plan/exec permission mapping (plan → `--agent-config` read-only, exec → `--permission-mode dangerous`), CLAUDE.md compatible — same architecture as Gemini/Codex/Aider. Session IDs auto-saved to `.devrelay/devin-session-id`, cleared by `x` command. **`-r` resume is plan-mode only**: Devin's resume preserves the original session's permission-mode and ignores the `--permission-mode dangerous` CLI flag, so exec mode starts a fresh session for write permissions to take effect. Conversation context survives via prompt-history injection (already applied to all non-Claude tools). **User-specified file paths respected**: the `OUTPUT_DIR_INSTRUCTION` prompt suffix says "save to `.devrelay-output/` unless user specifies otherwise" — so plain-text directives like 「ルートフォルダに」 ("in the root folder") override the default routing
- **Remote MCP Server**: DevRelay exposes Plan/Exec/BuildLog as MCP tools via `/mcp` Streamable HTTP endpoint. Claude mobile (voice) and Claude.ai Web can connect as custom connectors. 6 tools: `list_projects`, `search_project_context`, `get_plan`, `get_build_status`, `submit_instruction`, `approve_implementation`. OAuth 2.1 with Dynamic Client Registration + PKCE + Google login. Non-blocking: submit/approve return immediately, poll for results
- **Multi-Platform Project Scaffold**: Create new projects on any agent via the `devrelay-create-project` skill (e.g. "create a Flutter project on the Mac"). Five templates: `vite-react-web` (Vite + React 19 + TS + Tailwind), `flutter-app` (`flutter create`), `android-kotlin` (static Gradle Kotlin DSL), `xcode-swiftui` (`xcodegen generate` → SwiftUI iOS app, **macOS-only**), and `empty` (CLAUDE.md + .gitignore). CLI-generator approach — `flutter`/`xcodegen` must be installed (fail-fast with `brew install` guidance if missing). **OS auto-restriction**: the server checks `Machine.managementInfo.os` against each template's supported OS and rejects mismatches with 400 (e.g. `xcode-swiftui` on Linux). **Every template writes a `CLAUDE.md`** so the created project is immediately recognized by the agent (`looksLikeProject()` is CLAUDE.md-based) and appears in DevRelay's project list. Single source of truth: template id/os/required-tool live in shared `SCAFFOLD_TEMPLATE_DEFS`, driving both server validation and dynamically-generated skill files
- **Raw-Create Project Recognition**: Projects created by a plain `flutter create` / `gradle init` (without going through the scaffold skill) are still recognized — `looksLikeProject()` now also matches `pubspec.yaml` (Flutter) and `settings.gradle(.kts)` (Android) in addition to `CLAUDE.md` / `.xcodeproj`. Newly-detected projects missing a `CLAUDE.md` get a minimal one auto-written (keeping the "every project has CLAUDE.md" policy; existing projects are never overwritten). Additionally, the agent re-scans `projectsDirs` after every **exec** completion, so a freshly-created project appears in DevRelay's list immediately without waiting for an agent restart
- **AI Tool Auto-Detection**: Agent startup auto-detects installed AI CLIs (`which`/`where`) and adds them to `config.yaml` — no manual config needed. Preserves custom paths, never removes existing entries
- **Terminal Interface Mode**: Per-project "端末" toggle launches `claude` via PTY (`@homebridge/node-pty-prebuilt-multiarch` + `@xterm/headless` with 10000-line scrollback) instead of Agent SDK — on-demand start/stop with no memory residency. **New projects default to OFF (SDK mode)** — `Project.terminalMode @default(false)` in `schema.prisma`; enable per-project via the WebUI toggle / API (`0b32c83` briefly defaulted this to `true` on 2026-06-21, reverted to `false` on 2026-07-17). Works on Linux + Windows (CLI install). **Session continuity** via `claude --resume <id>`: agent captures Claude CLI's session UUID at exit (from the "Resume this session with:" message) and saves it to `.devrelay/claude-session-id`. SDK and terminal mode share `~/.claude/projects/<hash>/sessions/<id>.jsonl` so continuity flows in both directions, even for terminal-mode-only projects. `Previous conversation:` prompt history injection is **skipped for terminal mode** — Claude CLI manages its own session via JSONL, and injecting history makes Claude drift to past topics instead of focusing on the new question. **Any numbered-choice prompt** (trust folder, resume-from-summary, tool approvals, AskUserQuestion with `Enter to select` ↑/↓ navigation, future CLI system prompts) is automatically bridged to the existing WS approval card flow. Cursor-based select prompts (trust folder, resume — `Enter to confirm` pattern) use arrow-key navigation + Enter (#234: number typing confuses Claude CLI's SelectInput); text-input prompts (tool approval with bare `❯`) use number typing as before. Choice prompt detection scans only the last 30 screen lines (#235: stale prompts in scrollback caused duplicate forwarding) — option extraction uses "newest (bottom-most) sequential 1,2,3,... numbering" detection (#232: changed from "longest" to prevent old scrollback lists from shadowing the current prompt) so indented descriptions and `─────` separators between options don't break the parse. **Live progress visibility**: new text bullets stream to WebUI with Set-based dedup + prefix filter + 1.5s debounce; tool-call bullets (`Bash`/`PowerShell`/`Read`/`Write`/…), `⎿` tool-output summaries, and short partial fragments are filtered out (SDK-style output). 30s heartbeats surface Claude's thinking indicator (`⏳ [60s] Doing (109 tokens)`). **Completion fires** when screen idle 5s + prompt ready + at least one new bullet (tracked by `Map<text, count>` per-text delta so it survives both scrollback trim and re-asks where the response matches existing JSONL history), OR via an extended-idle path (30s of no screen change) for cases where `❯` is hidden behind background tasks like `npm run build`. Completion check polls a fresh `extractFinalOutput(term)` each 500ms tick to avoid xterm tracker freeze. Final response extracts only the most-recent bullet block by anchoring on the input box and walking up to `Previous conversation:` / `User:` / banner boundaries. Three safety nets: 5s idle gate (raised from 1.5s in #233 to prevent premature completion during tool→response gaps), 30s extended-idle, 10min first-bullet timeout, 10min onData-based idle timeout. Windows installer auto-downloads ABI-matching `conpty.node` from GitHub Releases when `prebuild-install` skips it. **Usage data collection**: on session completion, agent reads `~/.claude/projects/<hash>/<sessionId>.jsonl` to extract model name, token counts (input/output/cache), and populates the Conversations table — same columns as SDK mode. **Bypass permissions auto-accept**: when `approveAllMode=true` (i.e. `--dangerously-skip-permissions` was passed), the CLI shows a "1. No, exit / 2. Yes, I accept" confirmation — option order inverted from trust prompt. Agent auto-detects `"Yes, I accept"` in options and selects it via arrow-key + Enter, skipping user forwarding. **Startup failure auto-retry**: if terminal mode exits within 30s without ever sending the user's prompt (`promptSent=false` — e.g. broken `--resume` session ID), the agent automatically retries once without `--resume`. PTY exit(code≠0) with `promptSent=false` dumps last 500 chars of screen to agent.log for diagnostics. **Startup choice cooldown**: 3s cooldown after any startup choice answer (bypass/trust/resume) before detecting `promptReady`, preventing premature prompt injection while Claude CLI's input handler initializes. **Submit retry**: after sending `\r` to submit prompt, monitors screen for change; retries `\r` up to 3× if screen stays static (Windows ConPTY + Ink TextInput timing). Session ID is only saved when `promptSent=true` — startup failures no longer poison next `--resume`. **Shell running completion suppression**: completion is suppressed when Claude CLI shows `✻ ... still running` indicator (background Bash tasks) — prevents `/exit` from killing long-running builds like `electron-builder`. Exec mode prompts also instruct Claude to run shell commands in the foreground (belt-and-suspenders defense). **AI Screen Analysis**: when heuristics fail (submit verification after 3s with no response, or extended-idle before completing), the agent sends the PTY screen text to the server via WebSocket, which calls Claude Haiku to interpret the screen state and return a structured action (`send_enter`, `wait`, `select_option`, `abort`). This eliminates the "whack-a-mole" pattern of adding regex fixes for every Claude CLI UI change. Cost: ~$0.0006/call, fires only on failure (1-5%). Graceful degradation: skips if no Anthropic API key configured. Extended-idle AI checks are capped at 3 retries to prevent infinite loops

## 💡 Token Efficiency

DevRelay uses Claude Code's `--resume` option to continue sessions, achieving **the same token efficiency as direct CLI usage**. In Terminal Mode, `--resume` is used **only for exec mode** — plan mode starts a fresh session to prevent context bleed from previous exec work (#238).

- **Overhead**: ~200 tokens/prompt for plan/exec mode instructions
- **Session Continuity**: `--resume` keeps conversation context in Claude Code, no history re-sending (exec mode only in Terminal Mode)
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

`git` required (macOS: Xcode Command Line Tools). An **AI CLI is optional** — Claude Code, Gemini, Codex, Aider, or Devin; any one works, and the installer no longer aborts if none is present (a Devin-only machine is fine). The generated `config.yaml` picks its `default` from whichever AI CLI is detected (priority: claude > devin > gemini > codex > aider), and the agent's startup auto-detection adds any tool installed later. Node.js 20+ and pnpm are **auto-installed** if missing (downloaded to `~/.devrelay/node/`, sudo fallback for global pnpm install). Get your token from the WebUI Agents page (click "+ Add Agent"). The agent name will be set automatically from your hostname. The installer auto-detects OS (Linux/macOS) and configures the appropriate process manager (systemd/launchd).

#### Windows CLI Agent (One-liner)

```powershell
$env:DEVRELAY_TOKEN="YOUR_TOKEN"; irm https://raw.githubusercontent.com/murata1215/devrelay/main/scripts/install-agent.ps1 | iex
```

Node.js 20+ and git required (pnpm is auto-installed if missing). An AI CLI (Claude Code / Gemini / Codex / Aider / Devin) is **optional** — any one works and the installer no longer aborts if none is present. ExecutionPolicy is set automatically. Installs to `%APPDATA%\devrelay\agent\` with Startup folder auto-start.

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

The one-liner installers prompt for proxy settings **before** dependency checks, so that Node.js download and pnpm auto-install also use the proxy. When a proxy is configured, `HTTP_PROXY`/`HTTPS_PROXY` are set for all operations (`git clone`, `pnpm install`, token validation), **and `npm config set proxy/https-proxy` + `pnpm config set proxy/https-proxy` are also invoked automatically** so that `npm install -g pnpm` and `pnpm install` work reliably in environments where the env vars alone don't propagate (e.g. some corporate proxies). The proxy settings are also written to the service configuration (systemd `Environment=`, macOS LaunchAgent `EnvironmentVariables`, crontab inline env) so that the claude CLI can reach Anthropic API through the proxy at runtime. You can also specify proxy via CLI arguments or environment variables:

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

To remove the npm/pnpm proxy config installed by the installer:

```bash
pnpm config delete proxy && pnpm config delete https-proxy
npm  config delete proxy && npm  config delete https-proxy
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
- [x] Multi-platform project scaffold (Flutter / Android / Xcode-SwiftUI / empty templates with OS auto-restriction)
- [x] Flutter device deploy skill (`devrelay-flutter-deploy` — build & install to USB device via chat, iOS/Android, partial-match device resolution)
- [ ] LINE Bot
- [ ] AI tool switching (Gemini/Aider)

## 📄 License

Licensed under the [Apache License, Version 2.0](LICENSE) (the "License");
you may not use this project except in compliance with the License.

Copyright 2026 Keisuke Murata. See the [LICENSE](LICENSE) and [NOTICE](NOTICE) files for details.

Apache-2.0 is chosen for its explicit patent grant (Section 3) and clear contribution terms (Section 5), making DevRelay easy for organizations to adopt and contribute to. Contributions submitted for inclusion in the Work are licensed under the same terms without any additional conditions.
