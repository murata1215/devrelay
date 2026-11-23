/**
 * AI 回答契約サイクル（2026-11-23 改訂）: AI 応答の詳細ページ — ログイン不要の閲覧 API。
 *
 * GET /api/public/response/:token
 *   token が `Message.shareToken` と一致し、かつ `shareExpiresAt` が未来であれば、
 *   そのメッセージの「人間向け本文 + 詳細」（境界行は取り除き、進捗ノイズも除去済み）・
 *   作成日時・プロジェクト名を返す。添付ファイル・ユーザーの入力・他メッセージは一切返さない
 *   （公開面の最小化）。token 不一致・期限切れ・キルスイッチ OFF は一律 404
 *   （Usage サイネージと同じ作法）。結果は 1 分キャッシュ。
 *
 * キルスイッチ: `DEVRELAY_RESPONSE_SHARE=0`（既定）で全ルート 404。
 */

import { FastifyInstance } from 'fastify';
import { prisma } from '../db/client.js';
import { isResponseShareEnabled, isPlausibleShareToken, isShareExpired } from '../services/response-share-rules.js';
import { splitAiResponse, hasDetailSection } from '../services/response-split-rules.js';

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

    // 境界行より前（人間向け本文）＋後（詳細）を見出しで繋いで、読む人が全体を把握できるようにする。
    // 境界行が無ければ全文がそのまま summary に入る（splitAiResponse の仕様）。
    const split = splitAiResponse(message.content);
    const content = hasDetailSection(split)
      ? `${split.summary}\n\n---\n\n## 詳細\n\n${split.detail}`
      : split.summary;

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
