/**
 * 高辻ナレッジ サイクル2 — 管理 API（人の権限・案件/スレッドの機密度・スレッド閲覧）。
 *
 * 認証は `routes/sites-api.ts` / `routes/knowledge-api.ts` と同形
 * （`app.addHook('preHandler', authenticate)`、`Authorization: Bearer <AuthSession.token>`）。
 * killswitch（`DEVRELAY_KNOWLEDGE=0`）のときは全ルートが 404 を返す。
 */

import { FastifyInstance } from 'fastify';
import { prisma } from '../db/client.js';
import { authenticate } from './auth.js';
import { requireOrgAdmin, requireOrgManagerOrAdmin, getMembership } from './organization.js';
import { isKnowledgeEnabled } from '../services/knowledge-rank.js';
import { normalizeClearanceInput, COMPARTMENT_WILDCARD } from '../services/knowledge-access.js';
import {
  getKnowledgeThread,
  getThreadClassification,
  setThreadClassification,
  getProjectClassification,
  setProjectClassification,
} from '../services/knowledge-service.js';

/** killswitch OFF のときに全ルートで返す 404 ボディ（`knowledge-api.ts` と同文言の流儀）。 */
function sendKnowledgeDisabled(reply: { status: (code: number) => { send: (body: unknown) => unknown } }) {
  return reply.status(404).send({ error: 'Knowledge search is disabled (DEVRELAY_KNOWLEDGE=0)' });
}

export async function knowledgeAdminApiRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  // ========================================
  // GET /api/org/members/:userId/clearance — 組織 admin、または本人
  // ========================================
  app.get('/api/org/members/:userId/clearance', async (request, reply) => {
    if (!isKnowledgeEnabled(process.env.DEVRELAY_KNOWLEDGE)) return sendKnowledgeDisabled(reply);

    // @ts-ignore - authenticate フックが request.user を付与する
    const viewerUserId = request.user.id as string;
    const { userId: targetUserId } = request.params as { userId: string };

    const isSelf = viewerUserId === targetUserId;
    if (!isSelf) {
      const [viewerMembership, targetMembership] = await Promise.all([
        getMembership(viewerUserId),
        prisma.organizationMember.findUnique({ where: { userId: targetUserId }, select: { organizationId: true } }),
      ]);
      const isAdminOfTarget =
        viewerMembership?.role === 'admin' &&
        !!targetMembership &&
        viewerMembership.organizationId === targetMembership.organizationId;
      if (!isAdminOfTarget) {
        return reply.status(403).send({ error: '管理者権限が必要です' });
      }
    }

    const clearance = await prisma.userClearance.findUnique({
      where: { userId: targetUserId },
      select: { readLevel: true, writeLevel: true, compartments: true },
    });
    return {
      userId: targetUserId,
      readLevel: clearance?.readLevel ?? 0,
      writeLevel: clearance?.writeLevel ?? 0,
      compartments: clearance?.compartments ?? [],
    };
  });

  // ========================================
  // PUT /api/org/members/:userId/clearance — 組織 admin のみ
  // ========================================
  app.put('/api/org/members/:userId/clearance', async (request, reply) => {
    if (!isKnowledgeEnabled(process.env.DEVRELAY_KNOWLEDGE)) return sendKnowledgeDisabled(reply);

    // @ts-ignore
    const adminUserId = request.user.id as string;
    const { userId: targetUserId } = request.params as { userId: string };

    const membership = await requireOrgAdmin(adminUserId, reply);
    if (!membership) return;

    const targetMembership = await prisma.organizationMember.findUnique({
      where: { userId: targetUserId },
      select: { organizationId: true },
    });
    if (!targetMembership || targetMembership.organizationId !== membership.organizationId) {
      return reply.status(404).send({ error: '組織に所属していません' });
    }

    const body = request.body as { readLevel?: unknown; writeLevel?: unknown; compartments?: unknown };
    const normalized = normalizeClearanceInput(body);
    if (!normalized.ok) {
      return reply.status(400).send({ error: normalized.error });
    }

    await prisma.userClearance.upsert({
      where: { userId: targetUserId },
      create: { userId: targetUserId, ...normalized.value, updatedBy: adminUserId },
      update: { ...normalized.value, updatedBy: adminUserId },
    });

    return { userId: targetUserId, ...normalized.value };
  });

  // ========================================
  // GET /api/org/clearance — 組織 admin / manager（メンバー全員の一覧。設定画面の元データ）
  // ========================================
  app.get('/api/org/clearance', async (request, reply) => {
    if (!isKnowledgeEnabled(process.env.DEVRELAY_KNOWLEDGE)) return sendKnowledgeDisabled(reply);

    // @ts-ignore
    const viewerUserId = request.user.id as string;
    const membership = await requireOrgManagerOrAdmin(viewerUserId, reply);
    if (!membership) return;

    const members = await prisma.organizationMember.findMany({
      where: { organizationId: membership.organizationId },
      include: { user: { select: { id: true, email: true, name: true } } },
      orderBy: { createdAt: 'asc' },
    });
    const memberIds = members.map((m) => m.userId);
    const clearances = memberIds.length
      ? await prisma.userClearance.findMany({
          where: { userId: { in: memberIds } },
          select: { userId: true, readLevel: true, writeLevel: true, compartments: true },
        })
      : [];
    const clearanceMap = new Map(clearances.map((c) => [c.userId, c]));

    return {
      members: members.map((m) => {
        const clearance = clearanceMap.get(m.userId);
        return {
          userId: m.userId,
          email: m.user.email,
          name: m.user.name,
          role: m.role,
          readLevel: clearance?.readLevel ?? 0,
          writeLevel: clearance?.writeLevel ?? 0,
          compartments: clearance?.compartments ?? [],
        };
      }),
    };
  });

  // ========================================
  // GET /api/org/compartments — 組織メンバー（自分の組織内で使われている案件名の DISTINCT 一覧）
  // ========================================
  app.get('/api/org/compartments', async (request, reply) => {
    if (!isKnowledgeEnabled(process.env.DEVRELAY_KNOWLEDGE)) return sendKnowledgeDisabled(reply);

    // @ts-ignore
    const viewerUserId = request.user.id as string;
    const membership = await getMembership(viewerUserId);
    if (!membership) {
      return reply.status(404).send({ error: '組織に所属していません' });
    }

    const orgMembers = await prisma.organizationMember.findMany({
      where: { organizationId: membership.organizationId },
      select: { userId: true },
    });
    const memberIds = orgMembers.map((m) => m.userId);
    if (memberIds.length === 0) {
      return { compartments: [] };
    }

    const [projectCompartments, sessionCompartments, clearances] = await Promise.all([
      prisma.project.findMany({
        where: { machine: { userId: { in: memberIds } }, defaultCompartment: { not: null } },
        select: { defaultCompartment: true },
        distinct: ['defaultCompartment'],
      }),
      prisma.session.findMany({
        where: { userId: { in: memberIds }, compartment: { not: null } },
        select: { compartment: true },
        distinct: ['compartment'],
      }),
      prisma.userClearance.findMany({
        where: { userId: { in: memberIds } },
        select: { compartments: true },
      }),
    ]);

    const set = new Set<string>();
    for (const row of projectCompartments) {
      if (row.defaultCompartment) set.add(row.defaultCompartment);
    }
    for (const row of sessionCompartments) {
      if (row.compartment) set.add(row.compartment);
    }
    for (const row of clearances) {
      for (const c of row.compartments) {
        if (c !== COMPARTMENT_WILDCARD) set.add(c);
      }
    }

    return { compartments: Array.from(set).sort() };
  });

  // ========================================
  // GET / PUT /api/projects/:projectId/classification
  // 権限: 組織 admin/manager、または（組織なしの場合）プロジェクト所有者
  // ========================================
  app.get('/api/projects/:projectId/classification', async (request, reply) => {
    if (!isKnowledgeEnabled(process.env.DEVRELAY_KNOWLEDGE)) return sendKnowledgeDisabled(reply);
    // @ts-ignore
    const viewerUserId = request.user.id as string;
    const { projectId } = request.params as { projectId: string };
    const result = await getProjectClassification({ viewerUserId, projectId });
    if (!result.ok) {
      return reply.status(result.error === 'Project not found' ? 404 : 403).send({ error: result.error });
    }
    return { defaultLevel: result.after.level, defaultCompartment: result.after.compartment };
  });

  app.put('/api/projects/:projectId/classification', async (request, reply) => {
    if (!isKnowledgeEnabled(process.env.DEVRELAY_KNOWLEDGE)) return sendKnowledgeDisabled(reply);
    // @ts-ignore
    const viewerUserId = request.user.id as string;
    const { projectId } = request.params as { projectId: string };
    const body = request.body as { level?: number | null; compartment?: string | null };
    const result = await setProjectClassification({
      viewerUserId,
      projectId,
      level: body.level,
      compartment: body.compartment,
    });
    if (!result.ok) {
      return reply.status(result.error === 'Project not found' ? 404 : 400).send({ error: result.error });
    }
    return {
      before: { defaultLevel: result.before.level, defaultCompartment: result.before.compartment },
      after: { defaultLevel: result.after.level, defaultCompartment: result.after.compartment },
    };
  });

  // ========================================
  // GET / PUT /api/threads/:sessionId/classification
  // 権限: スレッド所有者、または同じ組織の admin/manager
  // ========================================
  app.get('/api/threads/:sessionId/classification', async (request, reply) => {
    if (!isKnowledgeEnabled(process.env.DEVRELAY_KNOWLEDGE)) return sendKnowledgeDisabled(reply);
    // @ts-ignore
    const viewerUserId = request.user.id as string;
    const { sessionId } = request.params as { sessionId: string };
    const result = await getThreadClassification({ viewerUserId, sessionId });
    if (!result.ok) {
      return reply.status(result.error === 'Session not found' ? 404 : 403).send({ error: result.error });
    }
    return result.snapshot;
  });

  app.put('/api/threads/:sessionId/classification', async (request, reply) => {
    if (!isKnowledgeEnabled(process.env.DEVRELAY_KNOWLEDGE)) return sendKnowledgeDisabled(reply);
    // @ts-ignore
    const viewerUserId = request.user.id as string;
    const { sessionId } = request.params as { sessionId: string };
    const body = request.body as { level?: number | null; compartment?: string | null };
    const result = await setThreadClassification({
      viewerUserId,
      sessionId,
      level: body.level,
      compartment: body.compartment,
    });
    if (!result.ok) {
      return reply.status(result.error === 'Session not found' ? 404 : 400).send({ error: result.error });
    }
    return { before: result.before, after: result.after };
  });

  // ========================================
  // GET /api/knowledge/threads/:sessionId — 可視判定つきで他人のスレッドを 1 件読む（監査あり）
  // ========================================
  app.get('/api/knowledge/threads/:sessionId', async (request, reply) => {
    if (!isKnowledgeEnabled(process.env.DEVRELAY_KNOWLEDGE)) return sendKnowledgeDisabled(reply);
    // @ts-ignore
    const viewerUserId = request.user.id as string;
    const { sessionId } = request.params as { sessionId: string };
    const query = request.query as { limit?: string; before?: string; after?: string; tail?: string };

    const result = await getKnowledgeThread({
      viewerUserId,
      sessionId,
      limit: query.limit !== undefined ? Number(query.limit) : undefined,
      before: query.before,
      after: query.after,
      tail: query.tail === 'true',
    });
    if (!result.ok) {
      return reply.status(404).send({ error: result.error });
    }
    const { ok: _ok, ...body } = result;
    return body;
  });
}
