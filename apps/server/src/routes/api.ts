import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomBytes } from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';
import { Prisma, Machine, Project, Session } from '@prisma/client';
import { prisma } from '../db/client.js';
import { authenticate } from './auth.js';
import { getConnectedAgents, requestHistoryDates, requestHistoryExport } from '../services/agent-manager.js';
import { encrypt, decrypt } from '../services/user-settings.js';
import {
  getLinkedPlatforms,
  validateAndConsumeLinkCode,
  unlinkPlatform,
} from '../services/platform-link.js';
import { encodeToken } from '@devrelay/shared';

const execAsync = promisify(exec);

// Type for machine with projects
type MachineWithProjects = Machine & {
  projects: Project[];
};

// Type for project with machine
type ProjectWithMachine = Project & {
  machine: { id: string; name: string };
};

// Type for session with relations
type SessionWithRelations = Session & {
  project: { name: string };
  machine: { name: string };
};

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

    return machines.map((m: MachineWithProjects) => ({
      id: m.id,
      name: m.name,
      status: connectedAgents.has(m.id) ? 'online' : 'offline',
      lastSeenAt: m.lastSeenAt,
      projectCount: m.projects.length,
      projects: m.projects.map((p: Project) => ({
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

    // トークン生成（サーバーURLを埋め込んだ新形式）
    // リクエストの Host ヘッダーからサーバーの WebSocket URL を構築
    const host = request.headers.host || 'localhost:3000';
    const protocol = request.headers['x-forwarded-proto'] === 'https' || host.includes('devrelay.io') ? 'wss' : 'ws';
    const serverWsUrl = `${protocol}://${host}/ws/agent`;
    const token = encodeToken(serverWsUrl, randomBytes(32).toString('hex'));

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
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
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

    return projects.map((p: ProjectWithMachine) => ({
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

    // API キー・トークンはマスク表示
    if (result.openai_api_key) {
      result.openai_api_key = maskApiKey(result.openai_api_key);
    }
    if (result.anthropic_api_key) {
      result.anthropic_api_key = maskApiKey(result.anthropic_api_key);
    }
    if (result.discord_bot_token) {
      result.discord_bot_token = maskApiKey(result.discord_bot_token);
    }
    if (result.telegram_bot_token) {
      result.telegram_bot_token = maskApiKey(result.telegram_bot_token);
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

    // API キー・トークンは暗号化して保存
    const shouldEncrypt = key.includes('api_key') || key.includes('secret') || key.includes('token');
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
      recentSessions: recentSessions.map((s: SessionWithRelations) => ({
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

  // ========================================
  // サービス再起動（PM2 で管理）
  // ========================================

  // サーバー再起動
  app.post('/api/services/restart/server', async (request, reply) => {
    try {
      // バックグラウンドで再起動（レスポンスを返してから再起動）
      setTimeout(async () => {
        try {
          await execAsync('pm2 restart devrelay-server');
        } catch (err) {
          console.error('Failed to restart server:', err);
        }
      }, 500);

      return { success: true, message: 'Server restart initiated' };
    } catch (err) {
      console.error('Failed to initiate server restart:', err);
      return reply.status(500).send({ error: 'Failed to restart server' });
    }
  });

  // Agent 再起動
  app.post('/api/services/restart/agent', async (request, reply) => {
    try {
      // バックグラウンドで再起動
      setTimeout(async () => {
        try {
          await execAsync('pm2 restart devrelay-agent');
        } catch (err) {
          console.error('Failed to restart agent:', err);
        }
      }, 500);

      return { success: true, message: 'Agent restart initiated' };
    } catch (err) {
      console.error('Failed to initiate agent restart:', err);
      return reply.status(500).send({ error: 'Failed to restart agent' });
    }
  });

  // サービスステータス取得（PM2 の pid コマンドでプロセス存在チェック）
  app.get('/api/services/status', async (request, reply) => {
    try {
      const [serverStatus, agentStatus] = await Promise.all([
        execAsync('pm2 pid devrelay-server').then(
          (result) => result.stdout.trim() !== '' && result.stdout.trim() !== '0' ? 'active' : 'inactive',
          () => 'inactive'
        ),
        execAsync('pm2 pid devrelay-agent').then(
          (result) => result.stdout.trim() !== '' && result.stdout.trim() !== '0' ? 'active' : 'inactive',
          () => 'inactive'
        ),
      ]);

      return {
        server: serverStatus,
        agent: agentStatus,
      };
    } catch (err) {
      console.error('Failed to get service status:', err);
      return reply.status(500).send({ error: 'Failed to get service status' });
    }
  });

  // ========================================
  // 履歴エクスポート
  // ========================================

  // 日付一覧取得
  app.get('/api/projects/:projectId/history/dates', async (request, reply) => {
    // @ts-ignore
    const userId = request.user.id;
    const { projectId } = request.params as { projectId: string };

    // プロジェクトの存在とユーザーの権限を確認
    const project = await prisma.project.findFirst({
      where: { id: projectId, machine: { userId } },
      include: { machine: true }
    });

    if (!project) {
      return reply.status(404).send({ error: 'Project not found' });
    }

    // Agent がオンラインか確認
    const connectedAgents = getConnectedAgents();
    if (!connectedAgents.has(project.machineId)) {
      return reply.status(503).send({ error: 'Agent is offline' });
    }

    try {
      const dates = await requestHistoryDates(project.machineId, project.path);
      return { dates };
    } catch (err: any) {
      console.error('Failed to get history dates:', err);
      return reply.status(500).send({ error: err.message || 'Failed to get history dates' });
    }
  });

  // ZIP ダウンロード
  app.get('/api/projects/:projectId/history/:date/download', async (request, reply) => {
    // @ts-ignore
    const userId = request.user.id;
    const { projectId, date } = request.params as { projectId: string; date: string };

    // 日付フォーマット検証
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return reply.status(400).send({ error: 'Invalid date format. Use YYYY-MM-DD' });
    }

    // プロジェクトの存在とユーザーの権限を確認
    const project = await prisma.project.findFirst({
      where: { id: projectId, machine: { userId } },
      include: { machine: true }
    });

    if (!project) {
      return reply.status(404).send({ error: 'Project not found' });
    }

    // Agent がオンラインか確認
    const connectedAgents = getConnectedAgents();
    if (!connectedAgents.has(project.machineId)) {
      return reply.status(503).send({ error: 'Agent is offline' });
    }

    try {
      const zipContent = await requestHistoryExport(project.machineId, project.path, date);
      const buffer = Buffer.from(zipContent, 'base64');

      reply.header('Content-Type', 'application/zip');
      reply.header('Content-Disposition', `attachment; filename="${project.name}_${date}.zip"`);
      return reply.send(buffer);
    } catch (err: any) {
      console.error('Failed to export history:', err);
      return reply.status(500).send({ error: err.message || 'Failed to export history' });
    }
  });
}

// API キーをマスク表示
function maskApiKey(key: string): string {
  if (key.length <= 8) return '****';
  return key.substring(0, 4) + '****' + key.substring(key.length - 4);
}
