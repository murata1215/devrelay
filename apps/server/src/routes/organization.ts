import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { prisma } from '../db/client.js';
import { authenticate } from './auth.js';

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

    return {
      members: members.map((m) => ({
        userId: m.userId,
        email: m.user.email,
        name: m.user.name,
        role: m.role,
        createdAt: m.createdAt,
        isSelf: m.userId === userId,
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
    if (role !== 'admin' && role !== 'member') {
      return reply.status(400).send({ error: 'role は admin または member を指定してください' });
    }

    const target = await prisma.organizationMember.findUnique({ where: { userId: targetUserId } });
    if (!target || target.organizationId !== membership.organizationId) {
      return reply.status(404).send({ error: 'メンバーが見つかりません' });
    }

    // admin → member への降格で admin が0人になる場合は拒否
    if (target.role === 'admin' && role === 'member') {
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
    return { ok: true };
  });

  // ========================================
  // GET /api/org/activity — メンバーごとのアクティビティ監視（admin のみ）
  // ========================================
  app.get('/api/org/activity', async (request, reply) => {
    // @ts-ignore
    const userId = request.user.id as string;
    const membership = await requireOrgAdmin(userId, reply);
    if (!membership) return;

    const members = await prisma.organizationMember.findMany({
      where: { organizationId: membership.organizationId },
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
}
