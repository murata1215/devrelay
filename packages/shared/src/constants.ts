// =============================================================================
// DevRelay Shared Constants
// =============================================================================

// Shortcut commands (works without API key)
export const SHORTCUTS: Record<string, string> = {
  'm': 'machine:list',
  'p': 'project:list',
  's': 'status',
  'r': 'recent',
  'c': 'continue',  // 前回の接続先に再接続
  'x': 'clear',     // 会話履歴をクリア
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
} as const;
