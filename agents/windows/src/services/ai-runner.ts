import { spawn, ChildProcess, execSync } from 'child_process';
import type { AiTool } from '@devrelay/shared';
import type { AgentConfig } from './config.js';
import { parseStreamJsonLine, formatContextUsage, isContextWarning, getContextWarningMessage, type ContextUsage } from './output-parser.js';
import { saveClaudeSessionId, saveContextUsage } from './session-store.js';

interface AiSession {
  sessionId: string;
  process: ChildProcess;
  projectPath: string;
  aiTool: AiTool;
}

export interface AiRunResult {
  extractedSessionId?: string;
  contextUsage?: ContextUsage;
}

// Active AI sessions: sessionId -> AiSession
const activeSessions = new Map<string, AiSession>();

type OutputCallback = (output: string, isComplete: boolean) => void;

/**
 * Find the full path to claude command on Windows
 */
function findClaudePath(): string | null {
  try {
    // Use 'where' command on Windows to find claude
    const result = execSync('where claude', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    const paths = result.trim().split('\r\n');
    // Return the first found path (usually claude.cmd or claude.exe)
    return paths[0] || null;
  } catch {
    return null;
  }
}

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

  console.log(`Starting session for ${aiTool} in ${projectPath}`);

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

export interface SendPromptOptions {
  /** Claude session ID to resume (from previous execution) */
  resumeSessionId?: string;
  /** Use plan mode (--permission-mode plan) instead of skip-permissions */
  usePlanMode?: boolean;
}

export async function sendPromptToAi(
  sessionId: string,
  prompt: string,
  projectPath: string,
  aiTool: AiTool,
  claudeSessionId: string,
  config: AgentConfig,
  onOutput: OutputCallback,
  options: SendPromptOptions = {}
): Promise<AiRunResult> {
  console.log(`Sending prompt to ${aiTool}: ${prompt.substring(0, 50)}...`);

  const command = getAiCommand(aiTool, config);
  if (!command) {
    onOutput(`Error: AI tool not configured: ${aiTool}`, true);
    return {};
  }

  const result: AiRunResult = {};
  let proc;

  if (aiTool === 'claude') {
    // On Windows, use claude directly (claude.cmd will be found in PATH)
    const claudePath = findClaudePath() || 'claude';
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose'
    ];

    // Add permission mode based on options
    if (options.usePlanMode) {
      args.push('--permission-mode', 'plan');
      console.log(`Using plan mode (--permission-mode plan)`);
    } else {
      args.push('--dangerously-skip-permissions');
      console.log(`Using exec mode (--dangerously-skip-permissions)`);
    }

    // Add resume option if we have a previous session ID
    if (options.resumeSessionId) {
      args.push('--resume', options.resumeSessionId);
      console.log(`Resuming session: ${options.resumeSessionId.substring(0, 8)}...`);
    }

    console.log(`Running: ${claudePath} ${args.join(' ')}`);

    proc = spawn(claudePath, args, {
      cwd: projectPath,
      shell: false,  // Use shell: false to properly pipe stdin (same as Linux)
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        DEVRELAY: '1',
        DEVRELAY_SESSION_ID: sessionId,
        DEVRELAY_PROJECT: projectPath,
      },
    });

    // Write prompt to stdin (secure - not visible in process list)
    proc.stdin?.write(prompt);
    proc.stdin?.end();
  } else {
    // For other AI tools, use shell
    // On Windows, need to handle shell differently
    const escapedPrompt = prompt.replace(/"/g, '\\"');
    const fullCommand = `${command} "${escapedPrompt}"`;

    console.log(`Running: ${fullCommand.substring(0, 100)}...`);

    proc = spawn(fullCommand, [], {
      cwd: projectPath,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    proc.stdin?.end();
  }

  let fullOutput = '';
  let lineBuffer = '';

  return new Promise<AiRunResult>((resolve) => {
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

          // Parse for session ID and context usage
          const parsed = parseStreamJsonLine(line);
          if (parsed.sessionId) {
            result.extractedSessionId = parsed.sessionId;
            console.log(`[${aiTool}] Session ID: ${parsed.sessionId.substring(0, 8)}...`);
            // Save session ID for future resumption
            saveClaudeSessionId(projectPath, parsed.sessionId).catch(err => {
              console.error(`Failed to save session ID:`, err);
            });
          }
          if (parsed.contextUsage) {
            result.contextUsage = parsed.contextUsage;
            console.log(`[${aiTool}] ${formatContextUsage(parsed.contextUsage)}`);
            // Save context usage for display at start of next prompt
            saveContextUsage(projectPath, parsed.contextUsage).catch(err => {
              console.error(`Failed to save context usage:`, err);
            });
          }

          // Extract text from assistant messages (new format)
          if (json.type === 'assistant' && json.message?.content) {
            for (const block of json.message.content) {
              if (block.type === 'text' && block.text) {
                fullOutput += block.text;
                console.log(`[${aiTool}] +${block.text.length} chars`);
                onOutput(block.text, false);
              } else if (block.type === 'tool_use' && block.name) {
                console.log(`[${aiTool}] 🔧 Using tool: ${block.name}`);
                onOutput(`\n🔧 ${block.name}を使用中...\n`, false);
              }
            }
          }
          // Extract text from streaming events (legacy format)
          else if (json.type === 'stream_event' &&
              json.event?.type === 'content_block_delta' &&
              json.event?.delta?.type === 'text_delta') {
            const deltaText = json.event.delta.text;
            fullOutput += deltaText;
            console.log(`[${aiTool}] +${deltaText.length} chars`);
            onOutput(deltaText, false);
          }
          // Also capture tool use for visibility (legacy format)
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
      resolve(result);
    });

    proc.on('error', (err) => {
      console.error(`[${aiTool}] Process error:`, err);
      onOutput(`Error: ${err.message}`, true);
      resolve(result);
    });
  });
}

export async function stopAiSession(sessionId: string): Promise<void> {
  const session = activeSessions.get(sessionId);

  if (!session) {
    return;
  }

  console.log(`Stopping AI session: ${sessionId}`);
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
