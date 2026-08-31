/**
 * アトミックなファイル書き込み（#348 層 B: Agent 側の直交化 第 2 の防御）。
 *
 * temp ファイルへ書いてから `rename()` で本体に置き換える方式で、書き込み途中のファイルを
 * 他プロセス/他セッションが読んでしまう事故（部分書き込みの読み取り）を防ぐ。
 *
 * Windows での `fs.rename` 上書き挙動は実機未検証（プラン #348 Step 0 参照、対象 Windows 機の
 * AI エージェントが検証スクリプトの実行をスコープ外と判断して正当に拒否したため実測できず）。
 * そのため本実装は「測ってから書く」の原則の代わりに、プランが列挙した3つの想定結果
 * （OK / EPERM・EEXIST / EBUSY）すべてを安全に扱える防御的な実装にしている:
 * rename が失敗したら unlink→rename を1回試み、それでも失敗するならリトライ（20/60/150ms）、
 * 最終的にすべて失敗した場合のみ直接書き込みにフォールバックし、必ず console.warn を出す
 * （#325 「静かなフォールバック禁止」）。
 *
 * Node 標準モジュール（`fs/promises` / `path`）以外の外部依存はゼロ。
 * `agents/linux` と `agents/macos` で byte-for-byte 同一内容を維持すること。
 */

import { writeFile, rename, unlink, mkdir } from 'fs/promises';
import { dirname, basename, join } from 'path';

const RETRY_DELAYS_MS = [20, 60, 150];

/** モジュール内でのユニーク性確保用カウンタ（同一ミリ秒内の複数呼び出しでも衝突しないように） */
let uniqueCounter = 0;

/**
 * 一時ファイル名の一意なサフィックスを生成する（プロセス ID + 時刻 + カウンタ + 乱数）。
 * 同一 target への並行書き込みが別々の temp ファイルを使うようにするためのもの
 * （排他は `path-mutex.ts` の責務。こちらは「衝突しても実害が出ない」ための保険）。
 */
export function nextUniqueSuffix(): string {
  uniqueCounter = (uniqueCounter + 1) % 1_000_000;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${process.pid}-${Date.now()}-${uniqueCounter}-${rand}`;
}

/**
 * `target` と同じディレクトリに置く一時ファイルのパスを組み立てる。
 * 同じディレクトリに置くのは `rename()` がアトミックに機能するのは同一ファイルシステム内
 * （多くの場合は同一ディレクトリ）に限られるため。
 *
 * @param target 最終的な書き込み先パス
 * @param suffix 一意なサフィックス（`nextUniqueSuffix()` の戻り値を渡す想定）
 */
export function buildTempPath(target: string, suffix: string): string {
  const dir = dirname(target);
  const base = basename(target);
  return join(dir, `.${base}.tmp-${suffix}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `target` に `data` をアトミックに書き込む。
 *
 * - 戻り値 `'atomic'`: temp へ書いて `rename()` で置き換えることに成功した
 * - 戻り値 `'fallback'`: `rename()` が最後まで失敗し、直接 `writeFile()` にフォールバックした
 *   （この経路では必ず `console.warn` を出す）
 *
 * @param target 書き込み先パス
 * @param data 書き込む内容（文字列、UTF-8）
 */
export async function writeFileAtomic(target: string, data: string): Promise<'atomic' | 'fallback'> {
  const dir = dirname(target);
  await mkdir(dir, { recursive: true });

  const tempPath = buildTempPath(target, nextUniqueSuffix());
  await writeFile(tempPath, data, 'utf-8');

  const attemptRename = async (): Promise<boolean> => {
    try {
      await rename(tempPath, target);
      return true;
    } catch {
      // Windows で EPERM/EEXIST の場合、先に target を消してから再試行する
      // （target が存在しない、または既に他プロセスが握っていない場合のみ成功する2段構え）
      try {
        await unlink(target);
      } catch {
        // target が存在しない、または削除できない → rename の再試行結果に委ねる
      }
      try {
        await rename(tempPath, target);
        return true;
      } catch {
        return false;
      }
    }
  };

  if (await attemptRename()) {
    return 'atomic';
  }

  for (const delayMs of RETRY_DELAYS_MS) {
    await sleep(delayMs);
    if (await attemptRename()) {
      return 'atomic';
    }
  }

  // ここまで全て失敗した場合のみ直接書き込みにフォールバックする（#325: 静かなフォールバック禁止）
  console.warn(`⚠️ atomic-write: rename to ${target} failed after retries, falling back to direct write`);
  try {
    await writeFile(target, data, 'utf-8');
  } finally {
    try {
      await unlink(tempPath);
    } catch {
      // temp ファイルの掃除に失敗しても致命的ではない
    }
  }
  return 'fallback';
}
