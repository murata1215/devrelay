import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';
import type {
  AgentMessage,
  ServerToAgentMessage,
  Project,
  AiTool,
  FileAttachment
} from '@devrelay/shared';
import { DEFAULTS } from '@devrelay/shared';
import type { AgentConfig } from './config.js';
import { startAiSession, sendPromptToAi, stopAiSession } from './ai-runner.js';
import { saveReceivedFiles, buildPromptWithFiles } from './file-handler.js';
import { clearOutputDir, collectOutputFiles, OUTPUT_DIR_INSTRUCTION, PLAN_MODE_INSTRUCTION, EXEC_MODE_INSTRUCTION } from './output-collector.js';
import {
  loadConversation,
  saveConversation,
  getConversationContext,
  clearConversation,
  markExecPoint,
  type ConversationEntry
} from './conversation-store.js';
import {
  loadWorkState,
  saveWorkState,
  archiveWorkState,
  formatWorkStateForPrompt
} from './work-state-store.js';
import type { WorkState, WorkStateSavePayload } from '@devrelay/shared';

let ws: WebSocket | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let pingTimer: NodeJS.Timeout | null = null;
let currentConfig: AgentConfig | null = null;

// Reconnection state
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 15;
const BASE_RECONNECT_DELAY = 1000; // 1 second
const MAX_RECONNECT_DELAY = 60000; // 60 seconds

// Store session info for prompt handling
interface SessionInfo {
  projectPath: string;
  aiTool: AiTool;
  claudeSessionId: string; // UUID for Claude Code --session-id
  history: ConversationEntry[]; // Conversation history (persisted to file)
  pendingWorkState?: WorkState; // Work state to include in next prompt
}
const sessionInfoMap = new Map<string, SessionInfo>();

export async function connectToServer(config: AgentConfig, projects: Project[]) {
  currentConfig = config;
  return new Promise<void>((resolve, reject) => {
    console.log(`🔌 Connecting to ${config.serverUrl}...`);

    ws = new WebSocket(config.serverUrl);

    ws.on('open', () => {
      console.log('✅ Connected to server');

      // Reset reconnect attempts on successful connection
      reconnectAttempts = 0;

      // Send connect message
      sendMessage({
        type: 'agent:connect',
        payload: {
          machineId: config.machineId,
          machineName: config.machineName,
          token: config.token,
          projects,
          availableAiTools: getAvailableAiTools(config),
        },
      });

      // Start ping
      startPing();
      resolve();
    });

    ws.on('message', (data) => {
      try {
        const message: ServerToAgentMessage = JSON.parse(data.toString());
        handleServerMessage(message, config);
      } catch (err) {
        console.error('Error parsing server message:', err);
      }
    });

    ws.on('close', () => {
      console.log('🔌 Disconnected from server');
      stopPing();
      scheduleReconnect(config, projects);
    });

    ws.on('error', (err) => {
      console.error('WebSocket error:', err.message);
      reject(err);
    });
  });
}

function handleServerMessage(message: ServerToAgentMessage, config: AgentConfig) {
  switch (message.type) {
    case 'server:connect:ack':
      if (message.payload.success) {
        console.log('✅ Authentication successful');
      } else {
        console.error('❌ Authentication failed:', message.payload.error);
        ws?.close();
      }
      break;

    case 'server:session:start':
      handleSessionStart(message.payload, config);
      break;

    case 'server:session:end':
      handleSessionEnd(message.payload.sessionId);
      break;

    case 'server:ai:prompt':
      handleAiPrompt(message.payload);
      break;

    case 'server:conversation:clear':
      handleConversationClear(message.payload);
      break;

    case 'server:conversation:exec':
      handleConversationExec(message.payload);
      break;

    case 'server:workstate:save':
      handleWorkStateSave(message.payload);
      break;
  }
}

async function handleSessionStart(
  payload: { sessionId: string; projectName: string; projectPath: string; aiTool: AiTool },
  config: AgentConfig
) {
  const { sessionId, projectName, projectPath, aiTool } = payload;

  console.log(`🚀 Starting session: ${sessionId}`);
  console.log(`   Project: ${projectName} (${projectPath})`);
  console.log(`   AI Tool: ${aiTool}`);

  // Load previous conversation history from file
  const history = await loadConversation(projectPath);

  // Check for pending work state (auto-continue feature)
  const pendingWorkState = await loadWorkState(projectPath);
  if (pendingWorkState) {
    console.log(`📂 Found pending work state: ${pendingWorkState.summary}`);
  }

  // Generate UUID for Claude Code session and store session info
  const claudeSessionId = uuidv4();
  sessionInfoMap.set(sessionId, { projectPath, aiTool, claudeSessionId, history, pendingWorkState: pendingWorkState || undefined });
  console.log(`📋 Session ${sessionId} -> Claude Session ${claudeSessionId}`);

  try {
    await startAiSession(sessionId, projectPath, aiTool, config, (output, isComplete) => {
      sendMessage({
        type: 'agent:ai:output',
        payload: {
          machineId: config.machineId,
          sessionId,
          output,
          isComplete,
        },
      });
    });

    sendMessage({
      type: 'agent:ai:status',
      payload: {
        machineId: config.machineId,
        sessionId,
        status: 'running',
      },
    });
  } catch (err: any) {
    console.error('Failed to start AI session:', err);
    sendMessage({
      type: 'agent:ai:status',
      payload: {
        machineId: config.machineId,
        sessionId,
        status: 'error',
        error: err.message,
      },
    });
  }
}

async function handleSessionEnd(sessionId: string) {
  console.log(`⏹️ Ending session: ${sessionId}`);
  await stopAiSession(sessionId);
}

async function handleConversationClear(payload: { sessionId: string; projectPath: string }) {
  const { sessionId, projectPath } = payload;
  console.log(`🗑️ Clearing conversation for session ${sessionId}`);

  // Clear the conversation file
  await clearConversation(projectPath);

  // Clear in-memory history if session exists
  const sessionInfo = sessionInfoMap.get(sessionId);
  if (sessionInfo) {
    sessionInfo.history = [];
    console.log(`📋 In-memory history cleared for session ${sessionId}`);
  }
}

async function handleConversationExec(payload: { sessionId: string; projectPath: string }) {
  const { sessionId, projectPath } = payload;
  console.log(`🚀 Marking exec point for session ${sessionId}`);

  const sessionInfo = sessionInfoMap.get(sessionId);
  if (sessionInfo) {
    // Mark exec point in history (this becomes the reset point)
    sessionInfo.history = await markExecPoint(projectPath, sessionInfo.history);
    console.log(`📋 Exec point marked, history now has ${sessionInfo.history.length} entries`);
  } else {
    // Session not in memory, just mark in file
    const history = await loadConversation(projectPath);
    await markExecPoint(projectPath, history);
  }
}

async function handleWorkStateSave(payload: WorkStateSavePayload) {
  const { sessionId, projectPath, workState } = payload;
  console.log(`💾 Saving work state for session ${sessionId}`);

  try {
    await saveWorkState(projectPath, workState);
    console.log(`✅ Work state saved: ${workState.summary}`);
  } catch (err) {
    console.error(`❌ Failed to save work state:`, (err as Error).message);
  }
}

async function handleAiPrompt(payload: { sessionId: string; prompt: string; userId: string; files?: FileAttachment[] }) {
  const { sessionId, prompt, userId, files } = payload;
  console.log(`📝 Received prompt for session ${sessionId}: ${prompt.slice(0, 50)}...`);
  if (files && files.length > 0) {
    console.log(`📎 Received ${files.length} file(s): ${files.map(f => f.filename).join(', ')}`);
  }

  const sessionInfo = sessionInfoMap.get(sessionId);
  if (!sessionInfo || !currentConfig) {
    console.error(`Session info not found for ${sessionId}`);
    return;
  }

  // Save received files and get their paths
  let promptWithFiles = prompt;
  if (files && files.length > 0) {
    const savedPaths = await saveReceivedFiles(sessionInfo.projectPath, files);
    if (savedPaths.length > 0) {
      promptWithFiles = buildPromptWithFiles(prompt, savedPaths);
      console.log(`📁 Files saved to: ${savedPaths.join(', ')}`);
    }
  }

  // Add user message to history and save
  sessionInfo.history.push({
    role: 'user',
    content: prompt,
    timestamp: new Date().toISOString()
  });
  await saveConversation(sessionInfo.projectPath, sessionInfo.history);

  // Clear output directory before running
  await clearOutputDir(sessionInfo.projectPath);

  // Check if exec marker exists in history (determines plan/exec mode)
  const hasExecMarker = sessionInfo.history.some(h => h.role === 'exec');
  const modeInstruction = hasExecMarker ? EXEC_MODE_INSTRUCTION : PLAN_MODE_INSTRUCTION;
  console.log(`📋 Mode: ${hasExecMarker ? 'EXEC (implementation)' : 'PLAN (no code changes)'}`);

  // Check for pending work state (auto-continue feature)
  let workStatePrompt = '';
  if (sessionInfo.pendingWorkState) {
    console.log(`📂 Including work state in prompt: ${sessionInfo.pendingWorkState.summary}`);
    workStatePrompt = '\n\n' + formatWorkStateForPrompt(sessionInfo.pendingWorkState);

    // Archive the work state file and clear from session
    await archiveWorkState(sessionInfo.projectPath);
    sessionInfo.pendingWorkState = undefined;
  }

  // Build prompt with history context and instructions
  let fullPrompt = promptWithFiles + workStatePrompt + OUTPUT_DIR_INSTRUCTION + modeInstruction;
  if (sessionInfo.history.length > 1) {
    const historyContext = getConversationContext(sessionInfo.history.slice(0, -1)); // exclude current message
    fullPrompt = `Previous conversation:\n${historyContext}\n\nUser: ${promptWithFiles}${workStatePrompt}${OUTPUT_DIR_INSTRUCTION}${modeInstruction}`;
  }

  console.log(`📜 History length: ${sessionInfo.history.length}`);

  let responseText = '';
  await sendPromptToAi(
    sessionId,
    fullPrompt,
    sessionInfo.projectPath,
    sessionInfo.aiTool,
    sessionInfo.claudeSessionId,
    currentConfig,
    async (output, isComplete) => {
      responseText += output;

      if (isComplete) {
        // Collect files from the output directory
        const files = await collectOutputFiles(sessionInfo.projectPath);
        if (files.length > 0) {
          console.log(`📎 Sending ${files.length} file(s) from output directory`);
        }

        sendMessage({
          type: 'agent:ai:output',
          payload: {
            machineId: currentConfig!.machineId,
            sessionId,
            output: responseText,  // Send full accumulated response
            isComplete,
            files: files.length > 0 ? files : undefined,
          },
        });

        // Save response to history and persist to file
        if (responseText.trim()) {
          sessionInfo.history.push({
            role: 'assistant',
            content: responseText.trim(),
            timestamp: new Date().toISOString()
          });
          await saveConversation(sessionInfo.projectPath, sessionInfo.history);
          console.log(`💾 Conversation saved (${sessionInfo.history.length} messages)`);
        }
      } else {
        // Stream intermediate output without files
        console.log(`📤 Streaming output (${output.length} chars): ${output.substring(0, 50)}...`);
        sendMessage({
          type: 'agent:ai:output',
          payload: {
            machineId: currentConfig!.machineId,
            sessionId,
            output,
            isComplete,
          },
        });
      }
    }
  );
}

function sendMessage(message: AgentMessage) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function getAvailableAiTools(config: AgentConfig): AiTool[] {
  const tools: AiTool[] = [];
  if (config.aiTools.claude) tools.push('claude');
  if (config.aiTools.gemini) tools.push('gemini');
  if (config.aiTools.codex) tools.push('codex');
  if (config.aiTools.aider) tools.push('aider');
  return tools;
}

function startPing() {
  pingTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.ping();
    }
  }, DEFAULTS.websocketPingInterval);
}

function stopPing() {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}

function scheduleReconnect(config: AgentConfig, projects: Project[]) {
  if (reconnectTimer) return;

  // Check max attempts
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.error(`❌ Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Giving up.`);
    console.error('💡 Restart the agent manually or check if the server is running.');
    return;
  }

  // Calculate delay with exponential backoff + jitter
  const exponentialDelay = Math.min(
    BASE_RECONNECT_DELAY * Math.pow(2, reconnectAttempts),
    MAX_RECONNECT_DELAY
  );
  const jitter = Math.random() * 1000; // 0-1 second random jitter
  const delay = exponentialDelay + jitter;

  reconnectAttempts++;
  console.log(`🔄 Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToServer(config, projects).catch((err) => {
      console.error('Reconnection failed:', err.message);
      // scheduleReconnect will be called from the 'close' event
    });
  }, delay);
}

export function disconnect() {
  stopPing();
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    ws.close();
    ws = null;
  }
}
