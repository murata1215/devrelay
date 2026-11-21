/**
 * Usage（コスト集計）サイクル — API。
 *
 * 1. `usageApiRoutes`（ログイン必須。`/usage` 画面用）
 *    - GET    /api/usage?month=YYYY-MM          当月（指定月）と前月のスレッド別コスト行・候補・メンバー
 *    - PUT    /api/usage/groups/:userId          人のグループ（本人 or 同組織の admin）
 *    - PUT    /api/usage/cases/:sessionId        スレッドの案件（スレッドの持ち主 or 同組織の admin）
 *    - POST   /api/usage/signage-token           サイネージ URL の鍵を発行（admin。再発行で旧 URL は無効）
 *    - DELETE /api/usage/signage-token           サイネージを停止（admin）
 *    閲覧範囲: 組織所属なら組織全員（ユーザー承認の決定「見られる人：全員でいい」）。未所属なら本人のみ。
 *
 * 2. `usagePublicRoutes`（ログイン不要。サイネージ用）
 *    - GET /api/public/usage-signage?token=…&by=case|user|project
 *    token が組織の `usageSignageToken` と一致したときだけ、当月・前月のグループ別集計を返す
 *    （表示名・グループ・案件/利用者名・金額・回数のみ。スレッド名・メール・会話本文は返さない）。
 *    結果は 1 分キャッシュ。token 不一致・未発行・キルスイッチ OFF は 404。
 *
 * キルスイッチ: `DEVRELAY_USAGE=0` で全ルート 404。
 */

import crypto from 'crypto';
import { FastifyInstance, FastifyReply } from 'fastify';
import { prisma } from '../db/client.js';
import { authenticate } from './auth.js';
import {
  isValidMonthKey,
  jstMonthKey,
  shiftMonthKey,
  normalizeUsageLabel,
  summarizeUsageNested,
  totalUsage,
  USAGE_TIME_ZONE,
} from '@devrelay/shared';
import { isUsageEnabled, isUsageCaseRequired, isPlausibleSignageToken, parseSignageInnerAxis, USAGE_SIGNAGE_CACHE_MS } from '../services/usage-rules.js';
import {
  resolveUsageScope,
  orgMemberUserIds,
  loadUsageRows,
  loadUsageLabelOptions,
  loadUsageMembers,
  clearUsageCache,
} from '../services/usage-service.js';

function sendUsageDisabled(reply: FastifyReply) {
  return reply.status(404).send({ error: 'Usage is disabled (DEVRELAY_USAGE=0)' });
}

export async function usageApiRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  // ========================================
  // GET /api/usage?month=YYYY-MM
  // ========================================
  app.get('/api/usage', async (request, reply) => {
    if (!isUsageEnabled(process.env.DEVRELAY_USAGE)) return sendUsageDisabled(reply);
    // @ts-ignore - authenticate フックが request.user を付与する
    const userId = request.user.id as string;
    const q = request.query as { month?: string };
    const month = isValidMonthKey(q.month) ? q.month : jstMonthKey(new Date());
    const prevMonth = shiftMonthKey(month, -1);

    const scope = await resolveUsageScope(userId);
    const [rows, prevRows, options, members, org] = await Promise.all([
      loadUsageRows(scope.userIds, month),
      loadUsageRows(scope.userIds, prevMonth),
      loadUsageLabelOptions(scope.userIds),
      loadUsageMembers(scope.userIds),
      scope.organizationId && scope.role === 'admin'
        ? prisma.organization.findUnique({ where: { id: scope.organizationId }, select: { usageSignageToken: true } })
        : Promise.resolve(null),
    ]);

    return {
      month,
      prevMonth,
      currentMonth: jstMonthKey(new Date()),
      timeZone: USAGE_TIME_ZONE,
      myUserId: userId,
      isAdmin: scope.role === 'admin',
      inOrganization: !!scope.organizationId,
      rows,
      prevRows,
      groupOptions: options.groups,
      caseOptions: options.cases,
      members,
      // サイネージの鍵は admin にだけ返す（URL を組み立ててコピーするため）
      signageToken: scope.role === 'admin' ? (org?.usageSignageToken ?? null) : undefined,
    };
  });

  // ========================================
  // PUT /api/usage/groups/:userId  { group: string | null }
  // ========================================
  app.put('/api/usage/groups/:userId', async (request, reply) => {
    if (!isUsageEnabled(process.env.DEVRELAY_USAGE)) return sendUsageDisabled(reply);
    // @ts-ignore
    const viewerUserId = request.user.id as string;
    const { userId: targetUserId } = request.params as { userId: string };

    if (viewerUserId !== targetUserId) {
      const [viewer, target] = await Promise.all([
        prisma.organizationMember.findUnique({ where: { userId: viewerUserId }, select: { organizationId: true, role: true } }),
        prisma.organizationMember.findUnique({ where: { userId: targetUserId }, select: { organizationId: true } }),
      ]);
      const ok = viewer?.role === 'admin' && !!target && target.organizationId === viewer.organizationId;
      if (!ok) return reply.status(403).send({ error: 'グループを変更できるのは本人と管理者だけです' });
    }

    const normalized = normalizeUsageLabel((request.body as { group?: unknown } | undefined)?.group);
    if (!normalized.ok) return reply.status(400).send({ error: normalized.error });

    if (normalized.value === null) {
      await prisma.userUsageGroup.deleteMany({ where: { userId: targetUserId } });
    } else {
      await prisma.userUsageGroup.upsert({
        where: { userId: targetUserId },
        create: { userId: targetUserId, groupName: normalized.value, updatedBy: viewerUserId },
        update: { groupName: normalized.value, updatedBy: viewerUserId },
      });
    }
    clearUsageCache();
    return { userId: targetUserId, group: normalized.value };
  });

  // ========================================
  // GET /api/usage/case-settings — スレッド未作成でも必須か・候補を知るため（Lite の初回送信で新規作成する経路）
  // ========================================
  app.get('/api/usage/case-settings', async (request, reply) => {
    if (!isUsageEnabled(process.env.DEVRELAY_USAGE)) return sendUsageDisabled(reply);
    // @ts-ignore
    const viewerUserId = request.user.id as string;
    // 候補は自分が付けた案件だけ（組織全員分を出すと他人の案件で埋まるため。Usage 画面の絞り込みは組織全体のまま）
    const options = await loadUsageLabelOptions([viewerUserId]);
    return { options: options.cases, required: isUsageCaseRequired(process.env.DEVRELAY_USAGE_CASE_REQUIRED) };
  });

  // ========================================
  // GET /api/usage/sessions/:sessionId/case — チャット入力欄の上の案件欄用
  // 見られるのはスレッドの持ち主と同じ組織のメンバー。editable は持ち主 or 同組織 admin。
  // required は DEVRELAY_USAGE_CASE_REQUIRED=1 のとき true（WebUI だけが送信を止める）
  // ========================================
  app.get('/api/usage/sessions/:sessionId/case', async (request, reply) => {
    if (!isUsageEnabled(process.env.DEVRELAY_USAGE)) return sendUsageDisabled(reply);
    // @ts-ignore
    const viewerUserId = request.user.id as string;
    const { sessionId } = request.params as { sessionId: string };

    const session = await prisma.session.findUnique({ where: { id: sessionId }, select: { userId: true, usageCase: true } });
    if (!session) return reply.status(404).send({ error: 'スレッドが見つかりません' });

    let editable = session.userId === viewerUserId;
    if (!editable) {
      const [viewer, owner] = await Promise.all([
        prisma.organizationMember.findUnique({ where: { userId: viewerUserId }, select: { organizationId: true, role: true } }),
        prisma.organizationMember.findUnique({ where: { userId: session.userId }, select: { organizationId: true } }),
      ]);
      const sameOrg = !!viewer && !!owner && viewer.organizationId === owner.organizationId;
      if (!sameOrg) return reply.status(403).send({ error: 'このスレッドは見られません' });
      editable = viewer!.role === 'admin';
    }

    // 候補は閲覧者自身が付けた案件だけ
    const options = await loadUsageLabelOptions([viewerUserId]);
    return {
      sessionId,
      caseName: session.usageCase ?? null,
      options: options.cases,
      required: isUsageCaseRequired(process.env.DEVRELAY_USAGE_CASE_REQUIRED),
      editable,
    };
  });

  // ========================================
  // PUT /api/usage/cases/:sessionId  { caseName: string | null }
  // ========================================
  app.put('/api/usage/cases/:sessionId', async (request, reply) => {
    if (!isUsageEnabled(process.env.DEVRELAY_USAGE)) return sendUsageDisabled(reply);
    // @ts-ignore
    const viewerUserId = request.user.id as string;
    const { sessionId } = request.params as { sessionId: string };

    const session = await prisma.session.findUnique({ where: { id: sessionId }, select: { userId: true } });
    if (!session) return reply.status(404).send({ error: 'スレッドが見つかりません' });

    if (session.userId !== viewerUserId) {
      const [viewer, owner] = await Promise.all([
        prisma.organizationMember.findUnique({ where: { userId: viewerUserId }, select: { organizationId: true, role: true } }),
        prisma.organizationMember.findUnique({ where: { userId: session.userId }, select: { organizationId: true } }),
      ]);
      const ok = viewer?.role === 'admin' && !!owner && owner.organizationId === viewer.organizationId;
      if (!ok) return reply.status(403).send({ error: '案件を変更できるのはスレッドの持ち主と管理者だけです' });
    }

    const normalized = normalizeUsageLabel((request.body as { caseName?: unknown } | undefined)?.caseName);
    if (!normalized.ok) return reply.status(400).send({ error: normalized.error });

    await prisma.session.update({ where: { id: sessionId }, data: { usageCase: normalized.value } });
    clearUsageCache();
    return { sessionId, caseName: normalized.value };
  });

  // ========================================
  // POST /api/usage/signage-token — 発行（再発行で旧 URL は無効）
  // DELETE /api/usage/signage-token — 停止
  // ========================================
  const requireAdmin = async (userId: string, reply: FastifyReply) => {
    const m = await prisma.organizationMember.findUnique({ where: { userId }, select: { organizationId: true, role: true } });
    if (!m) {
      reply.status(404).send({ error: '組織に所属していません' });
      return null;
    }
    if (m.role !== 'admin') {
      reply.status(403).send({ error: '管理者権限が必要です' });
      return null;
    }
    return m;
  };

  app.post('/api/usage/signage-token', async (request, reply) => {
    if (!isUsageEnabled(process.env.DEVRELAY_USAGE)) return sendUsageDisabled(reply);
    // @ts-ignore
    const m = await requireAdmin(request.user.id as string, reply);
    if (!m) return;
    const token = crypto.randomBytes(24).toString('base64url');
    await prisma.organization.update({ where: { id: m.organizationId }, data: { usageSignageToken: token } });
    signageCache.clear();
    return { signageToken: token };
  });

  app.delete('/api/usage/signage-token', async (request, reply) => {
    if (!isUsageEnabled(process.env.DEVRELAY_USAGE)) return sendUsageDisabled(reply);
    // @ts-ignore
    const m = await requireAdmin(request.user.id as string, reply);
    if (!m) return;
    await prisma.organization.update({ where: { id: m.organizationId }, data: { usageSignageToken: null } });
    signageCache.clear();
    return { signageToken: null };
  });
}

// ---------------------------------------------------------------------------
// サイネージ（ログイン不要）
// ---------------------------------------------------------------------------

const signageCache = new Map<string, { at: number; body: unknown }>();

export async function usagePublicRoutes(app: FastifyInstance) {
  app.get('/api/public/usage-signage', async (request, reply) => {
    if (!isUsageEnabled(process.env.DEVRELAY_USAGE)) return sendUsageDisabled(reply);
    const q = request.query as { token?: string; by?: string };
    if (!isPlausibleSignageToken(q.token)) return reply.status(404).send({ error: 'Not found' });
    const inner = parseSignageInnerAxis(q.by);
    const key = `${q.token}|${inner}`;

    const hit = signageCache.get(key);
    if (hit && Date.now() - hit.at < USAGE_SIGNAGE_CACHE_MS) return hit.body;

    const org = await prisma.organization.findUnique({
      where: { usageSignageToken: q.token },
      select: { id: true, name: true },
    });
    if (!org) return reply.status(404).send({ error: 'Not found' });

    const month = jstMonthKey(new Date());
    const prevMonth = shiftMonthKey(month, -1);
    const userIds = await orgMemberUserIds(org.id);
    const [rows, prevRows] = await Promise.all([loadUsageRows(userIds, month), loadUsageRows(userIds, prevMonth)]);

    const prevByGroup = new Map<string, number>();
    for (const g of summarizeUsageNested(prevRows, 'group', inner)) {
      prevByGroup.set(g.key ?? '\u0000none', g.costUsd);
    }
    // 外側の切り口はグループ固定。前月だけに実績があるグループもカードに残す（当月 $0 で表示）
    const groups = summarizeUsageNested(rows, 'group', inner).map((g) => ({
      group: g.key,
      costUsd: g.costUsd,
      prevCostUsd: prevByGroup.get(g.key ?? '\u0000none') ?? 0,
      turns: g.turns,
      unknownTurns: g.unknownTurns,
      items: g.items.map((i) => ({ label: i.label, costUsd: i.costUsd, turns: i.turns })),
    }));
    const seen = new Set(groups.map((g) => g.group ?? '\u0000none'));
    for (const [k, prevCost] of prevByGroup) {
      if (seen.has(k)) continue;
      groups.push({
        group: k === '\u0000none' ? null : k,
        costUsd: 0,
        prevCostUsd: prevCost,
        turns: 0,
        unknownTurns: 0,
        items: [],
      });
    }

    const total = totalUsage(rows);
    const prevTotal = totalUsage(prevRows);
    const body = {
      organizationName: org.name,
      month,
      prevMonth,
      timeZone: USAGE_TIME_ZONE,
      by: inner,
      total: { costUsd: total.costUsd, turns: total.turns, unknownTurns: total.unknownTurns },
      prevTotal: { costUsd: prevTotal.costUsd, turns: prevTotal.turns, unknownTurns: prevTotal.unknownTurns },
      groups,
      generatedAt: new Date().toISOString(),
    };
    signageCache.set(key, { at: Date.now(), body });
    if (signageCache.size > 50) signageCache.clear();
    return body;
  });
}
