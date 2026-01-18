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
  | { type: 'agent:ai:status'; payload: AiStatusPayload };

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
}

// Server -> Agent
export type ServerToAgentMessage =
  | { type: 'server:connect:ack'; payload: { success: boolean; error?: string } }
  | { type: 'server:session:start'; payload: SessionStartPayload }
  | { type: 'server:session:end'; payload: { sessionId: string } }
  | { type: 'server:ai:prompt'; payload: AiPromptPayload }
  | { type: 'server:conversation:clear'; payload: { sessionId: string; projectPath: string } }
  | { type: 'server:conversation:exec'; payload: { sessionId: string; projectPath: string } }
  | { type: 'server:workstate:save'; payload: WorkStateSavePayload };

export interface WorkStateSavePayload {
  sessionId: string;
  projectPath: string;
  workState: WorkState;
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
