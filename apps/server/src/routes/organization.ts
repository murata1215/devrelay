import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { prisma } from '../db/client.js';
import { authenticate } from './auth.js';
import {
  canViewMemberHistory,
  recordSupervisionAudit,
  isValidCidr,
  isIpAllowed,
  parseIpRanges,
  clearIpRangeCache,
} from '../services/org-control.js';
import { summarizeSessionActivity } from '../services/conversation-summarizer.js';

/**
 * エンタープライズモード（組織）API。
 * - 組織作成時にシステムが組織ID（orgCode）を自動発行し、admin が参加パスワードを設定する
 * - メンバーは「組織ID + 参加パスワード」を入力して自己参加する（admin のメール等は一切露出しない）
 * - admin はロゴ管理・メンバー管理・アクティビティ監視が可能
 */

/** ロゴ画像の最大サイズ（512KB） */
const MAX_LOGO_BYTES = 512 * 1024;

/** 組織参加のブルートフォース対策: userId ごとの失敗回数を記録するメモリ Map */
const joinFailures = new Map<string, { count: number; lockedUntil: number }>();
/** 失敗許容回数 */
const JOIN_MAX_FAILURES = 5;
/** ロック時間（10分） */
const JOIN_LOCK_MS = 10 * 60 * 1000;

/**
 * 組織ID（orgCode）を生成する。
 * 紛らわしい文字（0/O/1/I 等）を除いた英数から 6 桁を作り「ORG-」を付与する。
 */
function generateOrgCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(6);
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[bytes[i] % chars.length];
  }
  return `ORG-${code}`;
}

/**
 * 衝突しない一意な組織IDを発行する。
 */
async function generateUniqueOrgCode(): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = generateOrgCode();
    const existing = await prisma.organization.findUnique({ where: { orgCode: code } });
    if (!existing) return code;
  }
  // 万一連続衝突した場合はランダム性を増やして返す
  return `ORG-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

/**
 * リクエストユーザーの組織メンバー情報を取得する（組織本体を含む）。
 */
async function getMembership(userId: string) {
  return prisma.organizationMember.findUnique({
    where: { userId },
    include: { organization: true },
  });
}

/**
 * admin 権限を要求する共通ヘルパー。
 * admin でなければ 403 を送信して null を返す。
 */
async function requireOrgAdmin(userId: string, reply: FastifyReply) {
  const membership = await getMembership(userId);
  if (!membership) {
    reply.status(404).send({ error: '組織に所属していません' });
    return null;
  }
  if (membership.role !== 'admin') {
    reply.status(403).send({ error: '管理者権限が必要です' });
    return null;
  }
  return membership;
}

/**
 * admin または manager 権限を要求する共通ヘルパー。
 * member（一般ユーザー）または未所属なら 403/404 を送信して null を返す。
 * 監督（担当ユーザーの活動・会話閲覧）に使う。
 */
async function requireOrgManagerOrAdmin(userId: string, reply: FastifyReply) {
  const membership = await getMembership(userId);
  if (!membership) {
    reply.status(404).send({ error: '組織に所属していません' });
    return null;
  }
  if (membership.role !== 'admin' && membership.role !== 'manager') {
    reply.status(403).send({ error: '管理者またはマネージャー権限が必要です' });
    return null;
  }
  return membership;
}

export async function organizationRoutes(app: FastifyInstance) {
  // すべてのルートに認証を適用
  app.addHook('preHandler', authenticate);

  // ========================================
  // GET /api/org/me — 自分の所属組織
  // member にはメンバー情報のみ（orgCode・admin 情報は返さない）
  // ========================================
  app.get('/api/org/me', async (request) => {
    // @ts-ignore
    const userId = request.user.id as string;
    const membership = await getMembership(userId);
    if (!membership) return { organization: null };

    const org = membership.organization;
    const base = {
      name: org.name,
      role: membership.role,
      hasLogo: !!org.logo,
    };
    // admin にのみ組織ID（orgCode）を開示する
    if (membership.role === 'admin') {
      return { organization: { ...base, orgCode: org.orgCode } };
    }
    return { organization: base };
  });

  // ========================================
  // POST /api/org — 組織作成（作成者を admin として登録）
  // ========================================
  app.post('/api/org', async (request, reply) => {
    // @ts-ignore
    const userId = request.user.id as string;
    const { name, joinPassword, makeMeAdmin } = request.body as {
      name?: string;
      joinPassword?: string;
      makeMeAdmin?: boolean;
    };

    if (!name || !name.trim()) {
      return reply.status(400).send({ error: '会社名を入力してください' });
    }
    if (!joinPassword || joinPassword.length < 4) {
      return reply.status(400).send({ error: '参加パスワードは4文字以上で設定してください' });
    }
    if (makeMeAdmin === false) {
      // v1 では作成者を admin にしない選択肢は用意しない（統制の起点が消えるため）
      return reply.status(400).send({ error: '組織作成には管理者になる必要があります' });
    }

    // 既に組織に所属していれば作成不可
    const existing = await getMembership(userId);
    if (existing) {
      return reply.status(409).send({ error: '既に組織に所属しています' });
    }

    const orgCode = await generateUniqueOrgCode();
    const joinPasswordHash = await bcrypt.hash(joinPassword, 10);

    const org = await prisma.organization.create({
      data: {
        orgCode,
        name: name.trim(),
        joinPasswordHash,
        members: {
          create: { userId, role: 'admin' },
        },
      },
    });

    return { organization: { orgCode: org.orgCode, name: org.name, role: 'admin', hasLogo: false } };
  });

  // ========================================
  // POST /api/org/join — メンバー自己参加（組織ID + 参加パスワード）
  // ========================================
  app.post('/api/org/join', async (request, reply) => {
    // @ts-ignore
    const userId = request.user.id as string;
    const { orgCode, joinPassword } = request.body as {
      orgCode?: string;
      joinPassword?: string;
    };

    // レートリミット確認
    const fail = joinFailures.get(userId);
    if (fail && fail.lockedUntil > Date.now()) {
      const mins = Math.ceil((fail.lockedUntil - Date.now()) / 60000);
      return reply.status(429).send({ error: `試行回数が多すぎます。約${mins}分後に再試行してください` });
    }

    if (!orgCode || !joinPassword) {
      return reply.status(400).send({ error: '組織IDと参加パスワードを入力してください' });
    }

    // 既に組織に所属していれば参加不可
    const existing = await getMembership(userId);
    if (existing) {
      return reply.status(409).send({ error: '既に組織に所属しています' });
    }

    const org = await prisma.organization.findUnique({
      where: { orgCode: orgCode.trim().toUpperCase() },
    });

    // 組織IDまたはパスワードが違う場合は区別せず同一エラーを返す
    const ok = org && (await bcrypt.compare(joinPassword, org.joinPasswordHash));
    if (!org || !ok) {
      const next = { count: (fail?.count ?? 0) + 1, lockedUntil: 0 };
      if (next.count >= JOIN_MAX_FAILURES) {
        next.lockedUntil = Date.now() + JOIN_LOCK_MS;
        next.count = 0;
      }
      joinFailures.set(userId, next);
      return reply.status(401).send({ error: '組織IDまたはパスワードが違います' });
    }

    // 成功したら失敗カウンタをクリア
    joinFailures.delete(userId);

    await prisma.organizationMember.create({
      data: { organizationId: org.id, userId, role: 'member' },
    });

    return { organization: { name: org.name, role: 'member', hasLogo: !!org.logo } };
  });

  // ========================================
  // POST /api/org/leave — メンバー脱退（最後の admin は脱退不可）
  // ========================================
  app.post('/api/org/leave', async (request, reply) => {
    // @ts-ignore
    const userId = request.user.id as string;
    const membership = await getMembership(userId);
    if (!membership) {
      return reply.status(404).send({ error: '組織に所属していません' });
    }

    if (membership.role === 'admin') {
      const adminCount = await prisma.organizationMember.count({
        where: { organizationId: membership.organizationId, role: 'admin' },
      });
      if (adminCount <= 1) {
        return reply.status(400).send({ error: '最後の管理者は脱退できません' });
      }
    }

    await prisma.organizationMember.delete({ where: { userId } });
    return { ok: true };
  });

  // ========================================
  // PATCH /api/org/password — 参加パスワード変更（admin のみ）
  // ========================================
  app.patch('/api/org/password', async (request, reply) => {
    // @ts-ignore
    const userId = request.user.id as string;
    const membership = await requireOrgAdmin(userId, reply);
    if (!membership) return;

    const { joinPassword } = request.body as { joinPassword?: string };
    if (!joinPassword || joinPassword.length < 4) {
      return reply.status(400).send({ error: '参加パスワードは4文字以上で設定してください' });
    }

    const joinPasswordHash = await bcrypt.hash(joinPassword, 10);
    await prisma.organization.update({
      where: { id: membership.organizationId },
      data: { joinPasswordHash },
    });
    return { ok: true };
  });

  // ========================================
  // GET /api/org/ip-ranges — 許可 IP レンジ取得（admin のみ、#285）
  // 現在の接続元 IP も返す（UI で締め出し確認に使う）
  // ========================================
  app.get('/api/org/ip-ranges', async (request, reply) => {
    // @ts-ignore
    const userId = request.user.id as string;
    const membership = await requireOrgAdmin(userId, reply);
    if (!membership) return;

    const ranges = parseIpRanges(membership.organization.allowedIpRanges);
    return { allowedIpRanges: ranges, currentIp: request.ip };
  });

  // ========================================
  // PUT /api/org/ip-ranges — 許可 IP レンジ設定（admin のみ、#285）
  // body: { allowedIpRanges: string[], force?: boolean }
  // ロックアウト防止: 保存後レンジに現在の接続元 IP が含まれない場合、force なしなら 400 で警告
  // ========================================
  app.put('/api/org/ip-ranges', async (request, reply) => {
    // @ts-ignore
    const userId = request.user.id as string;
    const membership = await requireOrgAdmin(userId, reply);
    if (!membership) return;

    const body = request.body as { allowedIpRanges?: unknown; force?: boolean };
    const raw = body.allowedIpRanges;
    if (!Array.isArray(raw)) {
      return reply.status(400).send({ error: 'allowedIpRanges は配列で指定してください' });
    }
    // トリム + 空要素除去 + 重複排除
    const ranges = Array.from(
      new Set(
        raw
          .filter((x): x is string => typeof x === 'string')
          .map((x) => x.trim())
          .filter((x) => x.length > 0),
      ),
    );
    // CIDR 形式バリデーション
    const invalid = ranges.filter((r) => !isValidCidr(r));
    if (invalid.length > 0) {
      return reply
        .status(400)
        .send({ error: `IP レンジの形式が不正です: ${invalid.join(', ')}` });
    }

    // ロックアウト防止: レンジを設定するのに現在の接続元 IP が含まれないと自分が締め出される
    if (ranges.length > 0 && !isIpAllowed(request.ip, ranges) && !body.force) {
      return reply.status(400).send({
        error: 'lockout_warning',
        message: `現在の接続元 IP (${request.ip}) が許可レンジに含まれていません。このまま保存すると自分自身が締め出されます。続行するには確認してください。`,
        currentIp: request.ip,
      });
    }

    await prisma.organization.update({
      where: { id: membership.organizationId },
      data: { allowedIpRanges: ranges.length > 0 ? JSON.stringify(ranges) : null },
    });
    // IP レンジのキャッシュを全消去（次回チェックで新設定を反映）
    clearIpRangeCache();

    return { ok: true, allowedIpRanges: ranges, currentIp: request.ip };
  });

  // ========================================
  // GET /api/org/logo — ロゴ画像配信（メンバーなら誰でも取得可）
  // ========================================
  app.get('/api/org/logo', async (request, reply) => {
    // @ts-ignore
    const userId = request.user.id as string;
    const membership = await getMembership(userId);
    if (!membership || !membership.organization.logo) {
      return reply.status(404).send({ error: 'ロゴが登録されていません' });
    }
    const org = membership.organization;
    reply.header('Content-Type', org.logoMimeType || 'image/png');
    reply.header('Cache-Control', 'private, max-age=60');
    return reply.send(Buffer.from(org.logo!));
  });

  // ========================================
  // PUT /api/org/logo — ロゴ登録（admin のみ）
  // ========================================
  app.put('/api/org/logo', async (request, reply) => {
    // @ts-ignore
    const userId = request.user.id as string;
    const membership = await requireOrgAdmin(userId, reply);
    if (!membership) return;

    const { dataUrl } = request.body as { dataUrl?: string };
    if (!dataUrl) {
      return reply.status(400).send({ error: '画像データがありません' });
    }

    // data URL をパース（例: data:image/png;base64,xxxx）
    const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(dataUrl);
    if (!match) {
      return reply.status(400).send({ error: '画像形式が不正です（image/* の data URL が必要）' });
    }
    const mimeType = match[1];
    const buffer = Buffer.from(match[2], 'base64');
    if (buffer.length > MAX_LOGO_BYTES) {
      return reply.status(400).send({ error: 'ロゴ画像は512KB以下にしてください' });
    }

    await prisma.organization.update({
      where: { id: membership.organizationId },
      data: { logo: buffer, logoMimeType: mimeType },
    });
    return { ok: true, hasLogo: true };
  });

  // ========================================
  // DELETE /api/org/logo — ロゴ削除（admin のみ）
  // ========================================
  app.delete('/api/org/logo', async (request, reply) => {
    // @ts-ignore
    const userId = request.user.id as string;
    const membership = await requireOrgAdmin(userId, reply);
    if (!membership) return;

    await prisma.organization.update({
      where: { id: membership.organizationId },
      data: { logo: null, logoMimeType: null },
    });
    return { ok: true, hasLogo: false };
  });

  // ========================================
  // GET /api/org/members — メンバー一覧（admin のみ）
  // ========================================
  app.get('/api/org/members', async (request, reply) => {
    // @ts-ignore
    const userId = request.user.id as string;
    const membership = await requireOrgAdmin(userId, reply);
    if (!membership) return;

    const members = await prisma.organizationMember.findMany({
      where: { organizationId: membership.organizationId },
      include: { user: { select: { id: true, email: true, name: true } } },
      orderBy: { createdAt: 'asc' },
    });

    // 各 member に割り当てられている manager 数を集計（未割当の member を可視化するため）
    const assignmentCounts = await prisma.managerAssignment.groupBy({
      by: ['memberUserId'],
      where: { organizationId: membership.organizationId },
      _count: { memberUserId: true },
    });
    const countMap = new Map(assignmentCounts.map((a) => [a.memberUserId, a._count.memberUserId]));

    return {
      members: members.map((m) => ({
        userId: m.userId,
        email: m.user.email,
        name: m.user.name,
        role: m.role,
        createdAt: m.createdAt,
        isSelf: m.userId === userId,
        // member のみ割当数を返す（admin/manager は統制対象外のため null）
        managerCount: m.role === 'member' ? (countMap.get(m.userId) ?? 0) : null,
      })),
    };
  });

  // ========================================
  // DELETE /api/org/members/:userId — メンバー削除（admin のみ、最後の admin 不可）
  // ========================================
  app.delete('/api/org/members/:userId', async (request, reply) => {
    // @ts-ignore
    const adminUserId = request.user.id as string;
    const membership = await requireOrgAdmin(adminUserId, reply);
    if (!membership) return;

    const { userId: targetUserId } = request.params as { userId: string };

    const target = await prisma.organizationMember.findUnique({ where: { userId: targetUserId } });
    if (!target || target.organizationId !== membership.organizationId) {
      return reply.status(404).send({ error: 'メンバーが見つかりません' });
    }

    // 最後の admin は削除不可
    if (target.role === 'admin') {
      const adminCount = await prisma.organizationMember.count({
        where: { organizationId: membership.organizationId, role: 'admin' },
      });
      if (adminCount <= 1) {
        return reply.status(400).send({ error: '最後の管理者は削除できません' });
      }
    }

    await prisma.organizationMember.delete({ where: { userId: targetUserId } });
    return { ok: true };
  });

  // ========================================
  // PATCH /api/org/members/:userId — role 変更（admin のみ）
  // ========================================
  app.patch('/api/org/members/:userId', async (request, reply) => {
    // @ts-ignore
    const adminUserId = request.user.id as string;
    const membership = await requireOrgAdmin(adminUserId, reply);
    if (!membership) return;

    const { userId: targetUserId } = request.params as { userId: string };
    const { role } = request.body as { role?: string };
    if (role !== 'admin' && role !== 'manager' && role !== 'member') {
      return reply.status(400).send({ error: 'role は admin / manager / member を指定してください' });
    }

    const target = await prisma.organizationMember.findUnique({ where: { userId: targetUserId } });
    if (!target || target.organizationId !== membership.organizationId) {
      return reply.status(404).send({ error: 'メンバーが見つかりません' });
    }

    // admin → 非 admin への降格で admin が0人になる場合は拒否
    if (target.role === 'admin' && role !== 'admin') {
      const adminCount = await prisma.organizationMember.count({
        where: { organizationId: membership.organizationId, role: 'admin' },
      });
      if (adminCount <= 1) {
        return reply.status(400).send({ error: '最後の管理者を降格できません' });
      }
    }

    await prisma.organizationMember.update({
      where: { userId: targetUserId },
      data: { role },
    });

    // manager でなくなった場合、その人が担当していた割当を解除する
    // （admin は暗黙的に全員を監督するため割当不要 / member に降格したら監督権限を失う）
    if (target.role === 'manager' && role !== 'manager') {
      await prisma.managerAssignment.deleteMany({
        where: { organizationId: membership.organizationId, managerUserId: targetUserId },
      });
    }
    // member でなくなった場合（manager/admin に昇格）、その人が「担当される側」だった割当も解除する
    if (target.role === 'member' && role !== 'member') {
      await prisma.managerAssignment.deleteMany({
        where: { organizationId: membership.organizationId, memberUserId: targetUserId },
      });
    }
    return { ok: true };
  });

  // ========================================
  // GET /api/org/activity — メンバーごとのアクティビティ監視
  // admin は全メンバー、manager は担当メンバーのみ
  // ========================================
  app.get('/api/org/activity', async (request, reply) => {
    // @ts-ignore
    const userId = request.user.id as string;
    const membership = await requireOrgManagerOrAdmin(userId, reply);
    if (!membership) return;

    // manager の場合は担当ユーザーのみに絞り込む
    let userIdFilter: string[] | null = null;
    if (membership.role === 'manager') {
      const assignments = await prisma.managerAssignment.findMany({
        where: { organizationId: membership.organizationId, managerUserId: userId },
        select: { memberUserId: true },
      });
      userIdFilter = assignments.map((a) => a.memberUserId);
      if (userIdFilter.length === 0) return { activity: [] };
    }

    const members = await prisma.organizationMember.findMany({
      where: {
        organizationId: membership.organizationId,
        ...(userIdFilter ? { userId: { in: userIdFilter } } : {}),
      },
      include: { user: { select: { id: true, email: true, name: true } } },
      orderBy: { createdAt: 'asc' },
    });

    // 各メンバー（userId）ごとに利用状況を集計する
    const activity = await Promise.all(
      members.map(async (m) => {
        const [sessionCount, buildCount, onlineMachines, lastMessage] = await Promise.all([
          prisma.session.count({ where: { userId: m.userId } }),
          prisma.buildLog.count({ where: { userId: m.userId } }),
          prisma.machine.count({ where: { userId: m.userId, status: 'online', deletedAt: null } }),
          prisma.message.findFirst({
            where: { session: { userId: m.userId } },
            orderBy: { createdAt: 'desc' },
            select: { createdAt: true },
          }),
        ]);
        return {
          userId: m.userId,
          email: m.user.email,
          name: m.user.name,
          role: m.role,
          sessionCount,
          buildCount,
          onlineMachines,
          lastActiveAt: lastMessage?.createdAt ?? null,
        };
      })
    );

    return { activity };
  });

  // ========================================
  // GET /api/org/members/:userId/managers — 指定 member の担当 manager 一覧（admin のみ）
  // ========================================
  app.get('/api/org/members/:userId/managers', async (request, reply) => {
    // @ts-ignore
    const adminUserId = request.user.id as string;
    const membership = await requireOrgAdmin(adminUserId, reply);
    if (!membership) return;

    const { userId: targetUserId } = request.params as { userId: string };
    const target = await prisma.organizationMember.findUnique({ where: { userId: targetUserId } });
    if (!target || target.organizationId !== membership.organizationId) {
      return reply.status(404).send({ error: 'メンバーが見つかりません' });
    }

    const assignments = await prisma.managerAssignment.findMany({
      where: { organizationId: membership.organizationId, memberUserId: targetUserId },
      select: { managerUserId: true },
    });
    return { managerUserIds: assignments.map((a) => a.managerUserId) };
  });

  // ========================================
  // PUT /api/org/members/:userId/managers — 担当 manager を全置換（admin のみ）
  // body: { managerUserIds: string[] }
  // ========================================
  app.put('/api/org/members/:userId/managers', async (request, reply) => {
    // @ts-ignore
    const adminUserId = request.user.id as string;
    const membership = await requireOrgAdmin(adminUserId, reply);
    if (!membership) return;

    const { userId: targetUserId } = request.params as { userId: string };
    const { managerUserIds } = request.body as { managerUserIds?: string[] };
    if (!Array.isArray(managerUserIds)) {
      return reply.status(400).send({ error: 'managerUserIds は配列で指定してください' });
    }

    // 対象が同組織の member であることを確認
    const target = await prisma.organizationMember.findUnique({ where: { userId: targetUserId } });
    if (!target || target.organizationId !== membership.organizationId) {
      return reply.status(404).send({ error: 'メンバーが見つかりません' });
    }
    if (target.role !== 'member') {
      return reply.status(400).send({ error: 'マネージャーを割り当てられるのは一般ユーザー（member）のみです' });
    }

    // 指定された manager 候補が全員同組織の manager/admin であることを検証
    const uniqueIds = [...new Set(managerUserIds)].filter((id) => id !== targetUserId);
    if (uniqueIds.length > 0) {
      const validManagers = await prisma.organizationMember.findMany({
        where: {
          organizationId: membership.organizationId,
          userId: { in: uniqueIds },
          role: { in: ['manager', 'admin'] },
        },
        select: { userId: true },
      });
      if (validManagers.length !== uniqueIds.length) {
        return reply.status(400).send({ error: '指定されたマネージャーに、同じ組織の manager/admin でない人が含まれています' });
      }
    }

    // トランザクションで全置換（既存削除 → 新規作成）
    await prisma.$transaction([
      prisma.managerAssignment.deleteMany({
        where: { organizationId: membership.organizationId, memberUserId: targetUserId },
      }),
      ...uniqueIds.map((managerUserId) =>
        prisma.managerAssignment.create({
          data: { organizationId: membership.organizationId, managerUserId, memberUserId: targetUserId },
        })
      ),
    ]);

    return { ok: true, managerUserIds: uniqueIds };
  });

  // ========================================
  // GET /api/org/my-members — 自分が監督するユーザー一覧
  // admin は組織全 member、manager は担当 member のみ
  // ========================================
  app.get('/api/org/my-members', async (request, reply) => {
    // @ts-ignore
    const userId = request.user.id as string;
    const membership = await requireOrgManagerOrAdmin(userId, reply);
    if (!membership) return;

    let memberUserIds: string[] | null = null;
    if (membership.role === 'manager') {
      const assignments = await prisma.managerAssignment.findMany({
        where: { organizationId: membership.organizationId, managerUserId: userId },
        select: { memberUserId: true },
      });
      memberUserIds = assignments.map((a) => a.memberUserId);
      if (memberUserIds.length === 0) return { members: [] };
    }

    const members = await prisma.organizationMember.findMany({
      where: {
        organizationId: membership.organizationId,
        role: 'member',
        ...(memberUserIds ? { userId: { in: memberUserIds } } : {}),
      },
      include: { user: { select: { id: true, email: true, name: true } } },
      orderBy: { createdAt: 'asc' },
    });

    return {
      members: members.map((m) => ({
        userId: m.userId,
        email: m.user.email,
        name: m.user.name,
      })),
    };
  });

  // ========================================
  // 統制 v3（#270）: 配下メンバーの活動閲覧・AI 要約
  // ========================================

  // GET /api/org/members/:userId/sessions — 対象メンバーのセッション一覧（要約付き・検索可）
  // クエリ: offset / limit / q（メッセージ全文検索）/ from / to（startedAt 期間、ISO 文字列）
  app.get('/api/org/members/:userId/sessions', async (request, reply) => {
    // @ts-ignore
    const viewerUserId = request.user.id as string;
    const { userId: targetUserId } = request.params as { userId: string };
    const query = request.query as { offset?: string; limit?: string; q?: string; from?: string; to?: string };

    // 権限チェック（本人 / 同組織 admin / 担当 manager）
    const allowed = await canViewMemberHistory(viewerUserId, targetUserId);
    if (!allowed) {
      return reply.status(403).send({ error: 'このユーザーの活動を閲覧する権限がありません' });
    }

    const offset = Math.max(0, parseInt(query.offset || '0', 10) || 0);
    const limit = Math.min(100, Math.max(1, parseInt(query.limit || '30', 10) || 30));
    const q = (query.q || '').trim();

    // startedAt 期間フィルタ
    const startedAtFilter: { gte?: Date; lte?: Date } = {};
    if (query.from) {
      const d = new Date(query.from);
      if (!isNaN(d.getTime())) startedAtFilter.gte = d;
    }
    if (query.to) {
      const d = new Date(query.to);
      if (!isNaN(d.getTime())) startedAtFilter.lte = d;
    }

    const where: any = { userId: targetUserId };
    if (startedAtFilter.gte || startedAtFilter.lte) {
      where.startedAt = startedAtFilter;
    }
    // q が指定されていればセッション内メッセージの部分一致で絞り込み
    if (q) {
      where.messages = { some: { content: { contains: q, mode: 'insensitive' } } };
    }

    const [total, sessions] = await Promise.all([
      prisma.session.count({ where }),
      prisma.session.findMany({
        where,
        orderBy: { startedAt: 'desc' },
        skip: offset,
        take: limit,
        select: {
          id: true,
          aiTool: true,
          status: true,
          startedAt: true,
          endedAt: true,
          summary: true,
          summarizedAt: true,
          project: { select: { name: true, displayName: true } },
          machine: { select: { name: true, displayName: true } },
          _count: { select: { messages: true } },
          // 先頭の user メッセージ抜粋（一覧のプレビュー用）
          messages: {
            where: { role: 'user' },
            orderBy: { createdAt: 'asc' },
            take: 1,
            select: { content: true },
          },
        },
      }),
    ]);

    // 監査ログ記録（他人閲覧時のみ、fire-and-forget）
    recordSupervisionAudit(viewerUserId, targetUserId, 'view_sessions', JSON.stringify({ q: q || undefined, from: query.from, to: query.to }));

    return {
      total,
      sessions: sessions.map((s) => {
        const preview = s.messages[0]?.content ?? '';
        return {
          id: s.id,
          aiTool: s.aiTool,
          status: s.status,
          startedAt: s.startedAt.toISOString(),
          endedAt: s.endedAt ? s.endedAt.toISOString() : null,
          summary: s.summary,
          summarizedAt: s.summarizedAt ? s.summarizedAt.toISOString() : null,
          projectName: s.project.displayName ?? s.project.name,
          machineName: s.machine.displayName ?? s.machine.name,
          messageCount: s._count.messages,
          preview: preview.length > 120 ? preview.substring(0, 120) + '...' : preview,
        };
      }),
    };
  });

  // POST /api/org/members/:userId/sessions/summarize — 未要約セッションを閲覧者のキーで一括要約
  // body: { sessionIds: string[] }（最大 10 件/回）
  app.post('/api/org/members/:userId/sessions/summarize', async (request, reply) => {
    // @ts-ignore
    const viewerUserId = request.user.id as string;
    const { userId: targetUserId } = request.params as { userId: string };
    const body = request.body as { sessionIds?: string[] };

    const allowed = await canViewMemberHistory(viewerUserId, targetUserId);
    if (!allowed) {
      return reply.status(403).send({ error: 'このユーザーの活動を閲覧する権限がありません' });
    }

    const sessionIds = Array.isArray(body?.sessionIds) ? body.sessionIds.slice(0, 10) : [];
    if (sessionIds.length === 0) {
      return reply.status(400).send({ error: 'sessionIds を指定してください（最大10件）' });
    }

    // 対象セッション取得（対象ユーザーのもの・未要約優先）
    const sessions = await prisma.session.findMany({
      where: { id: { in: sessionIds }, userId: targetUserId },
      select: {
        id: true,
        summary: true,
        startedAt: true,
        endedAt: true,
        project: { select: { name: true, displayName: true } },
        machine: { select: { name: true, displayName: true } },
      },
    });

    const results: { sessionId: string; summary: string | null }[] = [];
    let notConfigured = false;

    for (const s of sessions) {
      // 既に要約済みならスキップ（キャッシュ、再課金しない）
      if (s.summary) {
        results.push({ sessionId: s.id, summary: s.summary });
        continue;
      }
      // 会話メッセージ取得（時系列）
      const messages = await prisma.message.findMany({
        where: { sessionId: s.id },
        orderBy: { createdAt: 'asc' },
        select: { role: true, content: true, createdAt: true },
      });

      const result = await summarizeSessionActivity(
        viewerUserId,
        {
          projectName: s.project.displayName ?? s.project.name,
          machineName: s.machine.displayName ?? s.machine.name,
          startedAt: s.startedAt,
          endedAt: s.endedAt,
        },
        messages,
      );

      if (result.notConfigured) {
        notConfigured = true;
        break; // キー未設定ならこれ以上試行しない
      }

      if (result.summary) {
        await prisma.session.update({
          where: { id: s.id },
          data: { summary: result.summary, summarizedAt: new Date() },
        });
      }
      results.push({ sessionId: s.id, summary: result.summary });
    }

    if (notConfigured) {
      return reply.status(400).send({
        error: '要約用の AI プロバイダー・API キーが未設定です。Settings で設定してください。',
      });
    }

    // 監査ログ記録
    recordSupervisionAudit(viewerUserId, targetUserId, 'summarize', JSON.stringify({ count: results.length }));

    return { results };
  });

  // GET /api/org/sessions/:sessionId/messages — セッションの会話全文
  app.get('/api/org/sessions/:sessionId/messages', async (request, reply) => {
    // @ts-ignore
    const viewerUserId = request.user.id as string;
    const { sessionId } = request.params as { sessionId: string };

    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        userId: true,
        startedAt: true,
        endedAt: true,
        summary: true,
        project: { select: { name: true, displayName: true } },
        machine: { select: { name: true, displayName: true } },
      },
    });
    if (!session) {
      return reply.status(404).send({ error: 'セッションが見つかりません' });
    }

    // セッション所有者に対する閲覧権限を検証
    const allowed = await canViewMemberHistory(viewerUserId, session.userId);
    if (!allowed) {
      return reply.status(403).send({ error: 'この会話を閲覧する権限がありません' });
    }

    const messages = await prisma.message.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, role: true, content: true, platform: true, createdAt: true },
    });

    // 監査ログ記録（他人の会話閲覧時のみ）
    recordSupervisionAudit(viewerUserId, session.userId, 'view_messages', JSON.stringify({ sessionId }));

    return {
      session: {
        id: session.id,
        startedAt: session.startedAt.toISOString(),
        endedAt: session.endedAt ? session.endedAt.toISOString() : null,
        summary: session.summary,
        projectName: session.project.displayName ?? session.project.name,
        machineName: session.machine.displayName ?? session.machine.name,
      },
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        platform: m.platform,
        createdAt: m.createdAt.toISOString(),
      })),
    };
  });

  // GET /api/org/audit-log — 監視監査ログ（admin のみ）
  // クエリ: offset / limit
  app.get('/api/org/audit-log', async (request, reply) => {
    // @ts-ignore
    const userId = request.user.id as string;
    const membership = await requireOrgAdmin(userId, reply);
    if (!membership) return;

    const query = request.query as { offset?: string; limit?: string };
    const offset = Math.max(0, parseInt(query.offset || '0', 10) || 0);
    const limit = Math.min(100, Math.max(1, parseInt(query.limit || '50', 10) || 50));

    const where = { organizationId: membership.organizationId };
    const [total, logs] = await Promise.all([
      prisma.supervisionAuditLog.count({ where }),
      prisma.supervisionAuditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
      }),
    ]);

    // viewer/target のメールを一括解決
    const userIds = [...new Set(logs.flatMap((l) => [l.viewerUserId, l.targetUserId]))];
    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, email: true, name: true },
    });
    const userMap = new Map(users.map((u) => [u.id, u]));

    return {
      total,
      logs: logs.map((l) => ({
        id: l.id,
        action: l.action,
        detail: l.detail,
        createdAt: l.createdAt.toISOString(),
        viewer: userMap.get(l.viewerUserId)
          ? { email: userMap.get(l.viewerUserId)!.email, name: userMap.get(l.viewerUserId)!.name }
          : { email: null, name: null },
        target: userMap.get(l.targetUserId)
          ? { email: userMap.get(l.targetUserId)!.email, name: userMap.get(l.targetUserId)!.name }
          : { email: null, name: null },
      })),
    };
  });
}
