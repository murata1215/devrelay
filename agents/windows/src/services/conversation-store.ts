import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

const CONVERSATION_DIR = '.devrelay';
const CONVERSATION_FILE = 'conversation.json';
const MAX_CONTEXT_MESSAGES = 20;  // Max messages to send to Claude (save is unlimited)

export interface ConversationEntry {
  role: 'user' | 'assistant' | 'exec';  // 'exec' = execution mode start marker
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

    console.log(`Loaded ${data.history.length} messages from conversation history`);
    return data.history;
  } catch (err) {
    console.warn(`Could not load conversation history:`, (err as Error).message);
    return [];
  }
}

/**
 * Save conversation history to project directory
 * Save is unlimited, only send recent 20 to Claude (token savings)
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
    console.error(`Could not save conversation history:`, (err as Error).message);
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
  console.log(`Conversation history cleared for ${projectPath}`);
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
  console.log(`Exec point marked at position ${updatedHistory.length}`);

  return updatedHistory;
}

/**
 * Get a summary of recent conversation for context
 *
 * Behavior:
 * 1. If exec marker exists in history, return recent maxMessages from the last exec marker
 * 2. If no exec marker, return recent maxMessages from the entire history
 * 3. exec marker itself is not included in context sent to Claude
 */
export function getConversationContext(
  history: ConversationEntry[],
  maxMessages: number = MAX_CONTEXT_MESSAGES
): string {
  if (history.length === 0) {
    return '';
  }

  // Find the last exec marker
  let startIndex = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'exec') {
      startIndex = i + 1;  // Start from the message after exec
      break;
    }
  }

  // Get messages from startIndex onwards
  const messagesAfterExec = history.slice(startIndex);

  // Filter out exec markers and get only user/assistant messages
  const filteredMessages = messagesAfterExec.filter(h => h.role === 'user' || h.role === 'assistant');

  // Limit to maxMessages
  const recentHistory = filteredMessages.slice(-maxMessages);

  console.log(`Context: ${filteredMessages.length} messages after exec, sending ${recentHistory.length}`);

  return recentHistory
    .map(h => `${h.role === 'user' ? 'User' : 'Assistant'}: ${h.content}`)
    .join('\n');
}
