import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomBytes } from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';
import { Prisma, Machine, Project, Session } from '@prisma/client';
import { prisma } from '../db/client.js';
import { authenticate } from './auth.js';
import { getConnectedAgents, sendToAgent, requestHistoryDates, requestHistoryExport, requestProjectFileRead, requestLatestPlanFile, pushConfigUpdate, getAgentLocalProjectsDirs, pushAllowedToolsToAgents, executeCrossProjectQuery, isAgentConnected } from '../services/agent-manager.js';
import { encrypt, decrypt, getUserSetting, SettingKeys } from '../services/user-settings.js';
import { getUnprocessedCounts, generateReport, generateReportHtml, type ReportContent } from '../services/dev-report-generator.js';
import archiver from 'archiver';
import { DEFAULT_RULES_TEMPLATE } from '../services/agreement-template.js';
import { DEFAULT_ALLOWED_TOOLS_LINUX, DEFAULT_ALLOWED_TOOLS_WINDOWS, type AiTool } from '@devrelay/shared';
import {
  getLinkedPlatforms,
  validateAndConsumeLinkCode,
  unlinkPlatform,
} from '../services/platform-link.js';
import { encodeToken } from '@devrelay/shared';
import {
  getVapidPublicKey,
  savePushSubscription,
  removePushSubscription,
} from '../services/push-notification-service.js';
import {
  saveFcmToken,
  removeFcmToken,
} from '../services/fcm-service.js';
import {
  getNotifications,
  markAllAsRead,
  getUnreadCount,
} from '../services/notification-service.js';

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
      where: { userId, deletedAt: null },
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
        where: { userId, name: machineName, deletedAt: null },
      });
      if (existing) {
        return reply.status(409).send({ error: 'Machine with this name already exists' });
      }
    } else {
      // 仮名を自動生成: 同一ユーザーの agent-N を検索し、最大 N+1 で採番
      const existingAgents = await prisma.machine.findMany({
        where: { userId, name: { startsWith: 'agent-' }, deletedAt: null },
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

    /** ユーザーが所有するアクティブなマシンのトークンを取得 */
    const machine = await prisma.machine.findFirst({
      where: { id, userId, deletedAt: null },
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

    // ユーザーが所有するアクティブなマシンか確認
    const machine = await prisma.machine.findFirst({
      where: { id, userId, deletedAt: null },
    });

    if (!machine) {
      return reply.status(404).send({ error: 'Machine not found' });
    }

    // ソフトデリート: deletedAt を設定し、name/token をリネームして unique 制約を回避
    // 関連データ（Session/Message/BuildLog/Project）はそのまま保持
    const now = new Date();
    await prisma.machine.update({
      where: { id },
      data: {
        deletedAt: now,
        status: 'offline',
        name: `${machine.name}__deleted_${now.getTime()}`,
        token: `deleted_${now.getTime()}_${machine.token}`,
      },
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
        deletedAt: null,
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
  // プロジェクト検索パス（Server 管理）
  // ========================================

  /** マシンのプロジェクト検索パスを取得 */
  app.get('/api/machines/:id/projects-dirs', async (request, reply) => {
    // @ts-ignore
    const userId = request.user.id;
    const { id } = request.params as { id: string };

    const machine = await prisma.machine.findFirst({
      where: { id, userId, deletedAt: null },
      select: { projectsDirs: true },
    });

    if (!machine) {
      return reply.status(404).send({ error: 'Machine not found' });
    }

    return {
      projectsDirs: (machine.projectsDirs as string[] | null) ?? null,
      localProjectsDirs: getAgentLocalProjectsDirs(id),
    };
  });

  /** マシンのプロジェクト検索パスを更新し、Agent がオンラインならリアルタイム配信 */
  app.put('/api/machines/:id/projects-dirs', async (request, reply) => {
    // @ts-ignore
    const userId = request.user.id;
    const { id } = request.params as { id: string };
    const { projectsDirs } = request.body as { projectsDirs: string[] | null };

    const machine = await prisma.machine.findFirst({
      where: { id, userId, deletedAt: null },
    });

    if (!machine) {
      return reply.status(404).send({ error: 'Machine not found' });
    }

    // DB 更新
    await prisma.machine.update({
      where: { id },
      data: { projectsDirs: projectsDirs ?? Prisma.DbNull },
    });

    // Agent がオンラインならリアルタイム配信
    const connectedAgents = getConnectedAgents();
    if (connectedAgents.has(id)) {
      pushConfigUpdate(id, { projectsDirs: projectsDirs ?? null });
    }

    return { success: true, projectsDirs: projectsDirs ?? null };
  });

  // skipPermissions（全ツール自動許可モード）の取得・更新
  app.get('/api/machines/:id/skip-permissions', async (request, reply) => {
    // @ts-ignore
    const userId = request.user.id;
    const { id } = request.params as { id: string };
    const machine = await prisma.machine.findFirst({
      where: { id, userId, deletedAt: null },
      select: { skipPermissions: true },
    });
    if (!machine) return reply.status(404).send({ error: 'Machine not found' });
    return { skipPermissions: machine.skipPermissions };
  });

  app.put('/api/machines/:id/skip-permissions', async (request, reply) => {
    // @ts-ignore
    const userId = request.user.id;
    const { id } = request.params as { id: string };
    const { skipPermissions } = request.body as { skipPermissions: boolean };

    const machine = await prisma.machine.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!machine) return reply.status(404).send({ error: 'Machine not found' });

    await prisma.machine.update({
      where: { id },
      data: { skipPermissions },
    });

    // Agent がオンラインならリアルタイム配信
    const connectedAgents = getConnectedAgents();
    if (connectedAgents.has(id)) {
      pushConfigUpdate(id, { skipPermissions });
    }

    return { success: true, skipPermissions };
  });

  // disableAsk（AskUserQuestion 無効化）の取得・更新
  app.get('/api/machines/:id/disable-ask', async (request, reply) => {
    // @ts-ignore
    const userId = request.user.id;
    const { id } = request.params as { id: string };
    const machine = await prisma.machine.findFirst({
      where: { id, userId, deletedAt: null },
      select: { disableAsk: true },
    });
    if (!machine) return reply.status(404).send({ error: 'Machine not found' });
    return { disableAsk: machine.disableAsk };
  });

  app.put('/api/machines/:id/disable-ask', async (request, reply) => {
    // @ts-ignore
    const userId = request.user.id;
    const { id } = request.params as { id: string };
    const { disableAsk } = request.body as { disableAsk: boolean };

    const machine = await prisma.machine.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!machine) return reply.status(404).send({ error: 'Machine not found' });

    await prisma.machine.update({
      where: { id },
      data: { disableAsk },
    });

    // Agent がオンラインならリアルタイム配信
    const connectedAgents = getConnectedAgents();
    if (connectedAgents.has(id)) {
      pushConfigUpdate(id, { disableAsk });
    }

    return { success: true, disableAsk };
  });

  // 個別 Agent 再起動（WebSocket 経由で Agent にリスタート指示を送信）
  app.post('/api/machines/:id/restart', async (request, reply) => {
    // @ts-ignore
    const userId = request.user.id;
    const { id } = request.params as { id: string };

    const machine = await prisma.machine.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!machine) return reply.status(404).send({ error: 'Machine not found' });

    const connectedAgents = getConnectedAgents();
    if (!connectedAgents.has(id)) {
      return reply.status(503).send({ error: 'Agent is offline' });
    }

    sendToAgent(id, { type: 'server:agent:restart', payload: {} });
    console.log(`🔄 Restart command sent to agent: ${machine.name} (${id})`);

    return { success: true, message: 'Restart command sent' };
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
        displayName: p.displayName ?? null,
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
  // プロジェクト表示名の更新
  // ========================================
  app.put('/api/projects/:projectId/display-name', async (request, reply) => {
    // @ts-ignore
    const userId = request.user.id;
    const { projectId } = request.params as { projectId: string };
    const { displayName } = (request.body || {}) as { displayName?: string | null };

    const project = await prisma.project.findFirst({
      where: { id: projectId, machine: { userId } },
    });
    if (!project) {
      return reply.status(404).send({ error: 'Project not found' });
    }

    // null または空文字列の場合はリセット（name に戻す）
    const newDisplayName = displayName?.trim() || null;

    await prisma.project.update({
      where: { id: projectId },
      data: { displayName: newDisplayName },
    });

    return { success: true, displayName: newDisplayName };
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
  // プロジェクトファイル読み取り（Agent 経由）
  // ========================================
  app.get('/api/projects/:projectId/file', async (request, reply) => {
    const userId = (request as any).user.id as string;
    const { projectId } = request.params as { projectId: string };
    const { filePath } = request.query as { filePath?: string };

    if (!filePath) {
      return reply.status(400).send({ error: 'filePath query parameter is required' });
    }

    // ファイルパスの基本バリデーション（パストラバーサル防止）
    if (filePath.includes('..') || filePath.startsWith('/') || filePath.startsWith('\\')) {
      return reply.status(400).send({ error: 'Invalid file path' });
    }

    const project = await prisma.project.findFirst({
      where: { id: projectId, machine: { userId } },
      include: { machine: true },
    });

    if (!project) {
      return reply.status(404).send({ error: 'Project not found' });
    }

    if (!getConnectedAgents().has(project.machineId)) {
      return reply.status(503).send({ error: 'Agent is offline' });
    }

    try {
      const result = await requestProjectFileRead(project.machineId, project.path, filePath);
      return { content: result.content };
    } catch (err: any) {
      return reply.status(500).send({ error: err.message || 'Failed to read project file' });
    }
  });

  /**
   * 最新プランファイルを Agent 経由で取得
   * @route GET /api/projects/:projectId/plan
   */
  app.get('/api/projects/:projectId/plan', async (request, reply) => {
    const userId = (request as any).user.id as string;
    const { projectId } = request.params as { projectId: string };

    const project = await prisma.project.findFirst({
      where: { id: projectId, machine: { userId } },
      include: { machine: true },
    });

    if (!project) {
      return reply.status(404).send({ error: 'Project not found' });
    }

    if (!getConnectedAgents().has(project.machineId)) {
      return reply.status(503).send({ error: 'Agent is offline' });
    }

    try {
      const result = await requestLatestPlanFile(project.machineId);
      return { filename: result.filename, content: result.content };
    } catch (err: any) {
      return reply.status(500).send({ error: err.message || 'Failed to read plan file' });
    }
  });

  /**
   * プロジェクト横断メッセージ履歴（全セッションを横断してカーソルベースページネーション）
   * @route GET /api/projects/:projectId/messages?limit=30&before=<messageId>
   */
  app.get('/api/projects/:projectId/messages', async (request: FastifyRequest<{ Params: { projectId: string }; Querystring: { limit?: string; before?: string } }>, reply: FastifyReply) => {
    const userId = (request as any).user.id;
    const { projectId } = request.params;
    const limit = Math.min(100, Math.max(1, parseInt(request.query.limit || '30', 10) || 30));
    const before = request.query.before || undefined;

    // プロジェクト認可チェック
    const project = await prisma.project.findFirst({
      where: { id: projectId, machine: { userId } },
    });
    if (!project) {
      return reply.status(404).send({ error: 'Project not found' });
    }

    // カーソル条件: before が指定されていれば、そのメッセージより古いものを取得
    const whereClause: any = { session: { projectId, userId } };
    if (before) {
      const cursorMsg = await prisma.message.findUnique({
        where: { id: before },
        select: { createdAt: true },
      });
      if (cursorMsg) {
        whereClause.createdAt = { lt: cursorMsg.createdAt };
      }
    }

    // limit + 1 件取得して hasMore を判定（全セッション横断）
    const messages = await prisma.message.findMany({
      where: whereClause,
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      select: {
        id: true,
        role: true,
        content: true,
        createdAt: true,
        sourceProjectName: true,
        files: {
          select: { id: true, filename: true, mimeType: true, size: true, direction: true },
        },
      },
    });

    const hasMore = messages.length > limit;
    const result = hasMore ? messages.slice(0, limit) : messages;

    // 時系列順（古い→新しい）に並び替えて返す
    result.reverse();

    reply.header('Cache-Control', 'no-store');
    return reply.send({
      messages: result.map(m => ({
        id: m.id,
        role: m.role,
        content: m.content,
        createdAt: m.createdAt.toISOString(),
        files: m.files,
        sourceProjectName: m.sourceProjectName ?? undefined,
      })),
      hasMore,
    });
  });

  // ========================================
  // ツール承認履歴
  // ========================================

  /** プロジェクトのツール承認履歴を取得（カーソルベースページネーション） */
  app.get('/api/projects/:projectId/approvals', async (request: FastifyRequest<{ Params: { projectId: string }; Querystring: { limit?: string; before?: string } }>, reply: FastifyReply) => {
    const userId = (request as any).user.id;
    const { projectId } = request.params;
    const limit = Math.min(200, Math.max(1, parseInt(request.query.limit || '100', 10) || 100));
    const before = request.query.before || undefined;

    // プロジェクト認可チェック
    const project = await prisma.project.findFirst({
      where: { id: projectId, machine: { userId } },
    });
    if (!project) {
      return reply.status(404).send({ error: 'Project not found' });
    }

    // カーソル条件
    const whereClause: any = { projectId };
    if (before) {
      const cursor = await prisma.toolApproval.findUnique({
        where: { id: before },
        select: { createdAt: true },
      });
      if (cursor) {
        whereClause.createdAt = { lt: cursor.createdAt };
      }
    }

    const approvals = await prisma.toolApproval.findMany({
      where: whereClause,
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      select: {
        id: true,
        requestId: true,
        toolName: true,
        toolInput: true,
        status: true,
        createdAt: true,
        resolvedAt: true,
      },
    });

    const hasMore = approvals.length > limit;
    const result = hasMore ? approvals.slice(0, limit) : approvals;

    // 時系列順（古い→新しい）に並び替えて返す
    result.reverse();

    return reply.send({
      approvals: result.map(a => ({
        id: a.id,
        requestId: a.requestId,
        toolName: a.toolName,
        toolInput: a.toolInput,
        status: a.status,
        createdAt: a.createdAt.toISOString(),
        resolvedAt: a.resolvedAt?.toISOString() ?? null,
      })),
      hasMore,
    });
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
      // Agreement テンプレートは専用 API で取得するため、汎用設定レスポンスからは除外
      if (s.key === SettingKeys.AGREEMENT_TEMPLATE) continue;
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
  // Agreement テンプレート
  // ========================================

  /**
   * Agreement テンプレートを取得
   * カスタムテンプレートがあればそれを返す。なければデフォルトを返す。
   */
  app.get('/api/agreement-template', async (request) => {
    // @ts-ignore
    const userId = request.user.id;

    const customTemplate = await getUserSetting(userId, SettingKeys.AGREEMENT_TEMPLATE);

    return {
      template: customTemplate ?? DEFAULT_RULES_TEMPLATE,
      isCustom: customTemplate !== null,
      defaultTemplate: DEFAULT_RULES_TEMPLATE,
    };
  });

  /**
   * Agreement テンプレートを保存（カスタマイズ）
   */
  app.put('/api/agreement-template', async (request, reply) => {
    // @ts-ignore
    const userId = request.user.id;
    const { template } = request.body as { template: string };

    if (!template || template.trim().length === 0) {
      return reply.status(400).send({ error: 'Template cannot be empty' });
    }

    await prisma.userSettings.upsert({
      where: { userId_key: { userId, key: SettingKeys.AGREEMENT_TEMPLATE } },
      update: { value: template, encrypted: false },
      create: { userId, key: SettingKeys.AGREEMENT_TEMPLATE, value: template, encrypted: false },
    });

    return { success: true };
  });

  /**
   * Agreement テンプレートをデフォルトにリセット（カスタムテンプレートを削除）
   */
  app.delete('/api/agreement-template', async (request) => {
    // @ts-ignore
    const userId = request.user.id;

    await prisma.userSettings.deleteMany({
      where: { userId, key: SettingKeys.AGREEMENT_TEMPLATE },
    });

    return { success: true, template: DEFAULT_RULES_TEMPLATE };
  });

  // ========================================
  // プランモード許可ツール（Allowed Tools）
  // ========================================

  /**
   * Linux/Windows 両方の allowedTools 設定を取得
   * カスタム値と各 OS のデフォルト値を返す
   */
  app.get('/api/settings/allowed-tools', async (request) => {
    // @ts-ignore
    const userId = request.user.id;

    const [linuxRaw, windowsRaw] = await Promise.all([
      getUserSetting(userId, SettingKeys.ALLOWED_TOOLS_LINUX),
      getUserSetting(userId, SettingKeys.ALLOWED_TOOLS_WINDOWS),
    ]);

    return {
      linux: {
        tools: linuxRaw ? JSON.parse(linuxRaw) as string[] : null,
        defaults: DEFAULT_ALLOWED_TOOLS_LINUX,
      },
      windows: {
        tools: windowsRaw ? JSON.parse(windowsRaw) as string[] : null,
        defaults: DEFAULT_ALLOWED_TOOLS_WINDOWS,
      },
    };
  });

  /**
   * 特定 OS の allowedTools を保存し、該当 OS のオンライン Agent にリアルタイム配信
   * tools が null の場合はカスタム設定を削除（デフォルトに戻す）
   */
  app.put('/api/settings/allowed-tools', async (request, reply) => {
    // @ts-ignore
    const userId = request.user.id;
    const { os, tools } = request.body as { os: 'linux' | 'windows'; tools: string[] | null };

    if (!os || !['linux', 'windows'].includes(os)) {
      return reply.status(400).send({ error: 'os must be "linux" or "windows"' });
    }

    const settingKey = os === 'linux' ? SettingKeys.ALLOWED_TOOLS_LINUX : SettingKeys.ALLOWED_TOOLS_WINDOWS;

    if (tools === null) {
      // デフォルトにリセット: UserSettings から削除
      await prisma.userSettings.deleteMany({
        where: { userId, key: settingKey },
      });
    } else {
      // カスタム値を保存（JSON 文字列として保存）
      await prisma.userSettings.upsert({
        where: { userId_key: { userId, key: settingKey } },
        update: { value: JSON.stringify(tools), encrypted: false },
        create: { userId, key: settingKey, value: JSON.stringify(tools), encrypted: false },
      });
    }

    // 該当 OS のオンライン Agent に配信
    await pushAllowedToolsToAgents(userId, os, tools);

    return { success: true };
  });

  // ========================================
  // ダッシュボード統計
  // ========================================
  app.get('/api/dashboard/stats', async (request) => {
    // @ts-ignore
    const userId = request.user.id;

    const [machineCount, projectCount, sessionCount, recentSessions] = await Promise.all([
      prisma.machine.count({ where: { userId, deletedAt: null } }),
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
        deletedAt: null,
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
    const userId = (request as any).user.id;

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
  // セッション履歴 API（Chat タブ復元・メッセージ履歴用）
  // ========================================

  /**
   * ユーザーのアクティブセッション一覧を取得（タブ復元用）
   * プロジェクトごとに最新1件を返す（重複排除）
   * @route GET /api/sessions/active
   */
  app.get('/api/sessions/active', async (request: FastifyRequest<{ Querystring: { limit?: string } }>, reply: FastifyReply) => {
    const userId = (request as any).user.id;
    const limit = Math.min(20, Math.max(1, parseInt(request.query.limit || '10', 10) || 10));

    // アクティブセッションをプロジェクトごとに最新1件取得
    const sessions = await prisma.session.findMany({
      where: { userId, status: 'active' },
      orderBy: { startedAt: 'desc' },
      include: {
        project: { select: { id: true, name: true } },
        machine: { select: { id: true, name: true, displayName: true } },
        _count: { select: { messages: true } },
      },
    });

    // プロジェクトごとに最新1件に重複排除
    const seen = new Set<string>();
    const unique = sessions.filter(s => {
      if (seen.has(s.projectId)) return false;
      seen.add(s.projectId);
      return true;
    }).slice(0, limit);

    const connectedAgents = getConnectedAgents();

    return reply.send({
      sessions: unique.map(s => ({
        sessionId: s.id,
        projectId: s.project.id,
        projectName: s.project.name,
        machineId: s.machine.id,
        machineDisplayName: s.machine.displayName ?? s.machine.name,
        machineOnline: connectedAgents.has(s.machine.id),
        messageCount: s._count.messages,
        startedAt: s.startedAt.toISOString(),
      })),
    });
  });

  /**
   * セッションのメッセージ履歴をカーソルベースページネーションで取得
   * @route GET /api/sessions/:id/messages?limit=30&before=<messageId>
   */
  app.get('/api/sessions/:id/messages', async (request: FastifyRequest<{ Params: { id: string }; Querystring: { limit?: string; before?: string } }>, reply: FastifyReply) => {
    const userId = (request as any).user.id;
    const { id: sessionId } = request.params;
    const limit = Math.min(100, Math.max(1, parseInt(request.query.limit || '30', 10) || 30));
    const before = request.query.before || undefined;

    // セッション認可チェック
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      select: { userId: true },
    });

    if (!session || session.userId !== userId) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    // カーソル条件: before が指定されていれば、そのメッセージより古いものを取得
    const whereClause: any = { sessionId };
    if (before) {
      const cursorMsg = await prisma.message.findUnique({
        where: { id: before },
        select: { createdAt: true },
      });
      if (cursorMsg) {
        whereClause.createdAt = { lt: cursorMsg.createdAt };
      }
    }

    // limit + 1 件取得して hasMore を判定
    const messages = await prisma.message.findMany({
      where: whereClause,
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      select: {
        id: true,
        role: true,
        content: true,
        createdAt: true,
        files: {
          select: { id: true, filename: true, mimeType: true, size: true, direction: true },
        },
      },
    });

    const hasMore = messages.length > limit;
    const result = hasMore ? messages.slice(0, limit) : messages;

    // 時系列順（古い→新しい）に並び替えて返す
    result.reverse();

    return reply.send({
      messages: result.map(m => ({
        id: m.id,
        role: m.role,
        content: m.content,
        createdAt: m.createdAt.toISOString(),
        files: m.files,
      })),
      hasMore,
    });
  });

  // ========================================
  // Claude セッション推定 API
  // ========================================

  /**
   * Claude のセッション開始を推定する
   * メッセージ間隔が5時間以上空いた箇所をセッション境界とみなす
   * セッション開始以降のトークン使用量も集計して返す
   * @route GET /api/sessions/:id/claude-session
   */
  app.get('/api/sessions/:id/claude-session', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const userId = (request as any).user.id;
    const { id: sessionId } = request.params;

    // セッション認可チェック
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      select: { userId: true },
    });
    if (!session || session.userId !== userId) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    // 24 時間分のメッセージを昇順で取得（セッション境界検出のため広めに取得）
    // ユーザー単位で検索（Claude セッションは全マシン・全プロジェクト共通）
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const messages = await prisma.message.findMany({
      where: {
        session: {
          userId,
        },
        createdAt: { gte: oneDayAgo },
      },
      orderBy: { createdAt: 'asc' },
      select: {
        createdAt: true,
        usageData: true,
        role: true,
      },
    });

    const emptyResponse = {
      sessionStart: null,
      messageCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      elapsedMinutes: 0,
      remainingMinutes: 300,
    };

    if (messages.length === 0) {
      return reply.send(emptyResponse);
    }

    // 5 時間以上のギャップを検出してセッション境界を特定
    // 最後の 5h ギャップ以降のメッセージが現在のセッション
    const FIVE_HOURS = 5 * 60 * 60 * 1000;
    let sessionStartIdx = 0;
    let hasSessionBoundary = false;
    for (let i = 1; i < messages.length; i++) {
      const prev = new Date(messages[i - 1].createdAt).getTime();
      const curr = new Date(messages[i].createdAt).getTime();
      if (curr - prev >= FIVE_HOURS) {
        sessionStartIdx = i;
        hasSessionBoundary = true;
      }
    }

    const sessionMessages = messages.slice(sessionStartIdx);

    // セッション開始時刻（5h ギャップで分割できた場合のみ）
    const sessionStart = hasSessionBoundary
      ? new Date(sessionMessages[0].createdAt)
      : null;

    // トークン集計
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheReadTokens = 0;
    let totalCacheCreationTokens = 0;
    for (const msg of sessionMessages) {
      if (msg.role === 'ai' && msg.usageData) {
        const data = msg.usageData as any;
        totalInputTokens += data.usage?.input_tokens ?? 0;
        totalOutputTokens += data.usage?.output_tokens ?? 0;
        totalCacheReadTokens += data.usage?.cache_read_input_tokens ?? 0;
        totalCacheCreationTokens += data.usage?.cache_creation_input_tokens ?? 0;
      }
    }

    const now = Date.now();
    const elapsedMinutes = sessionStart
      ? Math.floor((now - sessionStart.getTime()) / (60 * 1000))
      : 0;
    const remainingMinutes = sessionStart
      ? Math.max(0, 300 - elapsedMinutes)
      : 0;

    return reply.send({
      sessionStart: sessionStart?.toISOString() ?? null,
      messageCount: sessionMessages.length,
      totalInputTokens,
      totalOutputTokens,
      totalCacheReadTokens,
      totalCacheCreationTokens,
      elapsedMinutes,
      remainingMinutes,
    });
  });

  // ========================================
  // ファイル配信 API
  // ========================================

  /**
   * MessageFile の内容をバイナリで返す
   * 画像は img タグで直接表示可能、その他はダウンロード
   */
  app.get('/api/files/:id', async (request, reply) => {
    // @ts-ignore
    const userId = request.user?.id || (request as any).userId;
    const { id } = request.params as { id: string };

    const file = await prisma.messageFile.findUnique({
      where: { id },
      include: {
        message: {
          select: { session: { select: { userId: true } } },
        },
      },
    });

    if (!file || file.message.session.userId !== userId) {
      return reply.status(404).send({ error: 'File not found' });
    }

    return reply
      .header('Content-Type', file.mimeType)
      .header('Content-Disposition', `inline; filename="${file.filename}"`)
      .header('Cache-Control', 'private, max-age=86400')
      .send(file.content);
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
    const userId = (request as any).user.id;
    const offset = Math.max(0, parseInt(request.query.offset || '0', 10) || 0);
    const limit = Math.min(100, Math.max(1, parseInt(request.query.limit || '50', 10) || 50));

    // Step 1: AI メッセージを日時降順で取得（usageData の有無を問わない）
    const aiMessages = await prisma.message.findMany({
      where: {
        role: 'ai',
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
        files: {
          select: { id: true, filename: true, mimeType: true, size: true, direction: true },
        },
      },
    });

    // Step 2: 関連する sessionId の user メッセージをバッチ取得（N+1 回避、入力ファイルメタデータ含む）
    const sessionIds = [...new Set(aiMessages.map(m => m.sessionId))];
    const userMessages = sessionIds.length > 0
      ? await prisma.message.findMany({
          where: {
            sessionId: { in: sessionIds },
            role: 'user',
          },
          orderBy: { createdAt: 'asc' },
          select: {
            sessionId: true,
            content: true,
            createdAt: true,
            sourceProjectName: true,
            files: {
              select: { id: true, filename: true, mimeType: true, size: true, direction: true },
            },
          },
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
    // usageData がない場合（旧 Agent）は各フィールドを null/0 にフォールバック
    const conversations = aiMessages.map(aiMsg => {
      const data = (aiMsg.usageData as any) || {};
      const inputTokens = data.usage?.input_tokens ?? 0;
      const outputTokens = data.usage?.output_tokens ?? 0;
      const cacheReadTokens = data.usage?.cache_read_input_tokens ?? 0;
      const cacheCreationTokens = data.usage?.cache_creation_input_tokens ?? 0;
      const durationMs = data.durationMs ?? 0;
      const model = data.model ?? null;

      // 同一セッション内で AI メッセージの直前にある user メッセージを探す
      const sessionUserMsgs = userMsgMap.get(aiMsg.sessionId) || [];
      let userContent = '';
      let inputFiles: { id: string; filename: string; mimeType: string; size: number; direction: string }[] = [];
      let sourceProjectName: string | null = null;
      for (let i = sessionUserMsgs.length - 1; i >= 0; i--) {
        if (sessionUserMsgs[i].createdAt <= aiMsg.createdAt) {
          userContent = sessionUserMsgs[i].content;
          inputFiles = sessionUserMsgs[i].files || [];
          sourceProjectName = sessionUserMsgs[i].sourceProjectName ?? null;
          break;
        }
      }

      const machineName = aiMsg.session.machine.displayName ?? aiMsg.session.machine.name;
      const isCrossQuery = aiMsg.sessionId.startsWith('crossquery_') || aiMsg.sessionId.startsWith('teamexec_');

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
        inputFiles,
        outputFiles: aiMsg.files || [],
        isCrossQuery,
        sourceProjectName: isCrossQuery ? sourceProjectName : undefined,
      };
    });

    // Step 4: 総件数を取得（ページネーション用）
    const total = await prisma.message.count({
      where: {
        role: 'ai',
        session: { userId },
      },
    });

    return reply.send({ conversations, total, offset, limit });
  });

  // ========================================
  // 開発レポート API（Dev Reports ページ用）
  // ========================================

  /**
   * プロジェクト別の未処理会話数を取得
   * @route GET /api/dev-reports/projects
   */
  app.get('/api/dev-reports/projects', async (request, reply) => {
    const userId = (request as any).user.id;
    const counts = await getUnprocessedCounts(userId);
    return reply.send({ projects: counts });
  });

  /**
   * レポート一覧を取得
   * @route GET /api/dev-reports
   */
  app.get('/api/dev-reports', async (request, reply) => {
    const userId = (request as any).user.id;

    const reports = await prisma.devReport.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        projectName: true,
        title: true,
        status: true,
        error: true,
        createdAt: true,
        _count: { select: { entries: true } },
      },
    });

    const result = reports.map((r) => ({
      id: r.id,
      projectName: r.projectName,
      title: r.title,
      status: r.status,
      error: r.error,
      createdAt: r.createdAt.toISOString(),
      entryCount: r._count.entries,
    }));

    return reply.send({ reports: result });
  });

  /**
   * レポート詳細を取得
   * @route GET /api/dev-reports/:id
   */
  app.get('/api/dev-reports/:id', async (request, reply) => {
    const userId = (request as any).user.id;
    const { id } = request.params as { id: string };

    const report = await prisma.devReport.findUnique({
      where: { id },
      include: { _count: { select: { entries: true } } },
    });

    if (!report || report.userId !== userId) {
      return reply.status(404).send({ error: 'Report not found' });
    }

    return reply.send({
      id: report.id,
      projectName: report.projectName,
      title: report.title,
      content: report.content,
      status: report.status,
      error: report.error,
      createdAt: report.createdAt.toISOString(),
      entryCount: report._count.entries,
    });
  });

  /**
   * レポート生成を開始（バックグラウンド処理）
   * @route POST /api/dev-reports
   */
  app.post('/api/dev-reports', async (request, reply) => {
    const userId = (request as any).user.id;
    const { projectName } = request.body as { projectName?: string };

    if (!projectName) {
      return reply.status(400).send({ error: 'projectName is required' });
    }

    // レポートレコードを作成（status: generating）
    const report = await prisma.devReport.create({
      data: {
        userId,
        projectName,
        title: `${projectName} - Generating...`,
        content: {},
        status: 'generating',
      },
    });

    // バックグラウンドで AI 生成を開始
    setImmediate(() => {
      generateReport(report.id, userId, projectName).catch((err) => {
        console.error(`❌ DevReport background error:`, err);
      });
    });

    return reply.status(201).send({
      id: report.id,
      status: 'generating',
    });
  });

  /**
   * レポートを ZIP でダウンロード（オンデマンド生成）
   * @route GET /api/dev-reports/:id/download
   */
  app.get('/api/dev-reports/:id/download', async (request, reply) => {
    const userId = (request as any).user.id;
    const { id } = request.params as { id: string };

    const report = await prisma.devReport.findUnique({ where: { id } });
    if (!report || report.userId !== userId) {
      return reply.status(404).send({ error: 'Report not found' });
    }
    if (report.status !== 'completed') {
      return reply.status(400).send({ error: 'Report is not completed yet' });
    }

    const content = report.content as unknown as ReportContent;

    // レポートに含まれる全画像ファイルの ID を収集
    const allImageFileIds = content.sections.flatMap((s) =>
      s.imageRefs.map((img) => img.fileId),
    );

    // 画像ファイルの content (bytea) を取得
    const imageFiles = allImageFileIds.length > 0
      ? await prisma.messageFile.findMany({
          where: { id: { in: allImageFileIds } },
          select: { id: true, filename: true, mimeType: true, content: true },
        })
      : [];
    const imageMap = new Map(imageFiles.map((f) => [f.id, f]));

    // HTML レポートを生成
    const html = generateReportHtml(content);

    // ZIP ストリームを作成
    const dateStr = report.createdAt.toISOString().split('T')[0];
    const safeName = content.projectName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const zipFilename = `devreport-${safeName}-${dateStr}.zip`;
    const folderName = `devreport-${safeName}-${dateStr}`;

    reply.raw.setHeader('Content-Type', 'application/zip');
    reply.raw.setHeader('Content-Disposition', `attachment; filename="${zipFilename}"`);

    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.pipe(reply.raw);

    // HTML レポート
    archive.append(html, { name: `${folderName}/report.html` });

    // JSON データ
    archive.append(JSON.stringify(content, null, 2), { name: `${folderName}/report.json` });

    // 画像ファイル
    for (const section of content.sections) {
      for (const imgRef of section.imageRefs) {
        const file = imageMap.get(imgRef.fileId);
        if (file) {
          archive.append(Buffer.from(file.content), {
            name: `${folderName}/images/${file.filename}`,
          });
        }
      }
    }

    await archive.finalize();
    return reply;
  });

  /**
   * レポートを削除
   * @route DELETE /api/dev-reports/:id
   */
  app.delete('/api/dev-reports/:id', async (request, reply) => {
    const userId = (request as any).user.id;
    const { id } = request.params as { id: string };

    const report = await prisma.devReport.findUnique({ where: { id } });
    if (!report || report.userId !== userId) {
      return reply.status(404).send({ error: 'Report not found' });
    }

    // DevReportEntry は onDelete: Cascade で自動削除
    await prisma.devReport.delete({ where: { id } });

    return reply.send({ success: true });
  });

  // ─── プッシュ通知 API ───

  /** VAPID 公開鍵を返す（クライアントが購読登録に使用） */
  app.get('/api/push/vapid-key', { preHandler: [authenticate] }, async (_request, reply) => {
    const key = getVapidPublicKey();
    if (!key) {
      return reply.status(503).send({ error: 'Push notifications not configured' });
    }
    return reply.send({ publicKey: key });
  });

  /** プッシュ通知購読を登録 */
  app.post('/api/push/subscribe', { preHandler: [authenticate] }, async (request, reply) => {
    const userId = (request as any).user.id as string;
    const { subscription, browser } = request.body as {
      subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
      browser?: string;
    };

    if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
      return reply.status(400).send({ error: 'Invalid subscription' });
    }

    await savePushSubscription(userId, subscription, browser);
    return reply.send({ success: true });
  });

  /** プッシュ通知購読を解除 */
  app.post('/api/push/unsubscribe', { preHandler: [authenticate] }, async (request, reply) => {
    const userId = (request as any).user.id as string;
    const { endpoint } = request.body as { endpoint: string };

    if (!endpoint) {
      return reply.status(400).send({ error: 'Endpoint required' });
    }

    await removePushSubscription(userId, endpoint);
    return reply.send({ success: true });
  });

  /** FCM トークンを登録（モバイルアプリ用） */
  app.post('/api/push/fcm/subscribe', { preHandler: [authenticate] }, async (request, reply) => {
    const userId = (request as any).user.id as string;
    const { fcmToken, platform } = request.body as { fcmToken: string; platform: 'ios' | 'android' };

    if (!fcmToken || !platform) {
      return reply.status(400).send({ error: 'fcmToken and platform required' });
    }

    await saveFcmToken(userId, fcmToken, platform);
    return reply.send({ success: true });
  });

  /** FCM トークンを削除（モバイルアプリ用） */
  app.post('/api/push/fcm/unsubscribe', { preHandler: [authenticate] }, async (request, reply) => {
    const userId = (request as any).user.id as string;
    const { fcmToken } = request.body as { fcmToken: string };

    if (!fcmToken) {
      return reply.status(400).send({ error: 'fcmToken required' });
    }

    await removeFcmToken(userId, fcmToken);
    return reply.send({ success: true });
  });

  // ─── 通知 API（モバイルアプリの通知一覧・バッジ管理）───

  /** 通知一覧取得（カーソルベースページネーション、新しい順） */
  app.get('/api/notifications', { preHandler: [authenticate] }, async (request, reply) => {
    const userId = (request as any).user.id as string;
    const { limit, before } = request.query as { limit?: string; before?: string };
    const result = await getNotifications(userId, limit ? parseInt(limit) : 50, before);
    return reply.send(result);
  });

  /** 全未読通知を既読にする（空ボディ許容: Flutter が Content-Type: application/json でボディなしで送信するため） */
  app.post('/api/notifications/read-all', {
    preHandler: [authenticate],
    // 空ボディ時に Fastify の JSON パーサーが 400 を返すのを防止
    onRequest: async (request) => {
      const contentLength = request.headers['content-length'];
      if (!contentLength || contentLength === '0') {
        // Content-Type を除去して JSON パーサーをスキップ
        delete (request.headers as any)['content-type'];
      }
    },
  }, async (request, reply) => {
    const userId = (request as any).user.id as string;
    const readCount = await markAllAsRead(userId);
    return reply.send({ readCount });
  });

  /** 未読通知数を取得 */
  app.get('/api/notifications/unread-count', { preHandler: [authenticate] }, async (request, reply) => {
    const userId = (request as any).user.id as string;
    const count = await getUnreadCount(userId);
    return reply.send({ count });
  });

  // ========================================
  // チーム（クロスプロジェクトクエリ）
  // ========================================

  /** チーム一覧: ユーザーの全チームとメンバーを返す */
  app.get('/api/teams', async (request, reply) => {
    const userId = (request as any).user.id as string;

    const teams = await prisma.team.findMany({
      where: { userId },
      include: {
        members: {
          include: {
            project: {
              include: { machine: { select: { id: true, name: true, displayName: true, status: true } } },
            },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    return reply.send({
      teams: teams.map(t => ({
        id: t.id,
        name: t.name,
        createdAt: t.createdAt,
        members: t.members.map(m => ({
          id: m.id,
          projectId: m.project.id,
          projectName: m.project.displayName ?? m.project.name,
          projectOriginalName: m.project.name,
          description: m.project.description ?? undefined,
          machineName: m.project.machine.displayName ?? m.project.machine.name,
          machineId: m.project.machine.id,
          machineStatus: m.project.machine.status,
        })),
      })),
    });
  });

  /**
   * POST /api/projects/:projectId/ask-description
   * エージェントにプロジェクト概要を聞き、回答を Project.description に保存して返す
   */
  app.post('/api/projects/:projectId/ask-description', { preHandler: [authenticate] }, async (request, reply) => {
    const userId = (request as any).user.id as string;
    const { projectId } = request.params as { projectId: string };

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      include: { machine: { select: { id: true, userId: true, status: true, deletedAt: true } } },
    });

    if (!project || project.machine.userId !== userId || project.machine.deletedAt) {
      return reply.status(404).send({ error: 'Project not found' });
    }

    if (project.machine.status !== 'online' || !isAgentConnected(project.machine.id)) {
      return reply.status(503).send({ error: `Agent for ${project.name} is offline` });
    }

    // クロスプロジェクトクエリでプロジェクト概要を取得
    const tempSessionId = `askdesc_${randomBytes(16).toString('hex')}`;
    await prisma.session.create({
      data: {
        id: tempSessionId,
        userId,
        machineId: project.machine.id,
        projectId,
        aiTool: project.defaultAi,
        status: 'active',
      },
    });

    try {
      const result = await executeCrossProjectQuery(
        project.machine.id,
        tempSessionId,
        project.name,
        project.path,
        project.defaultAi as AiTool,
        'プロジェクトの概要を1〜2文で簡潔に教えてください。技術スタックと主な目的を含めてください。日本語で回答してください。',
        userId,
        60000, // 60秒タイムアウト
      );

      // 回答を Project.description に保存
      const description = result.output.trim().substring(0, 500);
      await prisma.project.update({
        where: { id: projectId },
        data: { description },
      });

      await prisma.session.update({
        where: { id: tempSessionId },
        data: { status: 'ended', endedAt: new Date() },
      }).catch(() => {});

      return reply.send({ description });
    } catch (error: any) {
      await prisma.session.update({
        where: { id: tempSessionId },
        data: { status: 'ended', endedAt: new Date() },
      }).catch(() => {});

      return reply.status(504).send({ error: `Failed to get description: ${error.message}` });
    }
  });

  /** チーム新規作成 */
  app.post('/api/teams', async (request, reply) => {
    const userId = (request as any).user.id as string;
    const { name } = request.body as { name?: string };

    if (!name || !name.trim()) {
      return reply.status(400).send({ error: 'Team name is required' });
    }

    const team = await prisma.team.create({
      data: { userId, name: name.trim() },
    });

    return reply.send({ id: team.id, name: team.name });
  });

  /** チーム削除 */
  app.delete('/api/teams/:teamId', async (request, reply) => {
    const userId = (request as any).user.id as string;
    const { teamId } = request.params as { teamId: string };

    const team = await prisma.team.findUnique({ where: { id: teamId } });
    if (!team || team.userId !== userId) {
      return reply.status(404).send({ error: 'Team not found' });
    }

    await prisma.team.delete({ where: { id: teamId } });
    return reply.send({ success: true });
  });

  /** チームにメンバー追加 */
  app.post('/api/teams/:teamId/members', async (request, reply) => {
    const userId = (request as any).user.id as string;
    const { teamId } = request.params as { teamId: string };
    const { projectId } = request.body as { projectId?: string };

    if (!projectId) {
      return reply.status(400).send({ error: 'projectId is required' });
    }

    // チーム所有権チェック
    const team = await prisma.team.findUnique({ where: { id: teamId } });
    if (!team || team.userId !== userId) {
      return reply.status(404).send({ error: 'Team not found' });
    }

    // プロジェクト所有権チェック
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      include: { machine: { select: { userId: true } } },
    });
    if (!project || project.machine.userId !== userId) {
      return reply.status(404).send({ error: 'Project not found' });
    }

    const member = await prisma.teamMember.upsert({
      where: { teamId_projectId: { teamId, projectId } },
      create: { teamId, projectId },
      update: {},
    });

    return reply.send({ id: member.id });
  });

  /** チームからメンバー削除 */
  app.delete('/api/teams/:teamId/members/:memberId', async (request, reply) => {
    const userId = (request as any).user.id as string;
    const { teamId, memberId } = request.params as { teamId: string; memberId: string };

    const team = await prisma.team.findUnique({ where: { id: teamId } });
    if (!team || team.userId !== userId) {
      return reply.status(404).send({ error: 'Team not found' });
    }

    await prisma.teamMember.delete({ where: { id: memberId } }).catch(() => null);
    return reply.send({ success: true });
  });
}

// API キーをマスク表示
function maskApiKey(key: string): string {
  if (key.length <= 8) return '****';
  return key.substring(0, 4) + '****' + key.substring(key.length - 4);
}
