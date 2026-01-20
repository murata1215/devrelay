import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import type { Agent } from 'http';
import type {
  AgentMessage,
  ServerToAgentMessage,
  Project,
  AiTool,
  FileAttachment,
  MissedMessage,
  ProxyConfig,
  AgreementApplyPayload,
  StorageSavePayload,
  StorageClearPayload
} from '@devrelay/shared';
import { DEFAULTS } from '@devrelay/shared';
import type { AgentConfig } from './config.js';
import { startAiSession, sendPromptToAi, stopAiSession } from './ai-runner.js';
import { saveReceivedFiles, buildPromptWithFiles } from './file-handler.js';
import {
  clearOutputDir,
  collectOutputFiles,
  OUTPUT_DIR_INSTRUCTION,
  PLAN_MODE_INSTRUCTION,
  EXEC_MODE_INSTRUCTION,
  DEVRELAY_AGREEMENT_MARKER,
  AGREEMENT_APPLY_PROMPT
} from './output-collector.js';
import { readFile, writeFile, unlink, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
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
let pongCheckInterval: NodeJS.Timeout | null = null;
let currentConfig: AgentConfig | null = null;

// Reconnection state (using shared constants for easy adjustment)
let reconnectAttempts = 0;

// Pong timeout detection
const PONG_TIMEOUT = 45000; // 45 seconds
let lastPongReceived = Date.now();

// Store session info for prompt handling
interface SessionInfo {
  projectPath: string;
  aiTool: AiTool;
  claudeSessionId: string; // UUID for Claude Code --session-id
  history: ConversationEntry[]; // Conversation history (persisted to file)
  pendingWorkState?: WorkState; // Work state to include in next prompt
}
const sessionInfoMap = new Map<string, SessionInfo>();

/**
 * Build a proxy URL with optional authentication credentials
 */
function buildProxyUrl(proxy: ProxyConfig): string {
  const url = new URL(proxy.url);
  if (proxy.username) {
    url.username = proxy.username;
    url.password = proxy.password || '';
  }
  return url.toString();
}

/**
 * Create an HTTP/SOCKS proxy agent based on the proxy URL scheme
 */
function createProxyAgent(proxyConfig: ProxyConfig): Agent {
  const proxyUrl = buildProxyUrl(proxyConfig);

  if (proxyUrl.startsWith('socks4://') || proxyUrl.startsWith('socks5://') || proxyUrl.startsWith('socks://')) {
    return new SocksProxyAgent(proxyUrl);
  } else {
    // HTTP/HTTPS proxy
    return new HttpsProxyAgent(proxyUrl);
  }
}

export async function connectToServer(config: AgentConfig, projects: Project[]) {
  currentConfig = config;
  return new Promise<void>((resolve, reject) => {
    // Build WebSocket options with optional proxy
    const wsOptions: WebSocket.ClientOptions = {};

    if (config.proxy?.url) {
      wsOptions.agent = createProxyAgent(config.proxy);
      console.log(`🔌 Connecting to ${config.serverUrl} via proxy ${config.proxy.url}...`);
    } else {
      console.log(`🔌 Connecting to ${config.serverUrl}...`);
    }

    ws = new WebSocket(config.serverUrl, wsOptions);

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

      // Start ping and pong timeout check
      startPing();
      lastPongReceived = Date.now();
      pongCheckInterval = setInterval(() => {
        const timeSinceLastPong = Date.now() - lastPongReceived;
        if (timeSinceLastPong > PONG_TIMEOUT) {
          console.error(`⚠️ Pong timeout detected (${timeSinceLastPong}ms since last pong), reconnecting...`);
          ws?.terminate();
        }
      }, 15000);
      resolve();
    });

    ws.on('pong', () => {
      lastPongReceived = Date.now();
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

    case 'server:agreement:apply':
      handleAgreementApply(message.payload);
      break;

    case 'server:storage:save':
      handleStorageSave(message.payload);
      break;

    case 'server:storage:clear':
      handleStorageClear(message.payload);
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

  // Check DevRelay Agreement status
  const agreementStatus = await checkAgreementStatus(projectPath);
  console.log(`📋 DevRelay Agreement: ${agreementStatus ? 'compliant' : 'not compliant'}`);

  // Check for storage context
  const hasStorageContext = await loadStorageContext(projectPath) !== null;
  if (hasStorageContext) {
    console.log(`📂 Storage context found for project`);
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
        agreementStatus,
        hasStorageContext,
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

async function handleConversationExec(payload: { sessionId: string; projectPath: string; userId: string }) {
  const { sessionId, projectPath, userId } = payload;
  console.log(`🚀 Marking exec point for session ${sessionId}`);

  let sessionInfo = sessionInfoMap.get(sessionId);

  if (sessionInfo) {
    // Mark exec point in history (this becomes the reset point)
    sessionInfo.history = await markExecPoint(projectPath, sessionInfo.history);
    console.log(`📋 Exec point marked, history now has ${sessionInfo.history.length} entries`);
  } else {
    // Session not in memory (e.g., after server restart), initialize from file
    console.log(`📋 Session not found in memory, initializing from file...`);
    const history = await loadConversation(projectPath);
    const claudeSessionId = uuidv4();
    const aiTool: AiTool = currentConfig?.aiTools?.default || 'claude';

    // Create session info and add to map
    sessionInfo = { projectPath, aiTool, claudeSessionId, history };
    sessionInfoMap.set(sessionId, sessionInfo);
    console.log(`📋 Session ${sessionId} initialized with ${history.length} history entries`);

    // Mark exec point in history
    sessionInfo.history = await markExecPoint(projectPath, sessionInfo.history);
    console.log(`📋 Exec point marked, history now has ${sessionInfo.history.length} entries`);
  }

  // Auto-execute AI with the implementation prompt
  console.log(`🚀 Auto-starting AI execution after exec...`);
  const autoPrompt = '実装を開始してください。直前のプランに従って作業を進めてください。';
  await handleAiPrompt({
    sessionId,
    prompt: autoPrompt,
    userId,
    files: undefined
  });
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

async function handleAiPrompt(payload: { sessionId: string; prompt: string; userId: string; files?: FileAttachment[]; missedMessages?: MissedMessage[] }) {
  const { sessionId, prompt, userId, files, missedMessages } = payload;
  console.log(`📝 Received prompt for session ${sessionId}: ${prompt.slice(0, 50)}...`);
  if (files && files.length > 0) {
    console.log(`📎 Received ${files.length} file(s): ${files.map(f => f.filename).join(', ')}`);
  }
  if (missedMessages && missedMessages.length > 0) {
    console.log(`📨 Received ${missedMessages.length} missed message(s) from Discord`);
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

  // Add missed messages to history (messages between last mention and current mention)
  if (missedMessages && missedMessages.length > 0) {
    for (const msg of missedMessages) {
      sessionInfo.history.push({
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: msg.content,
        timestamp: new Date(msg.timestamp).toISOString()
      });
    }
    console.log(`📋 Added ${missedMessages.length} missed messages to history`);
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

  // Load storage context if exists
  let storageContextPrompt = '';
  const storageContext = await loadStorageContext(sessionInfo.projectPath);
  if (storageContext) {
    console.log(`📂 Including storage context in prompt (${storageContext.length} chars)`);
    storageContextPrompt = '\n\n--- Storage Context ---\n' + storageContext + '\n--- End Storage Context ---';
  }

  // Build prompt with history context and instructions
  let fullPrompt = promptWithFiles + workStatePrompt + storageContextPrompt + OUTPUT_DIR_INSTRUCTION + modeInstruction;
  if (sessionInfo.history.length > 1) {
    // Check if this is the first message after exec (need to include plan context)
    const historyForContext = sessionInfo.history.slice(0, -1); // exclude current message
    let execIndex = -1;
    for (let i = historyForContext.length - 1; i >= 0; i--) {
      if (historyForContext[i].role === 'exec') {
        execIndex = i;
        break;
      }
    }
    const messagesAfterExec = execIndex >= 0 ? historyForContext.slice(execIndex + 1) : historyForContext;
    const isFirstMessageAfterExec = hasExecMarker && messagesAfterExec.filter(h => h.role === 'user' || h.role === 'assistant').length === 0;

    // If this is the first message after exec, include the plan context
    const historyContext = getConversationContext(
      historyForContext,
      undefined,
      { includePlanBeforeExec: isFirstMessageAfterExec }
    );
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

  const { baseDelay, maxDelay, maxAttempts, jitterRange } = DEFAULTS.reconnect;

  // Check max attempts
  if (reconnectAttempts >= maxAttempts) {
    console.error(`❌ Max reconnect attempts (${maxAttempts}) reached. Giving up.`);
    console.error('💡 Restart the agent manually or check if the server is running.');
    return;
  }

  // Calculate delay with exponential backoff + jitter
  const exponentialDelay = Math.min(
    baseDelay * Math.pow(2, reconnectAttempts),
    maxDelay
  );
  const jitter = Math.random() * jitterRange;
  const delay = exponentialDelay + jitter;

  reconnectAttempts++;
  console.log(`🔄 Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${reconnectAttempts}/${maxAttempts})...`);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToServer(config, projects).catch((err) => {
      console.error('Reconnection failed:', err.message);
      // scheduleReconnect will be called from the 'close' event
    });
  }, delay);
}

// Storage context functions
const STORAGE_CONTEXT_FILENAME = 'storage-context.md';

function getStorageContextPath(projectPath: string): string {
  return join(projectPath, '.devrelay', STORAGE_CONTEXT_FILENAME);
}

async function loadStorageContext(projectPath: string): Promise<string | null> {
  try {
    const content = await readFile(getStorageContextPath(projectPath), 'utf-8');
    return content;
  } catch {
    return null;
  }
}

async function saveStorageContext(projectPath: string, content: string): Promise<void> {
  const filePath = getStorageContextPath(projectPath);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf-8');
}

async function clearStorageContext(projectPath: string): Promise<void> {
  try {
    await unlink(getStorageContextPath(projectPath));
  } catch {
    // Ignore if file doesn't exist
  }
}

async function handleStorageSave(payload: StorageSavePayload) {
  const { sessionId, projectPath, content } = payload;
  console.log(`💾 Saving storage context for session ${sessionId}`);

  try {
    await saveStorageContext(projectPath, content);
    console.log(`✅ Storage context saved (${content.length} chars)`);
  } catch (err) {
    console.error(`❌ Failed to save storage context:`, (err as Error).message);
  }
}

async function handleStorageClear(payload: StorageClearPayload) {
  const { sessionId, projectPath } = payload;
  console.log(`🗑️ Clearing storage context for session ${sessionId}`);

  try {
    await clearStorageContext(projectPath);
    console.log(`✅ Storage context cleared`);
  } catch (err) {
    console.error(`❌ Failed to clear storage context:`, (err as Error).message);
  }
}

export function disconnect() {
  stopPing();
  if (pongCheckInterval) {
    clearInterval(pongCheckInterval);
    pongCheckInterval = null;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    ws.close();
    ws = null;
  }
}

// Check if CLAUDE.md has DevRelay Agreement
export async function checkAgreementStatus(projectPath: string): Promise<boolean> {
  try {
    const claudeMdPath = join(projectPath, 'CLAUDE.md');
    const content = await readFile(claudeMdPath, 'utf-8');
    return content.includes(DEVRELAY_AGREEMENT_MARKER);
  } catch (err: any) {
    // CLAUDE.md doesn't exist
    return false;
  }
}

// Handle agreement apply command - run Claude Code to update CLAUDE.md
async function handleAgreementApply(payload: AgreementApplyPayload) {
  const { sessionId, projectPath, userId } = payload;
  console.log(`📝 Applying DevRelay Agreement for session ${sessionId}`);

  let sessionInfo = sessionInfoMap.get(sessionId);

  if (!sessionInfo || !currentConfig) {
    // Session not in memory, initialize from file
    console.log(`📋 Session not found in memory, initializing...`);
    const history = await loadConversation(projectPath);
    const claudeSessionId = uuidv4();
    const aiTool: AiTool = currentConfig?.aiTools?.default || 'claude';

    sessionInfo = { projectPath, aiTool, claudeSessionId, history, pendingWorkState: undefined };
    sessionInfoMap.set(sessionId, sessionInfo);
  }

  // Use the agreement apply prompt
  await handleAiPrompt({
    sessionId,
    prompt: AGREEMENT_APPLY_PROMPT,
    userId,
    files: undefined,
  });
}
