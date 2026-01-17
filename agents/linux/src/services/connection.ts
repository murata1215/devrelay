import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';
import type {
  AgentMessage,
  ServerToAgentMessage,
  Project,
  AiTool,
  FileAttachment
} from '@devbridge/shared';
import { DEFAULTS } from '@devbridge/shared';
import type { AgentConfig } from './config.js';
import { startAiSession, sendPromptToAi, stopAiSession } from './ai-runner.js';
import { saveReceivedFiles, buildPromptWithFiles } from './file-handler.js';
import { clearOutputDir, collectOutputFiles, OUTPUT_DIR_INSTRUCTION } from './output-collector.js';

let ws: WebSocket | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let pingTimer: NodeJS.Timeout | null = null;
let currentConfig: AgentConfig | null = null;

// Store session info for prompt handling
interface SessionInfo {
  projectPath: string;
  aiTool: AiTool;
  claudeSessionId: string; // UUID for Claude Code --session-id
  history: Array<{ role: 'user' | 'assistant'; content: string }>; // Conversation history
}
const sessionInfoMap = new Map<string, SessionInfo>();

export async function connectToServer(config: AgentConfig, projects: Project[]) {
  currentConfig = config;
  return new Promise<void>((resolve, reject) => {
    console.log(`🔌 Connecting to ${config.serverUrl}...`);

    ws = new WebSocket(config.serverUrl);

    ws.on('open', () => {
      console.log('✅ Connected to server');

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

  // Generate UUID for Claude Code session and store session info
  const claudeSessionId = uuidv4();
  sessionInfoMap.set(sessionId, { projectPath, aiTool, claudeSessionId, history: [] });
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

  // Add user message to history
  sessionInfo.history.push({ role: 'user', content: prompt });

  // Clear output directory before running
  await clearOutputDir(sessionInfo.projectPath);

  // Build prompt with history context and output directory instruction
  let fullPrompt = promptWithFiles + OUTPUT_DIR_INSTRUCTION;
  if (sessionInfo.history.length > 1) {
    const historyContext = sessionInfo.history.slice(0, -1) // exclude current message
      .map(h => `${h.role === 'user' ? 'User' : 'Assistant'}: ${h.content}`)
      .join('\n');
    fullPrompt = `Previous conversation:\n${historyContext}\n\nUser: ${promptWithFiles}${OUTPUT_DIR_INSTRUCTION}`;
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
            output,
            isComplete,
            files: files.length > 0 ? files : undefined,
          },
        });

        // Save response to history when complete
        if (responseText.trim()) {
          sessionInfo.history.push({ role: 'assistant', content: responseText.trim() });
        }
      } else {
        // Stream intermediate output without files
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

  console.log(`🔄 Reconnecting in ${DEFAULTS.websocketReconnectDelay / 1000}s...`);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToServer(config, projects).catch(console.error);
  }, DEFAULTS.websocketReconnectDelay);
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
