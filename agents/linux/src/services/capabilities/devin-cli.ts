/**
 * サイクル P4-A: `devin` CLI を spawn する唯一のヘルパー（provider=devin, kind=plugin adapter 専用）。
 *
 * `claude-cli.ts` / `git-cli.ts` の鏡写し。`execFile` はコマンドと引数を配列で分離し、
 * シェル文字列連結は行わない（marketplace 索引由来の plugin id/source を安全に扱うため、
 * 既存 adapter 群と同じ方針を継承）。
 *
 * `NO_COLOR=1` / `TERM=dumb` を注入する。`devin plugins list`/`info` の出力に ANSI エスケープが
 * 混ざらないようにするため（本 adapter は list をパースしないが、`info`/`install` の stderr/stdout を
 * `failed[].reason` に生のまま格納することがあるため、ノイズを減らしておく）。
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

/**
 * CLI 呼び出し 1 回あたりの個別タイムアウト（共通層の 3 分枠の内側で使う安全弁）。
 * `claude-cli.ts`（60 秒）より長めに取る。Devin の install/update は marketplace の git fetch を
 * 含むため claude plugin install より時間がかかりうる実測未確認のため、安全側に長めの既定値にする。
 */
export const CLI_TIMEOUT_MS = 90 * 1000;

export interface DevinCliResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** 非 0 終了なら数値、spawn 失敗なら 'ENOENT' 等の文字列、シグナル終了なら null */
  code: number | string | null;
  /** timeout kill 等で強制終了されたか */
  killed: boolean;
  /** ok:false のときの `(err as Error).message`（failed[].reason にそのまま使える） */
  error?: string;
}

/**
 * `devin` CLI を実行する関数の型。**`cwd` は必須**（呼び出し側が省略できない。
 * P1.3 の claude-cli.ts cwd バグ根治と同じ理由で、型レベルで強制する）。
 * @param devinPath resolveSystemDevin() が返す実行ファイルの絶対パス
 * @param args サブコマンドと引数（例: `['plugins', 'install', 'owner/repo#plugins/x', '--yes']`）
 * @param cwd 実行時のカレントディレクトリ（machine 用の安定ディレクトリ。`machineCwd()` の戻り値）
 */
export type DevinCliRunner = (devinPath: string, args: string[], cwd: string) => Promise<DevinCliResult>;

/** `execFile` を使う既定の実装（本番用） */
export const execFileDevinRunner: DevinCliRunner = async (devinPath, args, cwd) => {
  try {
    const { stdout, stderr } = await execFileAsync(devinPath, args, {
      cwd,
      timeout: CLI_TIMEOUT_MS,
      windowsHide: true,
      env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' },
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
