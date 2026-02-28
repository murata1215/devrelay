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
