/**
 * サイクル P4-A: marketplace リポジトリの clone/fetch ロジックの共有化。
 *
 * `agent-skills-adapter.ts` が P3-A/P3-B で private 関数として持っていた `ensureMarketplaceClone()`
 * をそのまま移設したもの（**git 呼び出しの引数列は 1 文字も変えていない**。回帰確認は
 * `agent-skills-adapter.test.mjs` が無改造で通ることで行う）。`devin-plugin-adapter.ts` も同じ
 * marketplace clone を**索引としてだけ**読むため（配布物のコピーはしない。Devin が自前で fetch する）、
 * この関数を共有する。
 *
 * I/O 層のファイルのため、`agent-skills-rules.ts`（純関数）から `allocateGitTimeoutMs()` /
 * `GIT_TOTAL_BUDGET_MS` を import してよい（zero-import 規約は `*-rules.ts` 自身にのみ課される）。
 */
import { join } from 'path';
import { allocateGitTimeoutMs, GIT_TOTAL_BUDGET_MS } from './agent-skills-rules.js';
import type { GitCliRunner } from './git-cli.js';

/** `ensureMarketplaceClone()` が必要とする最小限の依存（呼び出し側の Deps 型が構造的に満たせばよい） */
export interface MarketplaceCloneDeps {
  runGit: GitCliRunner;
  /** 部分 clone の残骸掃除に使う（symlink は unlink のみ、ディレクトリは再帰削除） */
  removeManagedDir: (targetDir: string) => Promise<void>;
  /** ディレクトリ直下のディレクトリ名一覧（clone 済みかどうかの存在確認に使う） */
  listDirNames: (dir: string) => Promise<string[]>;
}

export type EnsureMarketplaceCloneResult =
  | { ok: true; cloneDir: string; commit: string | null }
  | { ok: false };

/**
 * marketplace リポジトリを `<cloneParentDir>/<dirName>` に shallow clone し、無ければ作成・
 * 既にあれば fetch + reset --hard + clean -fdx でリセットする。失敗したら `ok:false`
 * （呼び出し側は既存 managed 状態を last-known-good として保持し、撤去しない）。
 * 存在確認は `deps.listDirNames()` のみで行う（fake deps でも spawn ゼロで検証できるようにするため）。
 */
export async function ensureMarketplaceClone(
  deps: MarketplaceCloneDeps,
  cloneParentDir: string,
  dirName: string,
  gitPath: string,
  url: string,
): Promise<EnsureMarketplaceCloneResult> {
  const cloneDir = join(cloneParentDir, dirName);
  const parentNames = await deps.listDirNames(cloneParentDir);
  const cloneExists = parentNames.includes(dirName);

  if (!cloneExists) {
    const timeoutMs = allocateGitTimeoutMs(GIT_TOTAL_BUDGET_MS, 2);
    const cloneResult = await deps.runGit(gitPath, ['clone', '--depth', '1', '--single-branch', '--', url, cloneDir], cloneParentDir, timeoutMs);
    if (!cloneResult.ok) {
      await deps.removeManagedDir(cloneDir).catch(() => {}); // 部分 clone の残骸を掃除し次回リトライを新規 clone にする
      return { ok: false };
    }
  } else {
    const timeoutMs = allocateGitTimeoutMs(GIT_TOTAL_BUDGET_MS, 5);
    const steps: string[][] = [
      ['remote', 'set-url', 'origin', url],
      ['fetch', '--depth', '1', 'origin', 'HEAD'],
      ['reset', '--hard', 'FETCH_HEAD'],
      ['clean', '-fdx'],
    ];
    for (const args of steps) {
      const stepResult = await deps.runGit(gitPath, args, cloneDir, timeoutMs);
      if (!stepResult.ok) return { ok: false };
    }
  }

  const revParseTimeout = allocateGitTimeoutMs(GIT_TOTAL_BUDGET_MS, 1);
  const revParseResult = await deps.runGit(gitPath, ['rev-parse', 'HEAD'], cloneDir, revParseTimeout);
  const commit = revParseResult.ok ? (revParseResult.stdout.trim() || null) : null;
  return { ok: true, cloneDir, commit };
}
