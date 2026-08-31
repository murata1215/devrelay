import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { withPathLock, normalizeLockKey } from './path-mutex.js';
import { writeFileAtomic } from './atomic-write.js';

const CONVERSATION_DIR = '.devrelay';
const CONVERSATION_FILE = 'conversation.json';
const ARCHIVE_DIR = 'conversation-archive';  // アーカイブ保存用ディレクトリ
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
 * `saveConversation` のアトミック書き込み版（#348: 層 B 第 2 の防御）。
 * temp へ書いて rename する `writeFileAtomic` を使うため、書き込み途中のファイルを
 * 他プロセス/他セッションが読んでしまう事故を防ぐ。`saveConversation` 自体は
 * 既存呼び出し元（`connection.ts` の直接呼び出し等）との後方互換のため無変更で残す。
 */
async function saveConversationAtomic(
  projectPath: string,
  history: ConversationEntry[]
): Promise<void> {
  const dirPath = join(projectPath, CONVERSATION_DIR);
  const filePath = getConversationPath(projectPath);

  try {
    if (!existsSync(dirPath)) {
      await mkdir(dirPath, { recursive: true });
    }

    const data: ConversationData = {
      projectPath,
      lastUpdated: new Date().toISOString(),
      history
    };

    await writeFileAtomic(filePath, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error(`❌ Could not save conversation history (atomic):`, (err as Error).message);
  }
}

/**
 * 会話履歴を排他的に読み替えて保存する（#348）。
 * ロックを取ってから「再読み込み → 変換 → アトミック書き込み」を行うため、
 * 同一プロジェクトに複数セッションが同時に書いても lost update が起きない。
 * （#348: 実測で 83 → 82 → 81 と件数が減る lost update を確認したための対策）
 *
 * @param projectPath プロジェクトのパス
 * @param mutator 現在の履歴を受け取り、新しい履歴を返す純関数
 */
export async function mutateConversation(
  projectPath: string,
  mutator: (current: ConversationEntry[]) => ConversationEntry[]
): Promise<ConversationEntry[]> {
  const lockKey = normalizeLockKey(getConversationPath(projectPath));

  return withPathLock(lockKey, async () => {
    const current = await loadConversation(projectPath);
    const updated = mutator(current);
    await saveConversationAtomic(projectPath, updated);
    return updated;
  });
}

/**
 * Append a message to conversation and save
 * （#348: 内部実装を `mutateConversation` 経由に差し替え。引数・戻り値の型は無変更）
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

  return mutateConversation(projectPath, (current) => [...current, entry]);
}

/**
 * Clear conversation history for a project
 */
export async function clearConversation(projectPath: string): Promise<void> {
  await saveConversation(projectPath, []);
  console.log(`🗑️ Conversation history cleared for ${projectPath}`);
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
    console.log('📋 No conversation to archive (empty history)');
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
    console.log(`📦 Archived ${history.length} messages to ${filename}`);
  } catch (err) {
    console.error(`❌ Could not archive conversation:`, (err as Error).message);
  }
}

/**
 * Mark exec point in conversation history
 * This creates a reset point for context - only messages after exec are sent to Claude
 * （#348: 内部実装を `mutateConversation` 経由に差し替え。引数・戻り値の型は無変更）
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

  const updatedHistory = await mutateConversation(projectPath, (current) => [...current, entry]);
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
