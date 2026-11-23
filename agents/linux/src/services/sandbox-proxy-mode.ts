/**
 * `devrelay sandbox status`/`selftest` が中継プロキシ（127.0.0.1:48711）をどう扱うかの判定
 * （外部 import ゼロ、純関数）。
 *
 * サイクル SB-1a-1.1（B3 対応）。SB-1a-1 時点では status/selftest が中継プロキシを一切
 * 起動しなかったため、Sandbox Host の `loopback_probe_failed` が毎回発生していた
 * （実機確認済み）。本関数は「既存の待ち受けを再利用する／自分で一時起動する／
 * 上位プロキシが socks で起動できない」の 3 分岐を決める。
 */

export type SandboxProxyMode = 'reuse-existing' | 'start-own' | 'cannot-start-socks';

export interface SandboxProxyModeInput {
  /** 48711 への接続試行で既存の待ち受けを検出したか */
  listenerDetected: boolean;
  /** 上位プロキシ（`config.proxy.url`）のスキーム。未設定なら undefined */
  upstreamProxyScheme?: string;
}

export interface SandboxProxyModeDecision {
  mode: SandboxProxyMode;
  /** 人間向けの表示行 */
  message: string;
}

/** chain 可能な上位プロキシのスキーム（`sandbox-proxy.ts` の `createSandboxConnectProxy()` と同じ制約） */
const SUPPORTED_UPSTREAM_SCHEMES: ReadonlySet<string> = new Set(['http', 'https']);

export function decideSandboxProxyMode(input: SandboxProxyModeInput): SandboxProxyModeDecision {
  if (input.listenerDetected) {
    return {
      mode: 'reuse-existing',
      message: '中継プロキシ: 既存の待ち受け（127.0.0.1:48711）を使いました。',
    };
  }
  const scheme = input.upstreamProxyScheme?.toLowerCase();
  if (scheme && !SUPPORTED_UPSTREAM_SCHEMES.has(scheme)) {
    return {
      mode: 'cannot-start-socks',
      message: `中継プロキシ: 起動できませんでした（上位プロキシのスキーム '${scheme}' は chain できません。socks は未対応）。`,
    };
  }
  return {
    mode: 'start-own',
    message: '中継プロキシ: 自分で一時起動しました（127.0.0.1:48711）。',
  };
}
