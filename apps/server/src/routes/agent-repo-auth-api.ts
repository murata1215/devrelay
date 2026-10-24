import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authenticateByMachineTokenFull } from './document-api.js';
import { resolveAgentRepoAuthFromEnv, decideRepoAuthRateLimit } from '../services/agent-repo-rules.js';

/**
 * 読取PATのサーバー配布サイクル: `POST /api/agent/repo-auth`。
 *
 * インストーラー（`install-agent.sh`/`.ps1`）がインストール時にのみ使う HTTP エンドポイント
 * （`u` 実行時のローテーションは WS の `agent:repo:auth:request`/`server:repo:auth` を使う。
 * Agent 本体は HTTP クライアントを持たないため、この HTTP エンドポイントはインストーラー専用）。
 *
 * 認証: `Authorization: Bearer <machine token>`（`raw-completion-api.ts` と同じ既存慣習。
 * `/api/public/validate-token` には置かない — そちらは認証不要・レート制限なしの設計で、
 * 秘密配布には不適）。
 *
 * 応答に載る `authHeader` は秘密情報（`Authorization: Basic base64(x-access-token:PAT)`）。
 * **本ファイルは `authHeader`/PAT の値を一切 `console.*`/`app.log` に出さない**
 * （machineId と「配布したか否か」の真偽値のみ記録する）。
 */

/** machineId → 直近リクエスト時刻（ms epoch）のスライディング窓。プロセス内メモリのみ（再起動で消える＝問題ない） */
const recentRequests = new Map<string, number[]>();

/** 窓（1分）あたりの上限リクエスト数 */
const REPO_AUTH_RATE_WINDOW_MS = 60 * 1000;
const REPO_AUTH_RATE_LIMIT = 10;

/**
 * リクエストが HTTPS（または localhost 経由の開発用途）で届いているかを判定する。
 * `Fastify({ trustProxy: true })` のため、Caddy/IIS が `X-Forwarded-Proto` を正しく転送していれば
 * `request.protocol` が `https` になる（既存の `agent-token-url.ts` 等と同じ前提）。
 */
function isSecureRequest(request: FastifyRequest): boolean {
  if (request.protocol === 'https') return true;
  const host = request.hostname || '';
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

export async function agentRepoAuthRoutes(app: FastifyInstance) {
  app.post('/api/agent/repo-auth', async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = await authenticateByMachineTokenFull(request);
    if (!auth) {
      return reply.status(401).send({ error: 'Invalid or missing machine token', code: 'unauthorized' });
    }

    // 転送路ガード（要件5: HTTPS/WSS 以外では送らない）。社内プロキシ越しの平文 HTTP で
    // 秘密が流れる経路を構造的に閉じる。
    if (!isSecureRequest(request)) {
      return reply.status(403).send({ error: 'HTTPS is required for this endpoint', code: 'insecureTransport' });
    }

    // レート制限（machineId 単位、1分10回）。無効トークンの総当たりとは無関係に、
    // 認証済みマシンからの異常な連打も抑止する。
    const now = Date.now();
    const timestamps = recentRequests.get(auth.machineId) ?? [];
    const allowed = decideRepoAuthRateLimit({ timestamps, now, windowMs: REPO_AUTH_RATE_WINDOW_MS, max: REPO_AUTH_RATE_LIMIT });
    if (!allowed) {
      return reply.status(429).send({ error: 'Too many requests', code: 'rateLimited' });
    }
    const updated = timestamps.filter((t) => t > now - REPO_AUTH_RATE_WINDOW_MS);
    updated.push(now);
    recentRequests.set(auth.machineId, updated);

    const resolved = resolveAgentRepoAuthFromEnv((s: string) => Buffer.from(s).toString('base64'));

    // ログは machineId と「配布したか否か」の真偽値のみ（PAT/authHeader の値は絶対に出さない）
    console.log(`[agent-repo-auth] machineId=${auth.machineId} distributed=${resolved.authHeader !== null}`);

    return reply.status(200).send(resolved);
  });
}
