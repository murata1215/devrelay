/**
 * #344: AI CLI（devin 等）子プロセスが出力ゼロで終了した理由を分類する。
 *
 * 従来は出力ゼロのケースをすべて汎用「(No response from AI)」で握りつぶしていた。
 * `probeDevinCapabilities()` が（PATH 不在・更新直後のキャッシュ汚染・`--help` の非 0 終了等の理由で）
 * 誤って「非対応」判定を返すと、CLI 実行ファイル自体が見つからない／即死した場合でも
 * 実際の原因（exit code・stderr）が一切ユーザーに届かない構造だった（#329 由来の退行）。
 *
 * 外部 import ゼロの純関数（#337 progress-timeout.ts / #339 claude-login-code.ts /
 * #343 control-response.ts と同じ流儀）。既存の分岐（unknownFlag の自動リトライ、
 * devin の exit 0 空応答メッセージ等）は一切変更せず、それらに該当しなかった
 * 残りのケースだけを分類する目的で使う。
 */

export type CliFailureKind =
  | 'none'
  | 'commandNotFound'
  | 'unknownFlag'
  | 'emptyExitZero'
  | 'emptyNonZero';

export interface CliFailureResult {
  kind: CliFailureKind;
  /** kind === 'unknownFlag' のときのみ、CLI が拒否したフラグ名（例: '--agent-config'） */
  flag?: string;
  /** stderr の末尾 maxLines 行（無ければ空文字列） */
  stderrTail: string;
}

export interface ClassifyCliFailureInput {
  /** 子プロセスの終了コード（シグナル終了時は null） */
  exitCode: number | null;
  /** 収集した stdout の長さ（0 でなければ classify する必要はない） */
  stdoutLength: number;
  /** 収集した stderr 全文 */
  stderr: string;
  /** stderrTail に含める最大行数（既定 5） */
  maxLines?: number;
}

/**
 * PowerShell / cmd.exe / POSIX シェルの「コマンドが見つからない」系エラーメッセージを検出する。
 * 判定順序を変えないこと（呼び出し側の分岐と対応関係にあるため）。
 * @param input 分類対象の情報
 * @returns 分類結果（kind・任意で flag・stderr 末尾）
 */
export function classifyCliFailure(input: ClassifyCliFailureInput): CliFailureResult {
  const maxLines = input.maxLines ?? 5;
  const stderr = input.stderr ?? '';
  const stderrTail = stderr.trim().length > 0
    ? stderr.trim().split('\n').slice(-maxLines).join('\n')
    : '';

  if (input.stdoutLength > 0) {
    return { kind: 'none', stderrTail };
  }

  // シグナル終了（ユーザーによるキャンセル・タイムアウト kill 等）は CLI 自体の失敗ではない
  if (input.exitCode === null) {
    return { kind: 'none', stderrTail };
  }

  const unknownFlagMatch = stderr.match(/unexpected argument '(--[a-z][a-z-]*)'/i);
  if (unknownFlagMatch) {
    return { kind: 'unknownFlag', flag: unknownFlagMatch[1], stderrTail };
  }

  if (isCommandNotFoundMessage(stderr)) {
    return { kind: 'commandNotFound', stderrTail };
  }

  if (input.exitCode === 0) {
    return { kind: 'emptyExitZero', stderrTail };
  }

  return { kind: 'emptyNonZero', stderrTail };
}

/**
 * Windows（cmd.exe / PowerShell）・POSIX シェル・Node の ENOENT のいずれかの
 * 「コマンドが見つからない」表現に一致するか判定する。
 * @param stderr 子プロセスの stderr 全文
 */
function isCommandNotFoundMessage(stderr: string): boolean {
  return (
    /is not recognized as an internal or external command/i.test(stderr) ||
    /command not found/i.test(stderr) ||
    /The term '.*' is not recognized/i.test(stderr) ||
    /\bENOENT\b/.test(stderr)
  );
}

/**
 * #345: Devin CLI が workspace trust 拒否（`Refusing to run in an untrusted workspace` /
 * `respect_workspace_trust` の config 案内）で即死したかどうかを判定する。
 * `classifyCliFailure()` 自体（#344）は判定順序を含め一切変更しない。この関数はその外側で
 * 呼び出し側（ai-runner.ts）が `emptyNonZero` の中身をさらに細分類するために使う。
 * @param stderr 子プロセスの stderr 全文
 */
export function isWorkspaceTrustError(stderr: string): boolean {
  return (
    /Refusing to run in an untrusted workspace/i.test(stderr) ||
    /respect_workspace_trust/i.test(stderr)
  );
}
