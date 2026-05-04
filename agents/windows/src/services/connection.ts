import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import type { Agent } from 'http';
import {
  PROTOCOL_VERSION,
} from '@devrelay/shared';
import type {
  AgentMessage,
  ServerToAgentMessage,
  Project,
  AiTool,
  FileAttachment,
  ProxyConfig,
  AgreementApplyPayload,
  MissedMessage,
  StorageSavePayload,
  StorageClearPayload,
  HistoryDatesRequestPayload,
  HistoryExportRequestPayload,
  AiListPayload,
  AiSwitchPayload,
  AiCancelPayload
} from '@devrelay/shared';
import archiver from 'archiver';
import { PassThrough } from 'stream';
import { readdirSync } from 'fs';
import { DEFAULTS, DEFAULT_ALLOWED_TOOLS_WINDOWS } from '@devrelay/shared';
import type { AgentConfig } from './config.js';
import log from './logger.js';
import { startAiSession, sendPromptToAi, stopAiSession, cancelAiSession, type SendPromptOptions } from './ai-runner.js';
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
import {
  enableSleepPrevention,
  disableSleepPrevention
} from './sleep-preventer.js';
import type { WorkState, WorkStateSavePayload } from '@devrelay/shared';

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let appPingTimer: ReturnType<typeof setInterval> | null = null; // Application-level ping (agent:ping)
let pongCheckInterval: ReturnType<typeof setInterval> | null = null;
let currentConfig: AgentConfig | null = null;
let currentMachineId: string | null = null;
/** Server から配信されたプランモード許可ツール（null = デフォルト使用） */
let serverAllowedTools: string[] | null = null;

// Reconnection state (using shared constants for easy adjustment)
let reconnectAttempts = 0;
/** サーバーがプロトコルバージョン不足で接続拒否した場合 true（再接続ループを停止） */
let protocolUpdateRequired = false;

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

// Current session state for auto-restore after reconnection
let currentProjectPath: string | null = null;
let currentProjectName: string | null = null;
let currentProjects: Project[] = [];

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
  currentProjects = projects;
  return new Promise<void>((resolve, reject) => {
    // Build WebSocket options with optional proxy
    const wsOptions: WebSocket.ClientOptions = {};

    if (config.proxy?.url) {
      wsOptions.agent = createProxyAgent(config.proxy);
      log.info(`Connecting to ${config.serverUrl} via proxy ${config.proxy.url}...`);
    } else {
      log.info(`Connecting to ${config.serverUrl}...`);
    }

    ws = new WebSocket(config.serverUrl, wsOptions);

    ws.on('open', async () => {
      log.info('Connected to server');

      // Check if this is a reconnection with an active session
      const isReconnection = reconnectAttempts > 0;

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
          protocolVersion: PROTOCOL_VERSION,
        },
      });

      // Start ping (both WebSocket-level and application-level) and pong timeout check
      startPing();
      startAppPing();
      lastPongReceived = Date.now();
      pongCheckInterval = setInterval(() => {
        const timeSinceLastPong = Date.now() - lastPongReceived;
        if (timeSinceLastPong > PONG_TIMEOUT) {
          log.error(`Pong timeout detected (${timeSinceLastPong}ms since last pong), reconnecting...`);
          ws?.terminate();
        }
      }, 15000);

      // Enable sleep prevention if configured
      if (config.preventSleep) {
        enableSleepPrevention();
      }

      // If reconnecting with an active session, send session restore request
      if (isReconnection && currentProjectPath && currentProjectName) {
        log.info(`Sending session restore request for ${currentProjectName}...`);
        const agreementStatus = await getAgreementStatusType(currentProjectPath);
        sendMessage({
          type: 'agent:session:restore',
          payload: {
            machineId: config.machineId,
            projectPath: currentProjectPath,
            projectName: currentProjectName,
            agreementStatus,
          },
        });
      }

      resolve();
    });

    ws.on('message', (data) => {
      try {
        const message: ServerToAgentMessage = JSON.parse(data.toString());
        log.info(`📥 Received message: type=${message.type}`);
        handleServerMessage(message, config);
      } catch (err) {
        log.error('Error parsing server message:', err);
      }
    });

    ws.on('pong', () => {
      lastPongReceived = Date.now();
    });

    ws.on('close', () => {
      log.info('Disconnected from server');
      stopPing();
      stopAppPing();
      if (pongCheckInterval) {
        clearInterval(pongCheckInterval);
        pongCheckInterval = null;
      }
      scheduleReconnect(config, projects);
    });

    ws.on('error', (err) => {
      log.error('WebSocket error:', err.message);
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
          log.info(`Authentication successful (machineId: ${currentMachineId})`);
        } else {
          log.info('Authentication successful');
        }
        // Server 管理の allowedTools を受信（null = デフォルト使用）
        if (message.payload.allowedTools !== undefined) {
          serverAllowedTools = message.payload.allowedTools;
          const count = serverAllowedTools ? serverAllowedTools.length : 'default';
          log.info(`Allowed tools from server: ${count}`);
        }
        // プロトコルバージョン不足の警告（接続は成功しているが会話は制限される）
        if (message.payload.updateRequired) {
          log.warn('Agent の更新が必要です。会話は制限されます。`u` コマンドで更新してください。');
        }
      } else {
        log.error('Authentication failed:', message.payload.error);
        if (message.payload.updateRequired) {
          log.error('Agent の更新が必要です。`u` コマンドで更新するか、再インストールしてください。');
          protocolUpdateRequired = true;
        }
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

    case 'server:session:restored':
      handleSessionRestored(message.payload);
      break;

    case 'server:pong':
      // Application-level pong received, update last pong time
      lastPongReceived = Date.now();
      break;

    case 'server:storage:save':
      handleStorageSave(message.payload);
      break;

    case 'server:storage:clear':
      handleStorageClear(message.payload);
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

    case 'server:ai:cancel':
      handleAiCancel(message.payload);
      break;
  }
}

async function handleSessionStart(
  payload: { sessionId: string; projectName: string; projectPath: string; aiTool: AiTool },
  config: AgentConfig
) {
  const { sessionId, projectName, projectPath, aiTool } = payload;

  log.info(`Starting session: ${sessionId}`);
  log.info(`   Project: ${projectName} (${projectPath})`);
  log.info(`   AI Tool: ${aiTool}`);

  // Store current session state for auto-restore after reconnection
  currentProjectPath = projectPath;
  currentProjectName = projectName;

  // Load previous conversation history from file
  const history = await loadConversation(projectPath);

  // Check for pending work state (auto-continue feature)
  const pendingWorkState = await loadWorkState(projectPath);
  if (pendingWorkState) {
    log.info(`Found pending work state: ${pendingWorkState.summary}`);
  }

  // Check DevRelay Agreement status（詳細な状態を取得）
  const agreementStatus = await getAgreementStatusType(projectPath);
  const statusLabels = { latest: '最新版', outdated: '旧版（更新推奨）', none: '未対応' };
  log.info(`📋 DevRelay Agreement: ${statusLabels[agreementStatus]}`);

  // Check for storage context
  const storageContext = await loadStorageContext(projectPath);
  const hasStorageContext = !!storageContext;
  if (hasStorageContext) {
    log.info(`📦 Storage context found (${storageContext.length} chars)`);
  }

  // Load existing Claude session ID for --resume
  const claudeResumeSessionId = await loadClaudeSessionId(projectPath);
  if (claudeResumeSessionId) {
    log.info(`Found existing Claude session: ${claudeResumeSessionId.substring(0, 8)}...`);
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
  log.info(`Session ${sessionId} -> Claude Session ${claudeSessionId}`);

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
    log.error('Failed to start AI session:', err);
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
  log.info(`Ending session: ${sessionId}`);
  await stopAiSession(sessionId);

  // Clear current session state
  currentProjectPath = null;
  currentProjectName = null;
}

function handleSessionRestored(payload: { sessionId: string; projectPath: string; chatId: string; platform: string }) {
  const { sessionId, projectPath, chatId, platform } = payload;
  log.info(`Session restored: ${sessionId}`);
  log.info(`   Project: ${projectPath}`);
  log.info(`   Chat: ${chatId} (${platform})`);
}

async function handleConversationClear(payload: { sessionId: string; projectPath: string }) {
  const { sessionId, projectPath } = payload;
  log.info(`Clearing conversation for session ${sessionId}`);

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
    log.info(`In-memory history and Claude session ID cleared for session ${sessionId}`);
  }
}

async function handleConversationExec(payload: { sessionId: string; projectPath: string; userId: string; prompt?: string }) {
  const { sessionId, projectPath, userId, prompt: customPrompt } = payload;
  log.info(`Marking exec point for session ${sessionId}${customPrompt ? ` (custom prompt: ${customPrompt})` : ''}`);

  let sessionInfo = sessionInfoMap.get(sessionId);

  if (sessionInfo) {
    // Mark exec point in history (this becomes the reset point)
    sessionInfo.history = await markExecPoint(projectPath, sessionInfo.history);
    log.info(`Exec point marked, history now has ${sessionInfo.history.length} entries`);
  } else {
    // Session not in memory (e.g., after server restart), initialize from file
    log.info(`Session not found in memory, initializing from file...`);
    const history = await loadConversation(projectPath);
    const claudeSessionId = uuidv4();
    const aiTool: AiTool = currentConfig?.aiTools?.default || 'claude';

    // Create session info and add to map
    sessionInfo = { projectPath, aiTool, claudeSessionId, history };
    sessionInfoMap.set(sessionId, sessionInfo);
    log.info(`Session ${sessionId} initialized with ${history.length} history entries`);

    // Mark exec point in history
    sessionInfo.history = await markExecPoint(projectPath, sessionInfo.history);
    log.info(`Exec point marked, history now has ${sessionInfo.history.length} entries`);
  }

  // カスタムプロンプトがあればそれを使用、なければデフォルトのプラン実行プロンプト
  const execPrompt = customPrompt || 'プランに従って実装を開始してください。';
  log.info(`Auto-starting with prompt: ${execPrompt}`);
  await handleAiPrompt({
    sessionId,
    prompt: execPrompt,
    userId,
    files: undefined,
  });
}

async function handleWorkStateSave(payload: WorkStateSavePayload) {
  const { sessionId, projectPath, workState } = payload;
  log.info(`Saving work state for session ${sessionId}`);

  try {
    await saveWorkState(projectPath, workState);
    log.info(`Work state saved: ${workState.summary}`);
  } catch (err) {
    log.error(`Failed to save work state:`, (err as Error).message);
  }
}

async function handleAiPrompt(payload: { sessionId: string; prompt: string; userId: string; files?: FileAttachment[]; missedMessages?: MissedMessage[]; execPrompt?: string }) {
  const { sessionId, prompt, userId, files, missedMessages, execPrompt: callerExecPrompt } = payload;
  log.info(`Received prompt for session ${sessionId}: ${prompt.slice(0, 50)}...`);
  if (files && files.length > 0) {
    log.info(`Received ${files.length} file(s): ${files.map(f => f.filename).join(', ')}`);
  }
  if (missedMessages && missedMessages.length > 0) {
    log.info(`Received ${missedMessages.length} missed message(s) from Discord`);
  }

  // sessionInfoMap の登録を待機（session:start との race condition 対策）
  let sessionInfo = sessionInfoMap.get(sessionId);
  if (!sessionInfo) {
    log.info(`Waiting for session info registration: ${sessionId}`);
    for (let i = 0; i < 30; i++) {
      await new Promise(resolve => setTimeout(resolve, 500));
      sessionInfo = sessionInfoMap.get(sessionId);
      if (sessionInfo) break;
    }
  }
  if (!sessionInfo || !currentConfig) {
    log.error(`Session info not found for ${sessionId} after waiting`);
    return;
  }

  // Save received files and get their paths
  let promptWithFiles = prompt;
  if (files && files.length > 0) {
    const savedPaths = await saveReceivedFiles(sessionInfo.projectPath, files);
    if (savedPaths.length > 0) {
      promptWithFiles = buildPromptWithFiles(prompt, savedPaths);
      log.info(`Files saved to: ${savedPaths.join(', ')}`);
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
    log.info(`Added ${missedMessages.length} missed messages to history`);
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
  log.info(`Mode: ${isExecTriggered ? 'EXEC (--dangerously-skip-permissions)' : 'PLAN (--permission-mode plan)'}`);

  // Check for pending work state (auto-continue feature)
  let workStatePrompt = '';
  if (sessionInfo.pendingWorkState) {
    log.info(`Including work state in prompt: ${sessionInfo.pendingWorkState.summary}`);
    workStatePrompt = '\n\n' + formatWorkStateForPrompt(sessionInfo.pendingWorkState);

    // Archive the work state file and clear from session
    await archiveWorkState(sessionInfo.projectPath);
    sessionInfo.pendingWorkState = undefined;
  }

  // Add plan/exec mode instruction to prompt
  const modeInstruction = usePlanMode ? PLAN_MODE_INSTRUCTION : EXEC_MODE_INSTRUCTION;

  // Load storage context if exists
  let storageContextPrompt = '';
  const storageContext = await loadStorageContext(sessionInfo.projectPath);
  if (storageContext) {
    log.info(`Including storage context in prompt (${storageContext.length} chars)`);
    storageContextPrompt = '\n\n--- Storage Context ---\n' + storageContext + '\n--- End Storage Context ---';
  }

  // Build prompt with mode instruction and file output instruction
  let fullPrompt = modeInstruction + '\n\n' + promptWithFiles + workStatePrompt + storageContextPrompt + OUTPUT_DIR_INSTRUCTION;
  // 会話履歴のサイズを記録（ログ出力用）
  let historyContextSize = 0;

  // Include conversation history if:
  // 1. Claude: resumeSessionId がない場合（SDK の --resume でセッション引き継ぎするため通常は不要）
  // 2. Claude: missed messages がある場合（SDK 内部履歴にない新規メッセージ）
  // 3. 非 Claude（Devin/Gemini 等）: 常に含める（--resume が効かないためプロンプトが唯一のコンテキスト）
  const hasMissedMessages = missedMessages && missedMessages.length > 0;
  const isClaudeSdk = sessionInfo.aiTool === 'claude';
  const needsHistoryInPrompt = !isClaudeSdk || !sessionInfo.claudeResumeSessionId || hasMissedMessages;
  if (sessionInfo.history.length > 1 && needsHistoryInPrompt) {
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
  log.info(`Prompt size breakdown:`);
  log.info(`   - Mode instruction: ${modeInstruction.length} chars`);
  log.info(`   - User prompt: ${promptWithFiles.length} chars`);
  log.info(`   - Work state: ${workStatePrompt.length} chars`);
  log.info(`   - Storage context: ${storageContextPrompt.length} chars`);
  log.info(`   - Output instruction: ${OUTPUT_DIR_INSTRUCTION.length} chars`);
  if (historyContextSize > 0) {
    log.info(`   - History context: ${historyContextSize} chars`);
  }
  log.info(`   TOTAL: ${fullPrompt.length} chars (~${Math.round(fullPrompt.length / 4)} tokens)`);

  log.info(`History length: ${sessionInfo.history.length}`);
  if (sessionInfo.claudeResumeSessionId) {
    log.info(`Using --resume with session: ${sessionInfo.claudeResumeSessionId.substring(0, 8)}...`);
  }

  // 会話履歴件数を Discord/Telegram に表示
  const historyMessage = `📝 History: ${sessionInfo.history.length} messages`;

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

  // Prepare send options
  const sendOptions: SendPromptOptions = {
    resumeSessionId: sessionInfo.claudeResumeSessionId,
    usePlanMode,
    allowedTools: usePlanMode ? (serverAllowedTools ?? DEFAULT_ALLOWED_TOOLS_WINDOWS) : undefined,
  };

  // AI実行をtry/catchで囲む（Claude Code未インストール等のエラーでプロセスがクラッシュしないようにする）
  try {
    let responseText = '';
    // isComplete=true の二重送信防止ガード（error+close 競合、resumeFailed 等の対策）
    let completionSent = false;
    const aiResult = await sendPromptToAi(
      sessionId,
      fullPrompt,
      sessionInfo.projectPath,
      sessionInfo.aiTool,
      sessionInfo.claudeSessionId,
      currentConfig,
      async (output, isComplete, usageData) => {
        responseText += output;

        if (isComplete) {
          // 二重完了送信を防止（DB に重複 Message が作成されるのを防ぐ）
          if (completionSent) {
            log.info(`Duplicate completion ignored for session ${sessionId}`);
            return;
          }
          completionSent = true;

          // Collect files from the output directory
          const files = await collectOutputFiles(sessionInfo.projectPath);
          if (files.length > 0) {
            log.info(`Sending ${files.length} file(s) from output directory`);
          }

          sendMessage({
            type: 'agent:ai:output',
            payload: {
              machineId: currentConfig!.machineId,
              sessionId,
              output: responseText,  // Send full accumulated response
              isComplete,
              files: files.length > 0 ? files : undefined,
              usageData,  // AI 使用量データ（DB 保存用）
              isExec: isExecTriggered || undefined,  // exec モードフラグ（BuildLog 作成用）
              execPrompt: isExecTriggered ? callerExecPrompt : undefined,  // exec プロンプト（AI 要約用）
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
            log.info(`Conversation saved (${sessionInfo.history.length} messages)`);
          }
        } else {
          // Stream intermediate output without files
          log.info(`Streaming output (${output.length} chars): ${output.substring(0, 50)}...`);
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
      log.info(`Retrying without --resume due to session failure...`);
      sessionInfo.claudeResumeSessionId = undefined;
      await clearClaudeSessionId(sessionInfo.projectPath);

      // Retry without resume session ID（completionSent をリセットして retry の完了を受け付ける）
      responseText = '';
      completionSent = false;
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
        async (output, isComplete, usageData) => {
          responseText += output;

          if (isComplete) {
            if (completionSent) {
              log.info(`Duplicate completion ignored for retry session ${sessionId}`);
              return;
            }
            completionSent = true;

            const files = await collectOutputFiles(sessionInfo.projectPath);
            if (files.length > 0) {
              log.info(`Sending ${files.length} file(s) from output directory`);
            }

            sendMessage({
              type: 'agent:ai:output',
              payload: {
                machineId: currentConfig!.machineId,
                sessionId,
                output: responseText,
                isComplete,
                files: files.length > 0 ? files : undefined,
                usageData,  // AI 使用量データ（DB 保存用）
                isExec: isExecTriggered || undefined,  // exec モードフラグ（BuildLog 作成用）
                execPrompt: isExecTriggered ? callerExecPrompt : undefined,  // exec プロンプト（AI 要約用）
              },
            });

            if (responseText.trim()) {
              sessionInfo.history.push({
                role: 'assistant',
                content: responseText.trim(),
                timestamp: new Date().toISOString()
              });
              await saveConversation(sessionInfo.projectPath, sessionInfo.history);
              log.info(`Conversation saved (${sessionInfo.history.length} messages)`);
            }
          } else {
            log.info(`Streaming output (${output.length} chars): ${output.substring(0, 50)}...`);
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
        log.info(`Updated Claude session ID (after retry): ${retryResult.extractedSessionId.substring(0, 8)}...`);
      }
      return;
    }

    // Update session info with new Claude session ID if extracted
    if (aiResult.extractedSessionId) {
      sessionInfo.claudeResumeSessionId = aiResult.extractedSessionId;
      log.info(`Updated Claude session ID: ${aiResult.extractedSessionId.substring(0, 8)}...`);
    }
  } catch (error) {
    // AI実行エラー（Claude Code未インストール、パス解決失敗等）をキャッチしてDiscord/Telegramに通知
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error(`AI実行エラー: ${errorMessage}`);
    sendMessage({
      type: 'agent:ai:output',
      payload: {
        machineId: currentConfig!.machineId,
        sessionId,
        output: `❌ エラー: ${errorMessage}`,
        isComplete: true,
      },
    });
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
  if (config.aiTools.devin) tools.push('devin');
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
    log.info(`💓 Sending app ping (machineId: ${currentMachineId})`);
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
    log.info(`⏳ App ping skipped (ws: ${wsState}, machineId: ${currentMachineId || 'null'})`);
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

  // プロトコルバージョン不足で拒否された場合は再接続しない
  if (protocolUpdateRequired) {
    log.error('Agent の更新が必要です。再接続をスキップします。`u` コマンドで更新するか、再インストールしてください。');
    return;
  }

  const { baseDelay, maxDelay, maxAttempts, jitterRange } = DEFAULTS.reconnect;

  // Check max attempts
  if (reconnectAttempts >= maxAttempts) {
    log.error(`Max reconnect attempts (${maxAttempts}) reached. Giving up.`);
    log.error('Restart the agent manually or check if the server is running.');
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
  log.info(`Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${reconnectAttempts}/${maxAttempts})...`);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToServer(config, projects).catch((err) => {
      log.error('Reconnection failed:', err.message);
      // scheduleReconnect will be called from the 'close' event
    });
  }, delay);
}

export function disconnect() {
  stopPing();
  stopAppPing();
  if (pongCheckInterval) {
    clearInterval(pongCheckInterval);
    pongCheckInterval = null;
  }
  disableSleepPrevention();
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
 * Send updated project list to server
 * Call this after scanning/adding projects to sync without restart
 */
export function sendProjectsUpdate(projects: Project[]) {
  if (!ws || ws.readyState !== WebSocket.OPEN || !currentConfig) {
    log.info('⚠️ Cannot send projects update: not connected');
    return;
  }

  sendMessage({
    type: 'agent:projects',
    payload: {
      machineId: currentMachineId || currentConfig.machineId,
      projects,
    },
  });
  log.info(`📤 Sent projects update: ${projects.length} projects`);
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
// v4+: rules/devrelay.md を優先チェック → なければ CLAUDE.md にフォールバック
export async function getAgreementStatusType(projectPath: string): Promise<AgreementStatusType> {
  try {
    // v4+: rules/devrelay.md に最新版マーカーがあるか確認
    const rulesPath = join(projectPath, 'rules', 'devrelay.md');
    try {
      const rulesContent = await readFile(rulesPath, 'utf-8');
      if (rulesContent.includes(DEVRELAY_AGREEMENT_MARKER)) {
        return 'latest';
      }
    } catch {
      // rules/devrelay.md が存在しない → CLAUDE.md にフォールバック
    }

    // v3以前: CLAUDE.md のマーカーを確認
    const claudeMdPath = join(projectPath, 'CLAUDE.md');
    const content = await readFile(claudeMdPath, 'utf-8');

    // CLAUDE.md に最新版マーカーがある場合（v4 マーカーが CLAUDE.md に直接ある場合も対応）
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
// Server から agreementPrompt が送られてくればそれを優先使用（Server 側でテンプレート管理）
// 送られてこない場合（旧 Server）はローカルの AGREEMENT_APPLY_PROMPT にフォールバック
async function handleAgreementApply(payload: AgreementApplyPayload) {
  const { sessionId, projectPath, userId, agreementPrompt } = payload;
  log.info(`📝 Applying DevRelay Agreement for session ${sessionId}`);

  let sessionInfo = sessionInfoMap.get(sessionId);

  if (!sessionInfo || !currentConfig) {
    // Session not in memory, initialize from file
    log.info(`📋 Session not found in memory, initializing...`);
    const history = await loadConversation(projectPath);
    const claudeSessionId = uuidv4();
    const aiTool: AiTool = currentConfig?.aiTools?.default || 'claude';

    sessionInfo = { projectPath, aiTool, claudeSessionId, history, pendingWorkState: undefined };
    sessionInfoMap.set(sessionId, sessionInfo);
  }

  // Clear conversation history before applying Agreement
  // This ensures the new conversation starts fresh with plan mode enabled
  log.info(`🗑️ Clearing conversation history for Agreement apply...`);
  await clearConversation(projectPath);
  sessionInfo.history = [];

  // Server 配信プロンプトを優先、なければローカルフォールバック
  const basePrompt = agreementPrompt || AGREEMENT_APPLY_PROMPT;
  if (agreementPrompt) {
    log.info(`📡 Using server-provided agreement prompt`);
  } else {
    log.info(`📦 Using local agreement prompt (fallback)`);
  }

  // Use the agreement apply prompt (with instruction to mention the cleared history)
  const promptWithClearNotice = basePrompt + '\n\n最後に、会話履歴をクリアしたことも伝えてください：「🗑️ 会話履歴をクリアしました。新しい会話からプランモードが有効になります。」';

  await handleAiPrompt({
    sessionId,
    prompt: promptWithClearNotice,
    userId,
    files: undefined,
  });
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
  log.info(`Saving storage context for session ${sessionId}`);

  try {
    await saveStorageContext(projectPath, content);
    log.info(`Storage context saved (${content.length} chars)`);

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
    log.error(`Failed to save storage context:`, (err as Error).message);
  }
}

async function handleStorageClear(payload: StorageClearPayload) {
  const { sessionId, projectPath } = payload;
  log.info(`Clearing storage context for session ${sessionId}`);

  try {
    await clearStorageContext(projectPath);
    log.info(`Storage context cleared`);
  } catch (err) {
    log.error(`Failed to clear storage context:`, (err as Error).message);
  }
}

// -----------------------------------------------------------------------------
// History Export Functions
// -----------------------------------------------------------------------------

async function handleHistoryDates(payload: HistoryDatesRequestPayload) {
  log.info(`📥 handleHistoryDates called`);
  const { projectPath, requestId } = payload;
  log.info(`📦 Getting history dates for ${projectPath}`);

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

    log.info(`Found ${sortedDates.length} dates with history`);

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
    log.error(`Failed to get history dates:`, (err as Error).message);
  }
}

async function handleHistoryExport(payload: HistoryExportRequestPayload) {
  const { projectPath, requestId, date } = payload;
  log.info(`Exporting history for ${projectPath} on ${date}`);

  try {
    // Load conversation history
    const history = await loadConversation(projectPath);

    // Filter messages for the specified date
    const dayMessages = history.filter(m => m.timestamp?.startsWith(date));

    if (dayMessages.length === 0) {
      log.info(`No messages found for ${date}`);
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

    log.info(`Processing ${dayMessages.length} messages for ${date}`);
    log.info(`Found ${imageFiles.length} images for ${date}`);

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

    log.info(`Markdown generated: ${markdown.length} chars`);

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

    log.info(`Starting ZIP finalization...`);
    await archive.finalize();

    // Wait for all chunks
    await endPromise;

    const zipBuffer = Buffer.concat(chunks);
    const zipContent = zipBuffer.toString('base64');

    log.info(`ZIP created: ${zipBuffer.length} bytes, ${imageFiles.length} images`);

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
    log.error(`Failed to export history:`, (err as Error).message);
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
  log.info(`🤖 AI list requested for session ${sessionId}`);

  const available = getAvailableAiTools(config);
  const defaultTool = config.aiTools.default || 'claude';

  // Get current tool from session info or load from state
  const sessionInfo = sessionInfoMap.get(sessionId);
  let currentTool = sessionInfo?.aiTool || await loadLastAiTool() || defaultTool;

  log.info(`🤖 Available: ${available.join(', ')}, Current: ${currentTool}, Default: ${defaultTool}`);

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
  log.info(`🔄 Switching AI to ${aiTool} for session ${sessionId}`);

  try {
    // Verify the tool is available
    const available = getAvailableAiTools(config);
    if (!available.includes(aiTool)) {
      log.error(`❌ AI tool ${aiTool} is not available`);
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
      log.info(`📋 Updated session ${sessionId} to use ${aiTool}`);
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

    log.info(`✅ AI switched to ${aiTool}`);
  } catch (err) {
    log.error(`❌ Failed to switch AI:`, (err as Error).message);
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

/** 実行中の AI プロセスをキャンセルし、Server に完了通知を送信 */
async function handleAiCancel(payload: AiCancelPayload) {
  const { sessionId } = payload;
  log.info(`⛔ Cancel requested for session ${sessionId}`);

  const cancelled = cancelAiSession(sessionId);

  if (currentConfig) {
    sendMessage({
      type: 'agent:ai:cancelled',
      payload: {
        machineId: currentConfig.machineId,
        sessionId,
      },
    });
  }

  if (!cancelled) {
    log.info(`⚠️ No active process to cancel for session ${sessionId}`);
  }
}
