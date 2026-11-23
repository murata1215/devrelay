/**
 * `devrelay sandbox ...` を実際に実行可能な形で案内するためのコマンド文字列組み立て（純関数）。
 *
 * Windows には `devrelay` コマンドが存在しない（`package.json` の `bin` は `private: true` の
 * ワークスペース内 clone にしか無く、`install-agent.ps1` は PATH を変更しない。B1 の調査結果）。
 * そのため CLI の使い方を案内する箇所（install スクリプトの完了メッセージ・README・readiness の
 * エラー文言）は、実際に打てる `node.exe` + `cli/index.js` の絶対パスの組を組み立てて示す必要がある。
 *
 * サイクル SB-1a-1.1（B1 対応）。
 */

export interface SandboxCliCommandInput {
  /** `process.platform` 相当 */
  platform: string;
  /** node 実行ファイルの絶対パス（`process.execPath` 等） */
  nodeExe: string;
  /** CLI エントリの絶対パス（`dist/cli/index.js`） */
  cliEntry: string;
  /** `sandbox status` のようなサブコマンド（スペース区切りで複数語も可） */
  subcommand: string;
  /** `--project <path>` を付ける場合のプロジェクトパス */
  projectPath?: string;
}

/**
 * パスを対象 OS のシェルで安全に引用する。
 * Windows（PowerShell）はダブルクォートで囲み、内部の `"` は `` ` `` でエスケープする。
 * 他 OS（sh 系）はシングルクォートで囲み、内部の `'` は `'\''` で分離する。
 */
function quotePathForPlatform(platform: string, value: string): string {
  if (platform === 'win32') {
    return `"${value.replace(/"/g, '`"')}"`;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * 実際に打てる 1 行コマンドを組み立てる。
 * Windows: `& "<node>" "<cli>" <subcommand> [--project "<path>"]`
 *   （PowerShell では引用済み文字列をコマンドとして実行するには `&`（呼び出し演算子）が必要）
 * 他 OS :  `node '<cli>' <subcommand> [--project '<path>']`
 */
export function buildSandboxCliCommand(input: SandboxCliCommandInput): string {
  const parts: string[] = [];
  if (input.platform === 'win32') {
    parts.push('&', quotePathForPlatform(input.platform, input.nodeExe));
  } else {
    parts.push(quotePathForPlatform(input.platform, input.nodeExe));
  }
  parts.push(quotePathForPlatform(input.platform, input.cliEntry));
  parts.push(input.subcommand);
  if (input.projectPath) {
    parts.push('--project', quotePathForPlatform(input.platform, input.projectPath));
  }
  return parts.join(' ');
}
