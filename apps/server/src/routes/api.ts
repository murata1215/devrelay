import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomBytes } from 'crypto';
import { prisma } from '../db/client.js';
import { authenticate } from './auth.js';
import { getConnectedAgents } from '../services/agent-manager.js';
import { encrypt, decrypt } from '../services/user-settings.js';
import {
  getLinkedPlatforms,
  validateAndConsumeLinkCode,
  unlinkPlatform,
} from '../services/platform-link.js';

export async function apiRoutes(app: FastifyInstance) {
  // すべてのルートに認証を適用
  app.addHook('preHandler', authenticate);

  // ========================================
  // マシン（Agent）一覧
  // ========================================
  app.get('/api/machines', async (request) => {
    // @ts-ignore
    const userId = request.user.id;

    const machines = await prisma.machine.findMany({
      where: { userId },
      include: {
        projects: {
          orderBy: { lastUsedAt: 'desc' },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });

    // 接続中のエージェント情報を取得
    const connectedAgents = getConnectedAgents();

    return machines.map((m) => ({
      id: m.id,
      name: m.name,
      status: connectedAgents.has(m.id) ? 'online' : 'offline',
      lastSeenAt: m.lastSeenAt,
      projectCount: m.projects.length,
      projects: m.projects.map((p) => ({
        id: p.id,
        name: p.name,
        path: p.path,
        lastUsedAt: p.lastUsedAt,
      })),
    }));
  });

  // ========================================
  // マシン（Agent）登録
  // ========================================
  app.post('/api/machines', async (request, reply) => {
    // @ts-ignore
    const userId = request.user.id;
    const { name } = request.body as { name: string };

    if (!name || name.trim().length === 0) {
      return reply.status(400).send({ error: 'Machine name is required' });
    }

    // 同じユーザーで同じ名前のマシンがあるか確認
    const existing = await prisma.machine.findFirst({
      where: { userId, name: name.trim() },
    });

    if (existing) {
      return reply.status(409).send({ error: 'Machine with this name already exists' });
    }

    // トークン生成（machine_ プレフィックス + 32バイトのランダム文字列）
    const token = `machine_${randomBytes(32).toString('hex')}`;

    const machine = await prisma.machine.create({
      data: {
        userId,
        name: name.trim(),
        token,
      },
    });

    // トークンは初回のみ返す（以降は取得不可）
    return {
      id: machine.id,
      name: machine.name,
      token: machine.token,
      createdAt: machine.createdAt,
    };
  });

  // ========================================
  // マシン（Agent）削除
  // ========================================
  app.delete('/api/machines/:id', async (request, reply) => {
    // @ts-ignore
    const userId = request.user.id;
    const { id } = request.params as { id: string };

    // ユーザーが所有するマシンか確認
    const machine = await prisma.machine.findFirst({
      where: { id, userId },
    });

    if (!machine) {
      return reply.status(404).send({ error: 'Machine not found' });
    }

    // 関連するプロジェクト、セッション、メッセージも削除される（Cascade）
    // ただし、Prisma のデフォルトでは Cascade が設定されていないので、手動で削除
    await prisma.$transaction(async (tx) => {
      // セッションに紐づくメッセージを削除
      await tx.message.deleteMany({
        where: { session: { machineId: id } },
      });
      // セッションを削除
      await tx.session.deleteMany({
        where: { machineId: id },
      });
      // プロジェクトを削除
      await tx.project.deleteMany({
        where: { machineId: id },
      });
      // マシンを削除
      await tx.machine.delete({
        where: { id },
      });
    });

    return { success: true };
  });

  // ========================================
  // プロジェクト一覧
  // ========================================
  app.get('/api/projects', async (request) => {
    // @ts-ignore
    const userId = request.user.id;

    const projects = await prisma.project.findMany({
      where: { machine: { userId } },
      include: {
        machine: {
          select: { id: true, name: true },
        },
      },
      orderBy: { lastUsedAt: 'desc' },
    });

    const connectedAgents = getConnectedAgents();

    return projects.map((p) => ({
      id: p.id,
      name: p.name,
      path: p.path,
      defaultAi: p.defaultAi,
      lastUsedAt: p.lastUsedAt,
      machine: {
        id: p.machine.id,
        name: p.machine.name,
        online: connectedAgents.has(p.machine.id),
      },
    }));
  });

  // ========================================
  // 設定（UserSettings）
  // ========================================

  // 設定取得
  app.get('/api/settings', async (request) => {
    // @ts-ignore
    const userId = request.user.id;

    const settings = await prisma.userSettings.findMany({
      where: { userId },
    });

    const result: Record<string, string> = {};
    for (const s of settings) {
      // 暗号化された値は復号化
      result[s.key] = s.encrypted ? decrypt(s.value) : s.value;
    }

    // API キーはマスク表示
    if (result.openai_api_key) {
      result.openai_api_key = maskApiKey(result.openai_api_key);
    }
    if (result.anthropic_api_key) {
      result.anthropic_api_key = maskApiKey(result.anthropic_api_key);
    }

    return result;
  });

  // 設定更新
  app.put('/api/settings/:key', async (request, reply) => {
    // @ts-ignore
    const userId = request.user.id;
    const { key } = request.params as { key: string };
    const { value } = request.body as { value: string };

    if (!value) {
      return reply.status(400).send({ error: 'Value is required' });
    }

    // API キーは暗号化して保存
    const shouldEncrypt = key.includes('api_key') || key.includes('secret');
    const storedValue = shouldEncrypt ? encrypt(value) : value;

    await prisma.userSettings.upsert({
      where: { userId_key: { userId, key } },
      update: { value: storedValue, encrypted: shouldEncrypt },
      create: { userId, key, value: storedValue, encrypted: shouldEncrypt },
    });

    return { success: true };
  });

  // 設定削除
  app.delete('/api/settings/:key', async (request) => {
    // @ts-ignore
    const userId = request.user.id;
    const { key } = request.params as { key: string };

    await prisma.userSettings.delete({
      where: { userId_key: { userId, key } },
    }).catch(() => {});

    return { success: true };
  });

  // ========================================
  // ダッシュボード統計
  // ========================================
  app.get('/api/dashboard/stats', async (request) => {
    // @ts-ignore
    const userId = request.user.id;

    const [machineCount, projectCount, sessionCount, recentSessions] = await Promise.all([
      prisma.machine.count({ where: { userId } }),
      prisma.project.count({ where: { machine: { userId } } }),
      prisma.session.count({ where: { userId } }),
      prisma.session.findMany({
        where: { userId },
        orderBy: { startedAt: 'desc' },
        take: 5,
        include: {
          project: { select: { name: true } },
          machine: { select: { name: true } },
        },
      }),
    ]);

    const connectedAgents = getConnectedAgents();
    const onlineMachines = await prisma.machine.count({
      where: {
        userId,
        id: { in: Array.from(connectedAgents.keys()) },
      },
    });

    return {
      machines: { total: machineCount, online: onlineMachines },
      projects: projectCount,
      sessions: sessionCount,
      recentSessions: recentSessions.map((s) => ({
        id: s.id,
        projectName: s.project.name,
        machineName: s.machine.name,
        aiTool: s.aiTool,
        status: s.status,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
      })),
    };
  });

  // ========================================
  // プラットフォーム連携
  // ========================================

  // 連携済みプラットフォーム一覧
  app.get('/api/platforms', async (request) => {
    // @ts-ignore
    const userId = request.user.id;
    return await getLinkedPlatforms(userId);
  });

  // コードでプラットフォームをリンク
  app.post('/api/platforms/link', async (request, reply) => {
    // @ts-ignore
    const userId = request.user.id;
    const { code } = request.body as { code: string };

    if (!code || code.trim().length === 0) {
      return reply.status(400).send({ error: 'Code is required' });
    }

    const result = await validateAndConsumeLinkCode(code.trim(), userId);

    if (!result.success) {
      return reply.status(400).send({ error: result.error });
    }

    return {
      success: true,
      platform: result.platform,
      platformName: result.platformName,
    };
  });

  // プラットフォームのリンク解除
  app.delete('/api/platforms/:platform', async (request, reply) => {
    // @ts-ignore
    const userId = request.user.id;
    const { platform } = request.params as { platform: string };

    const success = await unlinkPlatform(userId, platform);

    if (!success) {
      return reply.status(404).send({ error: 'Platform link not found' });
    }

    return { success: true };
  });
}

// API キーをマスク表示
function maskApiKey(key: string): string {
  if (key.length <= 8) return '****';
  return key.substring(0, 4) + '****' + key.substring(key.length - 4);
}
