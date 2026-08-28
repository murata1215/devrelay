/**
 * Claude ログイン切れの検知（リモート再ログイン中継 Phase1）。
 *
 * `claude auth status --json` を子プロセスで1発実行するだけの軽量なヘルスチェック。
 * PTY もSDKのライブセッションも使わない（既存の AI 実行フローに一切影響を与えない設計）。
 *
 * 判定不能（コマンド未対応の旧 CLI・一時的な失敗等）の場合は 'unknown' を返し、
 * 誤って「ログイン切れ」を通知してしまう事故を防ぐ（安全側に倒す）。
 *
 * 注意: linux/macos の agents は意図的に同一内容を維持する
 * （`scaffold-templates.ts` の PATH フォールバックと同じ運用方針）。
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { resolveSystemClaude } from './ai-runner.js';

const execFileAsync = promisify(execFile);

export interface ClaudeAuthCheckResult {
  /** 'ok'=ログイン済み / 'expired'=ログイン切れ / 'unknown'=判定不能（通知しない） */
  state: 'ok' | 'expired' | 'unknown';
  /** ログイン中アカウントのメールアドレス（判明時のみ） */
  account?: string;
}

/**
 * claude CLI の `auth status --json` を実行してログイン状態を確認する。
 * @returns 判定結果（判定不能時は state:'unknown'）
 */
export async function checkClaudeAuth(): Promise<ClaudeAuthCheckResult> {
  const claudePath = resolveSystemClaude();
  if (!claudePath) {
    // claude 実体が見つからない = このマシンでは判定不能（未インストールの可能性もある）
    return { state: 'unknown' };
  }

  try {
    const { stdout } = await execFileAsync(claudePath, ['auth', 'status', '--json'], {
      timeout: 15000,
    });
    const parsed = JSON.parse(stdout);
    if (typeof parsed?.loggedIn !== 'boolean') {
      // 想定外の出力形式（バージョン差異等）→ 誤検知を避けるため unknown
      return { state: 'unknown' };
    }
    return {
      state: parsed.loggedIn ? 'ok' : 'expired',
      account: typeof parsed.email === 'string' ? parsed.email : undefined,
    };
  } catch {
    // `auth status --json` 未対応の旧 CLI、タイムアウト、一時的な失敗等
    // → 誤って「切れた」と通知しないよう unknown 扱いにする
    return { state: 'unknown' };
  }
}
