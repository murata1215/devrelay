/**
 * ポータル サイクル P1 — API。
 *
 * 1. `portalPublicRoutes`（ログイン不要。社内ネットワーク内のみ公開の前提、ユーザー決定 2026-11-21）
 *    - GET /api/portal/docs              `DEVRELAY_PORTAL_DIR` 配下の PDF を分類ごとに返す
 *    - GET /api/portal/docs/file?path=   PDF 本体（inline）。DIR の外・PDF 以外は 404
 *    - GET /api/portal/news              `<DIR>/news/items.json`（新しい順）
 *    - GET /api/portal/issues            `<DIR>/issues.json`
 *    DIR 未設定のときは `{ configured: false }` と空配列を返す（ポータル画面は空欄で表示される）。
 *
 * 2. `portalTodoRoutes`（ログイン必須。本人の TODO のみ）
 *    - GET    /api/portal/todos
 *    - POST   /api/portal/todos          { text }
 *    - PATCH  /api/portal/todos/:id      { text?, done? }
 *    - DELETE /api/portal/todos/:id
 *
 * キルスイッチ: `DEVRELAY_PORTAL=0` で全ルート 404。
 */

import fs from 'fs';
import path from 'path';
import { FastifyInstance, FastifyReply } from 'fastify';
import { prisma } from '../db/client.js';
import { authenticate } from './auth.js';
import { contentDisposition } from '../services/content-disposition.js';
import {
  isPortalEnabled,
  normalizeTodoText,
  PORTAL_TODO_MAX_PER_USER,
  resolvePortalDir,
} from '../services/portal-rules.js';
import { loadPortalDocs, loadPortalIssues, loadPortalNews, resolvePortalDocFile } from '../services/portal-service.js';

function sendPortalDisabled(reply: FastifyReply) {
  return reply.status(404).send({ error: 'Portal API is disabled (DEVRELAY_PORTAL=0)' });
}

export async function portalPublicRoutes(app: FastifyInstance) {
  app.get('/api/portal/docs', async (_request, reply) => {
    if (!isPortalEnabled(process.env.DEVRELAY_PORTAL)) return sendPortalDisabled(reply);
    const root = resolvePortalDir(process.env.DEVRELAY_PORTAL_DIR);
    if (!root) return { configured: false, categories: [] };
    return { configured: true, categories: await loadPortalDocs(root) };
  });

  app.get('/api/portal/docs/file', async (request, reply) => {
    if (!isPortalEnabled(process.env.DEVRELAY_PORTAL)) return sendPortalDisabled(reply);
    const root = resolvePortalDir(process.env.DEVRELAY_PORTAL_DIR);
    if (!root) return reply.status(404).send({ error: 'Not found' });
    const rel = (request.query as { path?: unknown }).path;
    const abs = await resolvePortalDocFile(root, rel);
    if (!abs) return reply.status(404).send({ error: 'Not found' });
    return reply
      .type('application/pdf')
      .header('Content-Disposition', contentDisposition('inline', path.basename(abs)))
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'no-cache')
      .send(fs.createReadStream(abs));
  });

  app.get('/api/portal/news', async (_request, reply) => {
    if (!isPortalEnabled(process.env.DEVRELAY_PORTAL)) return sendPortalDisabled(reply);
    const root = resolvePortalDir(process.env.DEVRELAY_PORTAL_DIR);
    if (!root) return { configured: false, items: [] };
    return { configured: true, items: await loadPortalNews(root) };
  });

  app.get('/api/portal/issues', async (_request, reply) => {
    if (!isPortalEnabled(process.env.DEVRELAY_PORTAL)) return sendPortalDisabled(reply);
    const root = resolvePortalDir(process.env.DEVRELAY_PORTAL_DIR);
    if (!root) return { configured: false, items: [] };
    return { configured: true, items: await loadPortalIssues(root) };
  });
}

const TODO_SELECT = { id: true, text: true, done: true, doneAt: true, createdAt: true, updatedAt: true } as const;

export async function portalTodoRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  app.get('/api/portal/todos', async (request, reply) => {
    if (!isPortalEnabled(process.env.DEVRELAY_PORTAL)) return sendPortalDisabled(reply);
    // @ts-ignore - authenticate フックが request.user を付与する
    const userId = request.user.id as string;
    const items = await prisma.portalTodo.findMany({
      where: { userId },
      orderBy: [{ done: 'asc' }, { createdAt: 'desc' }],
      take: PORTAL_TODO_MAX_PER_USER,
      select: TODO_SELECT,
    });
    return { items };
  });

  app.post('/api/portal/todos', async (request, reply) => {
    if (!isPortalEnabled(process.env.DEVRELAY_PORTAL)) return sendPortalDisabled(reply);
    // @ts-ignore
    const userId = request.user.id as string;
    const text = normalizeTodoText((request.body as { text?: unknown } | undefined)?.text);
    if (!text) return reply.status(400).send({ error: 'text is required (1-200 chars)' });
    const count = await prisma.portalTodo.count({ where: { userId } });
    if (count >= PORTAL_TODO_MAX_PER_USER) {
      return reply.status(400).send({ error: `TODO は ${PORTAL_TODO_MAX_PER_USER} 件までです。完了したものを削除してください` });
    }
    const item = await prisma.portalTodo.create({ data: { userId, text }, select: TODO_SELECT });
    return { item };
  });

  app.patch('/api/portal/todos/:id', async (request, reply) => {
    if (!isPortalEnabled(process.env.DEVRELAY_PORTAL)) return sendPortalDisabled(reply);
    // @ts-ignore
    const userId = request.user.id as string;
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { text?: unknown; done?: unknown };
    const data: { text?: string; done?: boolean; doneAt?: Date | null } = {};
    if (body.text !== undefined) {
      const text = normalizeTodoText(body.text);
      if (!text) return reply.status(400).send({ error: 'text must be 1-200 chars' });
      data.text = text;
    }
    if (body.done !== undefined) {
      if (typeof body.done !== 'boolean') return reply.status(400).send({ error: 'done must be boolean' });
      data.done = body.done;
      data.doneAt = body.done ? new Date() : null;
    }
    const existing = await prisma.portalTodo.findFirst({ where: { id, userId }, select: { id: true } });
    if (!existing) return reply.status(404).send({ error: 'Not found' });
    const item = await prisma.portalTodo.update({ where: { id }, data, select: TODO_SELECT });
    return { item };
  });

  app.delete('/api/portal/todos/:id', async (request, reply) => {
    if (!isPortalEnabled(process.env.DEVRELAY_PORTAL)) return sendPortalDisabled(reply);
    // @ts-ignore
    const userId = request.user.id as string;
    const { id } = request.params as { id: string };
    const res = await prisma.portalTodo.deleteMany({ where: { id, userId } });
    if (res.count === 0) return reply.status(404).send({ error: 'Not found' });
    return { ok: true };
  });
}
