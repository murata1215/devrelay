/**
 * サイクル P3-A: skill ツリーの安全な I/O 操作（`devin-skill-adapter.ts` 専用）。
 *
 * `devin-skill-rules.ts`（判断ロジック）とは異なり、本ファイルは実ファイルシステムを操作する。
 * すべての再帰走査は **`lstat` のみ**を使い、symlink はコピーせずスキップする
 * （`fs.cp(recursive)` は `dereference:false` でも symlink を作り直すため意図的に使わない）。
 * FIFO/socket/device 等の特殊ファイルも同様にスキップする。
 *
 * `SkillTreeOps` としてまとめて export し、adapter のテストで fake に差し替えられる seam にする。
 */
import { lstat, readdir, mkdir, copyFile, readFile, rm, rename, stat, unlink } from 'fs/promises';
import { join, relative, resolve, sep, isAbsolute } from 'path';
import { createHash } from 'crypto';

export interface TreeLimits {
  /** 合計バイト数上限 */
  maxBytes: number;
  /** ファイル数上限 */
  maxFiles: number;
  /** 再帰深さ上限 */
  maxDepth: number;
}

export type CopyTreeResult =
  | { ok: true; fileCount: number; totalBytes: number }
  | { ok: false; reason: 'too-large' | 'too-many-files' | 'too-deep' };

interface CopyState {
  fileCount: number;
  totalBytes: number;
}

async function copyTreeRecursive(
  src: string,
  dest: string,
  limits: TreeLimits,
  depth: number,
  state: CopyState,
): Promise<CopyTreeResult | null> {
  if (depth > limits.maxDepth) return { ok: false, reason: 'too-deep' };
  await mkdir(dest, { recursive: true });
  const entries = await readdir(src);
  for (const name of [...entries].sort()) {
    const srcPath = join(src, name);
    const destPath = join(dest, name);
    const st = await lstat(srcPath);
    if (st.isSymbolicLink()) continue; // symlink は作り直さない（clone 外を指すリンク対策）
    if (st.isDirectory()) {
      const failure = await copyTreeRecursive(srcPath, destPath, limits, depth + 1, state);
      if (failure) return failure;
      continue;
    }
    if (!st.isFile()) continue; // FIFO/socket/device 等はスキップ
    state.fileCount++;
    if (state.fileCount > limits.maxFiles) return { ok: false, reason: 'too-many-files' };
    state.totalBytes += st.size;
    if (state.totalBytes > limits.maxBytes) return { ok: false, reason: 'too-large' };
    await copyFile(srcPath, destPath);
  }
  return null;
}

/**
 * `src` の内容を `dest` へ symlink 安全に再帰コピーする。
 * 上限（バイト数/ファイル数/深さ）を超えた時点で中断し、`ok:false` を返す
 * （`dest` は部分的にコピーされた状態になり得るが、呼び出し側は staging ディレクトリを
 * 丸ごと破棄するだけでよい設計のため実害はない）。
 */
export async function copyTreeSafe(src: string, dest: string, limits: TreeLimits): Promise<CopyTreeResult> {
  const state: CopyState = { fileCount: 0, totalBytes: 0 };
  const failure = await copyTreeRecursive(src, dest, limits, 0, state);
  if (failure) return failure;
  return { ok: true, fileCount: state.fileCount, totalBytes: state.totalBytes };
}

async function listFilesSorted(dir: string, base: string): Promise<string[]> {
  const result: string[] = [];
  const entries = await readdir(dir);
  for (const name of [...entries].sort()) {
    const full = join(dir, name);
    const st = await lstat(full);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      result.push(...(await listFilesSorted(full, base)));
    } else if (st.isFile()) {
      result.push(relative(base, full));
    }
  }
  return result;
}

/**
 * ディレクトリ内容の決定的な sha256 ハッシュを計算する（相対パス + 内容を連結してハッシュ化）。
 * symlink は無視する（`copyTreeSafe` と対称の扱い）。
 * @returns `sha256:<hex>` 形式の文字列
 */
export async function hashTree(dir: string): Promise<string> {
  const files = (await listFilesSorted(dir, dir)).sort();
  const hash = createHash('sha256');
  for (const relPath of files) {
    const normalized = relPath.split(sep).join('/');
    hash.update(normalized);
    hash.update('\0');
    const content = await readFile(join(dir, relPath));
    hash.update(content);
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

/**
 * `child` が `resolve(parent)` 配下に完全に含まれるかをテキスト（`path.relative`）ベースで検査する。
 * 正規化すり抜け（`../` 等）を検出するための最終防衛線。
 */
export function isContainedPath(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  if (rel === '') return true;
  return !rel.startsWith('..') && !isAbsolute(rel);
}

export type AtomicSwapResult = { ok: true } | { ok: false; error: string };

/**
 * `stagingDir` を `destDir` にアトミックに差し替える。
 * 1. `destDir` が既存なら `trashDir` へ退避（rename）
 * 2. `stagingDir` → `destDir` へ rename
 * 3. `trashDir` を削除（失敗しても無害）
 * 4. 手順2が失敗したら `trashDir` → `destDir` にロールバックする
 *
 * 両 rename は同一ファイルシステム内であることが前提（`EXDEV` で失敗し得る。呼び出し側は
 * staging/trash を `skillsDir` と同じディレクトリ配下に置くこと）。
 */
export async function atomicSwapDir(stagingDir: string, destDir: string, trashDir: string): Promise<AtomicSwapResult> {
  let destExisted = false;
  try {
    await stat(destDir);
    destExisted = true;
  } catch {
    destExisted = false;
  }

  if (destExisted) {
    try {
      await rename(destDir, trashDir);
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  try {
    await rename(stagingDir, destDir);
  } catch (err) {
    if (destExisted) {
      try {
        await rename(trashDir, destDir);
      } catch {
        // ロールバックにも失敗した場合は destDir が無い状態のまま。呼び出し側が failed を報告する。
      }
    }
    return { ok: false, error: (err as Error).message };
  }

  if (destExisted) {
    try {
      await rm(trashDir, { recursive: true, force: true });
    } catch {
      // trash の掃除失敗は致命的ではない
    }
  }
  return { ok: true };
}

/**
 * 管理下ディレクトリを削除する。`lstat` で symlink でないことを確認してから実行する
 * （symlink であれば `unlink` のみ行い、リンク先を辿って削除しない）。
 * 対象が既に存在しない場合は何もしない。
 */
export async function removeManagedDir(targetDir: string): Promise<void> {
  let st;
  try {
    st = await lstat(targetDir);
  } catch {
    return;
  }
  if (st.isSymbolicLink()) {
    await unlink(targetDir);
    return;
  }
  await rm(targetDir, { recursive: true, force: true });
}

/**
 * `withTimeout()` で中断された前回 reconcile の残骸（`.devrelay-staging` / `.devrelay-trash`）を
 * reconcile 冒頭で掃除する。失敗しても致命的ではない（次回また試みる）。
 */
export async function cleanupResidue(skillsDir: string): Promise<void> {
  for (const name of ['.devrelay-staging', '.devrelay-trash']) {
    try {
      await rm(join(skillsDir, name), { recursive: true, force: true });
    } catch {
      // 掃除に失敗しても致命的ではない
    }
  }
}

/** `dir` 直下のディレクトリ名一覧を返す（symlink・ファイルは除外）。`dir` が無ければ空配列 */
export async function listDirNames(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const name of [...entries].sort()) {
    try {
      const st = await lstat(join(dir, name));
      if (st.isDirectory()) names.push(name);
    } catch {
      // 個別エントリの取得失敗（レース等）は無視
    }
  }
  return names;
}

/** JSON ファイルを読んでパースする。存在しない/壊れている場合は null（throw しない） */
export async function readJsonSafe(filePath: string): Promise<unknown> {
  try {
    const content = await readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/** ディレクトリが無ければ作成する（`mkdir -p` 相当） */
export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/** テストで fake に差し替えるための操作束（本ファイルの関数をそのまま束ねたもの） */
export const defaultSkillTreeOps = {
  copyTreeSafe,
  hashTree,
  isContainedPath,
  atomicSwapDir,
  removeManagedDir,
  cleanupResidue,
  listDirNames,
  readJsonSafe,
  ensureDir,
};

export type SkillTreeOps = typeof defaultSkillTreeOps;
