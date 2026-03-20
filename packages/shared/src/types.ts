// =============================================================================
// DevRelay Shared Types
// =============================================================================

// -----------------------------------------------------------------------------
// Protocol Version（Agent/Server 間の互換性管理）
// -----------------------------------------------------------------------------

/**
 * プロトコルバージョン（Agent がビルド時に焼き込む整数値）
 *
 * バージョン履歴:
 * - 1: protocolVersion フィールド導入（2026-03-20）
 *
 * バージョンを上げるタイミング:
 * - Agent/Server 間のメッセージフォーマットに後方互換性のない変更を加えた場合
 * - Agent 側に必須の新機能（ハンドラ等）を追加した場合
 *
 * サーバー側の MIN_PROTOCOL_VERSION を上げると、それ未満の Agent は接続拒否される。
 */
export const PROTOCOL_VERSION = 1;

// -----------------------------------------------------------------------------
// Machine & Project
// -----------------------------------------------------------------------------

export interface Machine {
  id: string;
  name: string;
  displayName?: string | null;  // ユーザーが設定した表示名（ホスト名エイリアスから自動計算）
  status: 'online' | 'offline';
  lastSeen: Date;
  projects: Project[];
}

export interface Project {
  name: string;
  path: string;
  defaultAi: AiTool;
  lastUsed?: Date;
}

export type AiTool = 'claude' | 'gemini' | 'codex' | 'aider';

/** AI API プロバイダー（API キー管理・機能別プロバイダー選択で使用） */
export type AiProvider = 'openai' | 'anthropic' | 'gemini' | 'none';

// Agreement ステータス
// 'latest' = 最新版あり, 'outdated' = 旧版あり（更新推奨）, 'none' = なし
export type AgreementStatus = 'latest' | 'outdated' | 'none';

// -----------------------------------------------------------------------------
// Proxy Configuration
// -----------------------------------------------------------------------------

export interface ProxyConfig {
  url: string;          // Proxy URL (http://, https://, socks4://, socks5://)
  username?: string;    // Optional: username for authentication
  password?: string;    // Optional: password for authentication
}

// -----------------------------------------------------------------------------
// Session
// -----------------------------------------------------------------------------

export interface Session {
  id: string;
  machineId: string;
  machineName: string;
  projectName: string;
  projectPath: string;
  aiTool: AiTool;
  aiStatus: 'starting' | 'running' | 'stopped';
  participants: Participant[];
  startedAt: Date;
}

export interface Participant {
  userId: string;
  platform: Platform;
  chatId: string;
  joinedAt: Date;
}

export type Platform = 'discord' | 'telegram' | 'line' | 'slack' | 'web';

// -----------------------------------------------------------------------------
// Messages (WebSocket Protocol - Agent)
// -----------------------------------------------------------------------------

// Agent -> Server
export type AgentMessage =
  | { type: 'agent:connect'; payload: AgentConnectPayload }
  | { type: 'agent:disconnect'; payload: { machineId: string } }
  | { type: 'agent:projects'; payload: { machineId: string; projects: Project[] } }
  | { type: 'agent:ai:output'; payload: AiOutputPayload }
  | { type: 'agent:ai:status'; payload: AiStatusPayload }
  | { type: 'agent:session:restore'; payload: SessionRestorePayload }
  | { type: 'agent:storage:saved'; payload: StorageSavedPayload }
  | { type: 'agent:ping'; payload: AgentPingPayload }
  | { type: 'agent:history:dates'; payload: HistoryDatesPayload }
  | { type: 'agent:history:export'; payload: HistoryExportPayload }
  | { type: 'agent:ai:list'; payload: AiListResponsePayload }
  | { type: 'agent:ai:switched'; payload: AiSwitchedPayload }
  | { type: 'agent:session:aiTool'; payload: SessionAiToolPayload }
  | { type: 'agent:ai:cancelled'; payload: AiCancelledPayload }
  | { type: 'agent:config:ack'; payload: { machineId: string } }
  | { type: 'agent:version:info'; payload: AgentVersionInfoPayload }
  | { type: 'agent:update:status'; payload: AgentUpdateStatusPayload }
  | { type: 'agent:project:file:content'; payload: ProjectFileContentPayload }
  | { type: 'agent:tool:approval:request'; payload: ToolApprovalRequestPayload }
  | { type: 'agent:tool:approval:auto'; payload: ToolApprovalAutoPayload };

export interface SessionRestorePayload {
  machineId: string;
  projectPath: string;
  projectName: string;
  agreementStatus: AgreementStatus | boolean;  // Agreement の状態（後方互換性のため boolean も可）
}

export interface AgentPingPayload {
  machineId: string;
  timestamp: string;
}

export interface HistoryDatesPayload {
  machineId: string;
  projectPath: string;
  requestId: string;
  dates: string[];  // Array of dates in YYYY-MM-DD format
}

export interface HistoryExportPayload {
  machineId: string;
  projectPath: string;
  requestId: string;
  date: string;  // YYYY-MM-DD format
  zipContent: string;  // Base64 encoded ZIP file
  error?: string;  // Error message if export failed
}

/**
 * 管理コマンドの1項目
 * Agent の環境に応じたシェルコマンドを保持する
 */
export interface ManagementCommand {
  /** コマンドの種類 */
  type: 'logs' | 'stop' | 'restart' | 'status' | 'crontab' | 'auto-start-disable';
  /** 表示ラベル（例: 「ログ」「停止」） */
  label: string;
  /** 実行するコマンド文字列（マシン固有のパスを含む） */
  command: string;
}

/**
 * Agent の管理情報
 * OS・インストール方法に応じた管理コマンドの一覧を構造化して保持
 */
export interface ManagementInfo {
  /** OS 種別: linux, win32, darwin */
  os: string;
  /** インストール方式 */
  installType: 'systemd' | 'pm2' | 'nohup' | 'launchd' | 'windows-startup' | 'manual';
  /** 管理コマンド一覧 */
  commands: ManagementCommand[];
}

export interface AgentConnectPayload {
  machineId: string;
  machineName: string;
  token: string;
  projects: Project[];
  availableAiTools: AiTool[];
  /** Agent の管理コマンド情報（環境固有のパスを含む） */
  managementInfo?: ManagementInfo;
  /** Agent ローカルの検索パス（Server 側で参照用） */
  projectsDirs?: string[];
  /** プロトコルバージョン（未送信の旧 Agent は 0 として扱う） */
  protocolVersion?: number;
}

export interface FileAttachment {
  filename: string;
  content: string; // base64 encoded
  mimeType: string;
  size: number;
}

/** Claude Code 実行時の使用量データ（result メッセージから取得してそのまま保存） */
export interface AiUsageData {
  /** per-request トークン情報: { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens } */
  usage?: Record<string, number>;
  /** モデル別セッション累積トークン: { "claude-opus-4-6": { contextWindow, input, output, cacheRead, cacheCreation } } */
  modelUsage?: Record<string, any>;
  /** 実行時間（ミリ秒） */
  durationMs?: number;
  /** 使用モデル名（modelUsage の最初のキーから取得。例: "claude-opus-4-6"） */
  model?: string;
  /** レートリミット情報（Agent SDK の rate_limit_event から取得） */
  rateLimits?: {
    fiveHour?: { utilization: number; resetsAt?: number; status: string };
    sevenDay?: { utilization: number; resetsAt?: number; status: string };
  };
}

export interface AiOutputPayload {
  machineId: string;
  sessionId: string;
  output: string;
  isComplete: boolean;
  files?: FileAttachment[];
  /** AI 実行の使用量データ（isComplete: true 時のみ） */
  usageData?: AiUsageData;
  /** exec モードで実行された場合 true（BuildLog 作成用） */
  isExec?: boolean;
  /** exec 実行時のプロンプト（BuildLog AI 要約のコンテキスト用） */
  execPrompt?: string;
}

export interface AiStatusPayload {
  machineId: string;
  sessionId: string;
  status: 'starting' | 'running' | 'stopped' | 'error';
  error?: string;
  agreementStatus?: AgreementStatus | boolean;  // Agreement の状態（後方互換性のため boolean も可）
  hasStorageContext?: boolean;  // Whether storage context exists for this project
}

// Server -> Agent
export type ServerToAgentMessage =
  | { type: 'server:connect:ack'; payload: ServerConnectAckPayload }
  | { type: 'server:session:start'; payload: SessionStartPayload }
  | { type: 'server:session:end'; payload: { sessionId: string } }
  | { type: 'server:ai:prompt'; payload: AiPromptPayload }
  | { type: 'server:conversation:clear'; payload: { sessionId: string; projectPath: string } }
  | { type: 'server:conversation:exec'; payload: ConversationExecPayload }
  | { type: 'server:workstate:save'; payload: WorkStateSavePayload }
  | { type: 'server:agreement:apply'; payload: AgreementApplyPayload }
  | { type: 'server:session:restored'; payload: SessionRestoredPayload }
  | { type: 'server:storage:save'; payload: StorageSavePayload }
  | { type: 'server:storage:clear'; payload: StorageClearPayload }
  | { type: 'server:pong'; payload: ServerPongPayload }
  | { type: 'server:history:dates'; payload: HistoryDatesRequestPayload }
  | { type: 'server:history:export'; payload: HistoryExportRequestPayload }
  | { type: 'server:ai:list'; payload: AiListPayload }
  | { type: 'server:ai:switch'; payload: AiSwitchPayload }
  | { type: 'server:ai:cancel'; payload: AiCancelPayload }
  | { type: 'server:config:update'; payload: ServerConfigUpdatePayload }
  | { type: 'server:agent:version-check'; payload: {} }
  | { type: 'server:agent:update'; payload: {} }
  | { type: 'server:doc:sync'; payload: DocSyncPayload }
  | { type: 'server:doc:delete'; payload: DocDeletePayload }
  | { type: 'server:project:file:read'; payload: ProjectFileReadPayload }
  | { type: 'server:tool:approval:response'; payload: ToolApprovalResponsePayload };

export interface HistoryDatesRequestPayload {
  projectPath: string;
  requestId: string;
}

export interface HistoryExportRequestPayload {
  projectPath: string;
  requestId: string;
  date: string;  // YYYY-MM-DD format
}

export interface ServerConnectAckPayload {
  success: boolean;
  machineId?: string;  // DB machine ID (only on success)
  error?: string;
  projectsDirs?: string[] | null;  // Server 管理のプロジェクト検索パス（null = ローカル設定を使用）
  allowedTools?: string[] | null;  // プランモード許可ツール（null = デフォルト使用）
  /** true の場合、Agent の更新が必要（プロトコルバージョン不足で接続拒否） */
  updateRequired?: boolean;
  /** サーバーが要求する最小プロトコルバージョン */
  minProtocolVersion?: number;
}

/** Server → Agent: 設定更新の配信（リアルタイム） */
export interface ServerConfigUpdatePayload {
  projectsDirs?: string[] | null;  // プロジェクト検索パスの更新（null = ローカル設定に戻す）
  allowedTools?: string[] | null;  // プランモード許可ツールの更新（null = デフォルトに戻す）
}

/** ドキュメント同期ペイロード（サーバー → Agent、ファイル追加） */
export interface DocSyncPayload {
  filename: string;
  content: string;  // base64 エンコード
  mimeType: string;
}

/** ドキュメント削除ペイロード（サーバー → Agent） */
export interface DocDeletePayload {
  filename: string;
}

/** Server → Agent: プロジェクト内ファイル読み取り要求 */
export interface ProjectFileReadPayload {
  projectPath: string;
  filePath: string;      // 相対パス（例: "doc/issues.md"）
  requestId: string;
}

/** Agent → Server: プロジェクト内ファイル読み取り結果 */
export interface ProjectFileContentPayload {
  machineId: string;
  requestId: string;
  content: string | null;  // ファイル内容（null = 未存在）
  error?: string;
}

export interface ServerPongPayload {
  timestamp: string;
}

export interface ConversationExecPayload {
  sessionId: string;
  projectPath: string;
  userId: string;
  /** exec コマンドに付加されたカスタムプロンプト（例: "exec, コミットして"） */
  prompt?: string;
}

export interface SessionRestoredPayload {
  sessionId: string;
  projectPath: string;
  chatId: string;
  platform: string;
}

export interface WorkStateSavePayload {
  sessionId: string;
  projectPath: string;
  workState: WorkState;
}

export interface AgreementApplyPayload {
  sessionId: string;
  projectPath: string;
  userId: string;
  /** Server から配信される Agreement 適用プロンプト（Agent のローカルテンプレートより優先） */
  agreementPrompt?: string;
}

export interface StorageSavePayload {
  sessionId: string;
  projectPath: string;
  content: string;
}

export interface StorageClearPayload {
  sessionId: string;
  projectPath: string;
}

export interface StorageSavedPayload {
  machineId: string;
  sessionId: string;
  projectPath: string;
  contentLength: number;
}

export interface SessionStartPayload {
  sessionId: string;
  projectName: string;
  projectPath: string;
  aiTool: AiTool;
}

// AI ツール切り替え関連
export interface AiListPayload {
  sessionId: string;
  requestId: string;
}

export interface AiListResponsePayload {
  machineId: string;
  sessionId: string;
  requestId: string;
  available: AiTool[];
  defaultTool: AiTool;
  currentTool: AiTool;
}

export interface AiSwitchPayload {
  sessionId: string;
  aiTool: AiTool;
}

/** Server → Agent: AI プロセスのキャンセル要求 */
export interface AiCancelPayload {
  sessionId: string;
}

/** Agent → Server: AI プロセスのキャンセル完了通知 */
export interface AiCancelledPayload {
  machineId: string;
  sessionId: string;
}

/** Agent → Server: バージョン情報の応答 */
export interface AgentVersionInfoPayload {
  machineId: string;
  localCommit: string;
  localDate: string;
  remoteCommit: string;
  remoteDate: string;
  hasUpdate: boolean;
  /** 開発リポジトリから実行中の場合 true */
  isDevRepo?: boolean;
  error?: string;
}

/** Agent → Server: 更新処理の進捗・結果 */
export interface AgentUpdateStatusPayload {
  machineId: string;
  status: 'started' | 'error';
  error?: string;
}

export interface AiSwitchedPayload {
  machineId: string;
  sessionId: string;
  aiTool: AiTool;
  success: boolean;
  error?: string;
}

export interface SessionAiToolPayload {
  machineId: string;
  sessionId: string;
  aiTool: AiTool;
}

// Missed messages (messages between last mention and current mention)
export interface MissedMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

export interface AiPromptPayload {
  sessionId: string;
  prompt: string;
  userId: string;
  files?: FileAttachment[];
  missedMessages?: MissedMessage[];
  /** Agent 再起動時の自動セッション初期化用（server:session:start を受け取れなかった場合のフォールバック） */
  projectPath?: string;
  aiTool?: AiTool;
}

// -----------------------------------------------------------------------------
// Commands (User -> Server via Platform)
// -----------------------------------------------------------------------------

export type UserCommand =
  | { type: 'machine:list' }
  | { type: 'machine:connect'; machineName: string }
  | { type: 'project:list' }
  | { type: 'project:connect'; projectName: string }
  | { type: 'select'; number: number }
  | { type: 'status' }
  | { type: 'recent' }
  | { type: 'continue' }  // 前回の接続先に再接続
  | { type: 'clear' }     // 会話履歴をクリア
  | { type: 'exec'; prompt?: string }  // プラン実行（会話履歴リセットポイント）。prompt 付きで直接指示も可
  | { type: 'link' }      // プラットフォームリンクコード生成
  | { type: 'agreement' } // DevRelay Agreement を CLAUDE.md に追加
  | { type: 'session' }   // 現在のセッション情報を表示
  | { type: 'log'; count?: number }
  | { type: 'summary'; period?: string }
  | { type: 'build' }     // ビルドログ表示
  | { type: 'quit' }
  | { type: 'help' }
  | { type: 'ai:list' }   // AI ツール一覧
  | { type: 'ai:switch'; tool: AiTool }
  | { type: 'ai:prompt'; text: string }
  | { type: 'kill' }     // 実行中の AI プロセスを強制停止
  | { type: 'update' }   // Agent バージョン確認・更新
  | { type: 'testflight'; subcommand: 'list' }
  | { type: 'testflight'; subcommand: 'create'; name: string }
  | { type: 'testflight'; subcommand: 'remove'; name: string }
  | { type: 'testflight'; subcommand: 'info'; name: string }
  | { type: 'ask:member'; targetProject: string; question: string }
  | { type: 'teamexec:member'; targetProject: string; instruction: string };

// -----------------------------------------------------------------------------
// User Context (for command parsing)
// -----------------------------------------------------------------------------

export interface UserContext {
  userId: string;
  platform: Platform;
  chatId: string;
  lastListType?: 'machine' | 'project' | 'recent' | 'ai';
  lastListItems?: string[];
  currentMachineId?: string;
  currentMachineName?: string;
  currentSessionId?: string;
  currentProjectName?: string;
  lastProjectId?: string;  // 前回接続したプロジェクトID（再接続用）
}

// -----------------------------------------------------------------------------
// History
// -----------------------------------------------------------------------------

export interface ChatMessage {
  id: string;
  sessionId: string;
  userId: string;
  role: 'user' | 'ai' | 'system';
  content: string;
  platform: Platform;
  timestamp: Date;
}

export interface SessionSummary {
  sessionId: string;
  machineName: string;
  projectName: string;
  startedAt: Date;
  endedAt?: Date;
  messageCount: number;
  lastMessage?: string;
  platform: Platform;
}

// -----------------------------------------------------------------------------
// Work State (作業状態の保存・継続)
// -----------------------------------------------------------------------------

export interface WorkStateTodo {
  task: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface WorkState {
  createdAt: string;
  status: 'pending_restart' | 'completed';
  summary: string;
  todoList: WorkStateTodo[];
  restartInfo?: {
    reason: string;
    commands: string[];
  };
  context: {
    lastMessage: string;
    filesModified: string[];
  };
}

// -----------------------------------------------------------------------------
// Messages (Tool Approval Protocol)
// -----------------------------------------------------------------------------

/** ツール承認リクエスト（Agent → Server） */
export interface ToolApprovalRequestPayload {
  machineId: string;
  sessionId: string;
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  title?: string;
  description?: string;
  decisionReason?: string;
  /** AskUserQuestion の場合 true（UI を質問カード表示に切り替える） */
  isQuestion?: boolean;
}

/** 自動承認通知（Agent → Server、approveAllMode 時の通知のみ） */
export interface ToolApprovalAutoPayload {
  machineId: string;
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
}

/** ツール承認レスポンス（Server → Agent） */
export interface ToolApprovalResponsePayload {
  requestId: string;
  behavior: 'allow' | 'deny';
  message?: string;
  /** true の場合、以降の全ツール実行を自動許可する */
  approveAll?: boolean;
  /** セッション内で常時許可するツールルール（例: "Edit", "Bash(git *)"） */
  alwaysAllowRule?: string;
  /** AskUserQuestion の回答（question → selected label のマップ） */
  answers?: Record<string, string>;
}

/** ツール承認 UI 表示用（Server → Web/Discord/Telegram） */
export interface ToolApprovalPromptPayload {
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  title?: string;
  description?: string;
  projectId?: string;
  /** AskUserQuestion の場合 true */
  isQuestion?: boolean;
}

// -----------------------------------------------------------------------------
// Messages (WebSocket Protocol - Web Client)
// -----------------------------------------------------------------------------

/** ブラウザ → サーバー */
export type WebClientMessage =
  | { type: 'web:command'; payload: { text: string; files?: FileAttachment[]; projectId?: string } }
  | { type: 'web:tool:approval:response'; payload: { requestId: string; behavior: 'allow' | 'deny'; approveAll?: boolean; alwaysAllow?: boolean; answers?: Record<string, string> } }
  | { type: 'web:ping' };

/** サーバー → ブラウザ（projectId: タブルーティング用、省略時はアクティブタブに表示） */
export type ServerToWebMessage =
  | { type: 'web:response'; payload: { message: string; files?: FileAttachment[]; projectId?: string } }
  | { type: 'web:progress'; payload: { output: string; elapsed: number; projectId?: string } }
  | { type: 'web:session_info'; payload: { projectId: string; sessionId: string } }
  | { type: 'web:user_message'; payload: { content: string; files?: FileAttachment[]; projectId?: string } }
  | { type: 'web:tool:approval'; payload: ToolApprovalPromptPayload }
  | { type: 'web:tool:approval:resolved'; payload: { requestId: string; behavior: 'allow' | 'deny'; projectId?: string } }
  | { type: 'web:tool:approval:auto'; payload: { toolName: string; toolInput: Record<string, unknown>; projectId?: string } }
  | { type: 'web:error'; payload: { error: string } }
  | { type: 'web:pong' };
