import { spawn, ChildProcess, execSync } from 'child_process';
import path from 'path';
import type { AiTool } from '@devrelay/shared';
import type { AgentConfig } from './config.js';
import { parseStreamJsonLine, formatContextUsage, isContextWarning, getContextWarningMessage, type ContextUsage } from './output-parser.js';
import { saveClaudeSessionId, saveContextUsage } from './session-store.js';
import log from './logger.js';

interface AiSession {
  sessionId: string;
  process: ChildProcess;
  projectPath: string;
  aiTool: AiTool;
}

export interface AiRunResult {
  extractedSessionId?: string;
  contextUsage?: ContextUsage;
  resumeFailed?: boolean;  // True if --resume failed (exit code 1 + no output)
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

  log.info(`Starting session for ${aiTool} in ${projectPath}`);

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
  log.info(`Sending prompt to ${aiTool}: ${prompt.substring(0, 50)}...`);

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
      log.info(`Using plan mode (--permission-mode plan)`);
    } else {
      args.push('--dangerously-skip-permissions');
      log.info(`Using exec mode (--dangerously-skip-permissions)`);
    }

    // Add resume option if we have a previous session ID
    if (options.resumeSessionId) {
      args.push('--resume', options.resumeSessionId);
      log.info(`Resuming session: ${options.resumeSessionId.substring(0, 8)}...`);
    }

    log.info(`Running: ${claudePath} ${args.join(' ')}`);

    // プロキシ環境変数を追加（自動起動時には process.env に含まれていないことがある）
    const proxyEnv: Record<string, string> = {};
    if (config.proxy?.url) {
      proxyEnv.HTTP_PROXY = config.proxy.url;
      proxyEnv.HTTPS_PROXY = config.proxy.url;
      proxyEnv.http_proxy = config.proxy.url;
      proxyEnv.https_proxy = config.proxy.url;
      log.info(`Setting proxy env for Claude: ${config.proxy.url}`);
    }

    proc = spawn(claudePath, args, {
      cwd: projectPath,
      shell: true,  // Windows needs shell: true to execute .cmd files (claude.cmd)
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...proxyEnv,
        DEVRELAY: '1',
        DEVRELAY_SESSION_ID: sessionId,
        DEVRELAY_PROJECT: projectPath,
      },
    });

    // Write prompt to stdin (secure - not visible in process list)
    proc.stdin?.write(prompt);
    proc.stdin?.end();
  } else if (aiTool === 'gemini') {
    // Gemini CLI with auto_edit approval mode
    // Use stdin to pass prompt (same as Claude) to avoid shell interpretation issues
    const args = ['--approval-mode', 'auto_edit'];
    log.info(`Running: ${command} --approval-mode auto_edit (prompt via stdin)`);

    // Extract directory from gemini command path and add to PATH
    // This ensures node can be found when running as a Windows service
    const geminiDir = path.dirname(command);
    const envPath = process.env.PATH ? `${geminiDir};${process.env.PATH}` : geminiDir;

    // プロキシ環境変数を追加（Gemini 用）
    const geminiProxyEnv: Record<string, string> = {};
    if (config.proxy?.url) {
      geminiProxyEnv.HTTP_PROXY = config.proxy.url;
      geminiProxyEnv.HTTPS_PROXY = config.proxy.url;
      geminiProxyEnv.http_proxy = config.proxy.url;
      geminiProxyEnv.https_proxy = config.proxy.url;
    }

    proc = spawn(command, args, {
      cwd: projectPath,
      shell: true,  // Windows needs shell: true for .cmd files
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...geminiProxyEnv,
        PATH: envPath,  // Add gemini's directory to PATH so node can be found
        DEVRELAY: '1',
        DEVRELAY_SESSION_ID: sessionId,
        DEVRELAY_PROJECT: projectPath,
      },
    });

    // Write prompt to stdin (secure - not visible in process list)
    proc.stdin?.write(prompt);
    proc.stdin?.end();
  } else {
    // For other AI tools (aider, codex), use shell
    // On Windows, need to handle shell differently
    const escapedPrompt = prompt.replace(/"/g, '\\"');
    const fullCommand = `${command} "${escapedPrompt}"`;

    log.info(`Running: ${fullCommand.substring(0, 100)}...`);

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
  // stderr を収集してエラー検出に使用
  let stderrOutput = '';

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
            log.info(`[${aiTool}] Session ID: ${parsed.sessionId.substring(0, 8)}...`);
            // Save session ID for future resumption
            saveClaudeSessionId(projectPath, parsed.sessionId).catch(err => {
              log.error(`Failed to save session ID:`, err);
            });
          }
          if (parsed.contextUsage) {
            result.contextUsage = parsed.contextUsage;
            log.info(`[${aiTool}] ${formatContextUsage(parsed.contextUsage)}`);
            // Save context usage for display at start of next prompt
            saveContextUsage(projectPath, parsed.contextUsage).catch(err => {
              log.error(`Failed to save context usage:`, err);
            });
          }

          // Extract text from assistant messages (new format)
          if (json.type === 'assistant' && json.message?.content) {
            for (const block of json.message.content) {
              if (block.type === 'text' && block.text) {
                fullOutput += block.text;
                log.info(`[${aiTool}] +${block.text.length} chars`);
                onOutput(block.text, false);
              } else if (block.type === 'tool_use' && block.name) {
                log.info(`[${aiTool}] 🔧 Using tool: ${block.name}`);
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
            log.info(`[${aiTool}] +${deltaText.length} chars`);
            onOutput(deltaText, false);
          }
          // Also capture tool use for visibility (legacy format)
          else if (json.type === 'stream_event' &&
                   json.event?.type === 'content_block_start' &&
                   json.event?.content_block?.type === 'tool_use') {
            const toolName = json.event.content_block.name;
            log.info(`[${aiTool}] 🔧 Using tool: ${toolName}`);
            onOutput(`\n🔧 ${toolName}を使用中...\n`, false);
          }
          // Capture result for final output
          else if (json.type === 'result') {
            log.info(`[${aiTool}] ✅ Complete (${json.duration_ms}ms)`);
          }
        } catch {
          // Not JSON or parse error - ignore
        }
      }
    });

    proc.stderr?.on('data', (data) => {
      const text = data.toString();
      stderrOutput += text;
      log.error(`[${aiTool}] stderr: ${text}`);
    });

    proc.on('close', (code) => {
      log.info(`[${aiTool}] Process exited with code ${code}`);

      // Detect --resume failure: exit code 1 + no output
      if (code === 1 && fullOutput.length === 0 && options.resumeSessionId) {
        log.info(`[${aiTool}] ⚠️ --resume failed, flagging for retry without session ID`);
        result.resumeFailed = true;
      }

      // "Prompt is too long" などのエラーを stderr から検出
      if (stderrOutput.includes('Prompt is too long') ||
          (stderrOutput.toLowerCase().includes('token') && stderrOutput.toLowerCase().includes('limit'))) {
        log.info(`[${aiTool}] ⚠️ Prompt too long error detected`);
        onOutput('⚠️ プロンプトが長すぎます。`x` コマンドで会話履歴をクリアしてください。', true);
        resolve(result);
        return;
      }

      if (fullOutput.length === 0) {
        onOutput('(No response from AI)', true);
      } else {
        onOutput('', true); // Signal completion
      }
      resolve(result);
    });

    proc.on('error', (err) => {
      log.error(`[${aiTool}] Process error:`, err);
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

  log.info(`Stopping AI session: ${sessionId}`);
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
