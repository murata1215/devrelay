// =============================================================================
// DevRelay Shared Types
// =============================================================================

// -----------------------------------------------------------------------------
// Machine & Project
// -----------------------------------------------------------------------------

export interface Machine {
  id: string;
  name: string;
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

export type Platform = 'discord' | 'telegram' | 'line' | 'slack';

// -----------------------------------------------------------------------------
// Messages (WebSocket Protocol)
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
  | { type: 'agent:history:export'; payload: HistoryExportPayload };

export interface SessionRestorePayload {
  machineId: string;
  projectPath: string;
  projectName: string;
  agreementStatus: boolean;
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

export interface AgentConnectPayload {
  machineId: string;
  machineName: string;
  token: string;
  projects: Project[];
  availableAiTools: AiTool[];
}

export interface FileAttachment {
  filename: string;
  content: string; // base64 encoded
  mimeType: string;
  size: number;
}

export interface AiOutputPayload {
  machineId: string;
  sessionId: string;
  output: string;
  isComplete: boolean;
  files?: FileAttachment[];
}

export interface AiStatusPayload {
  machineId: string;
  sessionId: string;
  status: 'starting' | 'running' | 'stopped' | 'error';
  error?: string;
  agreementStatus?: boolean;  // Whether CLAUDE.md has DevRelay Agreement
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
  | { type: 'server:history:export'; payload: HistoryExportRequestPayload };

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
}

export interface ServerPongPayload {
  timestamp: string;
}

export interface ConversationExecPayload {
  sessionId: string;
  projectPath: string;
  userId: string;
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
  | { type: 'exec' }      // プラン実行（会話履歴リセットポイント）
  | { type: 'link' }      // プラットフォームリンクコード生成
  | { type: 'agreement' } // DevRelay Agreement を CLAUDE.md に追加
  | { type: 'session' }   // 現在のセッション情報を表示
  | { type: 'log'; count?: number }
  | { type: 'summary'; period?: string }
  | { type: 'quit' }
  | { type: 'help' }
  | { type: 'ai:switch'; tool: AiTool }
  | { type: 'ai:prompt'; text: string };

// -----------------------------------------------------------------------------
// User Context (for command parsing)
// -----------------------------------------------------------------------------

export interface UserContext {
  userId: string;
  platform: Platform;
  chatId: string;
  lastListType?: 'machine' | 'project' | 'recent';
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
