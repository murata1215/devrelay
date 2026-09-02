/**
 * `agent:version:info` の `runningCodeStale` 判定を複数ファイルで行う純関数群（#354）。
 *
 * 背景: 従来の判定（`connection.ts` にインライン実装）は `process.argv[1]`
 * （= `agents/linux/dist/index.js` 1 ファイル）の mtime だけを見ていた。
 * `index.js` だけが再ビルドされ `dist/services/*.js` が古いまま残る
 * 「partial build」が起きると、実際には古いコードが動いているのに
 * `stale: false` と誤報告してしまう（#350 `decideUpdateAction()` の入力を汚す）。
 *
 * #352 で `update.ps1` の成果物ゲート（`buildArtifactFreshnessGate`）は
 * shared/agent の複数ファイル AND 判定に強化済みだが、version-check の申告側
 * （本ファイルが担う側）は 1 ファイルのままだった。この非対称を解消する。
 *
 * 外部 import ゼロに保ち、コンパイル済み dist を直接 `node --test` から import して
 * 単体検証できるようにする（agent-update-decision.ts / claude-locator.ts と同じ流儀）。
 *
 * 注意: `agents/macos` はこのファイルの byte-for-byte 複製を持つ（意図的に同一内容を維持する）。
 */

/** 検査対象ファイル 1 件（mtime 取得は呼び出し側の責務、失敗時は null を渡す） */
export interface RunningCodeFile {
  path: string;
  mtimeMs: number | null;
}

/** stale 判定の結果 */
export interface RunningCodeStaleResult {
  stale: boolean;
  oldestPath: string | null;
  oldestMtimeMs: number | null;
}

/**
 * 実行中コードが古いかどうかを判定する。
 *
 * 判定順（変更しないこと）:
 *   1. `commitMs` が NaN → `stale:false`（判定不能。従来どおり fail-open）
 *   2. `mtimeMs === null`（stat 失敗＝ファイル不在）のものは無視する（fail-open）
 *   3. 1 つでも `mtimeMs < commitMs` → `stale:true` とし、最古のパスを返す
 *   4. それ以外 → `stale:false`
 *
 * @param files 検査対象ファイルの一覧（mtime 取得済み）
 * @param commitMs ローカルコミット日時（epoch ms）。`Date.parse()` の結果をそのまま渡す想定
 */
export function decideRunningCodeStale(
  files: RunningCodeFile[],
  commitMs: number,
): RunningCodeStaleResult {
  if (Number.isNaN(commitMs)) {
    return { stale: false, oldestPath: null, oldestMtimeMs: null };
  }

  let oldestPath: string | null = null;
  let oldestMtimeMs: number | null = null;

  for (const file of files) {
    if (file.mtimeMs === null) {
      continue;
    }
    if (file.mtimeMs < commitMs) {
      if (oldestMtimeMs === null || file.mtimeMs < oldestMtimeMs) {
        oldestMtimeMs = file.mtimeMs;
        oldestPath = file.path;
      }
    }
  }

  if (oldestPath !== null) {
    return { stale: true, oldestPath, oldestMtimeMs };
  }
  return { stale: false, oldestPath: null, oldestMtimeMs: null };
}

/**
 * entry パス（`process.argv[1]`）から検査対象ファイルの一覧を組み立てる。
 * entry 自身に加え、同じ `services/` ディレクトリ配下の主要 3 本（実際に stale dist
 * デッドロックで問題になった `ai-runner.js` / `connection.js` に、判定の対称性のため
 * `config.js` を加えた 3 本）を対象にする。Windows(`\`) / POSIX(`/`) いずれの区切りでも動く。
 *
 * @param entryPath `process.argv[1]` の値（例: `.../agents/linux/dist/index.js`）
 * @returns 検査対象の絶対パス一覧（entry を含む）。区切り文字は entryPath のものを踏襲する
 */
export function buildRunningCodeTargets(entryPath: string): string[] {
  const lastSlash = Math.max(entryPath.lastIndexOf('/'), entryPath.lastIndexOf('\\'));
  if (lastSlash === -1) {
    // ディレクトリ区切りが無い＝相対ファイル名のみ。services/ 側は組み立てられないため entry のみ返す
    return [entryPath];
  }
  const sep = entryPath.includes('\\') && !entryPath.includes('/') ? '\\' : '/';
  const dir = entryPath.slice(0, lastSlash);
  const servicesDir = `${dir}${sep}services`;
  return [
    entryPath,
    `${servicesDir}${sep}ai-runner.js`,
    `${servicesDir}${sep}connection.js`,
    `${servicesDir}${sep}config.js`,
  ];
}
