/**
 * #368 Phase 2a: git 自動復元ガードの I/O 層。
 *
 * 判定ロジック（純関数）は `git-guard-core.ts` に分離済み。このモジュールは
 * `execFile`（既定 `shell: false`）のみで git を呼び出し、コマンドインジェクション経路を
 * 構造的に持たない（`shell: true` や文字列連結によるコマンド構築は一切使わない）。
 *
 * 使い方（`connection.ts` 側の想定フロー）:
 * 1. Devin のプランモードターン開始前に `captureBaseline(projectPath)` でベースラインを取得
 * 2. ターン終了後に `restoreToBaseline(projectPath, baseline)` で復元
 *    - 追跡済みファイルの変更・追加・削除・リネームは `git checkout`/`git reset` で HEAD の状態へ戻す
 *    - 未追跡ファイル（`??`）は削除せず `.devrelay/reverted/<ISO8601>/` へ退避（quarantine）
 *    - 無視対象（`!!`）は触らない
 *
 * `devin-file-watch.ts`/`devin-atif.ts`/`session-scope.ts`/`plan-permission.ts`/`git-guard-core.ts`
 * と同じ流儀（3 OS byte-for-byte 同一）。ただし本ファイルは実ファイルシステム操作を伴うため
 * `git-guard-core.ts` とは異なり専用の単体テストファイルは持たず、E2E で確認する。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  parsePorcelainZ,
  isGuardExcludedPath,
  isSafeRelativePath,
  diffAgainstBaseline,
  classifyRestoreAction,
  type PorcelainEntry,
} from './git-guard-core.js';
// connection.ts 側が `import { ..., type PorcelainEntry } from './git-guard.js'` する経路のため、
// 型を再エクスポートしておく（re-export しないと TS2459 でビルドが通らない）。
export type { PorcelainEntry };

const execFileAsync = promisify(execFile);

/** git 呼び出しの共通オプション。shell 経由にしないことでコマンドインジェクション経路を持たない。 */
const EXEC_OPTS = {
  windowsHide: true,
  timeout: 30_000,
  maxBuffer: 8 * 1024 * 1024,
} as const;

/** `restoreToBaseline` の結果集計。呼び出し側のログ・チャット通知用。 */
export interface RestoreResult {
  /** `git checkout`/`git reset` で HEAD の状態へ戻したパス */
  restored: string[];
  /** 未追跡のため `.devrelay/reverted/<ISO8601>/` へ退避したパス */
  quarantined: string[];
  /** 復元処理中にエラーが発生し諦めたパス（`.devrelay`/`.git` 等の除外対象は含まない） */
  failed: string[];
}

/**
 * `projectPath` が git 管理下（work tree 内）かどうかを判定する。例外を投げない
 * （非 git ディレクトリでは false を返し、呼び出し側は警告を出して続行する設計）。
 */
export async function isGitRepo(projectPath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['rev-parse', '--is-inside-work-tree'],
      { cwd: projectPath, ...EXEC_OPTS },
    );
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * ターン開始時の git 状態を記録する。取得に失敗した場合は空配列を返し、
 * `console.warn` のみで例外は投げない（ベースライン取得失敗が原因で AI ターン自体を
 * 止めないようにするため。復元側もベースラインが空なら「何もしない」に倒れ安全）。
 */
export async function captureBaseline(projectPath: string): Promise<PorcelainEntry[]> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
      { cwd: projectPath, ...EXEC_OPTS },
    );
    return parsePorcelainZ(stdout);
  } catch (err) {
    console.warn(`[git-guard] captureBaseline failed for ${projectPath}: ${(err as Error).message}`);
    return [];
  }
}

/** `.devrelay/reverted/<ISO8601>/` の隔離先ディレクトリ名を作る（`:`/`.` はファイル名に不向きなため `-` に置換）。 */
function buildQuarantineDir(projectPath: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return join(projectPath, '.devrelay', 'reverted', stamp);
}

/**
 * 未追跡ファイル1件を `.devrelay/reverted/<ISO8601>/` へ退避する（削除ではなく rename）。
 * `relPath` は事前に `isSafeRelativePath`/`isGuardExcludedPath` でチェック済みであること。
 */
async function quarantineFile(projectPath: string, relPath: string, quarantineDir: string): Promise<void> {
  const src = join(projectPath, relPath);
  const dest = join(quarantineDir, relPath);
  await mkdir(dirname(dest), { recursive: true });
  await rename(src, dest);
}

/**
 * ターン終了時に現在の git 状態を再取得し、`baseline` との差分（Devin がこのターン中に
 * 変化させたパスのみ）を復元する。
 *
 * - `checkout` 対象（追跡済みの変更・追加・削除・リネーム）は `git checkout -- <path>` で
 *   HEAD の状態へ戻す。新規追加（インデックスに乗っただけの未コミットファイル）は
 *   `git checkout` だけでは消えないことがあるため `git reset -- <path>` を先に実行してから
 *   `checkout` する（両方失敗しても例外は投げず `failed` に積む）。
 * - `quarantine` 対象（未追跡 `??`）は削除せず退避。
 * - `skip` 対象（無視対象 `!!`）・`.git`/`.devrelay`/`.devrelay-output` 配下・危険な相対パスは
 *   一切触らない。
 *
 * 例外を投げない。個々のパスの復元に失敗しても他のパスの処理は続行する。
 */
export async function restoreToBaseline(projectPath: string, baseline: PorcelainEntry[]): Promise<RestoreResult> {
  const result: RestoreResult = { restored: [], quarantined: [], failed: [] };

  let after: PorcelainEntry[];
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
      { cwd: projectPath, ...EXEC_OPTS },
    );
    after = parsePorcelainZ(stdout);
  } catch (err) {
    console.warn(`[git-guard] restoreToBaseline: status failed for ${projectPath}: ${(err as Error).message}`);
    return result;
  }

  const changed = diffAgainstBaseline(baseline, after);
  if (changed.length === 0) return result;

  let quarantineDir: string | null = null;

  for (const entry of changed) {
    const paths = entry.origPath ? [entry.path, entry.origPath] : [entry.path];
    const safePaths = paths.filter((p) => isSafeRelativePath(p) && !isGuardExcludedPath(p));
    if (safePaths.length === 0) continue;

    const action = classifyRestoreAction(entry);
    if (action === 'skip') continue;

    if (action === 'quarantine') {
      if (!quarantineDir) quarantineDir = buildQuarantineDir(projectPath);
      for (const p of safePaths) {
        try {
          await quarantineFile(projectPath, p, quarantineDir);
          result.quarantined.push(p);
        } catch (err) {
          console.warn(`[git-guard] quarantine failed for ${p}: ${(err as Error).message}`);
          result.failed.push(p);
        }
      }
      continue;
    }

    // action === 'checkout'
    try {
      await execFileAsync('git', ['reset', '--', ...safePaths], { cwd: projectPath, ...EXEC_OPTS }).catch(() => {
        // reset 失敗は無視（対象がインデックスに乗っていないだけの可能性があるため、
        // 後続の checkout が本命）。
      });
      await execFileAsync('git', ['checkout', '--', ...safePaths], { cwd: projectPath, ...EXEC_OPTS });
      result.restored.push(...safePaths);
    } catch (err) {
      console.warn(`[git-guard] checkout failed for ${safePaths.join(', ')}: ${(err as Error).message}`);
      result.failed.push(...safePaths);
    }
  }

  return result;
}
