/**
 * 高辻ナレッジ サイクル1 — `GET /api/knowledge/search`（次サイクルの WebUI 用。本サイクルは API のみ）。
 *
 * WebUI の他エンドポイントと同じ認証（`routes/sites-api.ts` と同形: `addHook('preHandler', authenticate)`、
 * `Authorization: Bearer <AuthSession.token>`、Cookie は使わない）。
 * killswitch（`DEVRELAY_KNOWLEDGE=0`）のときは 404 を返す。
 */

import { FastifyInstance } from 'fastify';
import { authenticate } from './auth.js';
import { searchKnowledge } from '../services/knowledge-service.js';
import { isKnowledgeEnabled } from '../services/knowledge-rank.js';

export async function knowledgeApiRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  app.get('/api/knowledge/search', async (request, reply) => {
    if (!isKnowledgeEnabled(process.env.DEVRELAY_KNOWLEDGE)) {
      return reply.status(404).send({ error: 'Knowledge search is disabled (DEVRELAY_KNOWLEDGE=0)' });
    }

    // @ts-ignore - authenticate フックが request.user を付与する
    const userId = request.user.id as string;
    const query = request.query as {
      query?: string;
      mode?: string;
      projectId?: string;
      kind?: string;
      since?: string;
      until?: string;
      limit?: string;
    };

    const result = await searchKnowledge({
      userId,
      query: query.query,
      mode: query.mode,
      projectId: query.projectId,
      kind: query.kind,
      since: query.since,
      until: query.until,
      limit: query.limit !== undefined ? Number(query.limit) : undefined,
    });

    if (!result.ok) {
      return reply.status(400).send({ error: result.error });
    }

    return reply.send({
      query: result.query,
      mode: result.mode,
      coverage: result.coverage,
      total: result.total,
      results: result.results,
    });
  });
}
