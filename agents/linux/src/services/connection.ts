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
  AiSwitchPayload,
  AiCancelPayload,
  DocSyncPayload,
  DocDeletePayload
} from '@devrelay/shared';
import archiver from 'archiver';
import { PassThrough } from 'stream';
import { readdirSync, mkdirSync, writeFileSync } from 'fs';
import { DEFAULTS, DEFAULT_ALLOWED_TOOLS_LINUX } from '@devrelay/shared';
import { saveConfig, getConfigDir, type AgentConfig } from './config.js';
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
import { ensureSkillFiles } from './skill-manager.js';
import { exec as execCallback, spawn } from 'child_process';
import { promisify } from 'util';
import { homedir } from 'os';
import { readFile, writeFile, unlink, mkdir } from 'fs/promises';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
const execAsync = promisify(execCallback);
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
import { generateManagementInfo } from './management-info.js';
import { autoDiscoverProjects, loadProjects } from './projects.js';

let ws: WebSocket | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let pingTimer: NodeJS.Timeout | null = null;
let appPingTimer: NodeJS.Timeout | null = null; // Application-level ping (agent:ping)
let pongCheckInterval: NodeJS.Timeout | null = null;
let currentConfig: AgentConfig | null = null;
let currentMachineId: string | null = null;
/** Server から配信されたプランモード許可ツール（null = デフォルト使用） */
let serverAllowedTools: string[] | null = null;

// 再接続状態（バックオフ管理）
let reconnectAttempts = 0;
/** 最後に WebSocket 接続が確立した時刻（安定接続判定用） */
let lastConnectedAt = 0;

/** 最後に更新を開始した時刻（二重更新防止用、60秒で自動解除） */
let updateStartedAt = 0;

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

    // 旧 WebSocket が残っていればクリーンアップ（close ハンドラの誤発火防止）
    if (ws) {
      ws.removeAllListeners();
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.terminate();
      }
    }

    ws = new WebSocket(config.serverUrl, wsOptions);

    ws.on('open', () => {
      console.log('✅ Connected to server');

      // 接続時刻を記録（安定接続判定用。リセットは scheduleReconnect で行う）
      lastConnectedAt = Date.now();

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
          managementInfo: generateManagementInfo(),
          projectsDirs: config.projectsDirs,
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
        // デバッグ: pong 以外の受信メッセージタイプをログ出力
        if (message.type !== 'server:pong') {
          console.log(`📩 Received message: ${message.type}`);
        }
        handleServerMessage(message, config);
      } catch (err) {
        console.error('Error parsing server message:', err);
      }
    });

    // close ハンドラ: この WS が既に置き換えられていたら再接続をスキップ
    const thisWs = ws;
    thisWs.on('close', () => {
      if (ws !== thisWs) {
        console.log('🔌 Old WebSocket closed (replaced), skipping reconnect');
        return;
      }
      console.log('🔌 Disconnected from server');
      stopPing();
      stopAppPing();
      // pongCheckInterval をクリア（再接続時に新規作成されるため、古いものが残るとリーク）
      if (pongCheckInterval) {
        clearInterval(pongCheckInterval);
        pongCheckInterval = null;
      }
      scheduleReconnect(config, projects);
    });

    thisWs.on('error', (err) => {
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
        // Server 管理のプロジェクト検索パスが設定されていれば再スキャン
        if (message.payload.projectsDirs) {
          handleProjectsDirsUpdate(message.payload.projectsDirs, config).catch(err =>
            console.error('❌ projectsDirs update failed:', err)
          );
        }
        // Server 管理の allowedTools を受信（null = デフォルト使用）
        if (message.payload.allowedTools !== undefined) {
          serverAllowedTools = message.payload.allowedTools;
          const count = serverAllowedTools ? serverAllowedTools.length : 'default';
          console.log(`🔧 Allowed tools from server: ${count}`);
        }
        // Claude Code スキルファイルを作成・更新（ドキュメント検索用）
        ensureSkillFiles(config).catch(err =>
          console.error('❌ Skill files update failed:', err.message));
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

    case 'server:ai:cancel':
      handleAiCancel(message.payload);
      break;

    case 'server:config:update':
      if (message.payload.projectsDirs !== undefined) {
        handleProjectsDirsUpdate(message.payload.projectsDirs, config).catch(err =>
          console.error('❌ projectsDirs update failed:', err)
        );
      }
      if (message.payload.allowedTools !== undefined) {
        serverAllowedTools = message.payload.allowedTools;
        const count = serverAllowedTools ? serverAllowedTools.length : 'default';
        console.log(`🔧 Allowed tools updated from server: ${count}`);
        // ack を送信（pending リトライを停止させる）
        if (currentMachineId) {
          sendMessage({
            type: 'agent:config:ack',
            payload: { machineId: currentMachineId },
          });
        }
      }
      break;

    case 'server:agent:version-check':
      handleVersionCheck();
      break;

    case 'server:agent:update':
      handleAgentUpdate();
      break;

    case 'server:doc:sync':
      handleDocSync(message.payload);
      break;

    case 'server:doc:delete':
      handleDocDelete(message.payload);
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

/** 実行中の AI プロセスをキャンセルし、Server に完了通知を送信 */
async function handleAiCancel(payload: AiCancelPayload) {
  const { sessionId } = payload;
  console.log(`⛔ Cancel requested for session ${sessionId}`);

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
    console.log(`⚠️ No running process to cancel for session ${sessionId}`);
  }
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

async function handleConversationExec(payload: { sessionId: string; projectPath: string; userId: string; prompt?: string }) {
  const { sessionId, projectPath, userId, prompt: customPrompt } = payload;
  console.log(`🚀 Marking exec point for session ${sessionId}${customPrompt ? ` (custom prompt: ${customPrompt})` : ''}`);

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

  // カスタムプロンプトがあればそれを使用、なければデフォルトのプラン実行プロンプト
  const execPrompt = customPrompt || 'プランに従って実装を開始してください。';
  console.log(`🚀 Auto-starting with prompt: ${execPrompt}`);
  await handleAiPrompt({
    sessionId,
    prompt: execPrompt,
    userId,
    files: undefined,
    execPrompt,  // BuildLog AI 要約のコンテキスト用に exec プロンプトを伝搬
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

async function handleAiPrompt(payload: { sessionId: string; prompt: string; userId: string; files?: FileAttachment[]; missedMessages?: MissedMessage[]; execPrompt?: string }) {
  const { sessionId, prompt, userId, files, missedMessages, execPrompt: callerExecPrompt } = payload;
  console.log(`📝 Received prompt for session ${sessionId}: ${prompt.slice(0, 50)}...`);
  if (files && files.length > 0) {
    console.log(`📎 Received ${files.length} file(s): ${files.map(f => f.filename).join(', ')}`);
  }
  if (missedMessages && missedMessages.length > 0) {
    console.log(`📨 Received ${missedMessages.length} missed message(s) from Discord`);
  }

  // sessionInfoMap の登録を待機（session:start との race condition 対策）
  let sessionInfo = sessionInfoMap.get(sessionId);
  if (!sessionInfo) {
    console.log(`⏳ Waiting for session info registration: ${sessionId}`);
    for (let i = 0; i < 30; i++) {
      await new Promise(resolve => setTimeout(resolve, 500));
      sessionInfo = sessionInfoMap.get(sessionId);
      if (sessionInfo) break;
    }
  }
  if (!sessionInfo || !currentConfig) {
    console.error(`Session info not found for ${sessionId} after waiting`);
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
  if (sessionInfo.claudeResumeSessionId) {
    console.log(`🔄 Using --resume with session: ${sessionInfo.claudeResumeSessionId.substring(0, 8)}...`);
  }

  // Prepare send options
  const sendOptions: SendPromptOptions = {
    resumeSessionId: sessionInfo.claudeResumeSessionId,
    usePlanMode,
    allowedTools: usePlanMode ? (serverAllowedTools ?? DEFAULT_ALLOWED_TOOLS_LINUX) : undefined,
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
            console.log(`⚠️ Duplicate completion ignored for session ${sessionId}`);
            return;
          }
          completionSent = true;

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
              console.log(`⚠️ Duplicate completion ignored for retry session ${sessionId}`);
              return;
            }
            completionSent = true;

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
  } catch (error) {
    // AI実行エラー（Claude Code未インストール、パス解決失敗等）をキャッチしてDiscord/Telegramに通知
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`❌ AI実行エラー: ${errorMessage}`);
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

  // 前回接続が安定していた（60秒以上）場合のみバックオフカウンタをリセット
  // 即切断ループ時はリセットせず、バックオフを効かせる
  const connectionDuration = Date.now() - lastConnectedAt;
  if (lastConnectedAt > 0 && connectionDuration > DEFAULTS.reconnectStableThreshold) {
    reconnectAttempts = 0;
  }

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

  // Server 配信プロンプトを優先、なければローカルフォールバック
  const prompt = agreementPrompt || AGREEMENT_APPLY_PROMPT;
  if (agreementPrompt) {
    console.log(`📡 Using server-provided agreement prompt`);
  } else {
    console.log(`📦 Using local agreement prompt (fallback)`);
  }

  await handleAiPrompt({
    sessionId,
    prompt,
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

/**
 * Server から配信されたプロジェクト検索パスでプロジェクトを再スキャン
 * 各パスを autoDiscoverProjects でスキャンし、更新後のプロジェクト一覧を Server に送信
 */
async function handleProjectsDirsUpdate(dirs: string[] | null, config: AgentConfig) {
  if (!dirs || dirs.length === 0) {
    console.log(`📂 projectsDirs is empty/null, skipping`);
    return;
  }

  console.log(`📂 Server-managed projectsDirs received: ${JSON.stringify(dirs)}`);

  try {
    // config.yaml の projectsDirs を Server 設定で上書き・永続化
    config.projectsDirs = dirs;
    await saveConfig(config);
    console.log(`💾 config.yaml updated with server projectsDirs: ${JSON.stringify(dirs)}`);
  } catch (err) {
    console.error(`❌ Failed to save config.yaml:`, (err as Error).message);
  }

  // 各パスをスキャン（新規プロジェクトを検出）
  let totalAdded = 0;
  for (const dir of dirs) {
    try {
      const added = await autoDiscoverProjects(dir);
      totalAdded += added;
    } catch (err) {
      console.error(`❌ Failed to scan ${dir}:`, (err as Error).message);
    }
  }

  // 変更有無に関わらず、現在のプロジェクト一覧を Server に送信（同期目的）
  const projects = await loadProjects(config);
  sendProjectsUpdate(projects);
  console.log(`📤 Projects synced: ${projects.length} projects (${totalAdded} new)`);

  // Server に設定更新の適用完了を通知（pending リトライを停止させる）
  if (currentMachineId) {
    sendMessage({
      type: 'agent:config:ack',
      payload: { machineId: currentMachineId },
    });
    console.log(`📤 Sent config:ack to server`);
  }
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

// -----------------------------------------------------------------------------
// Agent Version Check / Update
// -----------------------------------------------------------------------------

/**
 * Agent のルートディレクトリを取得する
 * process.argv[1] = <root>/agents/linux/dist/index.js → 3階層上がルート
 */
function getAgentRootDir(): string {
  return resolve(dirname(process.argv[1]), '..', '..', '..');
}

/**
 * インストール済み Agent かどうかを判定する
 * ~/.devrelay/agent/ 配下にあればインストール済み、それ以外は開発リポジトリ
 */
function isInstalledAgent(agentDir: string): boolean {
  // Windows: %APPDATA%\devrelay\agent, Linux: ~/.devrelay/agent
  const installedDir = join(getConfigDir(), 'agent');
  return agentDir.startsWith(installedDir);
}

/**
 * プロキシ設定を含む環境変数オブジェクトを構築する
 * Agent の config.yaml にプロキシが設定されている場合、git/pnpm にも適用
 */
function getExecEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (currentConfig?.proxy?.url) {
    const proxyUrl = buildProxyUrl(currentConfig.proxy);
    env.HTTP_PROXY = proxyUrl;
    env.HTTPS_PROXY = proxyUrl;
    env.http_proxy = proxyUrl;
    env.https_proxy = proxyUrl;
  }
  return env;
}

/**
 * リモートのデフォルトブランチを動的検出（origin/main, origin/master 等）
 * git symbolic-ref → origin/main → origin/master の順で試行
 */
async function detectRemoteBranch(execOpts: { cwd: string; env: NodeJS.ProcessEnv; timeout: number }): Promise<string> {
  // 1. git symbolic-ref で origin/HEAD を確認
  try {
    const { stdout } = await execAsync('git symbolic-ref refs/remotes/origin/HEAD', execOpts);
    const branch = stdout.trim().replace('refs/remotes/', '');
    if (branch) return branch;
  } catch {}
  // 2. フォールバック: origin/main → origin/master の順で確認
  for (const candidate of ['origin/main', 'origin/master']) {
    try {
      await execAsync(`git rev-parse --verify ${candidate}`, execOpts);
      return candidate;
    } catch {}
  }
  throw new Error('Remote default branch not found (tried origin/HEAD, origin/main, origin/master)');
}

/**
 * Server からバージョン確認リクエストを受信
 * ローカル/リモートの git コミットを比較して結果を返す
 */
async function handleVersionCheck() {
  const agentDir = getAgentRootDir();
  const isDevRepo = !isInstalledAgent(agentDir);
  const machineId = currentMachineId || currentConfig?.machineId || '';

  console.log(`📦 Version check requested (dir: ${agentDir}, isDevRepo: ${isDevRepo})`);

  try {
    const execEnv = getExecEnv();
    const execOpts = { cwd: agentDir, env: execEnv, timeout: 30000 };

    // ローカルコミット情報を取得
    const { stdout: localRaw } = await execAsync('git log -1 --format="%H %ai"', execOpts);
    const localParts = localRaw.trim().split(' ');
    const localCommit = localParts[0];
    const localDate = localParts.slice(1).join(' ');

    // リモートの最新コミットを取得（fetch してから確認）
    await execAsync('git fetch origin --quiet', execOpts);
    const remoteBranch = await detectRemoteBranch(execOpts);
    const { stdout: remoteRaw } = await execAsync(`git log ${remoteBranch} -1 --format="%H %ai"`, execOpts);
    const remoteParts = remoteRaw.trim().split(' ');
    const remoteCommit = remoteParts[0];
    const remoteDate = remoteParts.slice(1).join(' ');

    const hasUpdate = localCommit !== remoteCommit;
    console.log(`📦 Local: ${localCommit.slice(0, 7)} (${localDate}), Remote: ${remoteCommit.slice(0, 7)} (${remoteDate}), hasUpdate: ${hasUpdate}`);

    sendMessage({
      type: 'agent:version:info',
      payload: {
        machineId,
        localCommit,
        localDate,
        remoteCommit,
        remoteDate,
        hasUpdate,
        isDevRepo,
      },
    });
  } catch (err) {
    console.error(`❌ Version check failed:`, (err as Error).message);
    sendMessage({
      type: 'agent:version:info',
      payload: {
        machineId,
        localCommit: '',
        localDate: '',
        remoteCommit: '',
        remoteDate: '',
        hasUpdate: false,
        isDevRepo,
        error: (err as Error).message,
      },
    });
  }
}

/**
 * Server から更新実行リクエストを受信
 * detached プロセスで git pull + ビルド + 再起動を実行
 * Agent 自身が再起動対象なので、親プロセスが終了してもスクリプトは継続する
 */
async function handleAgentUpdate() {
  const agentDir = getAgentRootDir();
  const machineId = currentMachineId || currentConfig?.machineId || '';

  // 二重更新防止（60秒以内の連打をブロック、それ以降は自動解除）
  const UPDATE_GUARD_MS = 60 * 1000;
  if (Date.now() - updateStartedAt < UPDATE_GUARD_MS) {
    sendMessage({
      type: 'agent:update:status',
      payload: { machineId, status: 'error', error: '更新が既に実行中です（60秒以内の再実行は不可）。' },
    });
    return;
  }

  // 開発リポジトリからは更新不可
  if (!isInstalledAgent(agentDir)) {
    sendMessage({
      type: 'agent:update:status',
      payload: {
        machineId,
        status: 'error',
        error: '開発リポジトリから実行中のため、リモート更新は不可。pnpm deploy-agent を使用してください。',
      },
    });
    return;
  }

  // 管理コマンドからリスタートコマンドを取得
  const mgmtInfo = generateManagementInfo();
  const restartCmd = mgmtInfo.commands.find(c => c.type === 'restart');

  if (!restartCmd) {
    sendMessage({
      type: 'agent:update:status',
      payload: {
        machineId,
        status: 'error',
        error: '再起動コマンドが見つかりません。',
      },
    });
    return;
  }

  updateStartedAt = Date.now();
  console.log(`🔄 Starting agent update (dir: ${agentDir}, installType: ${mgmtInfo.installType})`);

  // 更新開始を Server に通知
  sendMessage({
    type: 'agent:update:status',
    payload: {
      machineId,
      status: 'started',
    },
  });

  // ログディレクトリを事前作成（存在しないと bash の >> が失敗する）
  // Windows: %APPDATA%\devrelay\logs, Linux: ~/.devrelay/logs
  const logsDir = join(getConfigDir(), 'logs');
  mkdirSync(logsDir, { recursive: true });
  const updateLogFile = join(logsDir, 'update.log');

  /** タイムスタンプ付きログ出力ヘルパー（bash 用） */
  const ts = `date '+%Y-%m-%d %H:%M:%S'`;
  const log = (msg: string) => `echo "[\$(${ts})] ${msg}" >> "${updateLogFile}"`;
  /** コマンド実行 + exit code ログ記録ヘルパー */
  const runAndLog = (label: string, cmd: string) =>
    `${log(label)}; ${cmd} >> "${updateLogFile}" 2>&1; ${log(`${label} exit=$?`)}`;

  if (process.platform === 'win32') {
    // Windows: PowerShell スクリプトで更新
    // ビルド失敗でもリスタートは必ず実行（旧 dist/ コードで復帰）
    // 各ステップの $LASTEXITCODE を個別にログ記録し、障害時の原因特定を容易にする
    /** タイムスタンプ付きログ出力ヘルパー（PowerShell 用） */
    const psTs = `Get-Date -Format 'yyyy-MM-dd HH:mm:ss'`;
    const psLog = (msg: string) =>
      `"[$(${psTs})] ${msg}" | Out-File -Append "${updateLogFile}"`;
    /** コマンド実行 + exit code ログ記録ヘルパー（PowerShell 用） */
    const psRunAndLog = (label: string, cmd: string) =>
      `${psLog(label)}; ${cmd} 2>&1 | Out-File -Append "${updateLogFile}"; ${psLog(`${label} exit=$LASTEXITCODE`)}`;

    // PowerShell 更新スクリプトを .ps1 に書き出し、VBS ラッパー経由で実行（#116）
    // 直接 spawn('powershell') だと DETACHED_PROCESS でサイレント終了するため
    // start-agent.vbs と同じ wscript.exe + VBS .Run パターンで起動する
    const stopCmd = mgmtInfo.commands.find(c => c.type === 'stop');
    const scriptLines = [
      `$ErrorActionPreference = 'Continue'`,
      psLog('=== Update started ==='),
      `cd "${agentDir}"`,
      psRunAndLog('git fetch', 'git fetch origin'),
      `$remoteBranch = try { (git symbolic-ref refs/remotes/origin/HEAD 2>$null) -replace 'refs/remotes/', '' } catch { 'origin/main' }`,
      `if (-not $remoteBranch) { $remoteBranch = 'origin/main' }`,
      psRunAndLog('git reset', 'git reset --hard $remoteBranch'),
      psRunAndLog('pnpm install', 'pnpm install --frozen-lockfile --ignore-scripts'),
      psRunAndLog('shared build', 'pnpm --filter @devrelay/shared build'),
      psRunAndLog('agent build', 'pnpm --filter @devrelay/agent build'),
      psLog('Build done, restarting...'),
      `Start-Sleep -Seconds 2`,
      // 旧 Agent プロセスを停止（Get-CimInstance で node.exe + devrelay を検出して kill）
      ...(stopCmd ? [psRunAndLog('stop old agent', stopCmd.command), 'Start-Sleep -Seconds 2'] : []),
      restartCmd.command,
    ];

    const scriptPath = join(logsDir, 'update.ps1');
    writeFileSync(scriptPath, scriptLines.join('\n'), 'utf-8');

    // VBS ラッパーで PowerShell を起動（DETACHED_PROCESS 問題を回避）
    // .Run の第2引数 0 = 非表示、第3引数 False = 完了を待たない
    const vbsContent = [
      'Set objShell = CreateObject("Wscript.Shell")',
      `objShell.Run "powershell -ExecutionPolicy Bypass -NoProfile -File ""${scriptPath}""", 0, False`,
    ].join('\r\n');
    const vbsPath = join(logsDir, 'update.vbs');
    writeFileSync(vbsPath, vbsContent, 'utf-8');

    console.log(`📝 Update script: ${scriptPath}`);
    console.log(`📝 Update VBS wrapper: ${vbsPath}`);
    const child = spawn('wscript.exe', [vbsPath], {
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', (err) => {
      console.error(`❌ Update script spawn failed: ${err.message}`);
      updateStartedAt = 0;
      sendMessage({
        type: 'agent:update:status',
        payload: { machineId, status: 'error', error: `スクリプト起動失敗: ${err.message}` },
      });
    });
    child.unref();
  } else {
    // Linux/macOS: bash スクリプトで更新
    // 各ステップの exit code を個別にログ記録し、障害時の原因特定を容易にする
    const nodeBinDir = join(homedir(), '.devrelay', 'node', 'bin');
    const buildSteps = [
      `export PATH="${nodeBinDir}:$PATH"`,
      `cd "${agentDir}"`,
      log('=== Update started ==='),
      runAndLog('git fetch', 'git fetch origin'),
      `REMOTE_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/@@' || echo "origin/main")`,
      `[ -z "$REMOTE_BRANCH" ] && REMOTE_BRANCH="origin/main"`,
      runAndLog('git reset', 'git reset --hard $REMOTE_BRANCH'),
      runAndLog('pnpm install', 'pnpm install --frozen-lockfile --ignore-scripts'),
      runAndLog('shared build', 'pnpm --filter @devrelay/shared build'),
      runAndLog('agent build', 'pnpm --filter @devrelay/agent build'),
    ].join('; ');

    // nohup の場合: restartCmd.command をそのまま使うと、bash -c の cmdline に
    // .devrelay.*index.js が含まれ、pgrep が自身の bash プロセスもマッチして
    // スクリプトが自殺する。専用リスタートコマンドを構築して $$ で自 PID を除外する。
    let actualRestartCmd: string;
    if (mgmtInfo.installType === 'nohup') {
      const agentIndex = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'index.js');
      const agentLogFile = join(logsDir, 'agent.log');
      actualRestartCmd = [
        // 絶対パス(.devrelay含む) + 相対パス(node index.js) の両方を検出
        '{ pgrep -u $(whoami) -f "\\.devrelay.*index\\.js"; pgrep -u $(whoami) -fx "node index\\.js"; } 2>/dev/null | sort -u | grep -v "^$$\\$" | xargs kill 2>/dev/null || true',
        'sleep 1',
        // disown でバックグラウンドジョブを bash から切り離し、bash -c が即終了するようにする
        `cd "${dirname(agentIndex)}" ; nohup node "${agentIndex}" < /dev/null >> "${agentLogFile}" 2>&1 & disown`,
      ].join('; ');
    } else {
      actualRestartCmd = restartCmd.command;
    }

    // ビルド成否に関わらず、必ずリスタートを実行
    // セミコロンで分離し、ビルド失敗でも旧 dist/ コードで Agent を復帰させる
    const script = `${buildSteps}; ${log('restarting...')}; sleep 2; ${actualRestartCmd}`;

    const child = spawn('bash', ['-c', script], {
      detached: true,
      stdio: 'ignore',
      env: getExecEnv(),
    });
    child.on('error', (err) => {
      console.error(`❌ Update script spawn failed: ${err.message}`);
      updateStartedAt = 0;
      sendMessage({
        type: 'agent:update:status',
        payload: { machineId, status: 'error', error: `スクリプト起動失敗: ${err.message}` },
      });
    });
    child.unref();
  }

  console.log(`🔄 Update script spawned (detached). Agent will restart shortly.`);
}

/** ドキュメント保存ディレクトリ（~/.devrelay/docs/） */
function getDocsDir(): string {
  return join(getConfigDir(), 'docs');
}

/**
 * サーバーから送信されたドキュメントをローカルに保存
 * ファイル名にパストラバーサルが含まれる場合は拒否
 */
async function handleDocSync(payload: DocSyncPayload) {
  const { filename, content, mimeType } = payload;

  // パストラバーサル防止
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
    console.error(`❌ Doc sync rejected (unsafe filename): ${filename}`);
    return;
  }

  const docsDir = getDocsDir();
  await mkdir(docsDir, { recursive: true });
  const filePath = join(docsDir, filename);

  try {
    const buffer = Buffer.from(content, 'base64');
    await writeFile(filePath, buffer);
    console.log(`📁 Doc synced: ${filename} (${buffer.length} bytes) → ${filePath}`);
  } catch (err: any) {
    console.error(`❌ Doc sync failed for ${filename}:`, err.message);
  }
}

/**
 * サーバーから通知されたドキュメントをローカルから削除
 */
async function handleDocDelete(payload: DocDeletePayload) {
  const { filename } = payload;

  // パストラバーサル防止
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
    console.error(`❌ Doc delete rejected (unsafe filename): ${filename}`);
    return;
  }

  const filePath = join(getDocsDir(), filename);

  try {
    await unlink(filePath);
    console.log(`📁 Doc deleted: ${filename}`);
  } catch (err: any) {
    if (err.code !== 'ENOENT') {
      console.error(`❌ Doc delete failed for ${filename}:`, err.message);
    }
  }
}
