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
          await handleAgentDisconnect(message.payload.machineId);
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
      await handleAgentDisconnect(machineId);
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
  payload: { machineId: string; machineName: string; token: string; projects: Project[]; availableAiTools: AiTool[] }
) {
  const { machineId, machineName, token, projects, availableAiTools } = payload;

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

  // Update machine status
  await prisma.machine.update({
    where: { id: machine.id },
    data: { status: 'online', lastSeenAt: new Date() }
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

  // Store connection
  connectedAgents.set(machine.id, ws);
  machineCache.set(machine.id, {
    id: machine.id,
    name: machine.name,
    status: 'online',
    lastSeen: new Date(),
    projects
  });

  sendToAgent(ws, {
    type: 'server:connect:ack',
    payload: { success: true, machineId: machine.id }
  });

  console.log(`✅ Agent connected: ${machine.name} (${machine.id})`);

  // Agent再接続時にセッション参加者を復元（切断前のセッションを継続可能にする）
  await restoreSessionParticipantsForMachine(machine.id);
}

async function handleAgentDisconnect(machineId: string) {
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

async function handleAiOutput(payload: { machineId: string; sessionId: string; output: string; isComplete: boolean; files?: FileAttachment[] }) {
  const { sessionId, output, isComplete, files } = payload;

  console.log(`📥 AI Output received: isComplete=${isComplete}, length=${output.length}`);

  if (isComplete) {
    // Save final output to DB
    await prisma.message.create({
      data: {
        sessionId,
        role: 'ai',
        content: output,
        platform: 'system'
      }
    });

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
      statusMessage += '\n✅ DevRelay Agreement v2 対応済み';
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

  // Update lastSeenAt in database
  try {
    await prisma.machine.update({
      where: { id: machineId },
      data: { lastSeenAt: new Date() }
    });

    // Update cache
    const cached = machineCache.get(machineId);
    if (cached) {
      cached.lastSeen = new Date();
    }
  } catch (err) {
    // Machine may not exist in DB - this is expected during reconnection
  }

  // Send pong response
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

export function getConnectedAgents(): Map<string, WebSocket> {
  return connectedAgents;
}

export function getMachine(machineId: string): Machine | undefined {
  return machineCache.get(machineId);
}

export function isAgentConnected(machineId: string): boolean {
  return connectedAgents.has(machineId);
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

export async function execConversation(machineId: string, sessionId: string, projectPath: string, userId: string) {
  sendToAgent(machineId, {
    type: 'server:conversation:exec',
    payload: { sessionId, projectPath, userId }
  });
}

export async function saveWorkState(machineId: string, sessionId: string, projectPath: string, workState: WorkState) {
  sendToAgent(machineId, {
    type: 'server:workstate:save',
    payload: { sessionId, projectPath, workState }
  });
}

export async function applyAgreement(machineId: string, sessionId: string, projectPath: string, userId: string) {
  sendToAgent(machineId, {
    type: 'server:agreement:apply',
    payload: { sessionId, projectPath, userId }
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
      // Find machines that are marked as online but haven't sent a ping recently
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
