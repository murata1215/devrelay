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
  machine: { id: string; name: string; displayName: string | null };
};

// Type for session with relations
type SessionWithRelations = Session & {
  project: { name: string };
  machine: { name: string; displayName: string | null };
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
      displayName: m.displayName ?? null,
      status: connectedAgents.has(m.id) ? 'online' : 'offline',
      lastSeenAt: m.lastSeenAt,
      managementInfo: m.managementInfo ?? null,
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
    const { name } = (request.body || {}) as { name?: string };

    // 名前が指定されていない場合は仮名を自動生成（agent-1, agent-2, ...）
    let machineName: string;
    if (name && name.trim().length > 0) {
      machineName = name.trim();
      // 同じユーザーで同じ名前のマシンがあるか確認
      const existing = await prisma.machine.findFirst({
        where: { userId, name: machineName },
      });
      if (existing) {
        return reply.status(409).send({ error: 'Machine with this name already exists' });
      }
    } else {
      // 仮名を自動生成: 同一ユーザーの agent-N を検索し、最大 N+1 で採番
      const existingAgents = await prisma.machine.findMany({
        where: { userId, name: { startsWith: 'agent-' } },
        select: { name: true },
      });
      const maxNum = existingAgents.reduce((max, m) => {
        const num = parseInt(m.name.replace('agent-', ''), 10);
        return isNaN(num) ? max : Math.max(max, num);
      }, 0);
      machineName = `agent-${maxNum + 1}`;
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
        name: machineName,
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
  // マシン（Agent）トークン取得
  // ========================================
  app.get('/api/machines/:id/token', async (request, reply) => {
    // @ts-ignore
    const userId = request.user.id;
    const { id } = request.params as { id: string };

    /** ユーザーが所有するマシンのトークンを取得 */
    const machine = await prisma.machine.findFirst({
      where: { id, userId },
      select: { token: true },
    });

    if (!machine) {
      return reply.status(404).send({ error: 'Machine not found' });
    }

    return { token: machine.token };
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
      // ビルドログを削除
      await tx.buildLog.deleteMany({
        where: { machineId: id },
      });
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
  // ホスト名エイリアス設定
  // 同じホスト名を持つ全マシンの displayName を一括更新
  // ========================================
  app.put('/api/machines/hostname-alias', async (request, reply) => {
    // @ts-ignore
    const userId = request.user.id;
    const { hostname, alias } = request.body as { hostname: string; alias: string };

    if (!hostname || hostname.trim().length === 0) {
      return reply.status(400).send({ error: 'Hostname is required' });
    }

    // alias が空文字の場合は null に変換（エイリアス解除）
    const displayAlias = alias && alias.trim().length > 0 ? alias.trim() : null;

    // ユーザーが所有する同じホスト名のマシンを全て検索
    // machineName は "hostname/username" 形式なので、hostname + "/" で前方一致
    const machines = await prisma.machine.findMany({
      where: {
        userId,
        name: { startsWith: `${hostname.trim()}/` },
      },
    });

    if (machines.length === 0) {
      return reply.status(404).send({ error: 'No machines found with this hostname' });
    }

    // displayName を計算: alias が設定されている場合 "alias/username" 形式に変換
    // alias が null の場合は displayName を null にクリア
    const updates = machines.map((m) => {
      const parts = m.name.split('/');
      const username = parts.length > 1 ? parts.slice(1).join('/') : '';
      const newDisplayName = displayAlias
        ? (username ? `${displayAlias}/${username}` : displayAlias)
        : null;

      return prisma.machine.update({
        where: { id: m.id },
        data: { displayName: newDisplayName },
      });
    });

    await Promise.all(updates);

    return {
      success: true,
      hostname: hostname.trim(),
      alias: displayAlias,
      updatedCount: machines.length,
    };
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
          select: { id: true, name: true, displayName: true },
        },
      },
      orderBy: { lastUsedAt: 'desc' },
    });

    const connectedAgents = getConnectedAgents();

    // 各プロジェクトの最新ビルドログを一括取得（N+1 回避）
    const projectIds = projects.map((p: ProjectWithMachine) => p.id);
    const latestBuilds = await prisma.buildLog.findMany({
      where: { projectId: { in: projectIds } },
      orderBy: { buildNumber: 'desc' },
      distinct: ['projectId'],
      select: {
        projectId: true,
        buildNumber: true,
        summary: true,
        createdAt: true,
      },
    });
    const buildMap = new Map(latestBuilds.map((b: any) => [b.projectId, b]));

    return projects.map((p: ProjectWithMachine) => {
      const build = buildMap.get(p.id);
      return {
        id: p.id,
        name: p.name,
        path: p.path,
        defaultAi: p.defaultAi,
        lastUsedAt: p.lastUsedAt,
        machine: {
          id: p.machine.id,
          name: p.machine.name,
          displayName: p.machine.displayName ?? null,
          online: connectedAgents.has(p.machine.id),
        },
        latestBuild: build ? {
          buildNumber: build.buildNumber,
          summary: build.summary,
          createdAt: build.createdAt,
        } : null,
      };
    });
  });

  // ========================================
  // プロジェクトのビルドログ一覧
  // ========================================
  app.get('/api/projects/:projectId/builds', async (request, reply) => {
    // @ts-ignore
    const userId = request.user.id;
    const { projectId } = request.params as { projectId: string };

    // プロジェクトの存在とユーザーの権限を確認
    const project = await prisma.project.findFirst({
      where: { id: projectId, machine: { userId } },
    });

    if (!project) {
      return reply.status(404).send({ error: 'Project not found' });
    }

    // ビルドログを降順で取得（最大50件）
    const builds = await prisma.buildLog.findMany({
      where: { projectId },
      orderBy: { buildNumber: 'desc' },
      take: 50,
      include: {
        machine: {
          select: { name: true, displayName: true },
        },
      },
    });

    return {
      builds: builds.map((b: any) => ({
        buildNumber: b.buildNumber,
        summary: b.summary,
        prompt: b.prompt,
        createdAt: b.createdAt,
        machineName: b.machine.displayName ?? b.machine.name,
      })),
    };
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
    if (result.gemini_api_key) {
      result.gemini_api_key = maskApiKey(result.gemini_api_key);
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
          machine: { select: { name: true, displayName: true } },
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
        machineDisplayName: s.machine.displayName ?? null,
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

  // ========================================
  // セッション使用量 API
  // ========================================

  /**
   * セッション内の会話使用量を取得する
   * ユーザーメッセージ（IN）と AI 応答（OUT）をペアにして、各ペアの使用量データを返す
   * @route GET /api/sessions/:sessionId/usage
   */
  app.get('/api/sessions/:sessionId/usage', async (request: FastifyRequest<{ Params: { sessionId: string } }>, reply: FastifyReply) => {
    const { sessionId } = request.params;
    const userId = (request as any).userId;

    // セッション情報を取得（認可チェック含む）
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      include: {
        project: { select: { name: true } },
        machine: { select: { name: true, displayName: true } },
      },
    });

    if (!session) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    // ユーザー認可: セッションの所有者のみアクセス可能
    if (session.userId !== userId) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    // セッション内の全メッセージを時系列順に取得
    const messages = await prisma.message.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        role: true,
        content: true,
        usageData: true,
        createdAt: true,
      },
    });

    // user → ai のペアを構築
    // user メッセージの直後の ai メッセージをペアとして扱う
    const conversations: Array<{
      userMessage: { content: string; createdAt: string };
      aiMessage: { content: string; createdAt: string } | null;
      usage: {
        model: string | null;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheCreationTokens: number;
        durationMs: number;
      } | null;
    }> = [];

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalDurationMs = 0;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];

      if (msg.role === 'user') {
        // 直後の ai メッセージを探す
        const aiMsg = (i + 1 < messages.length && messages[i + 1].role === 'ai')
          ? messages[i + 1]
          : null;

        let usageInfo = null;
        if (aiMsg?.usageData) {
          const data = aiMsg.usageData as any;
          const inputTokens = data.usage?.input_tokens ?? 0;
          const outputTokens = data.usage?.output_tokens ?? 0;
          const cacheReadTokens = data.usage?.cache_read_input_tokens ?? 0;
          const cacheCreationTokens = data.usage?.cache_creation_input_tokens ?? 0;
          const durationMs = data.durationMs ?? 0;

          usageInfo = {
            model: data.model ?? null,
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheCreationTokens,
            durationMs,
          };

          totalInputTokens += inputTokens;
          totalOutputTokens += outputTokens;
          totalDurationMs += durationMs;
        }

        conversations.push({
          userMessage: {
            content: msg.content,
            createdAt: msg.createdAt.toISOString(),
          },
          aiMessage: aiMsg ? {
            content: aiMsg.content,
            createdAt: aiMsg.createdAt.toISOString(),
          } : null,
          usage: usageInfo,
        });

        // ai メッセージがペアになった場合はスキップ
        if (aiMsg) i++;
      }
    }

    // 表示名の解決: displayName ?? name
    const machineName = session.machine.displayName ?? session.machine.name;

    return reply.send({
      sessionId,
      machineName,
      projectName: session.project.name,
      aiTool: session.aiTool,
      startedAt: session.startedAt.toISOString(),
      conversations,
      totalUsage: {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        totalTokens: totalInputTokens + totalOutputTokens,
        totalDurationMs,
      },
    });
  });

  // ========================================
  // 会話一覧 API（Conversations ページ用）
  // ========================================

  /**
   * 全セッション横断で会話ペア（user→ai）をフラットに一覧取得する
   * AI メッセージの usageData が存在するもののみ対象（#80 以降のデータ）
   * N+1 回避: AI メッセージ取得 → sessionId でバッチ → user メッセージをメモリ内マッチング
   * @route GET /api/conversations?offset=0&limit=50
   */
  app.get('/api/conversations', async (request: FastifyRequest<{ Querystring: { offset?: string; limit?: string } }>, reply: FastifyReply) => {
    const userId = (request as any).userId;
    const offset = Math.max(0, parseInt(request.query.offset || '0', 10) || 0);
    const limit = Math.min(100, Math.max(1, parseInt(request.query.limit || '50', 10) || 50));

    // Step 1: AI メッセージ（usageData 付き）を日時降順で取得
    const aiMessages = await prisma.message.findMany({
      where: {
        role: 'ai',
        usageData: { not: Prisma.DbNull },
        session: { userId },
      },
      orderBy: { createdAt: 'desc' },
      skip: offset,
      take: limit,
      select: {
        id: true,
        sessionId: true,
        content: true,
        usageData: true,
        createdAt: true,
        session: {
          select: {
            project: { select: { name: true } },
            machine: { select: { name: true, displayName: true } },
          },
        },
      },
    });

    // Step 2: 関連する sessionId の user メッセージをバッチ取得（N+1 回避）
    const sessionIds = [...new Set(aiMessages.map(m => m.sessionId))];
    const userMessages = sessionIds.length > 0
      ? await prisma.message.findMany({
          where: {
            sessionId: { in: sessionIds },
            role: 'user',
          },
          orderBy: { createdAt: 'asc' },
          select: { sessionId: true, content: true, createdAt: true },
        })
      : [];

    // sessionId → user メッセージ配列のマップを構築
    const userMsgMap = new Map<string, typeof userMessages>();
    for (const msg of userMessages) {
      const arr = userMsgMap.get(msg.sessionId) || [];
      arr.push(msg);
      userMsgMap.set(msg.sessionId, arr);
    }

    // Step 3: AI メッセージごとに直前の user メッセージをマッチング
    const conversations = aiMessages.map(aiMsg => {
      const data = aiMsg.usageData as any;
      const inputTokens = data.usage?.input_tokens ?? 0;
      const outputTokens = data.usage?.output_tokens ?? 0;
      const cacheReadTokens = data.usage?.cache_read_input_tokens ?? 0;
      const cacheCreationTokens = data.usage?.cache_creation_input_tokens ?? 0;
      const durationMs = data.durationMs ?? 0;
      const model = data.model ?? null;

      // 同一セッション内で AI メッセージの直前にある user メッセージを探す
      const sessionUserMsgs = userMsgMap.get(aiMsg.sessionId) || [];
      let userContent = '';
      for (let i = sessionUserMsgs.length - 1; i >= 0; i--) {
        if (sessionUserMsgs[i].createdAt <= aiMsg.createdAt) {
          userContent = sessionUserMsgs[i].content;
          break;
        }
      }

      const machineName = aiMsg.session.machine.displayName ?? aiMsg.session.machine.name;

      return {
        messageId: aiMsg.id,
        sessionId: aiMsg.sessionId,
        projectName: aiMsg.session.project.name,
        machineName,
        userMessage: userContent,
        aiMessage: aiMsg.content,
        model,
        durationMs,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        createdAt: aiMsg.createdAt.toISOString(),
      };
    });

    // Step 4: 総件数を取得（ページネーション用）
    const total = await prisma.message.count({
      where: {
        role: 'ai',
        usageData: { not: Prisma.DbNull },
        session: { userId },
      },
    });

    return reply.send({ conversations, total, offset, limit });
  });
}

// API キーをマスク表示
function maskApiKey(key: string): string {
  if (key.length <= 8) return '****';
  return key.substring(0, 4) + '****' + key.substring(key.length - 4);
}
