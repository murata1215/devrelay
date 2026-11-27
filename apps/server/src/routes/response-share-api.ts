/**
 * AI 回答契約サイクル（2026-11-23 改訂）: AI 応答の詳細ページ — ログイン不要の閲覧 API。
 *
 * GET /api/public/response/:token
 *   token が `Message.shareToken` と一致し、かつ `shareExpiresAt` が未来であれば、
 *   そのメッセージの要約前の元文（進捗ノイズのみ除去）・
 *   作成日時・プロジェクト名を返す。添付ファイル・ユーザーの入力・他メッセージは一切返さない
 *   （公開面の最小化）。token 不一致・期限切れ・キルスイッチ OFF は一律 404
 *   （Usage サイネージと同じ作法）。結果は 1 分キャッシュ。
 *
 * キルスイッチ: `DEVRELAY_RESPONSE_SHARE=0`（既定）で全ルート 404。
 */

import { FastifyInstance } from 'fastify';
import { prisma } from '../db/client.js';
import { isResponseShareEnabled, isPlausibleShareToken, isShareExpired } from '../services/response-share-rules.js';
import { cleanAiResponse } from '../services/response-split-rules.js';

interface SharedResponseBody {
  content: string;
  createdAt: string;
  expiresAt: string | null;
  projectName: string;
}

/** token → レスポンスのキャッシュ（Usage サイネージと同じ 1 分キャッシュ・サイズ上限クリア）。 */
const shareCache = new Map<string, { at: number; body: SharedResponseBody }>();
const SHARE_CACHE_MS = 60_000;

export async function responseShareRoutes(app: FastifyInstance) {
  app.get('/api/public/response/:token', async (request, reply) => {
    if (!isResponseShareEnabled(process.env.DEVRELAY_RESPONSE_SHARE)) {
      return reply.status(404).send({ error: 'Not found' });
    }
    const { token } = request.params as { token: string };
    if (!isPlausibleShareToken(token)) {
      return reply.status(404).send({ error: 'Not found' });
    }

    const hit = shareCache.get(token);
    if (hit && Date.now() - hit.at < SHARE_CACHE_MS) return hit.body;

    const message = await prisma.message.findUnique({
      where: { shareToken: token },
      select: {
        content: true,
        createdAt: true,
        shareExpiresAt: true,
        session: { select: { project: { select: { name: true, displayName: true } } } },
      },
    });
    if (!message || isShareExpired(message.shareExpiresAt)) {
      return reply.status(404).send({ error: 'Not found' });
    }

    // 詳細画面は本文用要約を再掲せず、保存された元文をそのまま返す。
    // `<!-- devrelay:detail -->` は Markdown コメントのため表示には現れない。
    const content = cleanAiResponse(message.content);

    const body: SharedResponseBody = {
      content,
      createdAt: message.createdAt.toISOString(),
      expiresAt: message.shareExpiresAt?.toISOString() ?? null,
      projectName: message.session.project.displayName || message.session.project.name,
    };

    // キャッシュサイズの上限（Usage サイネージと同じ流儀）。超えたら全クリアして単純化する。
    if (shareCache.size > 500) shareCache.clear();
    shareCache.set(token, { at: Date.now(), body });
    return body;
  });
}
