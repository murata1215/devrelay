import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

const CONVERSATION_DIR = '.devbridge';
const CONVERSATION_FILE = 'conversation.json';
const MAX_CONTEXT_MESSAGES = 20;  // Claudeに送る最大メッセージ数（保存は無制限）

export interface ConversationEntry {
  role: 'user' | 'assistant';
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
 * Get a summary of recent conversation for context
 * Limits to last N messages to avoid token overflow
 */
export function getConversationContext(
  history: ConversationEntry[],
  maxMessages: number = MAX_CONTEXT_MESSAGES
): string {
  if (history.length === 0) {
    return '';
  }

  const recentHistory = history.slice(-maxMessages);

  return recentHistory
    .map(h => `${h.role === 'user' ? 'User' : 'Assistant'}: ${h.content}`)
    .join('\n');
}
