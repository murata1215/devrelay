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
import { executeCrossProjectQuery, executeCrossProjectExec, isAgentConnected } from '../services/agent-manager.js';
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

  /**
   * GET /api/agent/members
   * このマシンのプロジェクトと同じチームに属するメンバー一覧を取得
   * スキルから呼び出されて利用可能なメンバーを確認する
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

    // 自マシンのプロジェクトは除外して返す
    return reply.send(teamMembers
      .filter(m => m.project.machineId !== auth.machineId)
      .map(m => ({
        teamName: m.team.name,
        memberProjectName: m.project.name,
        memberProjectId: m.project.id,
        memberMachineName: m.project.machine.displayName || m.project.machine.name,
        memberMachineStatus: m.project.machine.status,
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
      },
    });

    console.log(`🔗 Cross-project query: ${tempSessionId} → ${targetProject.name} (${targetProject.machine.id})`);

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
      },
    });

    console.log(`🚀 Team exec: ${tempSessionId} → ${targetProject.name} (${targetProject.machine.id})`);

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

      console.error(`🚀 Team exec failed: ${error.message}`);
      return reply.status(504).send({ error: `Team exec timed out or failed: ${error.message}` });
    }
  });
}
