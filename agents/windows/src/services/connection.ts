import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import type { Agent } from 'http';
import {
  PROTOCOL_VERSION,
  AGENT_CAPABILITIES,
  shouldBypassProxy,
  tChat,
  DEFAULT_CHAT_LANGUAGE,
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
import { decideResume } from './resume-priority.js';
// 案C′ サイクルC1: resolveSessionStatePolicy() は第3区分（resumable-scoped）の許可リストを返す
// （サーバーが statePolicy を送らない限り isEphemeral の二値判定と完全に同じ結果になる）
import { isEphemeralSession, resolveSessionStatePolicy, isAiToolReadOnlyEnforceable } from './session-scope.js';
import { stripProgressMarkers } from './history-compaction.js';
import { loadClaudeSessionId, clearClaudeSessionId, clearDevinSessionId, clearDevinModel, clearDevinAtifStepOffset, clearDevinPermissionMode, clearCodexSessionId } from './session-store.js';
import { buildDevinPlanPreamble } from './devin-plan-prompt.js';
import { isGitRepo, captureBaseline, restoreToBaseline, type PorcelainEntry } from './git-guard.js';
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
// #291-B: コンテキスト使用率の予兆警告に使用（関数は既存・connection.ts からは未配線だった）
import { isContextWarning, type ContextUsage } from './output-parser.js';
import {
  enableSleepPrevention,
  disableSleepPrevention
} from './sleep-preventer.js';
import type { WorkState, WorkStateSavePayload, Language } from '@devrelay/shared';

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

// #291-B: コンテキスト使用率の警告閾値（%）。超過で `x` による履歴クリアを促し、1M 上限突破を予防する。
const CONTEXT_WARN_THRESHOLD = 85;
const CONTEXT_HARD_THRESHOLD = 95;

// Store session info for prompt handling
interface SessionInfo {
  projectPath: string;
  aiTool: AiTool;
  claudeSessionId: string; // UUID for Claude Code --session-id (legacy, not used with --resume)
  claudeResumeSessionId?: string; // Session ID from Claude Code for --resume
  history: ConversationEntry[]; // Conversation history (persisted to file)
  pendingWorkState?: WorkState; // Work state to include in next prompt
  contextWarned?: boolean; // #291-B: コンテキスト警告を既に送信済みか（スパム防止。閾値未満に戻ると解除）
  /** core#336: MCP submission 単位のスコープ識別子。指定時は `.devrelay/sessions/<agentScopeId>/` を使う（対話経路は未指定のまま = 従来どおり） */
  agentScopeId?: string;
  /**
   * 案C′ サイクルC1: 一時セッションの状態ポリシー（wire 上の `EphemeralStatePolicy` と同じ値）。
   * `server:session:start` で受け取った値を保持し、以降のターン（`server:ai:prompt`）で
   * payload 側が省略された場合のフォールバックに使う（`resolveSessionStatePolicy()` に渡す）。
   */
  statePolicy?: string;
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

    if (config.proxy?.url && shouldBypassProxy(config.serverUrl, config.proxy.noProxy)) {
      // noProxy に一致 → サーバー接続だけ直結する。社内に Server を置き AI API だけ
      // 社内プロキシ経由にする構成では、ここを直結にしないと接続できない
      // （社内プロキシは社内アドレスへ到達できないのが通常）。
      log.info(`Connecting to ${config.serverUrl} directly (noProxy match, proxy bypassed)...`);
    } else if (config.proxy?.url) {
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
          // raw-completion（実装プラン D4）: Windows Electron agent の ai-runner.ts は
          // @anthropic-ai/claude-agent-sdk を import しておらず claude CLI を直接 spawn する実装のため、
          // system prompt 完全置換を原理的に実装できない。「できないのに申告する」状態を避けるため、
          // capability 一覧から raw-completion を除外する（申告しなければサーバーは raw を投げない）。
          // サイクルS1: 同じ理由で plan-gate-hook も除外する（Agent SDK 非依存のため in-process
          // PreToolUse フックを実装できない。DevRelay のプランモード書き込みゲート自体は
          // windows でも `--permission-mode plan` + `--disallowedTools ExitPlanMode` で一定機能するが、
          // Bash の allowlist 強制（本サイクルの対象）は未対応のまま。サーバーはこの capability を
          // 見てクロスユーザー ask を未申告 Agent に対して断る）。
          capabilities: AGENT_CAPABILITIES.filter((c) => c !== 'raw-completion' && c !== 'plan-gate-hook'),
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

// #348: 一時セッション（ask-member/teamexec-member/askDesc）用の exec マーカー付与。
// disk I/O をせずメモリ内 history のみに追記する（agents/linux/src/services/connection.ts の写し）。
function markExecPointInMemory(history: ConversationEntry[]): ConversationEntry[] {
  return [...history, {
    role: 'exec',
    content: '--- EXEC: Implementation Started ---',
    timestamp: new Date().toISOString()
  }];
}

async function handleSessionStart(
  payload: { sessionId: string; projectName: string; projectPath: string; aiTool: AiTool; agentScopeId?: string; statePolicy?: string },
  config: AgentConfig
) {
  const { sessionId, projectName, projectPath, aiTool: requestedAiTool, agentScopeId } = payload;

  // #348: crossquery_/teamexec_/askdesc_ は一時セッション（projectPath 上の状態を読み書きしない）
  const isEphemeral = isEphemeralSession(sessionId);
  // 案C′ サイクルC1 + サイクルG: 一時セッションが projectPath 上の状態をどこまで読み書きしてよいか、
  // およびサーバーへの報告（Project.defaultAi）を触ってよいかの許可リスト。サーバーが
  // statePolicy を送らない限り（isolated 未配線の経路）、isEphemeral の二値判定と完全に同じ
  // 結果になる。resolveEffectiveAiTool のガードに使うため、それより前に計算する
  // （サイクルG: 計算順序を前倒し）。
  const statePolicy = resolveSessionStatePolicy(sessionId, { statePolicy: payload.statePolicy, agentScopeId });

  // Devin 専用端末等でサーバー指定の AI が未インストールなら、実際に使えるツールへ差し替える
  const aiTool = await resolveEffectiveAiTool(requestedAiTool, config);
  if (aiTool !== requestedAiTool) {
    log.info(`⚠️ AI ${requestedAiTool} not installed on this machine → using ${aiTool} instead`);
    // 2026-10-02 修正: 差し替えをサーバーへ報告する（既存の agent:session:aiTool メッセージ・
    // handleSessionAiTool() を利用）。これが無いと Session.aiTool / Project.defaultAi が
    // 要求値（例: claude）のまま残り、サーバーは要求ツール用のモデル設定を解決し続けてしまい、
    // 実際に動くツール（例: devin）へモデル未指定のまま渡ってしまう（組織 AI デフォルト無視事故）。
    // サイクルG: isolated（クロスユーザー ask）では報告しない — 他人の質問 1 通で所有者の
    // Project.defaultAi が書き換わる既存バグ（`handleSessionAiTool` 参照）を再発させないため。
    if (statePolicy.reportAiToolSubstitution) {
      sendMessage({
        type: 'agent:session:aiTool',
        payload: { machineId: config.machineId, sessionId, aiTool },
      });
    }
  }

  log.info(`Starting session: ${sessionId}`);
  log.info(`   Project: ${projectName} (${projectPath})`);
  log.info(`   AI Tool: ${aiTool}`);

  // Store current session state for auto-restore after reconnection
  currentProjectPath = projectPath;
  currentProjectName = projectName;

  // #348: 一時セッションは conversation.json を読まない（全セッション共有の resume/履歴汚染を防ぐ）
  // core#336: agentScopeId 指定時はスコープ専用ディレクトリを読む（対話経路は agentScopeId 未指定 = 従来どおり）
  // 案C′: resumable（statePolicy.scopedConversation）なら scope dir から読む
  const loadedHistory = statePolicy.scopedConversation ? await loadConversation(projectPath, agentScopeId) : [];
  // 案C′ 二段防御（④）: forcePlanTurn のときは load 時点で exec マーカーを取り除き、
  // isExecTriggered 系の判定（rescanProjectsAndSync 等）に一切影響させない。
  const history = statePolicy.forcePlanTurn ? loadedHistory.filter(h => h.role !== 'exec') : loadedHistory;

  // Check for pending work state (auto-continue feature)
  // G-2（Phase C 既存バグ修正、agents/linux と同一内容。byte-for-byte 同一を維持すること）:
  // 一時セッション（crossquery_ 等）は所有者の作業途中メモを読んではならない。無条件に読むと、
  // 借り手向けのプロンプトに所有者のメモが混入し（クロスユーザーのデータ露出）、かつ下の
  // handleAiPrompt 側で archiveWorkState() が呼ばれて所有者の auto-continue が消費されてしまう。
  // サイクルG（Q5）: 静的ガード（apps/server/tests/cross-team-chat-wiring.test.mjs）も
  // statePolicy.workState の判定へ更新したため、`isEphemeral` 直書きから切り替える
  // （legacy/resumable/isolated は全て workState:false のため挙動は不変）。
  const pendingWorkState = statePolicy.workState ? await loadWorkState(projectPath) : null;
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
  // #348: 一時セッションは resume しない（対話セッションと同じ --resume を共有すると輻輳の原因になる）
  // 案C′: resumable（statePolicy.scopedConversation）なら scope dir から resume できる
  const claudeResumeSessionId = statePolicy.scopedConversation ? await loadClaudeSessionId(projectPath, agentScopeId) : undefined;
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
    pendingWorkState: pendingWorkState || undefined,
    agentScopeId,
    statePolicy: payload.statePolicy
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

  // #348: 一時セッションは sessionInfoMap にも残さない（対話セッションと違い再接続で復元する必要がない）
  if (isEphemeralSession(sessionId)) {
    sessionInfoMap.delete(sessionId);
  }
}

function handleSessionRestored(payload: { sessionId: string; projectPath: string; chatId: string; platform: string }) {
  const { sessionId, projectPath, chatId, platform } = payload;
  log.info(`Session restored: ${sessionId}`);
  log.info(`   Project: ${projectPath}`);
  log.info(`   Chat: ${chatId} (${platform})`);
}

/**
 * スレッド管理 cycle2: `agentScopeId` を解決してそのスレッドの scope dir 配下だけをクリアする。
 * payload に `agentScopeId` が無い場合は sessionInfoMap に記録済みの値にフォールバックする
 * （旧サーバー × 新 Agent の組み合わせでも既定スレッドを巻き添えにしない防御）。
 * どちらも無ければ従来どおり `.devrelay/` 直下（既定スレッド）をクリアする。
 *
 * 例外安全: `resolveScopeDir()`（呼び出し先の各 clear/archive 関数経由）は不正な agentScopeId で
 * throw するが、このハンドラは await されずに呼ばれる（server:conversation:clear のディスパッチ側）ため、
 * 捕捉しないと unhandled rejection で Agent プロセスが落ちうる。必ず try/catch で囲む。
 */
export async function handleConversationClear(payload: { sessionId: string; projectPath: string; agentScopeId?: string }) {
  const { sessionId, projectPath } = payload;
  const agentScopeId = payload.agentScopeId ?? sessionInfoMap.get(sessionId)?.agentScopeId;
  log.info(`Clearing conversation for session ${sessionId} (scope: ${agentScopeId ?? 'default'})`);

  try {
    // 1. 現在の履歴をロードしてアーカイブ保存（アーカイブ先も scope 配下）
    const history = await loadConversation(projectPath, agentScopeId);
    if (history.length > 0) {
      await archiveConversation(projectPath, history, agentScopeId);
    }

    // 2. 会話履歴ファイルをクリア
    await clearConversation(projectPath, agentScopeId);

    // 3. Claude / Devin / Codex セッション ID をクリア（次回プロンプトで新規セッション開始）
    await clearClaudeSessionId(projectPath, agentScopeId);
    await clearDevinSessionId(projectPath, agentScopeId);
    await clearDevinModel(projectPath, agentScopeId);
    await clearDevinAtifStepOffset(projectPath, agentScopeId);
    await clearDevinPermissionMode(projectPath, agentScopeId);
    await clearCodexSessionId(projectPath, agentScopeId);

    // 4. メモリ内の履歴とセッション ID もクリア
    const sessionInfo = sessionInfoMap.get(sessionId);
    if (sessionInfo) {
      sessionInfo.history = [];
      sessionInfo.claudeResumeSessionId = undefined;
      log.info(`In-memory history and Claude session ID cleared for session ${sessionId}`);
    }
  } catch (err) {
    log.error(`Failed to clear conversation for session ${sessionId} (scope: ${agentScopeId ?? 'default'}):`, (err as Error).message);
  }
}

async function handleConversationExec(payload: { sessionId: string; projectPath: string; userId: string; prompt?: string; aiTool?: AiTool; model?: string; isWCommand?: boolean; language?: Language; agentScopeId?: string; resumeSessionId?: string; turnId?: string }) {
  const { sessionId, projectPath, userId, prompt: customPrompt } = payload;
  log.info(`Marking exec point for session ${sessionId}${customPrompt ? ` (custom prompt: ${customPrompt})` : ''}`);

  // #348: 一時セッションは exec マーカーも projectPath 上のファイルに書かない
  // （対話セッションと conversation.json を共有しているため、書くと相互汚染する）
  const isEphemeral = isEphemeralSession(sessionId);

  let sessionInfo = sessionInfoMap.get(sessionId);

  if (sessionInfo) {
    // #307: Server から aiTool が送られてきていて既存の sessionInfo と異なる場合は
    // DB (Session.aiTool) を正として上書きする（`a` での切り替え直後の exec 等）。
    if (payload.aiTool && payload.aiTool !== sessionInfo.aiTool && currentConfig) {
      const resolved = await resolveEffectiveAiTool(payload.aiTool, currentConfig);
      if (resolved !== sessionInfo.aiTool) {
        log.info(`[exec] aiTool synced from server: ${sessionInfo.aiTool} -> ${resolved}`);
        sessionInfo.aiTool = resolved;
      }
    }
    // core#336: sessionInfo が session:start より前（server restart 後の初回 exec 等）に生成されていて
    // agentScopeId が未設定のままの場合、exec の payload から後付けで補完する（Linux :809-811 の写し）
    if (payload.agentScopeId && !sessionInfo.agentScopeId) {
      sessionInfo.agentScopeId = payload.agentScopeId;
    }
    // Mark exec point in history (this becomes the reset point)
    sessionInfo.history = isEphemeral
      ? markExecPointInMemory(sessionInfo.history)
      : await markExecPoint(projectPath, sessionInfo.history, sessionInfo.agentScopeId);
    log.info(`Exec point marked, history now has ${sessionInfo.history.length} entries`);
  } else {
    // Session not in memory (e.g., after server restart), initialize from file
    log.info(`Session not found in memory, initializing from file...`);
    const history = isEphemeral ? [] : await loadConversation(projectPath, payload.agentScopeId);
    const claudeSessionId = uuidv4();
    // #307: Server から渡された aiTool（DB の Session.aiTool）を優先する。
    // ここでハードコードの config 既定値にフォールバックすると、`a` で選択した AI ツール
    // （例: Devin CLI）が Agent 再起動後の exec で無視され claude に戻ってしまう。
    const requestedAiTool: AiTool = payload.aiTool || currentConfig?.aiTools?.default || 'claude';
    const aiTool: AiTool = currentConfig
      ? await resolveEffectiveAiTool(requestedAiTool, currentConfig)
      : requestedAiTool;

    // Create session info and add to map
    sessionInfo = { projectPath, aiTool, claudeSessionId, history, agentScopeId: payload.agentScopeId };
    sessionInfoMap.set(sessionId, sessionInfo);
    log.info(`Session ${sessionId} initialized with ${history.length} history entries (aiTool=${aiTool})`);

    // Mark exec point in history
    sessionInfo.history = isEphemeral
      ? markExecPointInMemory(sessionInfo.history)
      : await markExecPoint(projectPath, sessionInfo.history, sessionInfo.agentScopeId);
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
    execPrompt,  // BuildLog AI 要約のコンテキスト用に exec プロンプトを伝搬
    model: payload.model,  // #309: AI モデル指定を継承（claude/codex/gemini/devin 共通）
    isWCommand: payload.isWCommand,  // #312: Codex w コマンドのサンドボックス切替判定に使用
    language: payload.language,  // #316: チャット表示言語を継承
    // core#336: MCP submission 単位のスコープ + resume 指定 + turnId を継承
    agentScopeId: sessionInfo?.agentScopeId ?? payload.agentScopeId,
    resumeSessionId: payload.resumeSessionId,
    turnId: payload.turnId,
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

async function handleAiPrompt(payload: { sessionId: string; prompt: string; userId: string; files?: FileAttachment[]; missedMessages?: MissedMessage[]; execPrompt?: string; model?: string; isWCommand?: boolean; language?: Language; agentScopeId?: string; resumeSessionId?: string; turnId?: string; forceNewSession?: boolean; statePolicy?: string }) {
  const { sessionId, prompt, userId, files, missedMessages, execPrompt: callerExecPrompt } = payload;
  // #348/案C′: 一時セッションが projectPath 上の状態をどこまで読み書きしてよいかは、
  // sessionInfo 確定後に statePolicy（resolveSessionStatePolicy）として解決する（下記参照）。
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

  // 案C′ サイクルC1: handleSessionStart が解決した statePolicy を引き継ぐ
  // （payload 側が省略された場合は sessionInfo に保存済みの値へフォールバックする）。
  const statePolicy = resolveSessionStatePolicy(sessionId, {
    statePolicy: payload.statePolicy ?? sessionInfo.statePolicy,
    agentScopeId: sessionInfo.agentScopeId,
  });

  // サイクルG（G-7 の一般化）: isolated（クロスユーザー ask）は、読み取り専用を権限で
  // 強制できない実効 AI（devin / gemini）への質問を AI を一切起動せずに拒否する。
  // Windows（Electron GUI 版）には terminalMode の概念が無いため常に false を渡す
  // （isAiToolReadOnlyEnforceable のシグネチャは 3 機種 byte-for-byte 同一を維持する）。
  // サーバー側（cross-ask-runner.ts/document-api.ts）の事前拒否が主防御、これは最後の砦のため
  // statePolicy 解決の直後・他の一時セッション副作用（saveReceivedFiles 以降）より前に置く。
  if (statePolicy.refuseUnsafeAiTool && !isAiToolReadOnlyEnforceable(sessionInfo.aiTool, false)) {
    log.info(`🚫 [isolated] Refusing cross-user ask: aiTool=${sessionInfo.aiTool} is not read-only enforceable`);
    sendMessage({
      type: 'agent:ai:output',
      payload: {
        machineId: currentConfig.machineId,
        sessionId,
        output: tChat(payload.language ?? DEFAULT_CHAT_LANGUAGE, 'ask.crossUserUnsafeAiRefused', { aiTool: sessionInfo.aiTool }),
        isComplete: true,
      },
    });
    return;
  }

  // Save received files and get their paths
  // サイクルG（G-4 相当）: isolated では所有者プロジェクトへの添付保存を一切行わない。
  let promptWithFiles = prompt;
  if (statePolicy.receivedFiles && files && files.length > 0) {
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
  // #348: 一時セッションは conversation.json を書かない（メモリ内 history のみで完結させる）
  // 案C′: resumable（statePolicy.scopedConversation）なら scope dir に書く
  if (statePolicy.scopedConversation) {
    await saveConversation(sessionInfo.projectPath, sessionInfo.history, sessionInfo.agentScopeId);
  }

  // Clear output directory before running
  // #348: 一時セッションは呼ばない（対話セッションが書きかけの .devrelay-output/ 成果物を
  // cross-query 開始のたびに rm -rf されてしまう事故を防ぐ）
  // 案C′: resumable でも outputDirClear は常に false（所有者プロジェクトへの副作用を一切許可しない）
  if (statePolicy.outputDirClear) {
    await clearOutputDir(sessionInfo.projectPath);
  }

  // Check if the last entry (before current user message) is an exec marker
  // This means exec was just sent, so this prompt should run in exec mode
  // After one exec-mode prompt, subsequent prompts return to plan mode
  const historyBeforeThisMessage = sessionInfo.history.slice(0, -1);
  const lastEntry = historyBeforeThisMessage[historyBeforeThisMessage.length - 1];
  const isExecTriggered = lastEntry?.role === 'exec';
  // Use CLI --permission-mode plan for plan mode, --dangerously-skip-permissions for exec mode
  // 案C′ 二段防御（④）: forcePlanTurn のときは履歴の exec マーカーを無視して plan ターンに固定する
  const isPlanTurn = statePolicy.forcePlanTurn ? true : !isExecTriggered;
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
  const modeInstruction = isPlanTurn ? PLAN_MODE_INSTRUCTION : EXEC_MODE_INSTRUCTION;

  // Load storage context if exists
  // サイクルG（G-3）: isolated では所有者の storage-context.md をプロンプトに注入しない
  // （クロスユーザーの情報漏れ）。同一ユーザーの ask（legacy）は既存どおり注入する。
  let storageContextPrompt = '';
  const storageContext = statePolicy.storageContext ? await loadStorageContext(sessionInfo.projectPath) : null;
  if (storageContext) {
    log.info(`Including storage context in prompt (${storageContext.length} chars)`);
    storageContextPrompt = '\n\n--- Storage Context ---\n' + storageContext + '\n--- End Storage Context ---';
  }

  // Devin 専用端末等でサーバー指定の AI が未インストールなら、実行直前に使えるツールへ差し替える
  // （新規セッションの defaultAi 継承や古い active セッションの再利用で claude が渡されるケースを救済）
  if (currentConfig) {
    const resolvedAiTool = await resolveEffectiveAiTool(sessionInfo.aiTool, currentConfig);
    if (resolvedAiTool !== sessionInfo.aiTool) {
      log.info(`⚠️ AI ${sessionInfo.aiTool} not installed on this machine → using ${resolvedAiTool} instead`);
      sessionInfo.aiTool = resolvedAiTool;
      // 2026-10-02 修正: handleSessionStart と同じ理由でサーバーへ報告する（既存の
      // agent:session:aiTool メッセージを利用。Session.aiTool / Project.defaultAi を実態に揃える）
      // サイクルG: isolated では報告しない（所有者の Project.defaultAi を書き換えないため）。
      if (statePolicy.reportAiToolSubstitution) {
        sendMessage({
          type: 'agent:session:aiTool',
          payload: { machineId: currentConfig.machineId, sessionId, aiTool: resolvedAiTool },
        });
      }
    }
  }

  // サイクルG: 直前の実行直前差し替えで実効 AI が変わった場合の二段目の拒否チェック
  // （冒頭の判定は handleSessionStart 時点の aiTool を見ているため、ここで初めて devin 等へ
  // 化けるケースを取り落とさないための最後の砦）。AI プロセスはまだ起動していない。
  if (statePolicy.refuseUnsafeAiTool && !isAiToolReadOnlyEnforceable(sessionInfo.aiTool, false)) {
    log.info(`🚫 [isolated] Refusing cross-user ask after late aiTool substitution: aiTool=${sessionInfo.aiTool}`);
    sendMessage({
      type: 'agent:ai:output',
      payload: {
        machineId: currentConfig!.machineId,
        sessionId,
        output: tChat(payload.language ?? DEFAULT_CHAT_LANGUAGE, 'ask.crossUserUnsafeAiRefused', { aiTool: sessionInfo.aiTool }),
        isComplete: true,
      },
    });
    return;
  }

  // #368 Phase2a-C: Devin はプランモードを使わない（常に dangerous で起動し、
  // プランの規律は前置きプロンプト、安全性は git 自動復元ガードで担保する）
  const isDevin = sessionInfo.aiTool === 'devin';
  const usePlanMode = isPlanTurn && !isDevin;
  const devinPlanPreamble = isDevin && isPlanTurn ? buildDevinPlanPreamble() : '';
  const effectiveModeInstruction = devinPlanPreamble
    ? `${devinPlanPreamble}\n\n${modeInstruction}`
    : modeInstruction;

  // 会話履歴のサイズを記録（ログ出力用）
  let historyContextSize = 0;

  // #291-A: fullPrompt 構築を関数化。retry-without-resume 時に履歴（＝プラン）を再注入するため
  // includeHistory を切り替えられるようにする。
  // - includeHistory=false: プラン無し（Claude SDK の --resume 依存の通常経路。挙動不変）
  // - includeHistory=true : exec マーカー直前のプランを含む会話履歴を注入
  // 履歴注入の判定条件（元コードと同一）:
  //   1. Claude: resumeSessionId がない（SDK の --resume でセッション引き継ぎするため通常は不要）
  //   2. Claude: missed messages がある（SDK 内部履歴にない新規メッセージ）
  //   3. 非 Claude（Devin/Gemini 等）: 常に含める（--resume が効かずプロンプトが唯一のコンテキスト）
  // 案C′: resumable では OUTPUT_DIR_INSTRUCTION（成果物を .devrelay-output/ に置くよう AI へ促す
  // 文言）を付与しない（所有者プロジェクトへの書き込みを AI に勧める必要が無く、strictReadonly の
  // 無駄な deny ログを避けるため）。resumable 以外（現状の全経路）は従来どおり常に付与する。
  const outputDirInstructionText = statePolicy.outputDirInstruction ? OUTPUT_DIR_INSTRUCTION : '';
  const composeFullPrompt = (includeHistory: boolean): string => {
    const basePrompt = effectiveModeInstruction + '\n\n' + promptWithFiles + workStatePrompt + storageContextPrompt + outputDirInstructionText;
    if (!(sessionInfo.history.length > 1 && includeHistory)) {
      historyContextSize = 0;
      return basePrompt;
    }
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
    return `${effectiveModeInstruction}\n\nPrevious conversation:\n${historyContext}\n\nUser: ${promptWithFiles}${workStatePrompt}${outputDirInstructionText}`;
  };

  const hasMissedMessages = missedMessages && missedMessages.length > 0;
  const isClaudeSdk = sessionInfo.aiTool === 'claude';
  const needsHistoryInPrompt = !isClaudeSdk || !sessionInfo.claudeResumeSessionId || hasMissedMessages;
  // 通常実行は従来どおり（needsHistoryInPrompt に従う）。挙動は不変。
  let fullPrompt = composeFullPrompt(!!needsHistoryInPrompt);

  // #291-B: コンテキスト使用率が閾値超過なら1回だけ警告（x で履歴クリア誘導）。
  // 使用率が閾値未満に戻ったら（x 後など）フラグをリセットして再警告を許可する。
  const maybeWarnContext = (usage?: ContextUsage): void => {
    if (!usage) return;
    if (isContextWarning(usage, CONTEXT_WARN_THRESHOLD)) {
      if (sessionInfo.contextWarned) return; // 既に警告済みならスパム防止
      sessionInfo.contextWarned = true;
      const isHard = usage.percentage >= CONTEXT_HARD_THRESHOLD;
      const warnBody = isHard
        ? `⚠️ コンテキスト ${usage.percentage}%（上限間近）。次の指示で上限超過・応答劣化の恐れがあります。今すぐ \`x\` で履歴をクリアしてください（作業状況は CLAUDE.md に記録済みか確認）。`
        : `⚠️ コンテキスト ${usage.percentage}%。作業状況を CLAUDE.md に記録し、\`x\` で履歴クリアを推奨します。`;
      sendMessage({
        type: 'agent:ai:output',
        payload: {
          machineId: currentConfig!.machineId,
          sessionId,
          output: warnBody,
          isComplete: false,
        },
      });
      log.warn(`Context warning sent (${usage.percentage}%, hard=${isHard})`);
    } else if (usage.percentage < CONTEXT_WARN_THRESHOLD && sessionInfo.contextWarned) {
      sessionInfo.contextWarned = false;
    }
  };

  // プロンプトサイズの詳細ログ（原因特定用）
  log.info(`Prompt size breakdown:`);
  log.info(`   - Mode instruction: ${modeInstruction.length} chars`);
  log.info(`   - User prompt: ${promptWithFiles.length} chars`);
  log.info(`   - Work state: ${workStatePrompt.length} chars`);
  log.info(`   - Storage context: ${storageContextPrompt.length} chars`);
  log.info(`   - Output instruction: ${outputDirInstructionText.length} chars`);
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

  // core#336: サーバーが明示指定した resumeSessionId（MCP approve_implementation 等）を最優先とし、
  // forceNewSession 指定時は resume させず、それ以外は従来どおりストア済みセッション ID を使う。
  const resumeDecision = decideResume({
    explicitResumeSessionId: payload.resumeSessionId,
    forceNewSession: payload.forceNewSession,
    storedSessionId: sessionInfo.claudeResumeSessionId,
  });
  const effectiveResumeSessionId = resumeDecision.resumeSessionId;

  // Prepare send options
  const sendOptions: SendPromptOptions = {
    resumeSessionId: effectiveResumeSessionId,
    // 2026-10-27 サイクル2（D2、plan→exec resume）: gemini 分岐は resumeSource === 'explicit'
    // （サーバーが approve_implementation 等で明示指定した ID）のときのみ --resume に使う。
    // claude/codex/devin は resumeSessionId のみ参照し resumeSource を見ないため無影響。
    resumeSource: resumeDecision.source,
    usePlanMode,
    allowedTools: usePlanMode ? (serverAllowedTools ?? DEFAULT_ALLOWED_TOOLS_WINDOWS) : undefined,
    model: payload.model,  // #309: AI モデル指定（claude/codex/gemini/devin 共通、l コマンド／Settings で設定）
    isWCommand: payload.isWCommand,  // #312: Codex の w コマンドのみ danger-full-access に切り替える
    language: payload.language,  // #316: チャット表示言語（'en' の場合のみ AI への英語応答指示が付与される）
    // #348: 一時セッションは claude-session-id / context-usage を projectPath 上に書かない
    // 案C′: resumable（statePolicy.scopedConversation）なら scope dir には書いてよい
    persistProjectState: statePolicy.scopedConversation,
    // サイクルG（G-5b）: Codex/Devin のセッション ID 等の読み出しを許可するか
    // （書き込み・削除は persistProjectState が別途ガードする。既存の仕組みと対にする）
    projectStateRead: statePolicy.projectStateRead,
    // core#336: MCP submission 単位のスコープ配線
    agentScopeId: sessionInfo.agentScopeId,
    turnId: payload.turnId,
    forceNewSession: payload.forceNewSession,
  };

  // #368 Phase2a-C: Devin のプランターンのみ、ターン前の作業ツリー状態を記録する。
  // dangerous で走らせる代わりに、書き込みが起きたらターン後に自動で巻き戻す。
  const lang = payload.language ?? DEFAULT_CHAT_LANGUAGE;
  const sendGuardNotice = (output: string) => sendMessage({
    type: 'agent:ai:output',
    payload: {
      machineId: currentConfig!.machineId,
      sessionId,
      output,
      isComplete: false,
    },
  });
  let devinGuardBaseline: PorcelainEntry[] | null = null;
  if (isDevin && isPlanTurn) {
    if (await isGitRepo(sessionInfo.projectPath)) {
      devinGuardBaseline = await captureBaseline(sessionInfo.projectPath);
    } else {
      // 静かなフォールバック禁止（#325）: ガードが効かないことを必ず可視化する
      sendGuardNotice(tChat(lang, 'devin.planGuardUnavailable', { path: sessionInfo.projectPath }));
    }
  }

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
      async (output, isComplete, usageData, extractedSessionId) => {
        // #276: ⏳ 始まりは進捗専用チャンク。サーバーへは流す（進捗ボックス表示 + タイムアウトリセット）が、
        // 最終保存メッセージ responseText には含めない（最終回答の汚染防止）。
        if (!output.startsWith('⏳')) {
          responseText += output;
        }

        if (isComplete) {
          // 二重完了送信を防止（DB に重複 Message が作成されるのを防ぐ）
          if (completionSent) {
            log.info(`Duplicate completion ignored for session ${sessionId}`);
            return;
          }
          completionSent = true;

          // Collect files from the output directory
          // サイクルG（G-4）: isolated では所有者の .devrelay-output/ を一切添付しない
          // （クロスユーザーの成果物漏洩。同一ユーザー ask は既存どおり添付する）。
          const files = statePolicy.outputFileCollect ? await collectOutputFiles(sessionInfo.projectPath) : [];
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
              // core#336: server が Session.planAiSessionId を紐付けるためのエコーバック。
              // aiResult.extractedSessionId を直接参照すると TDZ エラーになるためコールバック引数を使う。
              aiSessionId: extractedSessionId,
              aiTool: sessionInfo.aiTool,
              turnId: payload.turnId,
            },
          });

          // Save response to history and persist to file
          // #348: 一時セッションは conversation.json を書かない（メモリ内 history のみで完結させる）
          if (responseText.trim()) {
            sessionInfo.history.push({
              role: 'assistant',
              // #372: 進捗マーカー（🔧 ...を使用中...）は表示用の装飾で、次ターンの文脈としては
              // 価値ゼロなのに conversation.json を肥大させていた。保存時に落とす。
              // 全文が進捗マーカーだった場合だけ従来どおり原文を残す（空文字を保存しない）。
              content: stripProgressMarkers(responseText).trim() || responseText.trim(),
              timestamp: new Date().toISOString()
            });
            // 案C′: resumable（statePolicy.scopedConversation）なら scope dir に書く
            if (statePolicy.scopedConversation) {
              await saveConversation(sessionInfo.projectPath, sessionInfo.history, sessionInfo.agentScopeId);
              log.info(`Conversation saved (${sessionInfo.history.length} messages)`);
            }
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
      // #348: 一時セッションは projectPath 上の claude-session-id ファイルを消さない
      // （そもそも読んでいないため = undefined のはずだが、念のため書き込み経路も揃えておく）
      // 案C′: resumable（statePolicy.scopedConversation）なら scope dir のファイルは消してよい
      if (statePolicy.scopedConversation) {
        await clearClaudeSessionId(sessionInfo.projectPath, sessionInfo.agentScopeId);
      }

      // Retry without resume session ID（completionSent をリセットして retry の完了を受け付ける）
      responseText = '';
      completionSent = false;
      const retryOptions: SendPromptOptions = {
        resumeSessionId: undefined,  // Don't use --resume
        usePlanMode,
        model: payload.model,  // #309: AI モデル指定を retry でも維持
        language: payload.language,  // #316: チャット表示言語を retry でも維持
        // #348: persistProjectState も retry で引き継ぐ
        persistProjectState: sendOptions.persistProjectState,
        // サイクルC2（A-2）: projectStateRead が retry で引き継がれていなかった既存バグの修正。
        // 未指定だと ai-runner.ts 側で `!== false` 判定により true 扱いになり、isolated
        // （projectStateRead:false）のターンが resume 失敗 retry に入った際に Codex/Devin の
        // セッション状態読み出しガードが外れてしまう（agentScopeId が無指定だと
        // resolveScopeDir() が所有者の projectPath 直下を指すため実害になる）。
        projectStateRead: sendOptions.projectStateRead,
        // core#336: 1ターンの前半（--resume 失敗）と後半（retry）で保存先スコープが割れないよう継承する
        agentScopeId: sendOptions.agentScopeId,
        turnId: sendOptions.turnId,
        // Linux パリティ追加（Windows のみ継承漏れがあり、plan ターンの retry で読み取りツールが
        // 全て失われる既存欠陥。forceNewSession は Linux も継承しないため意図的に含めない）
        allowedTools: sendOptions.allowedTools,
        // 2026-10-27 サイクル2（D2）: resumeSource は意図的に渡さない（undefined = 新規セッション扱い）。
        // resumeSessionId: undefined と対で、gemini 分岐が壊れた ID を --resume に使わないようにする。
      };

      // #291-A: retry は --resume を捨てるため、履歴（＝プラン）を含めて再構築する。
      // 通常経路で needsHistoryInPrompt=false（resume 依存）だとプランが resume 内にしか無く、
      // resume 破棄で失われる（=「プランの内容が見当たりません」で停止）。ここで
      // composeFullPrompt(true) により exec マーカー直前のプランを再注入し、新セッションでも保持する。
      const retryPrompt = composeFullPrompt(true);
      log.info(`Retry prompt size: ${retryPrompt.length} chars (history context: ${historyContextSize} chars)`);

      const retryResult = await sendPromptToAi(
        sessionId,
        retryPrompt,
        sessionInfo.projectPath,
        sessionInfo.aiTool,
        sessionInfo.claudeSessionId,
        currentConfig,
        async (output, isComplete, usageData, extractedSessionId) => {
          // #276: ⏳ 始まりは進捗専用チャンク（最終保存メッセージには含めない）。
          if (!output.startsWith('⏳')) {
            responseText += output;
          }

          if (isComplete) {
            if (completionSent) {
              log.info(`Duplicate completion ignored for retry session ${sessionId}`);
              return;
            }
            completionSent = true;

            // サイクルG（G-4）: isolated では所有者の .devrelay-output/ を一切添付しない。
            const files = statePolicy.outputFileCollect ? await collectOutputFiles(sessionInfo.projectPath) : [];
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
                // core#336: server が Session.planAiSessionId を紐付けるためのエコーバック。
                // retryResult.extractedSessionId を直接参照すると TDZ エラーになるためコールバック引数を使う。
                aiSessionId: extractedSessionId,
                aiTool: sessionInfo.aiTool,
                turnId: payload.turnId,
              },
            });

            // #348: 一時セッションは conversation.json を書かない（メモリ内 history のみで完結させる）
            if (responseText.trim()) {
              sessionInfo.history.push({
                role: 'assistant',
                // #372: 進捗マーカーを落として保存（上の通常経路と同じ理由）
                content: stripProgressMarkers(responseText).trim() || responseText.trim(),
                timestamp: new Date().toISOString()
              });
              // 案C′: resumable（statePolicy.scopedConversation）なら scope dir に書く
              if (statePolicy.scopedConversation) {
                await saveConversation(sessionInfo.projectPath, sessionInfo.history, sessionInfo.agentScopeId);
                log.info(`Conversation saved (${sessionInfo.history.length} messages)`);
              }
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
      // #291-B: retry 後のコンテキスト使用率を評価して警告
      maybeWarnContext(retryResult.contextUsage);
      return;
    }

    // Update session info with new Claude session ID if extracted
    if (aiResult.extractedSessionId) {
      sessionInfo.claudeResumeSessionId = aiResult.extractedSessionId;
      log.info(`Updated Claude session ID: ${aiResult.extractedSessionId.substring(0, 8)}...`);
    }
    // #291-B: 通常実行後のコンテキスト使用率を評価して警告
    maybeWarnContext(aiResult.contextUsage);
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
  } finally {
    if (devinGuardBaseline) {
      const r = await restoreToBaseline(sessionInfo.projectPath, devinGuardBaseline);
      if (r.restored.length || r.quarantined.length) {
        sendGuardNotice(tChat(lang, 'devin.planGuardRestored', {
          restored: r.restored.length, quarantined: r.quarantined.length, dir: '.devrelay/reverted/',
        }));
      }
      if (r.failed.length) {
        sendGuardNotice(tChat(lang, 'devin.planGuardFailed', {
          failed: r.failed.length, detail: r.failed.slice(0, 3).join(', '),
        }));
      }
    }
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

/**
 * サーバー指定の AI ツールが実際にはこの端末に入っていない場合に、
 * 利用可能なツールへ差し替える（Devin 専用端末で claude が要求されて
 * 「Claude Code 未ログイン」で止まる問題の救済）。
 * - 指定ツールがインストール済み → そのまま尊重（claude ログイン切れ等はここでは触らない）
 * - 未インストール → 最後に手動選択したツール → config 既定 → 先頭の利用可能ツール の順で採用
 */
async function resolveEffectiveAiTool(requested: AiTool, config: AgentConfig): Promise<AiTool> {
  const available = getAvailableAiTools(config);
  if (available.length === 0) return requested;        // 何も入っていない → 従来どおり（エラー表示）
  if (available.includes(requested)) return requested; // 指定ツールは実在 → 尊重
  const last = await loadLastAiTool();
  if (last && available.includes(last)) return last;
  if (config.aiTools.default && available.includes(config.aiTools.default)) return config.aiTools.default;
  return available[0];
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
