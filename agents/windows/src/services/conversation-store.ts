import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

const CONVERSATION_DIR = '.devrelay';
const CONVERSATION_FILE = 'conversation.json';
const ARCHIVE_DIR = 'conversation-archive';  // アーカイブ保存用ディレクトリ
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
 * アーカイブファイルのメタデータ型
 */
export interface ArchivedConversation {
  archivedAt: string;
  messageCount: number;
  firstMessageAt: string | null;
  lastMessageAt: string | null;
  projectPath: string;
  history: ConversationEntry[];
}

/**
 * 会話履歴をアーカイブ保存する
 * クリア前に呼び出して、履歴を日時付きファイルとして退避保存する
 * ファイル名: conversation_YYYYMMDD_HHmmss.json
 *
 * @param projectPath プロジェクトのパス
 * @param history アーカイブする会話履歴
 */
export async function archiveConversation(
  projectPath: string,
  history: ConversationEntry[]
): Promise<void> {
  // 空の履歴はアーカイブしない
  if (history.length === 0) {
    console.log('No conversation to archive (empty history)');
    return;
  }

  const archiveDir = join(projectPath, CONVERSATION_DIR, ARCHIVE_DIR);

  try {
    // アーカイブディレクトリを作成（存在しない場合）
    if (!existsSync(archiveDir)) {
      await mkdir(archiveDir, { recursive: true });
    }

    // ファイル名生成（YYYYMMDD_HHmmss形式）
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    const timestamp = `${year}${month}${day}_${hours}${minutes}${seconds}`;
    const filename = `conversation_${timestamp}.json`;
    const archivePath = join(archiveDir, filename);

    // メタデータ付きでアーカイブデータを作成
    const archiveData: ArchivedConversation = {
      archivedAt: now.toISOString(),
      messageCount: history.length,
      firstMessageAt: history[0]?.timestamp || null,
      lastMessageAt: history[history.length - 1]?.timestamp || null,
      projectPath,
      history
    };

    // ファイルに保存
    await writeFile(archivePath, JSON.stringify(archiveData, null, 2), 'utf-8');
    console.log(`Archived ${history.length} messages to ${filename}`);
  } catch (err) {
    console.error(`Could not archive conversation:`, (err as Error).message);
  }
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

export interface GetContextOptions {
  /** Include plan conversation before exec marker (for exec start) */
  includePlanBeforeExec?: boolean;
  /** Max messages to include from plan (default: 10) */
  maxPlanMessages?: number;
}

/**
 * Get a summary of recent conversation for context
 *
 * Behavior:
 * 1. If exec marker exists in history, return recent maxMessages from the last exec marker
 * 2. If no exec marker, return recent maxMessages from the entire history
 * 3. exec marker itself is not included in context sent to Claude
 * 4. If includePlanBeforeExec is true, also include plan messages before exec marker
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
      console.log(`Including ${planMessages.length} plan messages before exec`);
    }
  }

  // Get messages from after exec marker (or from start if no exec)
  const startIndex = execIndex >= 0 ? execIndex + 1 : 0;
  const messagesAfterExec = history.slice(startIndex);

  // Filter out exec markers and get only user/assistant messages
  const filteredMessages = messagesAfterExec.filter(h => h.role === 'user' || h.role === 'assistant');

  // Limit to maxMessages
  const recentHistory = filteredMessages.slice(-maxMessages);

  console.log(`Context: ${filteredMessages.length} messages after exec, sending ${recentHistory.length}`);

  const currentContext = recentHistory
    .map(h => `${h.role === 'user' ? 'User' : 'Assistant'}: ${h.content}`)
    .join('\n');

  return planContext + currentContext;
}
