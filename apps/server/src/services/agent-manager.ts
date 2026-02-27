import type { WebSocket } from 'ws';
import type { FastifyRequest } from 'fastify';
import type {
  AgentMessage,
  ServerToAgentMessage,
  Machine,
  Project,
  AiTool,
  FileAttachment,
  WorkState,
  AiListResponsePayload,
  AiSwitchedPayload
} from '@devrelay/shared';
import { prisma } from '../db/client.js';
import { appendSessionOutput, finalizeProgress, broadcastToSession, clearSessionsForMachine, restoreSessionParticipantsForMachine } from './session-manager.js';
import { summarizeBuildOutput } from './build-summarizer.js';
import { buildAgreementApplyPrompt } from './agreement-template.js';

// Connected agents: machineId -> WebSocket
const connectedAgents = new Map<string, WebSocket>();

// Machine info cache: machineId -> Machine
const machineCache = new Map<string, Machine>();

// Pending history requests: requestId -> { resolve, reject, timeout }
interface HistoryRequest<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}
const pendingHistoryDatesRequests = new Map<string, HistoryRequest<string[]>>();
const pendingHistoryExportRequests = new Map<string, HistoryRequest<string>>();

// AI tool list/switch requests
const pendingAiListRequests = new Map<string, HistoryRequest<AiListResponsePayload>>();
const pendingAiSwitchRequests = new Map<string, HistoryRequest<AiSwitchedPayload>>();

// Heartbeat: メモリ内で lastSeenAt を管理し、60秒ごとにまとめて DB 更新（バッチ化）
const lastSeenMap = new Map<string, Date>();

// Agent 再接続フラグ: Agent が再接続した machineId を記録
// 再接続後の最初のプロンプトでセッション再開始が必要かを判定するために使用
const needsSessionRestart = new Set<string>();

export function setupAgentWebSocket(connection: { socket: WebSocket }, req: FastifyRequest) {
  const ws = connection.socket;
  let machineId: string | null = null;

  console.log('🔌 New agent connection attempt');

  ws.on('message', async (data) => {
    try {
      const message: AgentMessage = JSON.parse(data.toString());

      switch (message.type) {
        case 'agent:connect':
          await handleAgentConnect(ws, message.payload);
          machineId = message.payload.machineId;
          break;

        case 'agent:disconnect':
          await handleAgentDisconnect(message.payload.machineId, ws);
          break;

        case 'agent:projects':
          await handleProjectsUpdate(message.payload.machineId, message.payload.projects);
          break;

        case 'agent:ai:output':
          await handleAiOutput(message.payload);
          break;

        case 'agent:ai:status':
          await handleAiStatus(message.payload);
          break;

        case 'agent:storage:saved':
          await handleStorageSaved(message.payload);
          break;

        case 'agent:ping':
          await handleAgentPing(ws, message.payload);
          break;

        case 'agent:session:restore':
          await handleSessionRestore(ws, message.payload);
          break;

        case 'agent:history:dates':
          await handleHistoryDates(message.payload);
          break;

        case 'agent:history:export':
          await handleHistoryExport(message.payload);
          break;

        case 'agent:ai:list':
          await handleAgentAiList(message.payload);
          break;

        case 'agent:ai:switched':
          await handleAgentAiSwitched(message.payload);
          break;

        case 'agent:session:aiTool':
          await handleSessionAiTool(message.payload);
          break;
      }
    } catch (err) {
      console.error('Error processing agent message:', err);
    }
  });

  ws.on('close', async () => {
    if (machineId) {
      await handleAgentDisconnect(machineId, ws);
      console.log(`🔌 Agent disconnected: ${machineId}`);
    }
  });

  ws.on('error', (err) => {
    console.error('Agent WebSocket error:', err);
  });
}

// -----------------------------------------------------------------------------
// Handlers
// -----------------------------------------------------------------------------

async function handleAgentConnect(
  ws: WebSocket,
  payload: { machineId: string; machineName: string; token: string; projects: Project[]; availableAiTools: AiTool[]; managementInfo?: any }
) {
  const { machineId, machineName, token, projects, availableAiTools, managementInfo } = payload;

  // Verify token
  const machine = await prisma.machine.findUnique({
    where: { token }
  });

  if (!machine) {
    sendToAgent(ws, {
      type: 'server:connect:ack',
      payload: { success: false, error: 'Invalid token' }
    });
    ws.close();
    return;
  }

  // Agent から送信された machineName で DB の名前を自動更新する条件:
  // 1. 仮名（agent-N）→ 正式名への更新（初回接続時）
  // 2. 旧形式（hostname のみ）→ 新形式（hostname/username）への自動マイグレーション
  //    例: DB "DESKTOP-Q43QT7L" + Agent "DESKTOP-Q43QT7L/fwjg2" → 更新
  //    ユーザーが手動で別名に設定した場合は上書きしない（hostname が一致しないため）
  let updatedName = machine.name;
  const trimmedName = machineName?.trim();
  if (trimmedName && trimmedName.length > 0 && trimmedName !== machine.name) {
    const isProvisional = machine.name.startsWith('agent-');
    // 旧形式判定: Agent が hostname/username で送信し、DB の名前が hostname 部分と一致
    const isOldFormat = trimmedName.includes('/') && machine.name === trimmedName.split('/')[0];

    if (isProvisional || isOldFormat) {
      // 同じユーザーに同名の Agent が既にないか確認（重複防止）
      const duplicate = await prisma.machine.findFirst({
        where: { userId: machine.userId, name: trimmedName, id: { not: machine.id } },
      });
      if (!duplicate) {
        updatedName = trimmedName;
      }
    }
  }

  // マシン状態を更新（仮名の場合は名前も更新、管理コマンド情報も保存）
  await prisma.machine.update({
    where: { id: machine.id },
    data: {
      status: 'online',
      lastSeenAt: new Date(),
      name: updatedName,
      ...(managementInfo ? { managementInfo } : {}),
    }
  });

  // Update projects
  for (const project of projects) {
    await prisma.project.upsert({
      where: {
        machineId_name: { machineId: machine.id, name: project.name }
      },
      update: { path: project.path, defaultAi: project.defaultAi },
      create: {
        machineId: machine.id,
        name: project.name,
        path: project.path,
        defaultAi: project.defaultAi
      }
    });
  }

  // 同じホスト名を持つ兄弟マシンから displayName を自動計算
  // 例: 兄弟マシン "x220/user1" に displayName "vps-prod/user1" がある場合、
  // 新しいマシン "x220/user2" には "vps-prod/user2" を自動設定
  let autoDisplayName = machine.displayName;
  if (!autoDisplayName && updatedName.includes('/')) {
    const hostname = updatedName.split('/')[0];
    const username = updatedName.split('/').slice(1).join('/');

    // 同じユーザーの同じホスト名の兄弟マシンで displayName が設定されているものを検索
    const sibling = await prisma.machine.findFirst({
      where: {
        userId: machine.userId,
        name: { startsWith: `${hostname}/` },
        displayName: { not: null },
        id: { not: machine.id },
      },
      select: { displayName: true },
    });

    if (sibling?.displayName) {
      // 兄弟の displayName からエイリアス部分を抽出して新しい displayName を構築
      const siblingAlias = sibling.displayName.split('/')[0];
      autoDisplayName = `${siblingAlias}/${username}`;

      // DB に保存
      await prisma.machine.update({
        where: { id: machine.id },
        data: { displayName: autoDisplayName },
      });
    }
  }

  // Store connection
  connectedAgents.set(machine.id, ws);
  machineCache.set(machine.id, {
    id: machine.id,
    name: updatedName,
    displayName: autoDisplayName,
    status: 'online',
    lastSeen: new Date(),
    projects
  });

  sendToAgent(ws, {
    type: 'server:connect:ack',
    payload: { success: true, machineId: machine.id }
  });

  console.log(`✅ Agent connected: ${updatedName} (${machine.id})`);

  // Agent再接続時にセッション参加者を復元（切断前のセッションを継続可能にする）
  await restoreSessionParticipantsForMachine(machine.id);

  // Agent 再接続フラグを設定（次回プロンプト時にセッション再開始が必要）
  // Agent 再起動で sessionInfoMap がクリアされるため、server:session:start の再送が必要
  needsSessionRestart.add(machine.id);
}

/**
 * Agent 切断時の処理
 * pm2 restart 時などに旧接続の close イベントが新接続の後に遅延発火する場合があるため、
 * 切断された WebSocket が現在の接続と同一かを確認し、異なればスキップする（Race Condition 防止）
 *
 * @param machineId 切断された Agent のマシンID
 * @param disconnectedWs 切断された WebSocket インスタンス（close イベントから渡される）
 */
async function handleAgentDisconnect(machineId: string, disconnectedWs?: WebSocket) {
  // 既に新しい接続に差し替わっている場合は、古い接続の切断として扱いスキップ
  const currentWs = connectedAgents.get(machineId);
  if (disconnectedWs && currentWs && currentWs !== disconnectedWs) {
    console.log(`🔌 Stale connection closed for ${machineId} (new connection already active), skipping disconnect`);
    return;
  }

  connectedAgents.delete(machineId);
  machineCache.delete(machineId);

  try {
    await prisma.machine.update({
      where: { id: machineId },
      data: { status: 'offline' }
    });
  } catch (err) {
    // Machine may not exist in DB (e.g., already deleted)
    console.log(`⚠️ Could not update machine status for ${machineId}:`, err);
  }

  // Clear any active sessions for this machine
  await clearSessionsForMachine(machineId);
}

async function handleProjectsUpdate(machineId: string, projects: Project[]) {
  const cached = machineCache.get(machineId);
  if (cached) {
    cached.projects = projects;
  }

  // Update DB
  for (const project of projects) {
    await prisma.project.upsert({
      where: {
        machineId_name: { machineId, name: project.name }
      },
      update: { path: project.path, defaultAi: project.defaultAi },
      create: {
        machineId,
        name: project.name,
        path: project.path,
        defaultAi: project.defaultAi
      }
    });
  }
}

async function handleAiOutput(payload: { machineId: string; sessionId: string; output: string; isComplete: boolean; files?: FileAttachment[]; usageData?: any; isExec?: boolean; execPrompt?: string }) {
  const { sessionId, output, isComplete, files, usageData, isExec, execPrompt } = payload;

  console.log(`📥 AI Output received: isComplete=${isComplete}, length=${output.length}${isExec ? ' [EXEC]' : ''}`);

  if (isComplete) {
    // Save final output to DB（usageData がある場合は JSON として保存）
    await prisma.message.create({
      data: {
        sessionId,
        role: 'ai',
        content: output,
        platform: 'system',
        usageData: usageData ?? undefined,
      }
    });
    if (usageData) {
      const models = usageData.modelUsage ? Object.keys(usageData.modelUsage).join(', ') : 'unknown';
      console.log(`💾 Usage data saved: duration=${usageData.durationMs}ms, models=${models}`);
    }

    // BuildLog: exec 実行完了時にビルドログを自動作成
    // フォールバックサマリー（先頭200文字）で即座に作成し、
    // 非同期で AI 要約を生成して DB を上書きする（fire-and-forget）
    if (isExec && output.trim()) {
      try {
        const session = await prisma.session.findUnique({
          where: { id: sessionId },
          include: { project: true },
        });

        if (session) {
          // フォールバックサマリーで即座に BuildLog 作成（ユーザー応答を遅延させない）
          const fallbackSummary = extractBuildSummary(output);
          const buildNumber = await createBuildLog({
            projectName: session.project.name,
            projectId: session.projectId,
            machineId: session.machineId,
            sessionId,
            userId: session.userId,
            summary: fallbackSummary,
            prompt: execPrompt,
          });
          console.log(`📋 BuildLog #${buildNumber} created for ${session.project.name}`);

          // AI 要約を非同期で生成し、完了後に DB を更新（fire-and-forget）
          updateBuildLogSummaryAsync(
            session.project.name,
            buildNumber,
            session.userId,
            output,
            execPrompt,
          );
        }
      } catch (err) {
        console.error('❌ Failed to create BuildLog:', (err as Error).message);
      }
    }

    // Log files if present
    if (files && files.length > 0) {
      console.log(`📎 Received ${files.length} file(s) from agent for session ${sessionId}`);
    }

    // Finalize progress with final message
    await finalizeProgress(sessionId, output, files);
  } else {
    // Append partial output to progress buffer
    appendSessionOutput(sessionId, output);
  }
}

/**
 * AI 応答テキストからビルドサマリーを抽出する
 * Markdown 装飾を除去し、先頭 maxLength 文字を取得
 */
function extractBuildSummary(output: string, maxLength: number = 200): string {
  let text = output;

  // contextInfo 行を除去（📊, 📝 で始まる行）
  text = text.replace(/^[📊📝].+\n?/gm, '');

  // Markdown 見出しを除去（# ## ### など）
  text = text.replace(/^#{1,6}\s+/gm, '');

  // コードブロックを除去
  text = text.replace(/```[\s\S]*?```/g, '[code]');

  // Markdown の太字・斜体を除去
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1');
  text = text.replace(/\*([^*]+)\*/g, '$1');

  // 連続する空白行を1行に圧縮
  text = text.replace(/\n{3,}/g, '\n\n');

  // 先頭の空白行を除去
  text = text.trimStart();

  // 指定文字数で切り詰め
  if (text.length > maxLength) {
    text = text.substring(0, maxLength) + '...';
  }

  return text;
}

/**
 * BuildLog の summary を AI 要約で非同期更新する（fire-and-forget）
 *
 * API 呼び出しに失敗しても、既にフォールバックサマリーが保存されているため
 * ユーザーへの影響はない。エラーはログ出力のみ。
 */
async function updateBuildLogSummaryAsync(
  projectName: string,
  buildNumber: number,
  userId: string,
  output: string,
  execPrompt?: string,
): Promise<void> {
  try {
    const aiSummary = await summarizeBuildOutput(userId, output, execPrompt);
    if (aiSummary) {
      await prisma.buildLog.update({
        where: {
          projectName_buildNumber: { projectName, buildNumber },
        },
        data: { summary: aiSummary },
      });
      console.log(`📋 BuildLog #${buildNumber} summary updated with AI: ${aiSummary}`);
    }
  } catch (err) {
    // fire-and-forget: エラーをログに出すだけ（フォールバックサマリーが残る）
    console.error(`⚠️ Failed to update BuildLog #${buildNumber} summary:`, (err as Error).message);
  }
}

/**
 * BuildLog レコードを作成する
 * projectName ごとの連番 buildNumber をトランザクション内で採番
 * @@unique 制約違反（レースコンディション）時は最大3回リトライ
 */
async function createBuildLog(params: {
  projectName: string;
  projectId: string;
  machineId: string;
  sessionId: string;
  userId: string;
  summary: string;
  prompt?: string;
}): Promise<number> {
  const MAX_RETRIES = 3;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const result = await prisma.$transaction(async (tx) => {
        // 同一 projectName の最大 buildNumber を取得
        const latest = await tx.buildLog.findFirst({
          where: { projectName: params.projectName },
          orderBy: { buildNumber: 'desc' },
          select: { buildNumber: true },
        });

        const nextBuildNumber = (latest?.buildNumber ?? 0) + 1;

        const log = await tx.buildLog.create({
          data: {
            buildNumber: nextBuildNumber,
            projectName: params.projectName,
            projectId: params.projectId,
            machineId: params.machineId,
            sessionId: params.sessionId,
            userId: params.userId,
            summary: params.summary,
            prompt: params.prompt,
          },
        });

        return log.buildNumber;
      });

      return result;
    } catch (err: any) {
      // @@unique 制約違反 = 同時挿入のレースコンディション → リトライ
      if (err.code === 'P2002' && attempt < MAX_RETRIES - 1) {
        console.log(`⚠️ BuildLog race condition, retrying (attempt ${attempt + 1})...`);
        continue;
      }
      throw err;
    }
  }

  throw new Error('Failed to create BuildLog after retries');
}

async function handleAiStatus(payload: { machineId: string; sessionId: string; status: string; error?: string; agreementStatus?: string | boolean }) {
  // Build status message
  let statusMessage = payload.error
    ? `❌ Error: ${payload.error}`
    : `🤖 AI Status: ${payload.status}`;

  // Add agreement status if provided
  if (payload.agreementStatus !== undefined && payload.status === 'running') {
    // 新しい詳細ステータス（'latest', 'outdated', 'none'）または後方互換の boolean
    const status = payload.agreementStatus;
    if (status === 'latest') {
      statusMessage += '\n✅ DevRelay Agreement 対応済み';
    } else if (status === 'outdated') {
      statusMessage += '\n⚠️ DevRelay Agreement 旧版 - `ag` で最新版に更新できます';
    } else if (status === 'none' || status === false) {
      statusMessage += '\n⚠️ DevRelay Agreement 未対応 - `ag` で対応できます';
    } else if (status === true) {
      // 後方互換: true の場合は対応済みとみなす
      statusMessage += '\n✅ DevRelay Agreement 対応済み';
    }
  }

  await broadcastToSession(payload.sessionId, statusMessage, false);
}

async function handleStorageSaved(payload: { machineId: string; sessionId: string; projectPath: string; contentLength: number }) {
  const { sessionId, contentLength } = payload;
  const message = `💾 ストレージコンテキストを保存しました（${contentLength}文字）`;
  await broadcastToSession(sessionId, message, false);
}

async function handleAgentPing(ws: WebSocket, payload: { machineId: string; timestamp: string }) {
  const { machineId, timestamp } = payload;

  // メモリ内の lastSeenMap のみ更新（DB 更新は heartbeat monitor でバッチ処理）
  const now = new Date();
  lastSeenMap.set(machineId, now);

  // キャッシュも更新
  const cached = machineCache.get(machineId);
  if (cached) {
    cached.lastSeen = now;
  }

  // pong 返信
  sendToAgent(ws, {
    type: 'server:pong',
    payload: { timestamp: new Date().toISOString() }
  });
}

async function handleHistoryDates(payload: { machineId: string; projectPath: string; requestId: string; dates: string[] }) {
  const { requestId, dates } = payload;
  const pending = pendingHistoryDatesRequests.get(requestId);

  if (pending) {
    clearTimeout(pending.timeout);
    pendingHistoryDatesRequests.delete(requestId);
    pending.resolve(dates);
    console.log(`📅 History dates received: ${dates.length} dates for request ${requestId}`);
  }
}

async function handleHistoryExport(payload: { machineId: string; projectPath: string; requestId: string; date: string; zipContent: string; error?: string }) {
  const { requestId, zipContent, error } = payload;
  const pending = pendingHistoryExportRequests.get(requestId);

  if (pending) {
    clearTimeout(pending.timeout);
    pendingHistoryExportRequests.delete(requestId);
    if (error) {
      pending.reject(new Error(error));
      console.log(`❌ History export failed for request ${requestId}: ${error}`);
    } else {
      pending.resolve(zipContent);
      console.log(`📦 History export received for request ${requestId}`);
    }
  }
}

async function handleSessionRestore(ws: WebSocket, payload: { machineId: string; projectPath: string; projectName: string; agreementStatus: string | boolean }) {
  const { machineId, projectPath, projectName, agreementStatus } = payload;

  console.log(`🔄 Session restore request: ${machineId} / ${projectName}`);

  // Find active session for this machine and project
  const session = await prisma.session.findFirst({
    where: {
      machineId,
      status: 'active',
      project: {
        path: projectPath
      }
    },
    include: {
      project: true
    }
  });

  if (session) {
    // Find the chat that was using this session (from ChannelSession)
    const channelSession = await prisma.channelSession.findFirst({
      where: {
        lastProjectId: session.projectId
      }
    });

    if (channelSession) {
      sendToAgent(ws, {
        type: 'server:session:restored',
        payload: {
          sessionId: session.id,
          projectPath,
          chatId: channelSession.chatId,
          platform: channelSession.platform
        }
      });

      console.log(`✅ Session restored: ${session.id} for chat ${channelSession.chatId}`);
    } else {
      console.log(`⚠️ No channel session found for project ${session.projectId}`);
    }
  } else {
    console.log(`⚠️ No active session found for ${machineId} / ${projectPath}`);
  }
}

async function handleAgentAiList(payload: AiListResponsePayload) {
  const { requestId } = payload;
  const pending = pendingAiListRequests.get(requestId);

  if (pending) {
    clearTimeout(pending.timeout);
    pendingAiListRequests.delete(requestId);
    pending.resolve(payload);
    console.log(`🤖 AI list received: ${payload.available.join(', ')} (current: ${payload.currentTool})`);
  }
}

async function handleAgentAiSwitched(payload: AiSwitchedPayload) {
  const { sessionId, aiTool, success, error } = payload;

  // Find pending request by sessionId (we use sessionId as requestId for switch)
  for (const [requestId, pending] of pendingAiSwitchRequests) {
    if (requestId.startsWith(`switch-${sessionId}`)) {
      clearTimeout(pending.timeout);
      pendingAiSwitchRequests.delete(requestId);
      pending.resolve(payload);
      console.log(`🔄 AI switch result: ${aiTool} - ${success ? 'success' : `failed: ${error}`}`);
      return;
    }
  }
}

async function handleSessionAiTool(payload: { machineId: string; sessionId: string; aiTool: AiTool }) {
  const { sessionId, aiTool } = payload;
  console.log(`📋 Session ${sessionId} using AI tool: ${aiTool}`);

  // Update session in DB
  try {
    await prisma.session.update({
      where: { id: sessionId },
      data: { aiTool }
    });
  } catch (err) {
    console.error(`⚠️ Could not update session AI tool:`, err);
  }
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

export function getConnectedMachines(userId: string): Machine[] {
  // TODO: Filter by userId
  return Array.from(machineCache.values());
}

/**
 * Agent が再接続してセッション再開始が必要かを判定する
 * Agent 再起動後は sessionInfoMap がクリアされるため、server:session:start の再送が必要
 *
 * @param machineId 確認対象のマシンID
 * @returns 再接続後でセッション再開始が必要なら true
 */
export function isAgentRestarted(machineId: string): boolean {
  return needsSessionRestart.has(machineId);
}

/**
 * Agent 再接続フラグをクリアする（セッション再開始完了後に呼び出す）
 *
 * @param machineId クリア対象のマシンID
 */
export function clearAgentRestarted(machineId: string): void {
  needsSessionRestart.delete(machineId);
}

export function getConnectedAgents(): Map<string, WebSocket> {
  return connectedAgents;
}

export function getMachine(machineId: string): Machine | undefined {
  return machineCache.get(machineId);
}

export function isAgentConnected(machineId: string): boolean {
  return connectedAgents.has(machineId);
}

/**
 * マシンの表示名を取得するヘルパー
 * displayName が設定されていれば displayName、なければ name を返す
 *
 * @param machineId マシンID
 * @returns 表示用のマシン名
 */
export function getMachineDisplayName(machineId: string): string | undefined {
  const cached = machineCache.get(machineId);
  if (cached) {
    return cached.displayName ?? cached.name;
  }
  return undefined;
}

export function sendToAgent(machineIdOrWs: string | WebSocket, message: ServerToAgentMessage) {
  const ws = typeof machineIdOrWs === 'string'
    ? connectedAgents.get(machineIdOrWs)
    : machineIdOrWs;

  if (ws && ws.readyState === ws.OPEN) {
    console.log(`📤 sendToAgent: type=${message.type}`);
    ws.send(JSON.stringify(message));
  } else {
    console.log(`📤 sendToAgent FAILED: type=${message.type}, ws=${!!ws}, readyState=${ws?.readyState}`);
  }
}

export async function startSession(
  machineId: string,
  sessionId: string,
  projectName: string,
  projectPath: string,
  aiTool: AiTool
) {
  sendToAgent(machineId, {
    type: 'server:session:start',
    payload: { sessionId, projectName, projectPath, aiTool }
  });
}

export interface MissedMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

export async function sendPromptToAgent(
  machineId: string,
  sessionId: string,
  prompt: string,
  userId: string,
  files?: FileAttachment[],
  missedMessages?: MissedMessage[]
) {
  sendToAgent(machineId, {
    type: 'server:ai:prompt',
    payload: { sessionId, prompt, userId, files, missedMessages }
  });
}

export async function endSession(machineId: string, sessionId: string) {
  sendToAgent(machineId, {
    type: 'server:session:end',
    payload: { sessionId }
  });
}

export async function clearConversation(machineId: string, sessionId: string, projectPath: string) {
  sendToAgent(machineId, {
    type: 'server:conversation:clear',
    payload: { sessionId, projectPath }
  });
}

export async function execConversation(machineId: string, sessionId: string, projectPath: string, userId: string, prompt?: string) {
  sendToAgent(machineId, {
    type: 'server:conversation:exec',
    payload: { sessionId, projectPath, userId, prompt }
  });
}

export async function saveWorkState(machineId: string, sessionId: string, projectPath: string, workState: WorkState) {
  sendToAgent(machineId, {
    type: 'server:workstate:save',
    payload: { sessionId, projectPath, workState }
  });
}

// Agreement 適用コマンドを Agent に送信
// Server 側でプロンプトを生成して配信するため、テンプレート更新は Server のみで完結する
export async function applyAgreement(machineId: string, sessionId: string, projectPath: string, userId: string) {
  const agreementPrompt = buildAgreementApplyPrompt();
  sendToAgent(machineId, {
    type: 'server:agreement:apply',
    payload: { sessionId, projectPath, userId, agreementPrompt }
  });
}

export async function saveStorageContext(machineId: string, sessionId: string, projectPath: string, content: string) {
  sendToAgent(machineId, {
    type: 'server:storage:save',
    payload: { sessionId, projectPath, content }
  });
}

export async function clearStorageContext(machineId: string, sessionId: string, projectPath: string) {
  sendToAgent(machineId, {
    type: 'server:storage:clear',
    payload: { sessionId, projectPath }
  });
}

// -----------------------------------------------------------------------------
// Heartbeat Monitoring
// -----------------------------------------------------------------------------

const HEARTBEAT_CHECK_INTERVAL = 60000; // 60 seconds
const HEARTBEAT_TIMEOUT = 60000; // 60 seconds without ping = offline
let heartbeatMonitorInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Start the heartbeat monitor that checks for stale connections
 * and marks machines as offline if they haven't sent a ping recently
 */
export function startHeartbeatMonitor() {
  if (heartbeatMonitorInterval) {
    console.log('⚠️ Heartbeat monitor already running');
    return;
  }

  console.log('💓 Starting heartbeat monitor (checking every 60s)');

  heartbeatMonitorInterval = setInterval(async () => {
    const now = new Date();
    const cutoffTime = new Date(now.getTime() - HEARTBEAT_TIMEOUT);

    try {
      // lastSeenMap のデータをまとめて DB に書き込み（バッチ更新）
      if (lastSeenMap.size > 0) {
        const entries = Array.from(lastSeenMap.entries());
        lastSeenMap.clear();

        for (const [machineId, lastSeenAt] of entries) {
          try {
            await prisma.machine.update({
              where: { id: machineId },
              data: { lastSeenAt }
            });
          } catch {
            // マシンが DB に存在しない場合は無視（再接続中など）
          }
        }
      }

      // stale チェック: オンラインだが ping が途絶えたマシンを offline に
      const staleMachines = await prisma.machine.findMany({
        where: {
          status: 'online',
          OR: [
            { lastSeenAt: { lt: cutoffTime } },
            { lastSeenAt: null }
          ]
        }
      });

      if (staleMachines.length > 0) {
        console.log(`💔 Found ${staleMachines.length} stale machine(s), marking offline...`);

        for (const machine of staleMachines) {
          // Update DB
          await prisma.machine.update({
            where: { id: machine.id },
            data: { status: 'offline' }
          });

          // Remove from cache and connected agents
          connectedAgents.delete(machine.id);
          machineCache.delete(machine.id);

          console.log(`   - ${machine.name} (${machine.id}) marked offline (last seen: ${machine.lastSeenAt?.toISOString() || 'never'})`);
        }
      }
    } catch (err) {
      console.error('❌ Error in heartbeat monitor:', err);
    }
  }, HEARTBEAT_CHECK_INTERVAL);
}

/**
 * Stop the heartbeat monitor
 */
export function stopHeartbeatMonitor() {
  if (heartbeatMonitorInterval) {
    clearInterval(heartbeatMonitorInterval);
    heartbeatMonitorInterval = null;
    console.log('💔 Heartbeat monitor stopped');
  }
}

// -----------------------------------------------------------------------------
// History Export API
// -----------------------------------------------------------------------------

const HISTORY_REQUEST_TIMEOUT = 120000; // 120 seconds (ZIP creation can take time with many messages)

/**
 * Request available history dates from an agent
 */
export function requestHistoryDates(machineId: string, projectPath: string): Promise<string[]> {
  console.log(`📤 requestHistoryDates: machineId=${machineId}, projectPath=${projectPath}`);

  return new Promise((resolve, reject) => {
    const ws = connectedAgents.get(machineId);
    const hasAgent = connectedAgents.has(machineId);
    console.log(`📤 connectedAgents.has(${machineId}): ${hasAgent}`);
    console.log(`📤 connectedAgents keys: ${Array.from(connectedAgents.keys()).join(', ')}`);
    console.log(`📤 ws.readyState: ${ws?.readyState} (OPEN=1)`);

    if (!ws || ws.readyState !== ws.OPEN) {
      console.log(`📤 Agent not connected or WebSocket not open`);
      reject(new Error('Agent is not connected'));
      return;
    }

    const requestId = `dates-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    console.log(`📤 Sending server:history:dates with requestId=${requestId}`);

    const timeout = setTimeout(() => {
      pendingHistoryDatesRequests.delete(requestId);
      console.log(`📤 Request ${requestId} timed out`);
      reject(new Error('Request timed out'));
    }, HISTORY_REQUEST_TIMEOUT);

    pendingHistoryDatesRequests.set(requestId, { resolve, reject, timeout });

    sendToAgent(ws, {
      type: 'server:history:dates',
      payload: { projectPath, requestId }
    });
  });
}

/**
 * Request history export for a specific date from an agent
 */
export function requestHistoryExport(machineId: string, projectPath: string, date: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = connectedAgents.get(machineId);
    if (!ws || ws.readyState !== ws.OPEN) {
      reject(new Error('Agent is not connected'));
      return;
    }

    const requestId = `export-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    const timeout = setTimeout(() => {
      pendingHistoryExportRequests.delete(requestId);
      reject(new Error('Request timed out'));
    }, HISTORY_REQUEST_TIMEOUT);

    pendingHistoryExportRequests.set(requestId, { resolve, reject, timeout });

    sendToAgent(ws, {
      type: 'server:history:export',
      payload: { projectPath, requestId, date }
    });
  });
}

// -----------------------------------------------------------------------------
// AI Tool Switching API
// -----------------------------------------------------------------------------

const AI_REQUEST_TIMEOUT = 10000; // 10 seconds

/**
 * Request AI tool list from an agent
 */
export function getAiToolList(machineId: string, sessionId: string): Promise<AiListResponsePayload> {
  return new Promise((resolve, reject) => {
    const ws = connectedAgents.get(machineId);
    if (!ws || ws.readyState !== ws.OPEN) {
      reject(new Error('Agent is not connected'));
      return;
    }

    const requestId = `list-${sessionId}-${Date.now()}`;

    const timeout = setTimeout(() => {
      pendingAiListRequests.delete(requestId);
      reject(new Error('Request timed out'));
    }, AI_REQUEST_TIMEOUT);

    pendingAiListRequests.set(requestId, { resolve, reject, timeout });

    sendToAgent(ws, {
      type: 'server:ai:list',
      payload: { sessionId, requestId }
    });
  });
}

/**
 * Switch AI tool for a session
 */
export function switchAiTool(machineId: string, sessionId: string, aiTool: AiTool): Promise<AiSwitchedPayload> {
  return new Promise((resolve, reject) => {
    const ws = connectedAgents.get(machineId);
    if (!ws || ws.readyState !== ws.OPEN) {
      reject(new Error('Agent is not connected'));
      return;
    }

    const requestId = `switch-${sessionId}-${Date.now()}`;

    const timeout = setTimeout(() => {
      pendingAiSwitchRequests.delete(requestId);
      reject(new Error('Request timed out'));
    }, AI_REQUEST_TIMEOUT);

    pendingAiSwitchRequests.set(requestId, { resolve, reject, timeout });

    sendToAgent(ws, {
      type: 'server:ai:switch',
      payload: { sessionId, aiTool }
    });
  });
}
