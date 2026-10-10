/**
 * Agent 接続トークンに埋め込むサーバー WebSocket URL の組み立て（純ロジック）。
 *
 * 背景: トークンにはサーバーの WS URL が埋め込まれ、Agent 側はそれを見て接続先を決める
 * （`packages/shared/src/token.ts`）。この URL をリクエストの `Host` ヘッダーから組み立てると、
 * リバースプロキシ配下で壊れたトークンが発行されてしまう:
 *
 *   - IIS + ARR は既定が `preserveHostHeader=false` のため、Fastify に届く `Host` は
 *     転送先（`localhost:3000`）に書き換わっている → `wss://localhost:3000/ws/agent`
 *   - サブパス配信（例 `https://host/foo/devrelay/`）ではパスのプレフィックスが落ちる
 *     → `wss://host/ws/agent`
 *
 * どちらも Agent が接続できず、`scripts/install-agent.ps1` / `.sh` のトークン事前検証が
 * 「サーバーに接続できません」で中断する。
 *
 * 対応: `PUBLIC_URL` が設定されていればそれを唯一の情報源とする。未設定時は従来どおり
 * `Host` ヘッダーから組み立てる（既存環境の挙動を変えない fail-soft）。
 */

/** `buildAgentWsUrl` が参照するリクエストヘッダーの最小形。 */
export interface AgentWsUrlRequestLike {
  headers: {
    host?: string;
    'x-forwarded-proto'?: string | string[];
  };
}

/**
 * Agent トークンに埋め込む WebSocket URL を組み立てる。
 *
 * @param request `Host` / `X-Forwarded-Proto` を持つリクエスト相当のオブジェクト
 * @param env `process.env` 相当のオブジェクト（テスト容易性のため引数で受ける）
 * @returns `wss://host/path/ws/agent` 形式の URL
 */
export function buildAgentWsUrl(
  request: AgentWsUrlRequestLike,
  env: NodeJS.ProcessEnv = process.env
): string {
  const publicUrl = env.PUBLIC_URL?.trim();
  if (publicUrl) {
    try {
      const url = new URL(publicUrl);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      // PUBLIC_URL が末尾スラッシュ付き・サブパス付きのどちらでも正しく連結する
      url.pathname = `${url.pathname.replace(/\/+$/, '')}/ws/agent`;
      url.search = '';
      url.hash = '';
      return url.toString();
    } catch {
      // PUBLIC_URL が URL として壊れている場合は Host ヘッダーにフォールバックする
    }
  }

  const host = request.headers.host || 'localhost:3000';
  const protocol =
    request.headers['x-forwarded-proto'] === 'https' || host.includes('devrelay.io') ? 'wss' : 'ws';
  return `${protocol}://${host}/ws/agent`;
}
