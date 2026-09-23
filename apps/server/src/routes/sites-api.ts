/**
 * DevRelay Sites Phase 1-A — 管理者限定の読み取り専用 API。
 *
 * 全ルートに `requireSystemAdmin`（`services/system-admin.ts`、#367 と同じ流儀）を適用する。
 * Caddy 設定・ログ・DB schema には一切書き込まない（`POST .../health-check` も外向き HTTP GET
 * を 1 回打つだけの読み取り専用操作）。
 */

import { FastifyInstance } from 'fastify';
import { authenticate } from './auth.js';
import { requireSystemAdmin, type MinimalRequest } from '../services/system-admin.js';
import { getSiteInventory, invalidateSiteInventoryCache } from '../services/sites/site-inventory-service.js';
import { checkNow } from '../services/sites/health-checker.js';
import { getSiteStats } from '../services/sites/access-aggregator.js';

/** `:host` パラメータの形式チェック（パス注入対策。ホスト名として妥当な文字のみ許可）。 */
const HOST_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;

export async function sitesApiRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  // `/api/sites/_meta` は `/api/sites/:host` より先に登録し、`_meta` が host パラメータとして
  // 食われないようにする（Fastify は登録順ではなく静的パス優先でルーティングするため実害はないが、
  // 意図を明示するためにも先に置く）。
  app.get('/api/sites/_meta', async (request, reply) => {
    if (!requireSystemAdmin(request as unknown as MinimalRequest, reply)) return;
    const { meta } = await getSiteInventory();
    return meta;
  });

  app.get('/api/sites', async (request, reply) => {
    if (!requireSystemAdmin(request as unknown as MinimalRequest, reply)) return;
    const query = request.query as { refresh?: string };
    const { sites, meta } = await getSiteInventory(query.refresh === '1');
    return { sites, generatedAt: new Date().toISOString(), meta };
  });

  app.get('/api/sites/:host', async (request, reply) => {
    if (!requireSystemAdmin(request as unknown as MinimalRequest, reply)) return;
    const { host } = request.params as { host: string };
    if (!HOST_PATTERN.test(host)) {
      return reply.status(400).send({ error: 'invalid host' });
    }
    const { sites } = await getSiteInventory();
    const site = sites.find((s) => s.host === host);
    if (!site) {
      return reply.status(404).send({ error: 'site not found' });
    }
    return site;
  });

  // DevRelay Sites Phase 1-B: 1 site のアクセス解析統計（PV/UU/Referer/UTM/bot/4xx5xx/coverage）。
  // ログ未導入 host や集計未完了時は `null`（200 で返す。404 にはしない）。
  app.get('/api/sites/:host/stats', async (request, reply) => {
    if (!requireSystemAdmin(request as unknown as MinimalRequest, reply)) return;
    const { host } = request.params as { host: string };
    if (!HOST_PATTERN.test(host)) {
      return reply.status(400).send({ error: 'invalid host' });
    }
    const { sites } = await getSiteInventory();
    if (!sites.some((s) => s.host === host)) {
      return reply.status(404).send({ error: 'site not found' });
    }
    return { host, stats: getSiteStats(host) };
  });

  app.post('/api/sites/:host/health-check', async (request, reply) => {
    if (!requireSystemAdmin(request as unknown as MinimalRequest, reply)) return;
    const { host } = request.params as { host: string };
    if (!HOST_PATTERN.test(host)) {
      return reply.status(400).send({ error: 'invalid host' });
    }
    // レジストリに存在しないホストへの任意アクセスを防ぐ（既知の公開 site のみ許可）
    const { sites } = await getSiteInventory();
    if (!sites.some((s) => s.host === host)) {
      return reply.status(404).send({ error: 'site not found' });
    }
    const health = await checkNow(host);
    invalidateSiteInventoryCache();
    return health;
  });
}
