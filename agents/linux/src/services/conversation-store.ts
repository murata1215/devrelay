import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

const CONVERSATION_DIR = '.devrelay';
const CONVERSATION_FILE = 'conversation.json';
const MAX_CONTEXT_MESSAGES = 20;  // Claudeに送る最大メッセージ数（保存は無制限）

export interface ConversationEntry {
  role: 'user' | 'assistant' | 'exec';  // 'exec' = 実行モード開始マーカー
  content: string;
  timestamp: string;
}

export interface ConversationData {
  projectPath: string;
  lastUpdated: string;
  history: ConversationEntry[];
}

function getConversationPath(projectPath: string): string {
  return join(projectPath, CONVERSATION_DIR, CONVERSATION_FILE);
}

/**
 * Load conversation history from project directory
 */
export async function loadConversation(projectPath: string): Promise<ConversationEntry[]> {
  const filePath = getConversationPath(projectPath);

  try {
    if (!existsSync(filePath)) {
      return [];
    }

    const content = await readFile(filePath, 'utf-8');
    const data: ConversationData = JSON.parse(content);

    console.log(`📜 Loaded ${data.history.length} messages from conversation history`);
    return data.history;
  } catch (err) {
    console.warn(`⚠️ Could not load conversation history:`, (err as Error).message);
    return [];
  }
}

/**
 * Save conversation history to project directory
 * 保存は無制限、Claudeに送るのは直近20件のみ
 */
export async function saveConversation(
  projectPath: string,
  history: ConversationEntry[]
): Promise<void> {
  const dirPath = join(projectPath, CONVERSATION_DIR);
  const filePath = getConversationPath(projectPath);

  try {
    // Ensure directory exists
    if (!existsSync(dirPath)) {
      await mkdir(dirPath, { recursive: true });
    }

    const data: ConversationData = {
      projectPath,
      lastUpdated: new Date().toISOString(),
      history
    };

    await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error(`❌ Could not save conversation history:`, (err as Error).message);
  }
}

/**
 * Append a message to conversation and save
 */
export async function appendToConversation(
  projectPath: string,
  history: ConversationEntry[],
  role: 'user' | 'assistant',
  content: string
): Promise<ConversationEntry[]> {
  const entry: ConversationEntry = {
    role,
    content,
    timestamp: new Date().toISOString()
  };

  const updatedHistory = [...history, entry];
  await saveConversation(projectPath, updatedHistory);

  return updatedHistory;
}

/**
 * Clear conversation history for a project
 */
export async function clearConversation(projectPath: string): Promise<void> {
  await saveConversation(projectPath, []);
  console.log(`🗑️ Conversation history cleared for ${projectPath}`);
}

/**
 * Mark exec point in conversation history
 * This creates a reset point for context - only messages after exec are sent to Claude
 */
export async function markExecPoint(
  projectPath: string,
  history: ConversationEntry[]
): Promise<ConversationEntry[]> {
  const entry: ConversationEntry = {
    role: 'exec',
    content: '--- EXEC: Implementation Started ---',
    timestamp: new Date().toISOString()
  };

  const updatedHistory = [...history, entry];
  await saveConversation(projectPath, updatedHistory);
  console.log(`🚀 Exec point marked at position ${updatedHistory.length}`);

  return updatedHistory;
}

export interface GetContextOptions {
  /** Include plan conversation before exec marker (for exec start) */
  includePlanBeforeExec?: boolean;
  /** Max messages to include from plan (default: 10) */
  maxPlanMessages?: number;
}

/**
 * Get a summary of recent conversation for context
 *
 * 動作:
 * 1. 履歴に exec マーカーがある場合、最後の exec から数えて直近 maxMessages 件を返す
 * 2. exec マーカーがない場合、全体から直近 maxMessages 件を返す
 * 3. exec マーカー自体は Claude に送るコンテキストには含めない
 * 4. includePlanBeforeExec が true の場合、exec マーカー前のプラン会話も含める
 */
export function getConversationContext(
  history: ConversationEntry[],
  maxMessages: number = MAX_CONTEXT_MESSAGES,
  options: GetContextOptions = {}
): string {
  if (history.length === 0) {
    return '';
  }

  const { includePlanBeforeExec = false, maxPlanMessages = 10 } = options;

  // Find the last exec marker
  let execIndex = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'exec') {
      execIndex = i;
      break;
    }
  }

  // If includePlanBeforeExec and exec marker exists, include plan messages
  let planContext = '';
  if (includePlanBeforeExec && execIndex >= 0) {
    // Get messages before exec marker (the plan conversation)
    const planMessages = history.slice(0, execIndex)
      .filter(h => h.role === 'user' || h.role === 'assistant')
      .slice(-maxPlanMessages);

    if (planMessages.length > 0) {
      planContext = '--- Previous Plan Conversation ---\n' +
        planMessages
          .map(h => `${h.role === 'user' ? 'User' : 'Assistant'}: ${h.content}`)
          .join('\n') +
        '\n--- End of Plan ---\n\n';
      console.log(`📚 Including ${planMessages.length} plan messages before exec`);
    }
  }

  // Get messages from after exec marker (or from start if no exec)
  const startIndex = execIndex >= 0 ? execIndex + 1 : 0;
  const messagesAfterExec = history.slice(startIndex);

  // Filter out exec markers and get only user/assistant messages
  const filteredMessages = messagesAfterExec.filter(h => h.role === 'user' || h.role === 'assistant');

  // Limit to maxMessages
  const recentHistory = filteredMessages.slice(-maxMessages);

  console.log(`📚 Context: ${filteredMessages.length} messages after exec, sending ${recentHistory.length}`);

  const currentContext = recentHistory
    .map(h => `${h.role === 'user' ? 'User' : 'Assistant'}: ${h.content}`)
    .join('\n');

  return planContext + currentContext;
}
