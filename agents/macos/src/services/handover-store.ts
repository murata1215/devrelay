import { readFile, readdir, rename, unlink, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { withPathLock, normalizeLockKey } from './path-mutex.js';
import { writeFileAtomic } from './atomic-write.js';
import { resolveScopeDir } from './scope-dir.js';

/**
 * スレッド引継ぎ（`n` コマンド）の Agent 側ストア。
 *
 * - 引継ぎ書の本体は `<projectPath>/doc/handover/` に置く（git で管理され `w` でコミットされる）
 *   - 未使用: `<YYYYMMDD_HHmmss>_<元スレッドID>.md`
 *   - 使用中: `<YYYYMMDD_HHmmss>_<元スレッドID>_<新スレッドID>.md`
 * - 引継ぎ先スレッドの scope dir（`.devrelay/sessions/<scope>/`、旧スレッドは `.devrelay/`）には
 *   使用中の引継ぎを指す `handover.json` だけを置く（本文の控えと「次のプロンプトで必ず注入する」印を含む）
 *
 * 同じ指示（`server:handover:apply`）を 2 回受けても結果は同じ（冪等）。
 * `agents/linux` と `agents/macos` で byte-for-byte 同一内容を維持すること。
 */

/** 引継ぎ書を置くディレクトリ（プロジェクトルートからの相対） */
export const HANDOVER_DIR_SEGMENTS = ['doc', 'handover'] as const;

/** scope dir に置く使用中ポインタのファイル名 */
const ACTIVE_HANDOVER_FILE = 'handover.json';

/** スタンプ（YYYYMMDD_HHmmss）の長さ */
const STAMP_LENGTH = 15;

/** スレッド ID（cuid 等）として安全な文字列か（パス区切り・ドットを含まない） */
export function isSafeHandoverId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(id);
}

/** スタンプの形式検証 */
export function isValidHandoverStamp(stamp: string): boolean {
  return /^\d{8}_\d{6}$/.test(stamp);
}

/** 未使用 / 使用中のファイル名 */
export function handoverFileName(stamp: string, sourceSessionId: string, targetSessionId?: string): string {
  return targetSessionId
    ? `${stamp}_${sourceSessionId}_${targetSessionId}.md`
    : `${stamp}_${sourceSessionId}.md`;
}

/** `name` が `sourceSessionId` の未使用ファイル（`<stamp>_<src>.md`）ならスタンプを返す */
export function unusedHandoverStamp(name: string, sourceSessionId: string): string | null {
  if (name.length !== STAMP_LENGTH + 1 + sourceSessionId.length + 3) return null;
  if (!name.endsWith(`_${sourceSessionId}.md`)) return null;
  const stamp = name.slice(0, STAMP_LENGTH);
  return isValidHandoverStamp(stamp) ? stamp : null;
}

/** 使用中ポインタ（引継ぎ先スレッドの scope dir の handover.json） */
export interface ActiveHandover {
  sourceSessionId: string;
  stamp: string;
  /** `doc/handover/` 内のファイル名 */
  fileName: string;
  /** 本文の控え（ファイルが消された・壊れた場合もこれで注入を続ける） */
  content: string;
  /** true の間は、次のプロンプトで（resume 中の Claude にも）必ず注入する */
  pending: boolean;
  /** 差し替えで入った引継ぎか（注入時に「以前の引継ぎは破棄」の一文を添える） */
  replaced: boolean;
  updatedAt: string;
}

export interface ApplyHandoverInput {
  projectPath: string;
  sourceSessionId: string;
  /** 省略時は `n make`: 未使用ファイルとして保存するだけ（ポインタは書かない） */
  targetSessionId?: string;
  targetAgentScopeId?: string;
  stamp: string;
  content: string;
  previous?: { sourceSessionId: string; stamp: string };
}

function activeHandoverPath(projectPath: string, agentScopeId?: string): string {
  return join(resolveScopeDir(projectPath, agentScopeId), ACTIVE_HANDOVER_FILE);
}

/** 使用中ポインタを読む（無い・壊れている場合は null） */
export async function loadActiveHandover(projectPath: string, agentScopeId?: string): Promise<ActiveHandover | null> {
  let path: string;
  try {
    path = activeHandoverPath(projectPath, agentScopeId);
  } catch {
    return null;
  }
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(await readFile(path, 'utf-8')) as Partial<ActiveHandover>;
    if (typeof data.content !== 'string' || typeof data.sourceSessionId !== 'string') return null;
    return {
      sourceSessionId: data.sourceSessionId,
      stamp: typeof data.stamp === 'string' ? data.stamp : '',
      fileName: typeof data.fileName === 'string' ? data.fileName : '',
      content: data.content,
      pending: data.pending === true,
      replaced: data.replaced === true,
      updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : '',
    };
  } catch (err) {
    console.warn(`⚠️ Could not read active handover (${path}):`, (err as Error).message);
    return null;
  }
}

/**
 * 注入したら pending / replaced を落とす（以後は「履歴を注入する条件」のときだけ注入される）。
 */
export async function markHandoverInjected(projectPath: string, agentScopeId?: string): Promise<void> {
  const path = activeHandoverPath(projectPath, agentScopeId);
  await withPathLock(normalizeLockKey(path), async () => {
    const current = await loadActiveHandover(projectPath, agentScopeId);
    if (!current || (!current.pending && !current.replaced)) return;
    const next: ActiveHandover = { ...current, pending: false, replaced: false, updatedAt: new Date().toISOString() };
    await writeFileAtomic(path, JSON.stringify(next, null, 2));
  });
}

/**
 * 引継ぎ書を doc/handover/ に保存する。
 *
 * `targetSessionId` が無いとき（`n make`）: 未使用ファイル `<stamp>_<元ID>.md` を書き、
 * 同じ元スレッドの古い未使用ファイルを消すだけ（ポインタは書かない）。
 *
 * `targetSessionId` があるとき（`n 1`）: 引継ぎ先スレッドの使用中ポインタも書く。
 * 1. 差し替え前の引継ぎ（previous）がこのスレッドで使用中なら外す:
 *    同じ元スレッドの未使用ファイルか、他スレッドで使用中のコピーが既にあれば削除、無ければ未使用名に戻す
 * 2. 今回の未使用ファイルがあれば使用中名にリネームし、本文を書き込む（無ければ新規作成＝コピー相当）
 * 3. 同じ元スレッドの古い未使用ファイルを消す（未使用は元スレッドごとに最新 1 つだけ）
 * 4. 使用中ポインタ（handover.json）を書く
 *
 * @returns 使用中ファイル名（`doc/handover/` からの相対）
 */
export async function applyHandover(input: ApplyHandoverInput): Promise<{ fileName: string }> {
  const { projectPath, sourceSessionId, targetSessionId, targetAgentScopeId, stamp, content, previous } = input;
  if (!isSafeHandoverId(sourceSessionId) || (targetSessionId !== undefined && !isSafeHandoverId(targetSessionId))) {
    throw new Error('invalid session id');
  }
  if (!isValidHandoverStamp(stamp)) {
    throw new Error('invalid stamp');
  }
  if (previous && (!isSafeHandoverId(previous.sourceSessionId) || !isValidHandoverStamp(previous.stamp))) {
    throw new Error('invalid previous handover');
  }

  const dir = join(projectPath, ...HANDOVER_DIR_SEGMENTS);
  const unusedName = handoverFileName(stamp, sourceSessionId);

  return withPathLock(normalizeLockKey(dir), async () => {
    await mkdir(dir, { recursive: true });

    // `n make`: 未使用ファイルとして保存し、同じ元スレッドの古い未使用ファイルを消す
    if (targetSessionId === undefined) {
      await writeFileAtomic(join(dir, unusedName), content);
      for (const n of await readdir(dir)) {
        const s = unusedHandoverStamp(n, sourceSessionId);
        if (s !== null && s < stamp) {
          await unlink(join(dir, n)).catch(() => {});
          console.log(`🗑️ Old unused handover removed: ${n}`);
        }
      }
      console.log(`📝 Handover note saved: doc/handover/${unusedName}`);
      return { fileName: unusedName };
    }

    const usedName = handoverFileName(stamp, sourceSessionId, targetSessionId);

    // 1. 差し替え前の引継ぎを外す
    if (previous && !(previous.sourceSessionId === sourceSessionId && previous.stamp === stamp)) {
      const prevUsed = handoverFileName(previous.stamp, previous.sourceSessionId, targetSessionId);
      const prevUnused = handoverFileName(previous.stamp, previous.sourceSessionId);
      if (existsSync(join(dir, prevUsed))) {
        const entries = await readdir(dir);
        const hasUnused = entries.some((n) => unusedHandoverStamp(n, previous.sourceSessionId) !== null);
        const hasOtherUsedCopy = entries.some(
          (n) => n !== prevUsed && n.startsWith(`${previous.stamp}_${previous.sourceSessionId}_`) && n.endsWith('.md'),
        );
        if (hasUnused || hasOtherUsedCopy) {
          await unlink(join(dir, prevUsed));
          console.log(`🗑️ Handover detached (deleted): ${prevUsed}`);
        } else {
          await rename(join(dir, prevUsed), join(dir, prevUnused));
          console.log(`↩️ Handover detached (back to unused): ${prevUnused}`);
        }
      }
    }

    // 2. 使用中ファイルを用意する
    if (existsSync(join(dir, unusedName)) && !existsSync(join(dir, usedName))) {
      await rename(join(dir, unusedName), join(dir, usedName));
    }
    await writeFileAtomic(join(dir, usedName), content);

    // 3. 同じ元スレッドの古い未使用ファイルを消す
    for (const n of await readdir(dir)) {
      const s = unusedHandoverStamp(n, sourceSessionId);
      if (s !== null && s < stamp) {
        await unlink(join(dir, n)).catch(() => {});
        console.log(`🗑️ Old unused handover removed: ${n}`);
      }
    }

    // 4. 使用中ポインタを書く
    const pointerPath = activeHandoverPath(projectPath, targetAgentScopeId);
    await withPathLock(normalizeLockKey(pointerPath), async () => {
      const before = await loadActiveHandover(projectPath, targetAgentScopeId);
      const replaced = !!before && !(before.sourceSessionId === sourceSessionId && before.stamp === stamp)
        ? true
        : (before?.replaced ?? false);
      const next: ActiveHandover = {
        sourceSessionId,
        stamp,
        fileName: usedName,
        content,
        pending: true,
        replaced,
        updatedAt: new Date().toISOString(),
      };
      await mkdir(resolveScopeDir(projectPath, targetAgentScopeId), { recursive: true });
      await writeFileAtomic(pointerPath, JSON.stringify(next, null, 2));
    });

    console.log(`📋 Handover applied: doc/handover/${usedName}`);
    return { fileName: usedName };
  });
}

/**
 * AI に渡す【前スレッドからの引継ぎ】ブロックを組み立てる。
 * 本文は控え（handover.json の content）を使い、ファイルの場所も添えて AI が全文を読めるようにする。
 */
export function formatHandoverForPrompt(handover: ActiveHandover, language?: string): string {
  const filePath = handover.fileName ? `doc/handover/${handover.fileName}` : '';
  if (language === 'en') {
    const replacedLine = handover.replaced
      ? 'The previous handover given to this thread is discarded and replaced by the one below.\n'
      : '';
    return (
      '\n\n--- Handover from the previous thread ---\n' +
      replacedLine +
      'This thread continues work from another thread. Use the handover note below as the starting context' +
      (filePath ? ` (full text: ${filePath})` : '') +
      '.\n\n' +
      handover.content.trim() +
      '\n--- End of handover ---'
    );
  }
  const replacedLine = handover.replaced ? '以前の引継ぎは破棄し、以下に置き換えます。\n' : '';
  return (
    '\n\n--- 【前スレッドからの引継ぎ】 ---\n' +
    replacedLine +
    'このスレッドは別のスレッドの作業の続きです。以下の引継ぎ書を前提として作業してください' +
    (filePath ? `（全文: ${filePath}）` : '') +
    '。\n\n' +
    handover.content.trim() +
    '\n--- 【引継ぎここまで】 ---'
  );
}
