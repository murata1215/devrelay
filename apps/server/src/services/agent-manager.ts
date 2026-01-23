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
  TaskCreatePayload,
  TaskCompletePayload,
  TaskFailPayload,
  TaskProgressPayload,
  TaskCommentPayload,
  TaskStartPayload,
} from '@devrelay/shared';
import { prisma } from '../db/client.js';
import { appendSessionOutput, finalizeProgress, broadcastToSession, clearSessionsForMachine } from './session-manager.js';
import {
  createTask,
  completeTask,
  failTask,
  startTask,
  addComment,
  getIncomingTasks,
  buildTaskAssignedPayload,
  buildTaskCompletedNotifyPayload,
  getTaskAttachments,
} from './task-manager.js';

// Connected agents: machineId -> WebSocket
const connectedAgents = new Map<string, WebSocket>();

// Machine info cache: machineId -> Machine
const machineCache = new Map<string, Machine>();

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

        // Task messages
        case 'agent:task:create':
          await handleTaskCreate(message.payload);
          break;

        case 'agent:task:start':
          await handleTaskStart(message.payload);
          break;

        case 'agent:task:complete':
          await handleTaskComplete(message.payload);
          break;

        case 'agent:task:fail':
          await handleTaskFail(message.payload);
          break;

        case 'agent:task:progress':
          await handleTaskProgress(message.payload);
          break;

        case 'agent:task:comment':
          await handleTaskComment(message.payload);
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

async function handleAiStatus(payload: { machineId: string; sessionId: string; status: string; error?: string; agreementStatus?: boolean }) {
  // Build status message
  let statusMessage = payload.error
    ? `❌ Error: ${payload.error}`
    : `🤖 AI Status: ${payload.status}`;

  // Add agreement status if provided
  if (payload.agreementStatus !== undefined && payload.status === 'running') {
    if (payload.agreementStatus) {
      statusMessage += '\n✅ DevRelay Agreement 対応済み';
    } else {
      statusMessage += '\n⚠️ DevRelay Agreement 未対応 - `a` または `agreement` で対応できます';
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

async function handleSessionRestore(ws: WebSocket, payload: { machineId: string; projectPath: string; projectName: string; agreementStatus: boolean }) {
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

// -----------------------------------------------------------------------------
// Task Handlers
// -----------------------------------------------------------------------------

async function handleTaskCreate(payload: TaskCreatePayload) {
  console.log(`📝 Task create request from ${payload.machineId}: ${payload.name}`);

  try {
    const { task, receiverMachineId } = await createTask(payload);
    console.log(`✅ Task created: ${task.id} (${task.name})`);

    // If receiver is specified and online, notify them
    if (receiverMachineId && connectedAgents.has(receiverMachineId)) {
      // Get receiver project path
      const receiverProject = await prisma.project.findUnique({
        where: { id: task.receiverProjectId! }
      });

      if (receiverProject) {
        // Get attachments
        const attachments = await getTaskAttachments(task.id);
        const fileAttachments = attachments.map(a => ({
          filename: a.filename,
          content: a.content,
          mimeType: a.mimeType,
          size: a.size,
        }));

        const assignedPayload = buildTaskAssignedPayload(
          task,
          receiverProject.path,
          fileAttachments.length > 0 ? fileAttachments : undefined
        );

        sendToAgent(receiverMachineId, {
          type: 'server:task:assigned',
          payload: assignedPayload,
        });

        console.log(`📨 Task assigned notification sent to ${receiverMachineId}`);
      }
    }
  } catch (err) {
    console.error('❌ Error creating task:', err);
  }
}

async function handleTaskStart(payload: TaskStartPayload) {
  console.log(`▶️ Task start: ${payload.taskId}`);

  try {
    const task = await startTask(payload);
    if (task) {
      console.log(`✅ Task started: ${task.id}`);
    }
  } catch (err) {
    console.error('❌ Error starting task:', err);
  }
}

async function handleTaskComplete(payload: TaskCompletePayload) {
  console.log(`✅ Task complete: ${payload.taskId}`);

  try {
    const { task, senderMachineId } = await completeTask(payload);
    console.log(`✅ Task completed: ${task.id}`);

    // Notify sender if online
    if (connectedAgents.has(senderMachineId)) {
      // Get sender project path
      const senderProject = await prisma.project.findUnique({
        where: { id: task.senderProjectId }
      });

      if (senderProject) {
        // Get result files
        const attachments = await getTaskAttachments(task.id);
        const resultFiles = attachments
          .filter(a => a.uploadedBy === task.executorProjectId)
          .map(a => ({
            filename: a.filename,
            content: a.content,
            mimeType: a.mimeType,
            size: a.size,
          }));

        const completedPayload = buildTaskCompletedNotifyPayload(
          task,
          senderProject.path,
          resultFiles.length > 0 ? resultFiles : undefined
        );

        sendToAgent(senderMachineId, {
          type: 'server:task:completed',
          payload: completedPayload,
        });

        console.log(`📨 Task completion notification sent to ${senderMachineId}`);
      }
    }
  } catch (err) {
    console.error('❌ Error completing task:', err);
  }
}

async function handleTaskFail(payload: TaskFailPayload) {
  console.log(`❌ Task failed: ${payload.taskId} - ${payload.error}`);

  try {
    const { task, senderMachineId } = await failTask(payload);
    console.log(`✅ Task marked as failed: ${task.id}`);

    // Notify sender if online
    if (connectedAgents.has(senderMachineId)) {
      // Get sender project path
      const senderProject = await prisma.project.findUnique({
        where: { id: task.senderProjectId }
      });

      if (senderProject) {
        const completedPayload = buildTaskCompletedNotifyPayload(
          task,
          senderProject.path
        );

        sendToAgent(senderMachineId, {
          type: 'server:task:completed',
          payload: completedPayload,
        });

        console.log(`📨 Task failure notification sent to ${senderMachineId}`);
      }
    }
  } catch (err) {
    console.error('❌ Error marking task as failed:', err);
  }
}

async function handleTaskProgress(payload: TaskProgressPayload) {
  console.log(`📊 Task progress: ${payload.taskId} - ${payload.progress}`);
  // Progress updates are logged for now
  // Future: Could store in a separate table or broadcast to interested parties
}

async function handleTaskComment(payload: TaskCommentPayload) {
  console.log(`💬 Task comment: ${payload.taskId}`);

  try {
    await addComment(payload);
    console.log(`✅ Comment added to task: ${payload.taskId}`);
  } catch (err) {
    console.error('❌ Error adding comment:', err);
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
    ws.send(JSON.stringify(message));
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

export async function sendIncomingTasksToAgent(machineId: string, projectPath: string) {
  const taskList = await getIncomingTasks(projectPath);

  sendToAgent(machineId, {
    type: 'server:task:list',
    payload: taskList,
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
