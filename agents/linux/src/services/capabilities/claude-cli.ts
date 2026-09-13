/**
 * サイクルP1.3: `claude` CLI を spawn する唯一のヘルパー（provider=claude adapter 専用）。
 *
 * P1/P1.2 の `claude-plugin-adapter.ts` は `execFile(claudePath, args, { timeout, windowsHide })` に
 * `cwd` を渡していなかったため、Agent プロセス自身の cwd（本番機で実測: `~/.devrelay/agent/agents/linux/dist`、
 * `u` の `git reset --hard` で消える場所）が継承され、install が意図しないディレクトリに対して
 * 行われていた（hp630g9/fwjg2 実機で確認: registry の `projectPath` が Agent の作業ディレクトリになっていた）。
 * このヘルパーは `cwd` を型レベルで必須の第 3 引数にし、呼び出し側が省略できないようにする。
 *
 * `execFile` はコマンドと引数を配列で分離し、シェル文字列連結を行わない
 * （Web 経由の plugin id / marketplaceSource を安全に扱うため、既存方針を継承）。
 */
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** `promisify(execFile)` の reject 時に付与される stdout/stderr/code/killed を持つエラー型 */
interface ExecFileRejection extends Error {
  stdout?: string;
  stderr?: string;
  code?: number | string | null;
  killed?: boolean;
}

/** CLI 呼び出し 1 回あたりの個別タイムアウト（共通層の 3 分枠の内側で使う軽量な安全弁） */
export const CLI_TIMEOUT_MS = 60 * 1000;

export interface ClaudeCliResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** 非 0 終了なら数値、spawn 失敗なら 'ENOENT' 等の文字列、シグナル終了なら null */
  code: number | string | null;
  /** timeout kill 等で強制終了されたか（索引ミスと誤分類しないための材料） */
  killed: boolean;
  /** ok:false のときの `(err as Error).message`（既存互換。failed[].reason にそのまま使える） */
  error?: string;
}

/**
 * `claude` CLI を実行する関数の型。**`cwd` は必須**（呼び出し側が省略できない）。
 * @param claudePath resolveSystemClaude() が返す実行ファイルの絶対パス
 * @param args サブコマンドと引数（例: `['plugin', 'list', '--json']`）
 * @param cwd 実行時のカレントディレクトリ（プロジェクト cwd or machine 用の安定ディレクトリ）
 */
export type ClaudeCliRunner = (claudePath: string, args: string[], cwd: string) => Promise<ClaudeCliResult>;

/** `execFile` を使う既定の実装（本番用） */
export const execFileClaudeRunner: ClaudeCliRunner = async (claudePath, args, cwd) => {
  try {
    const { stdout, stderr } = await execFileAsync(claudePath, args, { cwd, timeout: CLI_TIMEOUT_MS, windowsHide: true });
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
