import { spawn, ChildProcess } from 'child_process';
import type { AiTool } from '@devbridge/shared';
import type { AgentConfig } from './config.js';

interface AiSession {
  sessionId: string;
  process: ChildProcess;
  projectPath: string;
  aiTool: AiTool;
}

// Active AI sessions: sessionId -> AiSession
const activeSessions = new Map<string, AiSession>();

type OutputCallback = (output: string, isComplete: boolean) => void;

export async function startAiSession(
  sessionId: string,
  projectPath: string,
  aiTool: AiTool,
  config: AgentConfig,
  onOutput: OutputCallback
): Promise<void> {
  // Check if session already exists
  if (activeSessions.has(sessionId)) {
    throw new Error(`Session already exists: ${sessionId}`);
  }

  // Get AI tool command
  const command = getAiCommand(aiTool, config);
  if (!command) {
    throw new Error(`AI tool not configured: ${aiTool}`);
  }

  console.log(`🚀 Session ready for ${aiTool} in ${projectPath}`);

  // Don't spawn process here - we'll use -p mode for each prompt
  // Just register the session
  const session: AiSession = {
    sessionId,
    process: null as any, // No persistent process
    projectPath,
    aiTool,
  };

  activeSessions.set(sessionId, session);
}

export async function sendPromptToAi(
  sessionId: string,
  prompt: string,
  projectPath: string,
  aiTool: AiTool,
  claudeSessionId: string,
  config: AgentConfig,
  onOutput: OutputCallback
): Promise<void> {
  console.log(`📝 Sending prompt to ${aiTool}: ${prompt.substring(0, 50)}...`);

  // Use --print mode for non-interactive execution
  const command = getAiCommand(aiTool, config);
  if (!command) {
    onOutput(`Error: AI tool not configured: ${aiTool}`, true);
    return;
  }

  // Escape prompt for shell and build full command
  // History is managed by DevBridge, not Claude Code sessions
  const escapedPrompt = prompt.replace(/'/g, "'\\''");
  const fullCommand = aiTool === 'claude'
    ? `${command} -p '${escapedPrompt}' --dangerously-skip-permissions`
    : `${command} '${escapedPrompt}'`;

  console.log(`🔧 Running: ${fullCommand.substring(0, 100)}...`);

  const proc = spawn(fullCommand, [], {
    cwd: projectPath,
    shell: '/bin/bash',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
    },
  });

  // Close stdin immediately to signal no input
  proc.stdin?.end();

  let output = '';

  proc.stdout?.on('data', (data) => {
    const text = data.toString();
    output += text;
    console.log(`[${aiTool}] ${text}`);
    onOutput(text, false);
  });

  proc.stderr?.on('data', (data) => {
    const text = data.toString();
    console.error(`[${aiTool}] stderr: ${text}`);
  });

  proc.on('close', (code) => {
    console.log(`[${aiTool}] Process exited with code ${code}`);
    if (output.length === 0) {
      onOutput('(No response from AI)', true);
    } else {
      onOutput('', true); // Signal completion
    }
  });

  proc.on('error', (err) => {
    console.error(`[${aiTool}] Process error:`, err);
    onOutput(`Error: ${err.message}`, true);
  });
}

export async function stopAiSession(sessionId: string): Promise<void> {
  const session = activeSessions.get(sessionId);

  if (!session) {
    return;
  }

  console.log(`⏹️ Stopping AI session: ${sessionId}`);
  activeSessions.delete(sessionId);
}

export function getActiveSession(sessionId: string): AiSession | undefined {
  return activeSessions.get(sessionId);
}

export function getActiveSessions(): AiSession[] {
  return Array.from(activeSessions.values());
}

function getAiCommand(aiTool: AiTool, config: AgentConfig): string | undefined {
  switch (aiTool) {
    case 'claude':
      return config.aiTools.claude?.command || 'claude';
    case 'gemini':
      return config.aiTools.gemini?.command || 'gemini';
    case 'codex':
      return config.aiTools.codex?.command || 'codex';
    case 'aider':
      return config.aiTools.aider?.command || 'aider';
    default:
      return undefined;
  }
}
