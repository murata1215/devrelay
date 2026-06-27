import { readFile, writeFile, mkdir, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';

const SESSION_DIR = '.devrelay';
const SESSION_FILE = 'claude-session-id';
/** セッション ID + モード情報を JSON で保存するファイル */
const SESSION_META_FILE = 'claude-session-meta.json';
const DEVIN_SESSION_FILE = 'devin-session-id';
const CONTEXT_USAGE_FILE = 'context-usage.json';

/** セッションメタ情報（session ID + 前回のモード） */
export interface SessionMeta {
  sessionId: string;
  /** 前回のセッションがどのモードで実行されたか */
  mode: 'plan' | 'exec';
}

export interface StoredContextUsage {
  used: number;
  total: number;
  percentage: number;
  timestamp: string;
}

/**
 * Get the path to the Claude session ID file
 */
function getSessionPath(projectPath: string): string {
  return join(projectPath, SESSION_DIR, SESSION_FILE);
}

/**
 * Load Claude session ID from project directory
 * Returns null if no session exists
 */
export async function loadClaudeSessionId(projectPath: string): Promise<string | null> {
  const filePath = getSessionPath(projectPath);

  try {
    if (!existsSync(filePath)) {
      return null;
    }

    const content = await readFile(filePath, 'utf-8');
    const sessionId = content.trim();

    if (sessionId) {
      console.log(`📋 Loaded Claude session ID: ${sessionId.substring(0, 8)}...`);
      return sessionId;
    }
    return null;
  } catch (err) {
    console.warn(`⚠️ Could not load Claude session ID:`, (err as Error).message);
    return null;
  }
}

/**
 * Save Claude session ID to project directory
 * @param mode 省略時はメタファイルを更新しない（後方互換）
 */
export async function saveClaudeSessionId(projectPath: string, sessionId: string, mode?: 'plan' | 'exec'): Promise<void> {
  const dirPath = join(projectPath, SESSION_DIR);
  const filePath = getSessionPath(projectPath);

  try {
    // Ensure directory exists
    if (!existsSync(dirPath)) {
      await mkdir(dirPath, { recursive: true });
    }

    await writeFile(filePath, sessionId, 'utf-8');

    // モード情報付きメタファイルも保存（Plan→Plan resume 判定用）
    if (mode) {
      const metaPath = join(dirPath, SESSION_META_FILE);
      const meta: SessionMeta = { sessionId, mode };
      await writeFile(metaPath, JSON.stringify(meta), 'utf-8');
    }

    console.log(`💾 Saved Claude session ID: ${sessionId.substring(0, 8)}... (mode=${mode || 'unknown'})`);
  } catch (err) {
    console.error(`❌ Could not save Claude session ID:`, (err as Error).message);
  }
}

/**
 * セッションメタ情報（session ID + モード）を読み込む。
 * Plan モードで前回も Plan だった場合に resume するかの判定に使用。
 */
export async function loadSessionMeta(projectPath: string): Promise<SessionMeta | null> {
  const metaPath = join(projectPath, SESSION_DIR, SESSION_META_FILE);
  try {
    if (!existsSync(metaPath)) return null;
    const content = await readFile(metaPath, 'utf-8');
    return JSON.parse(content) as SessionMeta;
  } catch {
    return null;
  }
}

/**
 * Clear Claude session ID from project directory
 */
export async function clearClaudeSessionId(projectPath: string): Promise<void> {
  const filePath = getSessionPath(projectPath);

  try {
    if (existsSync(filePath)) {
      await unlink(filePath);
      console.log(`🗑️ Cleared Claude session ID`);
    }
  } catch (err) {
    console.warn(`⚠️ Could not clear Claude session ID:`, (err as Error).message);
  }
}

// -----------------------------------------------------------------------------
// Devin セッション ID 管理
// -----------------------------------------------------------------------------

/**
 * Devin セッション ID ファイルのパスを取得
 */
function getDevinSessionPath(projectPath: string): string {
  return join(projectPath, SESSION_DIR, DEVIN_SESSION_FILE);
}

/**
 * Devin セッション ID を読み込む（`-r` でセッション継続に使用）
 */
export async function loadDevinSessionId(projectPath: string): Promise<string | null> {
  const filePath = getDevinSessionPath(projectPath);
  try {
    if (!existsSync(filePath)) return null;
    const content = await readFile(filePath, 'utf-8');
    const sessionId = content.trim();
    if (sessionId) {
      console.log(`📋 Loaded Devin session ID: ${sessionId}`);
      return sessionId;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Devin セッション ID を保存
 */
export async function saveDevinSessionId(projectPath: string, sessionId: string): Promise<void> {
  const dirPath = join(projectPath, SESSION_DIR);
  const filePath = getDevinSessionPath(projectPath);
  try {
    if (!existsSync(dirPath)) {
      await mkdir(dirPath, { recursive: true });
    }
    await writeFile(filePath, sessionId, 'utf-8');
    console.log(`💾 Saved Devin session ID: ${sessionId}`);
  } catch (err) {
    console.error(`❌ Could not save Devin session ID:`, (err as Error).message);
  }
}

/**
 * Devin セッション ID をクリア（`x` コマンドで使用）
 */
export async function clearDevinSessionId(projectPath: string): Promise<void> {
  const filePath = getDevinSessionPath(projectPath);
  try {
    if (existsSync(filePath)) {
      await unlink(filePath);
      console.log(`🗑️ Cleared Devin session ID`);
    }
  } catch {
    // 無視
  }
}

/**
 * Get the path to the context usage file
 */
function getContextUsagePath(projectPath: string): string {
  return join(projectPath, SESSION_DIR, CONTEXT_USAGE_FILE);
}

/**
 * Load previous context usage from project directory
 */
export async function loadContextUsage(projectPath: string): Promise<StoredContextUsage | null> {
  const filePath = getContextUsagePath(projectPath);

  try {
    if (!existsSync(filePath)) {
      return null;
    }

    const content = await readFile(filePath, 'utf-8');
    const data = JSON.parse(content) as StoredContextUsage;
    return data;
  } catch (err) {
    console.warn(`⚠️ Could not load context usage:`, (err as Error).message);
    return null;
  }
}

/**
 * Save context usage to project directory
 */
export async function saveContextUsage(projectPath: string, usage: { used: number; total: number; percentage: number }): Promise<void> {
  const dirPath = join(projectPath, SESSION_DIR);
  const filePath = getContextUsagePath(projectPath);

  try {
    if (!existsSync(dirPath)) {
      await mkdir(dirPath, { recursive: true });
    }

    const data: StoredContextUsage = {
      ...usage,
      timestamp: new Date().toISOString()
    };

    await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error(`❌ Could not save context usage:`, (err as Error).message);
  }
}

/**
 * Clear context usage from project directory
 */
export async function clearContextUsage(projectPath: string): Promise<void> {
  const filePath = getContextUsagePath(projectPath);

  try {
    if (existsSync(filePath)) {
      await unlink(filePath);
    }
  } catch (err) {
    // Ignore errors
  }
}
