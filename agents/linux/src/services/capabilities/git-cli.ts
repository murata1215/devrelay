/**
 * サイクル P3-A: `git` CLI を spawn する唯一のヘルパー（`devin-skill-adapter.ts` 専用）。
 *
 * `claude-cli.ts` の鏡写し。`execFile` はコマンドと引数を配列で分離し、シェル文字列連結は行わない
 * （marketplaceSource は `devin-skill-rules.ts` の `resolveGitCloneUrl()` で事前検証済みの URL のみを渡す）。
 *
 * **非対話の強制**（プラン §3-1）: private リポ指定時の認証プロンプトで 60 秒ハングする事故を
 * 構造的に防ぐため、以下を必ず注入する。
 * - `GIT_TERMINAL_PROMPT=0`
 * - `GIT_ASKPASS`（win32 以外は `/bin/true`。win32 は空文字のダミーコマンドが無いため未設定のままにする）
 * - `GCM_INTERACTIVE=never`（Git Credential Manager 対策）
 * - 引数の先頭に必ず `-c credential.helper=` を付ける（保存済み credential helper を無効化する）
 */
import { execFile, execSync } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * システムにインストールされた git の実行パスを解決する。
 * `git` は多くの環境で PATH 上にあるため、絶対パスのフォールバック候補は持たない
 * （見つからなければ `null` を返し、呼び出し側は `failed: 'git-not-found'` として扱う）。
 */
export function resolveSystemGit(): string | null {
  try {
    const lookupCmd = process.platform === 'win32' ? 'where git' : 'command -v git';
    const raw = execSync(lookupCmd, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
    const p = raw.split(/\r?\n/)[0]?.trim();
    return p && p.length > 0 ? p : null;
  } catch {
    return null;
  }
}

/** `promisify(execFile)` の reject 時に付与される stdout/stderr/code/killed を持つエラー型 */
interface ExecFileRejection extends Error {
  stdout?: string;
  stderr?: string;
  code?: number | string | null;
  killed?: boolean;
}

/** CLI 呼び出し 1 回あたりの個別タイムアウトの既定値（呼び出し側が `allocateGitTimeoutMs()` で上書きする） */
export const GIT_CLI_DEFAULT_TIMEOUT_MS = 30 * 1000;

export interface GitCliResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** 非 0 終了なら数値、spawn 失敗なら 'ENOENT' 等の文字列、シグナル終了なら null */
  code: number | string | null;
  /** timeout kill 等で強制終了されたか */
  killed: boolean;
  /** ok:false のときの `(err as Error).message` */
  error?: string;
}

/**
 * `git` CLI を実行する関数の型。**`cwd` は必須**（呼び出し側が省略できない）。
 * @param gitPath resolveSystemGit() が返す実行ファイルの絶対パス
 * @param args サブコマンドと引数（`-c credential.helper=` は本関数が自動で先頭に付与する）
 * @param cwd 実行時のカレントディレクトリ
 * @param timeoutMs 個別タイムアウト（`allocateGitTimeoutMs()` の戻り値を渡す想定）
 */
export type GitCliRunner = (gitPath: string, args: string[], cwd: string, timeoutMs: number) => Promise<GitCliResult>;

/** `execFile` を使う既定の実装（本番用）。非対話 env を必ず注入する */
export const execFileGitRunner: GitCliRunner = async (gitPath, args, cwd, timeoutMs) => {
  const nonInteractiveArgs = ['-c', 'credential.helper=', ...args];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
  };
  if (process.platform !== 'win32') {
    env.GIT_ASKPASS = '/bin/true';
  }
  try {
    const { stdout, stderr } = await execFileAsync(gitPath, nonInteractiveArgs, {
      cwd,
      timeout: timeoutMs > 0 ? timeoutMs : GIT_CLI_DEFAULT_TIMEOUT_MS,
      windowsHide: true,
      env,
    });
    return { ok: true, stdout, stderr: stderr ?? '', code: 0, killed: false };
  } catch (err) {
    const e = err as ExecFileRejection;
    return {
      ok: false,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      code: e.code ?? null,
      killed: e.killed ?? false,
      error: e.message || 'error',
    };
  }
};
