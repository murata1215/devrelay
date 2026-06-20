/**
 * ドキュメント検索 API + クロスプロジェクトクエリ API
 *
 * Agent（Claude Code スキル）からマシントークン認証で呼び出される。
 * MessageFile のベクトル埋め込みを使ったセマンティック検索を提供。
 * また、他プロジェクトのエージェントに質問を送信するクロスプロジェクトクエリ機能を提供。
 *
 * エンドポイント:
 * - POST /api/agent/documents/search  — ベクトル類似検索
 * - GET  /api/agent/documents/:id     — ファイルテキスト内容取得
 * - POST /api/agent/ask-member        — クロスプロジェクトクエリ（プランモード）
 * - POST /api/agent/teamexec-member   — クロスプロジェクト実行依頼（exec モード）
 * - GET  /api/agent/members           — 登録済みメンバー一覧取得
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'crypto';
import { prisma } from '../db/client.js';
import { searchSimilarDocuments } from '../services/embedding-service.js';
import { getOpenAiApiKey } from '../services/user-settings.js';
import { executeCrossProjectQuery, executeCrossProjectExec, isAgentConnected, cancelPendingCrossQuery, executeScaffold, getConnectedAgents } from '../services/agent-manager.js';
import { getSessionParticipants, addParticipant } from '../services/session-manager.js';
import type { AiTool } from '@devrelay/shared';

/**
 * マシントークンから userId を取得する認証ヘルパー
 * Authorization: Bearer <machine_token> ヘッダーを使用
 *
 * @param request - Fastify リクエスト
 * @returns userId。認証失敗時は null
 */
async function authenticateByMachineToken(request: FastifyRequest): Promise<string | null> {
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return null;
  }

  const token = authHeader.replace('Bearer ', '').trim();
  if (!token) {
    return null;
  }

  // マシントークンで Machine を検索し、userId を取得
  const machine = await prisma.machine.findFirst({
    where: { token, deletedAt: null },
    select: { userId: true },
  });

  return machine?.userId ?? null;
}

/**
 * マシントークンから userId と machineId を取得する認証ヘルパー
 */
async function authenticateByMachineTokenFull(request: FastifyRequest): Promise<{ userId: string; machineId: string } | null> {
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return null;

  const token = authHeader.replace('Bearer ', '').trim();
  if (!token) return null;

  const machine = await prisma.machine.findFirst({
    where: { token, deletedAt: null },
    select: { id: true, userId: true },
  });

  return machine ? { userId: machine.userId, machineId: machine.id } : null;
}

/**
 * ドキュメント API ルートを登録
 */
export function registerDocumentApiRoutes(app: FastifyInstance) {
  /**
   * POST /api/agent/documents/search
   * ベクトル類似検索: クエリテキストに類似するファイルを検索
   *
   * Body: { query: string, limit?: number }
   * 認証: Authorization: Bearer <machine_token>
   * レスポンス: { results: [{ id, filename, mimeType, size, direction, textContent, similarity, createdAt, sessionId, projectName }] }
   */
  app.post('/api/agent/documents/search', async (request: FastifyRequest, reply: FastifyReply) => {
    // マシントークン認証
    const userId = await authenticateByMachineToken(request);
    if (!userId) {
      return reply.status(401).send({ error: 'Invalid or missing machine token' });
    }

    // リクエストボディのバリデーション
    const { query, limit } = (request.body || {}) as { query?: string; limit?: number };
    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      return reply.status(400).send({ error: 'query is required' });
    }

    // OpenAI API キーを取得（クエリの embedding 生成に必要）
    const apiKey = await getOpenAiApiKey(userId);
    if (!apiKey) {
      return reply.status(400).send({
        error: 'OpenAI API key not configured. Set it in WebUI Settings.',
      });
    }

    try {
      const searchLimit = Math.min(Math.max(limit || 5, 1), 20);
      const results = await searchSimilarDocuments(userId, query.trim(), apiKey, searchLimit);

      // textContent が長すぎる場合は先頭部分のみ返す（スキル側で --get で全文取得可能）
      const trimmedResults = results.map(r => ({
        ...r,
        textContent: r.textContent && r.textContent.length > 2000
          ? r.textContent.substring(0, 2000) + '\n... (truncated, use --get to fetch full content)'
          : r.textContent,
      }));

      return reply.send({ results: trimmedResults });
    } catch (error: any) {
      console.error('[DocumentAPI] Search error:', error.message);
      return reply.status(500).send({ error: 'Search failed: ' + error.message });
    }
  });

  /**
   * GET /api/agent/documents/:id
   * ファイルのテキスト内容を取得
   *
   * 認証: Authorization: Bearer <machine_token>
   * レスポンス: { id, filename, mimeType, size, direction, textContent, embeddingStatus, createdAt }
   */
  app.get('/api/agent/documents/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    // マシントークン認証
    const userId = await authenticateByMachineToken(request);
    if (!userId) {
      return reply.status(401).send({ error: 'Invalid or missing machine token' });
    }

    const { id } = request.params as { id: string };

    // ファイルを取得（ユーザー認可チェック込み）
    const file = await prisma.messageFile.findUnique({
      where: { id },
      select: {
        id: true,
        filename: true,
        mimeType: true,
        size: true,
        direction: true,
        textContent: true,
        embeddingStatus: true,
        createdAt: true,
        message: {
          select: {
            session: {
              select: { userId: true },
            },
          },
        },
      },
    });

    if (!file || file.message.session.userId !== userId) {
      return reply.status(404).send({ error: 'File not found' });
    }

    // message リレーションは返さない
    const { message: _message, ...fileData } = file;
    return reply.send(fileData);
  });

  // ---------------------------------------------------------------------------
  // GET /api/agent/inventory
  // ユーザーの全マシン・全プロジェクト一覧（Team に依存しない）
  // Manager のインベントリ確認用。devrelay-list-inventory スキルから呼び出される。
  //
  // 認証: Authorization: Bearer <machine_token>
  // ---------------------------------------------------------------------------
  app.get('/api/agent/inventory', async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = await authenticateByMachineTokenFull(request);
    if (!auth) {
      return reply.status(401).send({ error: 'Invalid or missing machine token' });
    }

    // ユーザーの全マシン・全プロジェクトを取得（Team 登録不要）
    const machines = await prisma.machine.findMany({
      where: { userId: auth.userId, deletedAt: null },
      include: {
        projects: {
          orderBy: { lastUsedAt: 'desc' },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });

    // connectedAgents Map でオンライン判定（api.ts の /api/machines と同パターン）
    const connectedAgentIds = getConnectedAgents();

    return reply.send(machines.map(m => ({
      machine: m.displayName || m.name,
      machineName: m.name,
      machineId: m.id,
      online: connectedAgentIds.has(m.id),
      projects: m.projects.map(p => ({
        name: p.displayName ?? p.name,
        originalName: p.name,
        id: p.id,
        path: p.path,
        description: (p as any).description ?? null,
        defaultAi: p.defaultAi,
      })),
    })));
  });

  /**
   * GET /api/agent/members
   * このマシンのプロジェクトと同じチームに属するメンバー一覧を取得
   * スキルから呼び出されて利用可能なメンバーを確認する（ask-member / teamexec 用）
   *
   * 認証: Authorization: Bearer <machine_token>
   */
  app.get('/api/agent/members', async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = await authenticateByMachineTokenFull(request);
    if (!auth) {
      return reply.status(401).send({ error: 'Invalid or missing machine token' });
    }

    // このマシンのプロジェクトが属するチームのメンバーを取得
    const teamMembers = await prisma.teamMember.findMany({
      where: {
        team: {
          members: { some: { project: { machineId: auth.machineId } } },
        },
      },
      include: {
        team: { select: { name: true } },
        project: {
          include: { machine: { select: { id: true, name: true, displayName: true, status: true } } },
        },
      },
    });

    // 同一マシン上の別プロジェクトも表示（isSameMachine マーク付き）
    return reply.send(teamMembers
      .map(m => ({
        teamName: m.team.name,
        memberProjectName: m.project.displayName ?? m.project.name,
        memberProjectOriginalName: m.project.name,
        memberProjectId: m.project.id,
        memberMachineName: m.project.machine.displayName || m.project.machine.name,
        memberMachineStatus: m.project.machine.status,
        isSameMachine: m.project.machineId === auth.machineId,
      }))
    );
  });

  /**
   * POST /api/agent/ask-member
   * クロスプロジェクトクエリ: 他プロジェクトのエージェントに質問を送信
   * ターゲットプロジェクトで新しい Claude セッションを起動し、回答を待つ
   *
   * Body: { targetProjectId: string, question: string }
   * 認証: Authorization: Bearer <machine_token>
   * レスポンス: { answer: string }
   */
  app.post('/api/agent/ask-member', async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = await authenticateByMachineTokenFull(request);
    if (!auth) {
      return reply.status(401).send({ error: 'Invalid or missing machine token' });
    }

    const { targetProjectId, question } = (request.body || {}) as { targetProjectId?: string; question?: string };
    if (!targetProjectId || !question) {
      return reply.status(400).send({ error: 'targetProjectId and question are required' });
    }

    // ターゲットプロジェクトの存在確認と所有権チェック
    const targetProject = await prisma.project.findUnique({
      where: { id: targetProjectId },
      include: { machine: { select: { id: true, userId: true, status: true, deletedAt: true } } },
    });

    if (!targetProject || targetProject.machine.userId !== auth.userId || targetProject.machine.deletedAt) {
      return reply.status(404).send({ error: 'Target project not found' });
    }

    if (targetProject.machine.status !== 'online' || !isAgentConnected(targetProject.machine.id)) {
      return reply.status(503).send({ error: `Agent for ${targetProject.name} is offline` });
    }

    // ループ検出: 同一マシンから同一ターゲットへの直近5分以内の crossquery セッションが3回以上あれば拒否
    if (targetProject.machine.id === auth.machineId) {
      const recentCount = await prisma.session.count({
        where: {
          projectId: targetProjectId,
          id: { startsWith: 'crossquery_' },
          startedAt: { gte: new Date(Date.now() - 5 * 60 * 1000) },
        },
      });
      if (recentCount >= 3) {
        console.log(`🔁 Cross-query loop detected: ${auth.machineId} → ${targetProject.name} (${recentCount} times in 5min)`);
        return reply.status(429).send({ error: `ループ検出: 同一マシンから ${targetProject.name} への問い合わせが5分以内に${recentCount}回発生しています。自分自身に問い合わせている可能性があります。` });
      }
    }

    // 送信元マシンのプロジェクト名を取得（クロスクエリの送信元表示用）
    const sourceProjects = await prisma.project.findMany({
      where: { machineId: auth.machineId },
      select: { name: true },
    });
    const sourceProjectName = sourceProjects.length === 1
      ? sourceProjects[0].name
      : (await prisma.machine.findUnique({ where: { id: auth.machineId }, select: { displayName: true, name: true } }))
        ?.displayName ?? sourceProjects[0]?.name ?? 'unknown';

    // 一時セッションを作成
    const tempSessionId = `crossquery_${crypto.randomUUID()}`;
    const tempSession = await prisma.session.create({
      data: {
        id: tempSessionId,
        userId: auth.userId,
        machineId: targetProject.machine.id,
        projectId: targetProjectId,
        aiTool: targetProject.defaultAi,
        status: 'active',
      },
    });

    // ユーザーメッセージを保存（Conversations ページで表示するため）
    await prisma.message.create({
      data: {
        sessionId: tempSessionId,
        role: 'user',
        content: question,
        platform: 'api',
        sourceProjectName,
      },
    });

    // 発信元マシンのアクティブセッションの参加者をコピー（承認通知の中継用）
    const originSessionAsk = await prisma.session.findFirst({
      where: { machineId: auth.machineId, status: 'active', id: { not: { startsWith: 'crossquery_' } } },
      orderBy: { startedAt: 'desc' },
    });
    if (originSessionAsk) {
      const originParticipants = getSessionParticipants(originSessionAsk.id);
      for (const p of originParticipants) {
        addParticipant(tempSessionId, p.platform, p.chatId);
      }
    }

    console.log(`🔗 Cross-project query: ${tempSessionId} → ${targetProject.name} from ${sourceProjectName}`);

    // HTTP 切断検知: curl タイムアウト等でクライアントが切断した場合にセッションをクリーンアップ
    let clientDisconnected = false;
    request.raw.on('close', () => {
      if (!reply.sent) {
        clientDisconnected = true;
        console.log(`🔌 Cross-project query client disconnected: ${tempSessionId}`);
        // pendingCrossQueries から削除して Promise を reject（サーバー側の待機を解放）
        cancelPendingCrossQuery(tempSessionId);
        // セッションを ended に更新
        prisma.session.update({
          where: { id: tempSessionId },
          data: { status: 'ended', endedAt: new Date() },
        }).catch(() => {});
      }
    });

    try {
      // エージェントにセッション開始 + プロンプト送信し、完了を待つ
      const result = await executeCrossProjectQuery(
        targetProject.machine.id,
        tempSessionId,
        targetProject.name,
        targetProject.path,
        targetProject.defaultAi as AiTool,
        question,
        auth.userId,
      );

      if (clientDisconnected) return;

      // 一時セッションを終了
      await prisma.session.update({
        where: { id: tempSessionId },
        data: { status: 'ended', endedAt: new Date() },
      });

      return reply.send({ answer: result.output });
    } catch (error: any) {
      // 一時セッションを終了（エラー時も）
      await prisma.session.update({
        where: { id: tempSessionId },
        data: { status: 'ended', endedAt: new Date() },
      }).catch(() => {});

      if (clientDisconnected) return;
      console.error(`🔗 Cross-project query failed: ${error.message}`);
      return reply.status(504).send({ error: `Query timed out or failed: ${error.message}` });
    }
  });

  /**
   * POST /api/agent/teamexec-member
   * クロスプロジェクト実行依頼: 他プロジェクトのエージェントに実行指示を送信
   * ターゲットプロジェクトで exec モードのセッションを起動し、完了を待つ
   *
   * Body: { targetProjectId: string, question: string }
   * 認証: Authorization: Bearer <machine_token>
   * レスポンス: { answer: string }
   */
  app.post('/api/agent/teamexec-member', async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = await authenticateByMachineTokenFull(request);
    if (!auth) {
      return reply.status(401).send({ error: 'Invalid or missing machine token' });
    }

    const { targetProjectId, question } = (request.body || {}) as { targetProjectId?: string; question?: string };
    if (!targetProjectId || !question) {
      return reply.status(400).send({ error: 'targetProjectId and question are required' });
    }

    // ターゲットプロジェクトの存在確認と所有権チェック
    const targetProject = await prisma.project.findUnique({
      where: { id: targetProjectId },
      include: { machine: { select: { id: true, userId: true, status: true, deletedAt: true } } },
    });

    if (!targetProject || targetProject.machine.userId !== auth.userId || targetProject.machine.deletedAt) {
      return reply.status(404).send({ error: 'Target project not found' });
    }

    if (targetProject.machine.status !== 'online' || !isAgentConnected(targetProject.machine.id)) {
      return reply.status(503).send({ error: `Agent for ${targetProject.name} is offline` });
    }

    // ループ検出: 同一マシンから同一ターゲットへの直近5分以内の teamexec セッションが3回以上あれば拒否
    if (targetProject.machine.id === auth.machineId) {
      const recentCount = await prisma.session.count({
        where: {
          projectId: targetProjectId,
          id: { startsWith: 'teamexec_' },
          startedAt: { gte: new Date(Date.now() - 5 * 60 * 1000) },
        },
      });
      if (recentCount >= 3) {
        console.log(`🔁 Team exec loop detected: ${auth.machineId} → ${targetProject.name} (${recentCount} times in 5min)`);
        return reply.status(429).send({ error: `ループ検出: 同一マシンから ${targetProject.name} への実行依頼が5分以内に${recentCount}回発生しています。自分自身に送信している可能性があります。` });
      }
    }

    // 送信元マシンのプロジェクト名を取得（クロスクエリの送信元表示用）
    const sourceProjects = await prisma.project.findMany({
      where: { machineId: auth.machineId },
      select: { name: true },
    });
    const sourceProjectName = sourceProjects.length === 1
      ? sourceProjects[0].name
      : (await prisma.machine.findUnique({ where: { id: auth.machineId }, select: { displayName: true, name: true } }))
        ?.displayName ?? sourceProjects[0]?.name ?? 'unknown';

    // teamexec 用セッションを作成
    const tempSessionId = `teamexec_${crypto.randomUUID()}`;
    const tempSession = await prisma.session.create({
      data: {
        id: tempSessionId,
        userId: auth.userId,
        machineId: targetProject.machine.id,
        projectId: targetProjectId,
        aiTool: targetProject.defaultAi,
        status: 'active',
      },
    });

    // ユーザーメッセージを保存（Conversations ページで表示するため）
    await prisma.message.create({
      data: {
        sessionId: tempSessionId,
        role: 'user',
        content: `[teamexec] ${question}`,
        platform: 'api',
        sourceProjectName,
      },
    });

    // 発信元マシンのアクティブセッションの参加者を teamexec セッションにコピー
    // → 承認通知が発信元の WebUI/Discord/Telegram にも表示される
    const originSession = await prisma.session.findFirst({
      where: { machineId: auth.machineId, status: 'active', id: { not: { startsWith: 'teamexec_' } } },
      orderBy: { startedAt: 'desc' },
    });
    if (originSession) {
      const originParticipants = getSessionParticipants(originSession.id);
      for (const p of originParticipants) {
        addParticipant(tempSessionId, p.platform, p.chatId);
      }
      if (originParticipants.length > 0) {
        console.log(`🔗 Team exec: copied ${originParticipants.length} participant(s) from origin session ${originSession.id}`);
      }
    }

    console.log(`🚀 Team exec: ${tempSessionId} → ${targetProject.name} from ${sourceProjectName}`);

    // HTTP 切断検知: curl タイムアウト等でクライアントが切断した場合にセッションをクリーンアップ
    let clientDisconnected = false;
    request.raw.on('close', () => {
      if (!reply.sent) {
        clientDisconnected = true;
        console.log(`🔌 Team exec client disconnected: ${tempSessionId}`);
        cancelPendingCrossQuery(tempSessionId);
        prisma.session.update({
          where: { id: tempSessionId },
          data: { status: 'ended', endedAt: new Date() },
        }).catch(() => {});
      }
    });

    try {
      // エージェントに exec モードでセッション開始し、完了を待つ
      const result = await executeCrossProjectExec(
        targetProject.machine.id,
        tempSessionId,
        targetProject.name,
        targetProject.path,
        targetProject.defaultAi as AiTool,
        question,
        auth.userId,
      );

      if (clientDisconnected) return;

      // セッションを終了
      await prisma.session.update({
        where: { id: tempSessionId },
        data: { status: 'ended', endedAt: new Date() },
      });

      return reply.send({ answer: result.output });
    } catch (error: any) {
      // セッションを終了（エラー時も）
      await prisma.session.update({
        where: { id: tempSessionId },
        data: { status: 'ended', endedAt: new Date() },
      }).catch(() => {});

      if (clientDisconnected) return;
      console.error(`🚀 Team exec failed: ${error.message}`);
      return reply.status(504).send({ error: `Team exec timed out or failed: ${error.message}` });
    }
  });

  // ---------------------------------------------------------------------------
  // POST /api/agent/scaffold
  // プロジェクト雛形作成: Manager スキルから呼び出される
  // 対象マシンにテンプレート展開を指示し、完了を待って応答する
  //
  // Body: { machineName: string, name: string, template: string }
  // 認証: Authorization: Bearer <machine_token>
  // ---------------------------------------------------------------------------
  app.post('/api/agent/scaffold', async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = await authenticateByMachineTokenFull(request);
    if (!auth) {
      return reply.status(401).send({ error: 'Invalid or missing machine token' });
    }

    const { machineName, name, template } = (request.body || {}) as {
      machineName?: string;
      name?: string;
      template?: string;
    };

    if (!machineName || !name || !template) {
      return reply.status(400).send({ error: 'machineName, name, and template are required' });
    }

    // プロジェクト名バリデーション（testflight-manager と同じルール）
    if (!/^[a-z][a-z0-9-]{2,29}$/.test(name)) {
      return reply.status(400).send({
        error: 'プロジェクト名は英小文字で始まり、英小文字・数字・ハイフンで構成、3〜30文字にしてください。',
      });
    }

    // 予約語チェック
    const reserved = ['devrelay', 'app', 'api', 'www', 'mail', 'admin', 'test', 'staging', 'prod'];
    if (reserved.includes(name)) {
      return reply.status(400).send({ error: `'${name}' は予約済みのため使用できません。` });
    }

    // テンプレート名チェック
    const validTemplates = ['vite-react-web'];
    if (!validTemplates.includes(template)) {
      return reply.status(400).send({ error: `テンプレート '${template}' は存在しません。利用可能: ${validTemplates.join(', ')}` });
    }

    // 対象マシンの検索（同一ユーザーのマシンを machineName で部分一致）
    const machine = await prisma.machine.findFirst({
      where: {
        userId: auth.userId,
        deletedAt: null,
        OR: [
          { name: { contains: machineName } },
          { displayName: { contains: machineName } },
        ],
      },
    });

    if (!machine) {
      return reply.status(404).send({ error: `マシン '${machineName}' が見つかりません` });
    }

    if (machine.status !== 'online' || !isAgentConnected(machine.id)) {
      return reply.status(503).send({ error: `マシン '${machineName}' はオフラインです` });
    }

    // 同名プロジェクトの既存チェック
    const existing = await prisma.project.findFirst({
      where: { machineId: machine.id, name },
    });
    if (existing) {
      return reply.status(409).send({ error: `プロジェクト '${name}' は既に存在します` });
    }

    try {
      console.log(`📦 Scaffold requested: ${name} (${template}) → ${machine.name}`);
      const result = await executeScaffold(machine.id, name, template);

      if (!result.ok) {
        return reply.status(500).send({ error: result.error || 'Scaffold failed' });
      }

      return reply.send({
        ok: true,
        name: result.name,
        path: result.path,
        machine: machine.displayName || machine.name,
      });
    } catch (error: any) {
      console.error(`📦 Scaffold failed: ${error.message}`);
      return reply.status(504).send({ error: `Scaffold failed: ${error.message}` });
    }
  });
}
