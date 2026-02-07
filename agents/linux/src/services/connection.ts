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
  StorageClearPayload,
  HistoryDatesRequestPayload,
  HistoryExportRequestPayload,
  AiListPayload,
  AiSwitchPayload
} from '@devrelay/shared';
import archiver from 'archiver';
import { PassThrough } from 'stream';
import { readdirSync } from 'fs';
import { DEFAULTS } from '@devrelay/shared';
import type { AgentConfig } from './config.js';
import { startAiSession, sendPromptToAi, stopAiSession, type SendPromptOptions } from './ai-runner.js';
import { loadClaudeSessionId, clearClaudeSessionId } from './session-store.js';
import { loadLastAiTool, saveLastAiTool } from './agent-state.js';
import { saveReceivedFiles, buildPromptWithFiles } from './file-handler.js';
import {
  clearOutputDir,
  collectOutputFiles,
  OUTPUT_DIR_INSTRUCTION,
  PLAN_MODE_INSTRUCTION,
  EXEC_MODE_INSTRUCTION,
  DEVRELAY_AGREEMENT_MARKER,
  DEVRELAY_AGREEMENT_OLD_MARKERS,
  AGREEMENT_APPLY_PROMPT
} from './output-collector.js';
import { readFile, writeFile, unlink, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import {
  loadConversation,
  saveConversation,
  getConversationContext,
  clearConversation,
  archiveConversation,
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
let appPingTimer: NodeJS.Timeout | null = null; // Application-level ping (agent:ping)
let pongCheckInterval: NodeJS.Timeout | null = null;
let currentConfig: AgentConfig | null = null;
let currentMachineId: string | null = null;

// Reconnection state (using shared constants for easy adjustment)
let reconnectAttempts = 0;

// Pong timeout detection
const PONG_TIMEOUT = 45000; // 45 seconds
let lastPongReceived = Date.now();

// Application-level heartbeat interval (30 seconds)
const APP_PING_INTERVAL = 30000;

// Store session info for prompt handling
interface SessionInfo {
  projectPath: string;
  aiTool: AiTool;
  claudeSessionId: string; // UUID for Claude Code --session-id (legacy, not used with --resume)
  claudeResumeSessionId?: string; // Session ID from Claude Code for --resume
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

      // Note: currentMachineId will be set when server:connect:ack is received

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

      // Start ping (both WebSocket-level and application-level) and pong timeout check
      startPing();
      startAppPing();
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
      stopAppPing();
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
        // Use machineId from server (DB ID) for heartbeat
        if (message.payload.machineId) {
          currentMachineId = message.payload.machineId;
          console.log(`✅ Authentication successful (machineId: ${currentMachineId})`);
        } else {
          console.log('✅ Authentication successful');
        }
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

    case 'server:pong':
      // Application-level pong received, update last pong time
      lastPongReceived = Date.now();
      break;

    case 'server:history:dates':
      handleHistoryDates(message.payload);
      break;

    case 'server:history:export':
      handleHistoryExport(message.payload);
      break;

    case 'server:ai:list':
      handleAiList(message.payload, config);
      break;

    case 'server:ai:switch':
      handleAiSwitch(message.payload, config);
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

  // Check DevRelay Agreement status（詳細な状態を取得）
  const agreementStatus = await getAgreementStatusType(projectPath);
  const statusLabels = { latest: '最新版', outdated: '旧版（更新推奨）', none: '未対応' };
  console.log(`📋 DevRelay Agreement: ${statusLabels[agreementStatus]}`);

  // Check for storage context
  const hasStorageContext = await loadStorageContext(projectPath) !== null;
  if (hasStorageContext) {
    console.log(`📂 Storage context found for project`);
  }

  // Load existing Claude session ID for --resume
  const claudeResumeSessionId = await loadClaudeSessionId(projectPath);
  if (claudeResumeSessionId) {
    console.log(`📋 Found existing Claude session: ${claudeResumeSessionId.substring(0, 8)}...`);
  }

  // Generate UUID for Claude Code session and store session info
  const claudeSessionId = uuidv4();
  sessionInfoMap.set(sessionId, {
    projectPath,
    aiTool,
    claudeSessionId,
    claudeResumeSessionId: claudeResumeSessionId || undefined,
    history,
    pendingWorkState: pendingWorkState || undefined
  });
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

  // 1. 現在の履歴をロードしてアーカイブ保存
  const history = await loadConversation(projectPath);
  if (history.length > 0) {
    await archiveConversation(projectPath, history);
  }

  // 2. 会話履歴ファイルをクリア
  await clearConversation(projectPath);

  // 3. Claude セッション ID をクリア（次回プロンプトで新規セッション開始）
  await clearClaudeSessionId(projectPath);

  // 4. メモリ内の履歴とセッション ID もクリア
  const sessionInfo = sessionInfoMap.get(sessionId);
  if (sessionInfo) {
    sessionInfo.history = [];
    sessionInfo.claudeResumeSessionId = undefined;
    console.log(`📋 In-memory history and Claude session ID cleared for session ${sessionId}`);
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

  // Automatically start implementation with exec mode
  console.log(`🚀 Auto-starting implementation...`);
  await handleAiPrompt({
    sessionId,
    prompt: 'プランに従って実装を開始してください。',
    userId,
    files: undefined,
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

  // Check if the last entry (before current user message) is an exec marker
  // This means exec was just sent, so this prompt should run in exec mode
  // After one exec-mode prompt, subsequent prompts return to plan mode
  const historyBeforeThisMessage = sessionInfo.history.slice(0, -1);
  const lastEntry = historyBeforeThisMessage[historyBeforeThisMessage.length - 1];
  const isExecTriggered = lastEntry?.role === 'exec';
  // Use CLI --permission-mode plan for plan mode, --dangerously-skip-permissions for exec mode
  const usePlanMode = !isExecTriggered;
  console.log(`📋 Mode: ${isExecTriggered ? 'EXEC (--dangerously-skip-permissions)' : 'PLAN (--permission-mode plan)'}`);

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

  // Add plan/exec mode instruction to prompt
  const modeInstruction = usePlanMode ? PLAN_MODE_INSTRUCTION : EXEC_MODE_INSTRUCTION;

  // Build prompt with mode instruction and file output instruction
  let fullPrompt = modeInstruction + '\n\n' + promptWithFiles + workStatePrompt + storageContextPrompt + OUTPUT_DIR_INSTRUCTION;
  // 会話履歴のサイズを記録（ログ出力用）
  let historyContextSize = 0;

  // Include conversation history if:
  // 1. We don't have a Claude session to resume, OR
  // 2. We have missed messages (they're not in Claude's internal history)
  const hasMissedMessages = missedMessages && missedMessages.length > 0;
  if (sessionInfo.history.length > 1 && (!sessionInfo.claudeResumeSessionId || hasMissedMessages)) {
    // Include conversation history when no resume session OR when there are missed messages
    const historyForContext = sessionInfo.history.slice(0, -1); // exclude current message
    let execIndex = -1;
    for (let i = historyForContext.length - 1; i >= 0; i--) {
      if (historyForContext[i].role === 'exec') {
        execIndex = i;
        break;
      }
    }
    const messagesAfterExec = execIndex >= 0 ? historyForContext.slice(execIndex + 1) : historyForContext;
    const isFirstMessageAfterExec = isExecTriggered && messagesAfterExec.filter(h => h.role === 'user' || h.role === 'assistant').length === 0;

    // If this is the first message after exec, include the plan context
    const historyContext = getConversationContext(
      historyForContext,
      undefined,
      { includePlanBeforeExec: isFirstMessageAfterExec }
    );
    historyContextSize = historyContext.length;
    fullPrompt = `${modeInstruction}\n\nPrevious conversation:\n${historyContext}\n\nUser: ${promptWithFiles}${workStatePrompt}${OUTPUT_DIR_INSTRUCTION}`;
  }

  // プロンプトサイズの詳細ログ（原因特定用）
  console.log(`📊 Prompt size breakdown:`);
  console.log(`   - Mode instruction: ${modeInstruction.length} chars`);
  console.log(`   - User prompt: ${promptWithFiles.length} chars`);
  console.log(`   - Work state: ${workStatePrompt.length} chars`);
  console.log(`   - Storage context: ${storageContextPrompt.length} chars`);
  console.log(`   - Output instruction: ${OUTPUT_DIR_INSTRUCTION.length} chars`);
  if (historyContextSize > 0) {
    console.log(`   - History context: ${historyContextSize} chars`);
  }
  console.log(`   📦 TOTAL: ${fullPrompt.length} chars (~${Math.round(fullPrompt.length / 4)} tokens)`);

  console.log(`📜 History length: ${sessionInfo.history.length}`);

  // 会話履歴件数を Discord/Telegram に表示（警告レベル付き）
  const historyCount = sessionInfo.history.length;
  let historyMessage = '';
  if (historyCount > 50) {
    // 50件超: 赤色警告 + クリア推奨
    historyMessage = `🚨 History: ${historyCount} messages (50件超)\n⚠️ 履歴が多くなっています。\`x\` コマンドでクリアすることを推奨します。`;
  } else if (historyCount > 30) {
    // 30件超: 黄色警告
    historyMessage = `⚠️ History: ${historyCount} messages (30件超)\n💡 履歴が増えています。必要に応じて \`x\` でクリアしてください。`;
  } else {
    // 通常表示
    historyMessage = `📝 History: ${historyCount} messages`;
  }

  // 履歴件数を先頭メッセージとして送信（contextInfo として検出される）
  sendMessage({
    type: 'agent:ai:output',
    payload: {
      machineId: currentConfig!.machineId,
      sessionId,
      output: historyMessage,
      isComplete: false,
    },
  });
  if (sessionInfo.claudeResumeSessionId) {
    console.log(`🔄 Using --resume with session: ${sessionInfo.claudeResumeSessionId.substring(0, 8)}...`);
  }

  // Prepare send options
  const sendOptions: SendPromptOptions = {
    resumeSessionId: sessionInfo.claudeResumeSessionId,
    usePlanMode,
  };

  let responseText = '';
  const aiResult = await sendPromptToAi(
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
    },
    sendOptions
  );

  // If --resume failed, clear session ID and retry without it
  if (aiResult.resumeFailed) {
    console.log(`🔄 Retrying without --resume due to session failure...`);
    sessionInfo.claudeResumeSessionId = undefined;
    await clearClaudeSessionId(sessionInfo.projectPath);

    // Retry without resume session ID
    responseText = '';
    const retryOptions: SendPromptOptions = {
      resumeSessionId: undefined,  // Don't use --resume
      usePlanMode,
    };

    const retryResult = await sendPromptToAi(
      sessionId,
      fullPrompt,
      sessionInfo.projectPath,
      sessionInfo.aiTool,
      sessionInfo.claudeSessionId,
      currentConfig,
      async (output, isComplete) => {
        responseText += output;

        if (isComplete) {
          const files = await collectOutputFiles(sessionInfo.projectPath);
          if (files.length > 0) {
            console.log(`📎 Sending ${files.length} file(s) from output directory`);
          }

          sendMessage({
            type: 'agent:ai:output',
            payload: {
              machineId: currentConfig!.machineId,
              sessionId,
              output: responseText,
              isComplete,
              files: files.length > 0 ? files : undefined,
            },
          });

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
      },
      retryOptions
    );

    // Update session info with new Claude session ID from retry
    if (retryResult.extractedSessionId) {
      sessionInfo.claudeResumeSessionId = retryResult.extractedSessionId;
      console.log(`📋 Updated Claude session ID (after retry): ${retryResult.extractedSessionId.substring(0, 8)}...`);
    }
    return;
  }

  // Update session info with new Claude session ID if extracted
  if (aiResult.extractedSessionId) {
    sessionInfo.claudeResumeSessionId = aiResult.extractedSessionId;
    console.log(`📋 Updated Claude session ID: ${aiResult.extractedSessionId.substring(0, 8)}...`);
  }
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

// Application-level ping for server-side lastSeenAt tracking
function startAppPing() {
  // Send immediately on connection
  sendAppPing();

  appPingTimer = setInterval(() => {
    sendAppPing();
  }, APP_PING_INTERVAL);
}

function sendAppPing() {
  if (ws && ws.readyState === WebSocket.OPEN && currentMachineId) {
    console.log(`💓 Sending app ping (machineId: ${currentMachineId})`);
    sendMessage({
      type: 'agent:ping',
      payload: {
        machineId: currentMachineId,
        timestamp: new Date().toISOString(),
      },
    });
  } else {
    // Debug: log why ping was skipped
    const wsState = ws ? ws.readyState : 'null';
    console.log(`⏳ App ping skipped (ws: ${wsState}, machineId: ${currentMachineId || 'null'})`);
  }
}

function stopAppPing() {
  if (appPingTimer) {
    clearInterval(appPingTimer);
    appPingTimer = null;
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

    // Notify server that storage context was saved
    if (currentConfig) {
      sendMessage({
        type: 'agent:storage:saved',
        payload: {
          machineId: currentConfig.machineId,
          sessionId,
          projectPath,
          contentLength: content.length,
        },
      });
    }
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
  stopAppPing();
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

/**
 * Send updated project list to server (for use after scanning)
 */
export function sendProjectsUpdate(projects: Project[]) {
  if (!ws || ws.readyState !== WebSocket.OPEN || !currentConfig) {
    console.log('⚠️ Cannot send projects update: not connected');
    return;
  }

  sendMessage({
    type: 'agent:projects',
    payload: {
      machineId: currentMachineId || currentConfig.machineId,
      projects,
    },
  });
  console.log(`📤 Sent projects update: ${projects.length} projects`);
}

// Agreement のステータスを表す型
// 'latest' = 最新版あり, 'outdated' = 旧版あり（更新推奨）, 'none' = なし
export type AgreementStatusType = 'latest' | 'outdated' | 'none';

// Check if CLAUDE.md has DevRelay Agreement
// 戻り値: boolean（後方互換性のため）- 最新版または旧版があれば true
export async function checkAgreementStatus(projectPath: string): Promise<boolean> {
  const status = await getAgreementStatusType(projectPath);
  return status !== 'none';
}

// Agreement の詳細ステータスを取得
export async function getAgreementStatusType(projectPath: string): Promise<AgreementStatusType> {
  try {
    const claudeMdPath = join(projectPath, 'CLAUDE.md');
    const content = await readFile(claudeMdPath, 'utf-8');

    // 最新版のマーカーがあるか確認
    if (content.includes(DEVRELAY_AGREEMENT_MARKER)) {
      return 'latest';
    }

    // 旧版のマーカーがあるか確認
    for (const oldMarker of DEVRELAY_AGREEMENT_OLD_MARKERS) {
      if (content.includes(oldMarker)) {
        return 'outdated';
      }
    }

    return 'none';
  } catch (err: any) {
    // CLAUDE.md が存在しない
    return 'none';
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

// -----------------------------------------------------------------------------
// History Export Functions
// -----------------------------------------------------------------------------

async function handleHistoryDates(payload: HistoryDatesRequestPayload) {
  const { projectPath, requestId } = payload;
  console.log(`📅 Getting history dates for ${projectPath}`);

  try {
    // Load conversation history
    const history = await loadConversation(projectPath);

    // Extract unique dates from timestamps
    const dates = new Set<string>();
    for (const message of history) {
      if (message.timestamp) {
        const date = message.timestamp.split('T')[0];  // YYYY-MM-DD
        dates.add(date);
      }
    }

    // Sort dates descending (newest first)
    const sortedDates = Array.from(dates).sort((a, b) => b.localeCompare(a));

    console.log(`📅 Found ${sortedDates.length} dates with history`);

    if (currentConfig) {
      sendMessage({
        type: 'agent:history:dates',
        payload: {
          machineId: currentConfig.machineId,
          projectPath,
          requestId,
          dates: sortedDates,
        },
      });
    }
  } catch (err) {
    console.error(`❌ Failed to get history dates:`, (err as Error).message);
  }
}

async function handleHistoryExport(payload: HistoryExportRequestPayload) {
  const { projectPath, requestId, date } = payload;
  console.log(`📦 Exporting history for ${projectPath} on ${date}`);

  try {
    // Load conversation history
    const history = await loadConversation(projectPath);

    // Filter messages for the specified date
    const dayMessages = history.filter(m => m.timestamp?.startsWith(date));

    if (dayMessages.length === 0) {
      console.log(`📦 No messages found for ${date}`);
      if (currentConfig) {
        sendMessage({
          type: 'agent:history:export',
          payload: {
            machineId: currentConfig.machineId,
            projectPath,
            requestId,
            date,
            zipContent: '',
            error: 'No messages found for this date',
          },
        });
      }
      return;
    }

    // Generate Markdown content
    let markdown = `# 会話履歴 - ${date}\n\n`;

    // Get files for this date from .devrelay-files/
    const filesDir = join(projectPath, '.devrelay-files');
    const imageFiles: { originalName: string; newName: string }[] = [];

    try {
      const files = readdirSync(filesDir);
      // Filter files that match the date (YYYYMMDD_ prefix)
      const datePrefix = date.replace(/-/g, '') + '_';
      let imageIndex = 1;

      for (const file of files) {
        if (file.startsWith(datePrefix)) {
          const ext = file.split('.').pop()?.toLowerCase();
          if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext || '')) {
            const newName = `image${imageIndex}.${ext}`;
            imageFiles.push({ originalName: file, newName });
            imageIndex++;
          }
        }
      }
    } catch {
      // .devrelay-files directory doesn't exist
    }

    console.log(`📦 Processing ${dayMessages.length} messages for ${date}`);
    console.log(`📦 Found ${imageFiles.length} images for ${date}`);

    // Build markdown content
    for (const message of dayMessages) {
      const time = message.timestamp ? new Date(message.timestamp).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }) : '';
      const role = message.role === 'user' ? 'ユーザー' : message.role === 'assistant' ? 'アシスタント' : message.role;

      markdown += `## ${time} - ${role}\n\n`;
      markdown += message.content + '\n\n';
    }

    // Add image references at the end if any
    if (imageFiles.length > 0) {
      markdown += `## 添付ファイル\n\n`;
      for (const img of imageFiles) {
        markdown += `![${img.newName}](./images/${img.newName})\n`;
      }
    }

    console.log(`📦 Markdown generated: ${markdown.length} chars`);

    // Create ZIP file in memory
    const archive = archiver('zip', { zlib: { level: 9 } });
    const chunks: Buffer[] = [];

    const passThrough = new PassThrough();
    passThrough.on('data', (chunk: Buffer) => chunks.push(chunk));

    // Promise を先に作成してから finalize() を呼ぶ
    const endPromise = new Promise<void>((resolve, reject) => {
      passThrough.on('end', resolve);
      passThrough.on('error', reject);
      archive.on('error', reject);
    });

    archive.pipe(passThrough);

    // Add conversation.md
    archive.append(markdown, { name: 'conversation.md' });

    // Add images
    for (const img of imageFiles) {
      const filePath = join(filesDir, img.originalName);
      archive.file(filePath, { name: `images/${img.newName}` });
    }

    console.log(`📦 Starting ZIP finalization...`);
    await archive.finalize();

    // Wait for all chunks
    await endPromise;

    const zipBuffer = Buffer.concat(chunks);
    const zipContent = zipBuffer.toString('base64');

    console.log(`📦 ZIP created: ${zipBuffer.length} bytes, ${imageFiles.length} images`);

    if (currentConfig) {
      sendMessage({
        type: 'agent:history:export',
        payload: {
          machineId: currentConfig.machineId,
          projectPath,
          requestId,
          date,
          zipContent,
        },
      });
    }
  } catch (err) {
    console.error(`❌ Failed to export history:`, (err as Error).message);
    if (currentConfig) {
      sendMessage({
        type: 'agent:history:export',
        payload: {
          machineId: currentConfig.machineId,
          projectPath,
          requestId,
          date,
          zipContent: '',
          error: (err as Error).message,
        },
      });
    }
  }
}

// -----------------------------------------------------------------------------
// AI Tool Switching Functions
// -----------------------------------------------------------------------------

async function handleAiList(payload: AiListPayload, config: AgentConfig) {
  const { sessionId, requestId } = payload;
  console.log(`🤖 AI list requested for session ${sessionId}`);

  const available = getAvailableAiTools(config);
  const defaultTool = config.aiTools.default || 'claude';

  // Get current tool from session info or load from state
  const sessionInfo = sessionInfoMap.get(sessionId);
  let currentTool = sessionInfo?.aiTool || await loadLastAiTool() || defaultTool;

  console.log(`🤖 Available: ${available.join(', ')}, Current: ${currentTool}, Default: ${defaultTool}`);

  sendMessage({
    type: 'agent:ai:list',
    payload: {
      machineId: currentMachineId || config.machineId,
      sessionId,
      requestId,
      available,
      defaultTool,
      currentTool,
    },
  });
}

async function handleAiSwitch(payload: AiSwitchPayload, config: AgentConfig) {
  const { sessionId, aiTool } = payload;
  console.log(`🔄 Switching AI to ${aiTool} for session ${sessionId}`);

  try {
    // Verify the tool is available
    const available = getAvailableAiTools(config);
    if (!available.includes(aiTool)) {
      console.error(`❌ AI tool ${aiTool} is not available`);
      sendMessage({
        type: 'agent:ai:switched',
        payload: {
          machineId: currentMachineId || config.machineId,
          sessionId,
          aiTool,
          success: false,
          error: `AI tool ${aiTool} is not configured`,
        },
      });
      return;
    }

    // Update session info if exists
    const sessionInfo = sessionInfoMap.get(sessionId);
    if (sessionInfo) {
      sessionInfo.aiTool = aiTool;
      console.log(`📋 Updated session ${sessionId} to use ${aiTool}`);
    }

    // Save to state file for persistence across restarts
    await saveLastAiTool(aiTool);

    sendMessage({
      type: 'agent:ai:switched',
      payload: {
        machineId: currentMachineId || config.machineId,
        sessionId,
        aiTool,
        success: true,
      },
    });

    console.log(`✅ AI switched to ${aiTool}`);
  } catch (err) {
    console.error(`❌ Failed to switch AI:`, (err as Error).message);
    sendMessage({
      type: 'agent:ai:switched',
      payload: {
        machineId: currentMachineId || config.machineId,
        sessionId,
        aiTool,
        success: false,
        error: (err as Error).message,
      },
    });
  }
}
