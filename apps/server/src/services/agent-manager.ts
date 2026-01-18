import type { WebSocket } from 'ws';
import type { FastifyRequest } from 'fastify';
import type {
  AgentMessage,
  ServerToAgentMessage,
  Machine,
  Project,
  AiTool,
  FileAttachment,
  WorkState
} from '@devrelay/shared';
import { prisma } from '../db/client.js';
import { appendSessionOutput, finalizeProgress, broadcastToSession } from './session-manager.js';

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
    payload: { success: true }
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

async function handleAiStatus(payload: { machineId: string; sessionId: string; status: string; error?: string }) {
  // Notify participants about status change
  const statusMessage = payload.error 
    ? `❌ Error: ${payload.error}`
    : `🤖 AI Status: ${payload.status}`;
  
  await broadcastToSession(payload.sessionId, statusMessage, false);
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

export async function sendPromptToAgent(
  machineId: string,
  sessionId: string,
  prompt: string,
  userId: string,
  files?: FileAttachment[]
) {
  sendToAgent(machineId, {
    type: 'server:ai:prompt',
    payload: { sessionId, prompt, userId, files }
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

export async function execConversation(machineId: string, sessionId: string, projectPath: string) {
  sendToAgent(machineId, {
    type: 'server:conversation:exec',
    payload: { sessionId, projectPath }
  });
}

export async function saveWorkState(machineId: string, sessionId: string, projectPath: string, workState: WorkState) {
  sendToAgent(machineId, {
    type: 'server:workstate:save',
    payload: { sessionId, projectPath, workState }
  });
}
