/**
 * Agent 自身（開発者身元）の SID 解決。`decideSandboxPreflight()` の
 * `identitySidDiffersFromAgent` 判定（Sandbox Host が Agent と同じ身元で動いていないことの確認）
 * に使う。
 *
 * サイクル SB-1a-1。I/O を伴うため `sandbox-readiness.ts` の「外部 import ゼロ」グループには
 * 含めない。実行コマンドは注入可能にしてテスト容易性を確保する。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type SandboxCommandRunner = (
  command: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

const defaultRunner: SandboxCommandRunner = (command, args) => execFileAsync(command, args);

/**
 * 現在実行中ユーザー（Agent 自身）の SID を取得する（Windows のみ）。
 * `whoami /user /fo csv /nh` の出力は `"ユーザー名","SID"` 形式（ヘッダ無し）。
 * @returns SID 文字列。失敗時は null（例外を投げない。呼び出し側は null を「判定できない」として
 *   扱い、`identitySidDiffersFromAgent` を false（fail-closed）にすること）
 */
export async function resolveCurrentUserSid(run: SandboxCommandRunner = defaultRunner): Promise<string | null> {
  try {
    const { stdout } = await run('whoami', ['/user', '/fo', 'csv', '/nh']);
    return parseWhoamiUserCsv(stdout);
  } catch {
    return null;
  }
}

/** `whoami /user /fo csv /nh` の出力から SID を取り出す（純粋なパース部分、テスト容易性のため分離） */
export function parseWhoamiUserCsv(stdout: string): string | null {
  const trimmed = stdout.trim();
  const match = /"[^"]*","([^"]+)"/.exec(trimmed);
  return match ? match[1] : null;
}
