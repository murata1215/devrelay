import { readFile, writeFile, mkdir, unlink, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { resolveScopeDir } from './scope-dir.js';

const SESSION_FILE = 'claude-session-id';
const DEVIN_SESSION_FILE = 'devin-session-id';
/** このサイクル: Devin セッション作成時に使用したモデルを記録するファイル（resume時のモデル一致判定用） */
const DEVIN_MODEL_FILE = 'devin-model';
/** #365: 前ターン終了時点の ATIF 累計ステップ数を記録するファイル（今回分だけの表示に使う差分の基準） */
const DEVIN_ATIF_STEP_OFFSET_FILE = 'devin-atif-step-offset';
/** #368 Phase2a: Devin セッション作成時に使用したパーミッションモードを記録するファイル（resume 時のモード一致判定用） */
const DEVIN_PERMISSION_MODE_FILE = 'devin-permission-mode';
const CODEX_SESSION_FILE = 'codex-session-id';
const CONTEXT_USAGE_FILE = 'context-usage.json';

export interface StoredContextUsage {
  used: number;
  total: number;
  percentage: number;
  timestamp: string;
}

/**
 * Get the path to the Claude session ID file
 * @param agentScopeId core#336: 指定時は `<projectPath>/.devrelay/sessions/<agentScopeId>/` 配下を使う（省略時は従来どおり `.devrelay/` 直下）
 */
function getSessionPath(projectPath: string, agentScopeId?: string): string {
  return join(resolveScopeDir(projectPath, agentScopeId), SESSION_FILE);
}

/**
 * Load Claude session ID from project directory
 * Returns null if no session exists
 */
export async function loadClaudeSessionId(projectPath: string, agentScopeId?: string): Promise<string | null> {
  const filePath = getSessionPath(projectPath, agentScopeId);

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
 */
export async function saveClaudeSessionId(projectPath: string, sessionId: string, agentScopeId?: string): Promise<void> {
  const dirPath = resolveScopeDir(projectPath, agentScopeId);
  const filePath = getSessionPath(projectPath, agentScopeId);

  try {
    // Ensure directory exists
    if (!existsSync(dirPath)) {
      await mkdir(dirPath, { recursive: true });
    }

    await writeFile(filePath, sessionId, 'utf-8');
    console.log(`💾 Saved Claude session ID: ${sessionId.substring(0, 8)}...`);
  } catch (err) {
    console.error(`❌ Could not save Claude session ID:`, (err as Error).message);
  }
}

/**
 * Clear Claude session ID from project directory
 */
export async function clearClaudeSessionId(projectPath: string, agentScopeId?: string): Promise<void> {
  const filePath = getSessionPath(projectPath, agentScopeId);

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
 * ログ表示用にスコープ識別子を整形する（`agentScopeId` 未指定 = 対話経路の従来スコープ）。
 * Devin のスレッド跨ぎ文脈汚染サイクル: load/save の scope が一致しているかを agent.log 上で
 * 突き合わせられるようにするための表示専用ヘルパー。
 */
function scopeLabel(agentScopeId?: string): string {
  return agentScopeId ?? 'default';
}

function getDevinSessionPath(projectPath: string, agentScopeId?: string): string {
  return join(resolveScopeDir(projectPath, agentScopeId), DEVIN_SESSION_FILE);
}

/** Devin セッション ID を読み込む */
export async function loadDevinSessionId(projectPath: string, agentScopeId?: string): Promise<string | null> {
  const filePath = getDevinSessionPath(projectPath, agentScopeId);
  try {
    if (!existsSync(filePath)) return null;
    const content = await readFile(filePath, 'utf-8');
    const sessionId = content.trim();
    if (sessionId) {
      console.log(`📋 Loaded Devin session ID: ${sessionId} (scope: ${scopeLabel(agentScopeId)})`);
      return sessionId;
    }
    return null;
  } catch { return null; }
}

/** Devin セッション ID を保存 */
export async function saveDevinSessionId(projectPath: string, sessionId: string, agentScopeId?: string): Promise<void> {
  const dirPath = resolveScopeDir(projectPath, agentScopeId);
  const filePath = getDevinSessionPath(projectPath, agentScopeId);
  try {
    if (!existsSync(dirPath)) await mkdir(dirPath, { recursive: true });
    await writeFile(filePath, sessionId, 'utf-8');
    console.log(`💾 Saved Devin session ID: ${sessionId} (scope: ${scopeLabel(agentScopeId)})`);
  } catch (err) { console.error(`❌ Could not save Devin session ID:`, (err as Error).message); }
}

/** Devin セッション ID をクリア */
export async function clearDevinSessionId(projectPath: string, agentScopeId?: string): Promise<void> {
  const filePath = getDevinSessionPath(projectPath, agentScopeId);
  try { if (existsSync(filePath)) { await unlink(filePath); console.log(`🗑️ Cleared Devin session ID (scope: ${scopeLabel(agentScopeId)})`); } } catch {}
}

/**
 * Devin のスレッド跨ぎ文脈汚染サイクル: `projectPath` 配下の全スコープ（default scope +
 * 全 `agentScopeId` スコープ）に保存済みの Devin セッション ID を走査し、
 * `セッション ID → スコープキー`（`'default'` または `agentScopeId`）の対応を返す。
 * `devin list` から新たに採用しようとしている ID が既に別スレッドのものであることを
 * 検出する専用の read-only ヘルパー（`ai-runner.ts` の `pickDevinSessionId()` から使う）。
 * @param projectPath プロジェクトのルートパス
 * @returns 発見した Devin セッション ID → スコープキーの Map。走査自体は best-effort で
 *   例外を投げない（読めないスコープ・ディレクトリが無い等はすべて無視して空 Map 側に倒す）
 */
export async function listDevinSessionOwners(projectPath: string): Promise<Map<string, string>> {
  const owners = new Map<string, string>();

  const readOwner = async (filePath: string, scopeKey: string): Promise<void> => {
    try {
      if (!existsSync(filePath)) return;
      const id = (await readFile(filePath, 'utf-8')).trim();
      if (id && !owners.has(id)) owners.set(id, scopeKey);
    } catch {
      // best-effort: 読めないスコープは無視する
    }
  };

  // default scope（agentScopeId 未指定の対話経路／レガシースレッド）
  await readOwner(getDevinSessionPath(projectPath), 'default');

  // スコープ付き（`.devrelay/sessions/<agentScopeId>/devin-session-id`）。
  // ディレクトリ名 'sessions' は scope-dir.ts の SCOPED_SESSIONS_DIR と一致させる必要がある。
  const scopedRoot = join(projectPath, '.devrelay', 'sessions');
  try {
    if (existsSync(scopedRoot)) {
      const scopeDirs = await readdir(scopedRoot, { withFileTypes: true });
      for (const entry of scopeDirs) {
        if (!entry.isDirectory()) continue;
        await readOwner(join(scopedRoot, entry.name, DEVIN_SESSION_FILE), entry.name);
      }
    }
  } catch {
    // best-effort: ディレクトリが読めない場合は無視する
  }

  return owners;
}

/**
 * Devin モデル記録ファイルのパスを取得
 * （このサイクル: `devin -r` はモデル指定を無視するため、resume 判定に使う）
 */
function getDevinModelPath(projectPath: string, agentScopeId?: string): string {
  return join(resolveScopeDir(projectPath, agentScopeId), DEVIN_MODEL_FILE);
}

/** 直近の Devin ターンで使用したモデルを読み込む（未指定時は空文字列を保存しているため `''` が返ることもある） */
export async function loadDevinModel(projectPath: string, agentScopeId?: string): Promise<string | null> {
  const filePath = getDevinModelPath(projectPath, agentScopeId);
  try {
    if (!existsSync(filePath)) return null;
    const content = await readFile(filePath, 'utf-8');
    return content.trim();
  } catch { return null; }
}

/**
 * 今回の Devin ターンで実際に使用されたモデルを保存する。
 * 2026-10-02 修正: 「要求したモデル」ではなく ATIF で実測できた実際のモデルを渡すこと
 * （要求値を保存すると、Devin が黙って別モデルへ振り替えた場合に誤判定が永久に固定される事故が
 * あったため）。実測できなかった場合は呼び出さない（前回までの実測値を上書きしない）。
 * 2026-10-08 訂正: 「実際のモデル ID」と書いていたが、ATIF は機械可読 slug の代わりに
 * 人間可読の表示名（`agent.model_name`、例: `Claude Opus 5.5`）しか返せないことがある
 * （古い Devin CLI 実機で確認）。ここに渡す値は slug でも表示名でもよい — 比較は常に
 * 読み出し側（`normalizeDevinModelId()`）で正規化してから行う。
 */
export async function saveDevinModel(projectPath: string, model: string, agentScopeId?: string): Promise<void> {
  const dirPath = resolveScopeDir(projectPath, agentScopeId);
  const filePath = getDevinModelPath(projectPath, agentScopeId);
  try {
    if (!existsSync(dirPath)) await mkdir(dirPath, { recursive: true });
    await writeFile(filePath, model, 'utf-8');
  } catch (err) { console.error(`❌ Could not save Devin model:`, (err as Error).message); }
}

/** Devin モデル記録をクリア（`x` コマンドで使用、`clearDevinSessionId()` と対で呼ぶ） */
export async function clearDevinModel(projectPath: string, agentScopeId?: string): Promise<void> {
  const filePath = getDevinModelPath(projectPath, agentScopeId);
  try { if (existsSync(filePath)) { await unlink(filePath); } } catch {}
}

/**
 * #365: ATIF 累計ステップ数オフセットファイルのパスを取得
 * （devin セッションが resume されるたびに --export が全トラジェクトリを書き直すため、
 * 「前ターンまでに何ステップあったか」を記録しておき、今回ターン分だけを差分表示するために使う）
 */
function getDevinAtifStepOffsetPath(projectPath: string, agentScopeId?: string): string {
  return join(resolveScopeDir(projectPath, agentScopeId), DEVIN_ATIF_STEP_OFFSET_FILE);
}

/** 前ターン終了時点の ATIF 累計ステップ数を読み込む（未保存 or 不正な値は null） */
export async function loadDevinAtifStepOffset(projectPath: string, agentScopeId?: string): Promise<number | null> {
  const filePath = getDevinAtifStepOffsetPath(projectPath, agentScopeId);
  try {
    if (!existsSync(filePath)) return null;
    const content = await readFile(filePath, 'utf-8');
    const n = Number(content.trim());
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

/** 今回ターン終了時点の ATIF 累計ステップ数を保存（次回ターンのオフセットとして使われる） */
export async function saveDevinAtifStepOffset(projectPath: string, offset: number, agentScopeId?: string): Promise<void> {
  const dirPath = resolveScopeDir(projectPath, agentScopeId);
  const filePath = getDevinAtifStepOffsetPath(projectPath, agentScopeId);
  try {
    if (!existsSync(dirPath)) await mkdir(dirPath, { recursive: true });
    await writeFile(filePath, String(offset), 'utf-8');
  } catch (err) { console.error(`❌ Could not save Devin ATIF step offset:`, (err as Error).message); }
}

/**
 * ATIF 累計ステップ数オフセットをクリア（`x` コマンド / resume 失敗 / モデル変更時に
 * `clearDevinSessionId()` + `clearDevinModel()` と併せて呼ぶ）
 */
export async function clearDevinAtifStepOffset(projectPath: string, agentScopeId?: string): Promise<void> {
  const filePath = getDevinAtifStepOffsetPath(projectPath, agentScopeId);
  try { if (existsSync(filePath)) { await unlink(filePath); } } catch {}
}

/**
 * #368 Phase2a: Devin パーミッションモードマーカーファイルのパスを取得
 * （Devin セッションはパーミッションモードを引き継ぐため、resume 時に前回と今回のモードが
 * 一致するかどうかを判定するのに使う）
 */
function getDevinPermissionModePath(projectPath: string, agentScopeId?: string): string {
  return join(resolveScopeDir(projectPath, agentScopeId), DEVIN_PERMISSION_MODE_FILE);
}

/** 前回 Devin セッション作成時に使用したパーミッションモードを読み込む（未保存 or 読み取り失敗は null） */
export async function loadDevinPermissionMode(projectPath: string, agentScopeId?: string): Promise<string | null> {
  const filePath = getDevinPermissionModePath(projectPath, agentScopeId);
  try {
    if (!existsSync(filePath)) return null;
    const content = await readFile(filePath, 'utf-8');
    const mode = content.trim();
    return mode ? mode : null;
  } catch { return null; }
}

/** 今回ターンで実際に Devin へ渡したパーミッションモードを保存（次回ターンの resume 一致判定に使う） */
export async function saveDevinPermissionMode(projectPath: string, mode: string, agentScopeId?: string): Promise<void> {
  const dirPath = resolveScopeDir(projectPath, agentScopeId);
  const filePath = getDevinPermissionModePath(projectPath, agentScopeId);
  try {
    if (!existsSync(dirPath)) await mkdir(dirPath, { recursive: true });
    await writeFile(filePath, mode, 'utf-8');
  } catch (err) { console.error(`❌ Could not save Devin permission mode:`, (err as Error).message); }
}

/**
 * Devin パーミッションモードマーカーをクリア（`x` コマンド / resume 失敗時に
 * `clearDevinSessionId()` + `clearDevinModel()` + `clearDevinAtifStepOffset()` と併せて呼ぶ）
 */
export async function clearDevinPermissionMode(projectPath: string, agentScopeId?: string): Promise<void> {
  const filePath = getDevinPermissionModePath(projectPath, agentScopeId);
  try { if (existsSync(filePath)) { await unlink(filePath); } } catch {}
}

// -----------------------------------------------------------------------------
// Codex CLI セッション（thread_id）管理（#308）
// -----------------------------------------------------------------------------

function getCodexSessionPath(projectPath: string, agentScopeId?: string): string {
  return join(resolveScopeDir(projectPath, agentScopeId), CODEX_SESSION_FILE);
}

/** Codex セッション ID（thread_id）を読み込む */
export async function loadCodexSessionId(projectPath: string, agentScopeId?: string): Promise<string | null> {
  const filePath = getCodexSessionPath(projectPath, agentScopeId);
  try {
    if (!existsSync(filePath)) return null;
    const content = await readFile(filePath, 'utf-8');
    const sessionId = content.trim();
    if (sessionId) {
      console.log(`📋 Loaded Codex session ID: ${sessionId}`);
      return sessionId;
    }
    return null;
  } catch { return null; }
}

/** Codex セッション ID（thread_id）を保存 */
export async function saveCodexSessionId(projectPath: string, sessionId: string, agentScopeId?: string): Promise<void> {
  const dirPath = resolveScopeDir(projectPath, agentScopeId);
  const filePath = getCodexSessionPath(projectPath, agentScopeId);
  try {
    if (!existsSync(dirPath)) await mkdir(dirPath, { recursive: true });
    await writeFile(filePath, sessionId, 'utf-8');
    console.log(`💾 Saved Codex session ID: ${sessionId}`);
  } catch (err) { console.error(`❌ Could not save Codex session ID:`, (err as Error).message); }
}

/** Codex セッション ID をクリア */
export async function clearCodexSessionId(projectPath: string, agentScopeId?: string): Promise<void> {
  const filePath = getCodexSessionPath(projectPath, agentScopeId);
  try { if (existsSync(filePath)) { await unlink(filePath); console.log(`🗑️ Cleared Codex session ID`); } } catch {}
}

/**
 * Get the path to the context usage file
 */
function getContextUsagePath(projectPath: string, agentScopeId?: string): string {
  return join(resolveScopeDir(projectPath, agentScopeId), CONTEXT_USAGE_FILE);
}

/**
 * Load previous context usage from project directory
 */
export async function loadContextUsage(projectPath: string, agentScopeId?: string): Promise<StoredContextUsage | null> {
  const filePath = getContextUsagePath(projectPath, agentScopeId);

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
export async function saveContextUsage(projectPath: string, usage: { used: number; total: number; percentage: number }, agentScopeId?: string): Promise<void> {
  const dirPath = resolveScopeDir(projectPath, agentScopeId);
  const filePath = getContextUsagePath(projectPath, agentScopeId);

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
export async function clearContextUsage(projectPath: string, agentScopeId?: string): Promise<void> {
  const filePath = getContextUsagePath(projectPath, agentScopeId);

  try {
    if (existsSync(filePath)) {
      await unlink(filePath);
    }
  } catch (err) {
    // Ignore errors
  }
}
