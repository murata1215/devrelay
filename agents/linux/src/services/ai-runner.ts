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

  const command = getAiCommand(aiTool, config);
  if (!command) {
    onOutput(`Error: AI tool not configured: ${aiTool}`, true);
    return;
  }

  let proc;

  if (aiTool === 'claude') {
    // Use devbridge-claude symlink so process name is clearly identifiable in ps
    // The symlink should be at ~/.devbridge/bin/devbridge-claude -> claude
    const devbridgeClaude = `${process.env.HOME}/.devbridge/bin/devbridge-claude`;
    const args = [
      '-p',
      '--dangerously-skip-permissions',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose'
    ];

    console.log(`🔧 Running: devbridge-claude -p [stdin] --output-format stream-json ...`);

    proc = spawn(devbridgeClaude, args, {
      cwd: projectPath,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        DEVBRIDGE: '1',
        DEVBRIDGE_SESSION_ID: sessionId,
        DEVBRIDGE_PROJECT: projectPath,
      },
    });

    // Write prompt to stdin (secure - not visible in process list)
    proc.stdin?.write(prompt);
    proc.stdin?.end();
  } else {
    // For other AI tools, use shell (legacy behavior)
    const escapedPrompt = prompt.replace(/'/g, "'\\''");
    const fullCommand = `${command} '${escapedPrompt}'`;

    console.log(`🔧 Running: ${fullCommand.substring(0, 100)}...`);

    proc = spawn(fullCommand, [], {
      cwd: projectPath,
      shell: '/bin/bash',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    proc.stdin?.end();
  }

  let fullOutput = '';
  let lineBuffer = '';

  proc.stdout?.on('data', (data) => {
    const text = data.toString();
    lineBuffer += text;

    // Process complete lines
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop() || ''; // Keep incomplete line in buffer

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const json = JSON.parse(line);

        // Extract text from streaming events
        if (json.type === 'stream_event' &&
            json.event?.type === 'content_block_delta' &&
            json.event?.delta?.type === 'text_delta') {
          const deltaText = json.event.delta.text;
          fullOutput += deltaText;
          console.log(`[${aiTool}] +${deltaText.length} chars`);
          onOutput(deltaText, false);
        }
        // Also capture tool use for visibility
        else if (json.type === 'stream_event' &&
                 json.event?.type === 'content_block_start' &&
                 json.event?.content_block?.type === 'tool_use') {
          const toolName = json.event.content_block.name;
          console.log(`[${aiTool}] 🔧 Using tool: ${toolName}`);
          onOutput(`\n🔧 ${toolName}を使用中...\n`, false);
        }
        // Capture result for final output
        else if (json.type === 'result') {
          console.log(`[${aiTool}] ✅ Complete (${json.duration_ms}ms)`);
        }
      } catch {
        // Not JSON or parse error - ignore
      }
    }
  });

  proc.stderr?.on('data', (data) => {
    const text = data.toString();
    console.error(`[${aiTool}] stderr: ${text}`);
  });

  proc.on('close', (code) => {
    console.log(`[${aiTool}] Process exited with code ${code}`);
    if (fullOutput.length === 0) {
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
