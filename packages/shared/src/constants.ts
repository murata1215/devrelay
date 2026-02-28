// =============================================================================
// DevRelay Shared Constants
// =============================================================================

// Shortcut commands (works without API key)
export const SHORTCUTS: Record<string, string> = {
  'm': 'machine:list',
  'p': 'project:list',
  // 's': 'status',  // 現在未使用
  'r': 'recent',
  'c': 'continue',  // 前回の接続先に再接続
  'x': 'clear',     // 会話履歴をクリア
  'e': 'exec',      // プラン実行開始
  'exec': 'exec',   // プラン実行開始（フルコマンド）
  'w': 'wrap',       // ドキュメント更新＋コミットプッシュ（wrap up）
  'link': 'link',   // プラットフォームリンクコード生成
  'a': 'ai:list',   // AI ツール一覧・切り替え
  'ag': 'agreement', // DevRelay Agreement を CLAUDE.md に追加
  'agreement': 'agreement',
  's': 'session',    // セッション情報を表示
  'session': 'session',
  'b': 'build',     // ビルドログ（exec 実行履歴）
  'build': 'build',
  'k': 'kill',     // AI プロセスを強制停止
  'kill': 'kill',
  'q': 'quit',
  'h': 'help',
  'log': 'log',
  'sum': 'summary',
};

// AI tool display names
export const AI_TOOL_NAMES: Record<string, string> = {
  'claude': 'Claude Code',
  'gemini': 'Gemini CLI',
  'codex': 'Codex CLI',
  'aider': 'Aider',
};

// Status emojis
export const STATUS_EMOJI = {
  online: '🟢',
  offline: '⚪',
  running: '🤖',
  starting: '🚀',
  stopped: '⏹️',
  error: '❌',
} as const;

// プランモード中に許可する読み取り専用 Bash コマンドのデフォルトリスト（Linux 用）
export const DEFAULT_ALLOWED_TOOLS_LINUX: string[] = [
  // PM2 ログ・ステータス確認
  'Bash(pm2 logs)',
  'Bash(pm2 log)',
  'Bash(pm2 status)',
  'Bash(pm2 list)',
  'Bash(pm2 show)',
  'Bash(pm2 describe)',
  // システム・ログ確認
  'Bash(journalctl)',
  'Bash(systemctl status)',
  'Bash(systemctl is-active)',
  // Git 読み取り
  'Bash(git log)',
  'Bash(git status)',
  'Bash(git diff)',
  'Bash(git show)',
  'Bash(git branch)',
  // システム情報
  'Bash(ps)',
  'Bash(free)',
  'Bash(df)',
  'Bash(du)',
  'Bash(ss)',
  'Bash(netstat)',
  // Docker（参照のみ）
  'Bash(docker ps)',
  'Bash(docker logs)',
  'Bash(docker compose ps)',
  'Bash(docker compose logs)',
  // ログ・ファイル読み取り
  'Bash(tail)',
  'Bash(head)',
  'Bash(wc)',
  // ネットワーク・サーバー状態
  'Bash(curl)',
  'Bash(lsof)',
  'Bash(uptime)',
  // リバースプロキシ確認
  'Bash(caddy)',
];

// プランモード中に許可する読み取り専用 Bash コマンドのデフォルトリスト（Windows 用）
export const DEFAULT_ALLOWED_TOOLS_WINDOWS: string[] = [
  // PM2 ログ・ステータス確認
  'Bash(pm2 logs)',
  'Bash(pm2 log)',
  'Bash(pm2 status)',
  'Bash(pm2 list)',
  'Bash(pm2 show)',
  'Bash(pm2 describe)',
  // Git 読み取り
  'Bash(git log)',
  'Bash(git status)',
  'Bash(git diff)',
  'Bash(git show)',
  'Bash(git branch)',
  // システム情報（PowerShell）
  'Bash(Get-Service)',
  'Bash(Get-Process)',
  'Bash(Get-EventLog)',
  'Bash(tasklist)',
  'Bash(sc query)',
  'Bash(netstat)',
  // Docker（参照のみ）
  'Bash(docker ps)',
  'Bash(docker logs)',
  'Bash(docker compose ps)',
  'Bash(docker compose logs)',
  // ファイル読み取り
  'Bash(Get-Content)',
  'Bash(type)',
  // ネットワーク・サーバー状態
  'Bash(curl)',
  'Bash(Invoke-WebRequest)',
];

// Default config values
export const DEFAULTS = {
  logCount: 10,
  maxLogCount: 100,
  summaryPeriodDays: 1,
  sessionTimeoutMinutes: 30,
  websocketPingInterval: 30000,
  websocketReconnectDelay: 5000,
  // Reconnection settings (shorter delays for stable connections)
  reconnect: {
    baseDelay: 500,       // Initial delay: 0.5 seconds
    maxDelay: 10000,      // Maximum delay: 10 seconds
    maxAttempts: 30,      // More attempts since delays are shorter
    jitterRange: 500,     // 0-0.5 second random jitter
  },
} as const;
