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
import type { AiTool, ManagementInfo } from '@devrelay/shared';
import { SCAFFOLD_TEMPLATE_DEFS, getScaffoldTemplateDef } from '@devrelay/shared';

/**
 * #294: クロスプロジェクト連携のループ防止パラメータ
 *
 * 2026-08-13 の暴走事故（dangou-card ⇄ Windows 側 pixblog の teamexec 無限ピンポン、
 * 8 分で 30 ホップ超）を受けて追加。既存のループ検出は「同一マシン内」限定だったため、
 * マシンをまたぐ往復では一度も発火しなかった。
 */
/** ホップ判定・レート集計の時間窓（5 分） */
const CROSS_RATE_WINDOW_MS = 5 * 60 * 1000;
/** 転送ホップ判定で「実行中」とみなす teamexec セッションの最大経過時間（65 分＝ask.sh の curl 60 分 + 余裕） */
const CROSS_INFLIGHT_WINDOW_MS = 65 * 60 * 1000;
/** 同一ターゲットへの teamexec 上限（5 分あたり） */
const TEAMEXEC_TARGET_LIMIT = 5;
/** ユーザー全体の teamexec 上限（5 分あたり・宛先を変えて回り続けるケースの backstop） */
const TEAMEXEC_USER_LIMIT = 12;
/** 同一ターゲットへの ask 上限（5 分あたり・読み取り専用なので緩め） */
const ASK_TARGET_LIMIT = 8;
/** ユーザー全体の ask 上限（5 分あたり） */
const ASK_USER_LIMIT = 20;

/**
 * 429 応答に必ず添える共通の注意文
 * AI が「文面を変えて再送」でガードを回避するのを防ぐ（今回の事故で実際に 15 回再送された）
 */
const NO_RETRY_NOTE = '同じ依頼を文面を変えて再送しないでください。ユーザーに状況を報告して停止してください。';

/**
 * #294: 発信元マシンが teamexec を実行中か（＝この依頼が「転送ホップ」か）を判定する
 *
 * teamexec で起動されたセッションの中からさらに teamexec を発行すると A→B→A のピンポンになるため、
 * 転送ホップは禁止する。取り残された active セッションで永久ブロックしないよう時間窓で絞る。
 *
 * @param machineId 発信元マシン ID
 * @returns 実行中の teamexec セッション ID。無ければ null
 */
async function findInflightTeamExec(machineId: string): Promise<string | null> {
  const inflight = await prisma.session.findFirst({
    where: {
      machineId,
      id: { startsWith: 'teamexec_' },
      status: 'active',
      startedAt: { gte: new Date(Date.now() - CROSS_INFLIGHT_WINDOW_MS) },
    },
    select: { id: true },
  });
  return inflight?.id ?? null;
}

/**
 * #294: 直近 5 分のクロスプロジェクトセッション数を数える（マシン横断の backstop）
 *
 * @param prefix セッション ID プレフィックス（'teamexec_' / 'crossquery_'）
 * @param userId 集計対象ユーザー
 * @param targetProjectId 指定時はそのプロジェクト宛のみ集計
 */
async function countRecentCrossSessions(
  prefix: string,
  userId: string,
  targetProjectId?: string
): Promise<number> {
  return prisma.session.count({
    where: {
      userId,
      id: { startsWith: prefix },
      startedAt: { gte: new Date(Date.now() - CROSS_RATE_WINDOW_MS) },
      ...(targetProjectId ? { projectId: targetProjectId } : {}),
    },
  });
}

/**
 * #295: ask / teamexec の宛先は「Team に事前登録されたプロジェクト」だけに限定する
 *
 * 従来は所有者チェックのみで、ユーザーの全プロジェクト（実運用で 330 件）が宛先になり得た。
 * 一覧が見づらいうえ、名前解決の誤爆が #294 の暴走の起点になったため、
 * 許可集合を `/api/agent/members` が返すもの（＝発信元マシンと同じ Team のメンバー）と一致させる。
 *
 * @param machineId 発信元マシン ID
 * @param userId 発信元ユーザー ID
 * @param targetProjectId 宛先プロジェクト ID
 * @returns allowed=許可するか / legacy=Team 未作成ユーザーの移行措置で通したか
 */
async function checkCrossTargetAllowed(
  machineId: string,
  userId: string,
  targetProjectId: string
): Promise<{ allowed: boolean; legacy: boolean }> {
  // 発信元マシンのプロジェクトが属する Team に、宛先プロジェクトも属しているか
  // （/api/agent/members の絞り込み条件と同形。一覧に出るものだけが送れる状態を保証する）
  const registered = await prisma.teamMember.count({
    where: {
      projectId: targetProjectId,
      team: { members: { some: { project: { machineId } } } },
    },
  });
  if (registered > 0) return { allowed: true, legacy: false };

  // 移行措置: Team を 1 つも作っていないユーザーは従来どおり通す
  // （Team を 1 つでも作った時点で厳格モードに切り替わる）
  const teamCount = await prisma.team.count({ where: { userId } });
  if (teamCount === 0) return { allowed: true, legacy: true };

  return { allowed: false, legacy: false };
}

/**
 * #295: 未登録の宛先を拒否する際の案内文を組み立てる
 * 登録済みの宛先一覧を添えて、AI が別プロジェクトへ当てずっぽうに送り直さないようにする
 */
async function buildUnregisteredTargetMessage(machineId: string, targetName: string): Promise<string> {
  const allowed = await prisma.teamMember.findMany({
    where: { team: { members: { some: { project: { machineId } } } } },
    include: {
      team: { select: { name: true } },
      project: { include: { machine: { select: { name: true, displayName: true } } } },
    },
  });
  const list = allowed
    .map(m => `  - ${m.project.displayName ?? m.project.name} (${m.project.machine.displayName || m.project.machine.name}) [${m.team.name}]`)
    .join('\n');
  return `未登録の宛先です: ${targetName}\n`
    + 'ask / teamexec で送れるのは Team に登録されたプロジェクトだけです。\n'
    + (list ? `登録済みの宛先:\n${list}\n` : 'このマシンには登録済みの宛先がありません。\n')
    + `WebUI の Team ページで宛先プロジェクトを登録してください。${NO_RETRY_NOTE}`;
}

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

    // #295: 宛先は Team に登録済みのものだけ（Team 未作成ユーザーは移行措置で従来どおり）
    const askAllowed = await checkCrossTargetAllowed(auth.machineId, auth.userId, targetProjectId);
    if (!askAllowed.allowed) {
      console.log(`🚫 Cross-query target not registered: ${auth.machineId} → ${targetProject.name}`);
      return reply.status(403).send({ error: await buildUnregisteredTargetMessage(auth.machineId, targetProject.name) });
    }
    if (askAllowed.legacy) {
      console.log(`⚠️ Cross-query allowed without team registration (no teams yet): → ${targetProject.name}`);
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
          startedAt: { gte: new Date(Date.now() - CROSS_RATE_WINDOW_MS) },
        },
      });
      if (recentCount >= 3) {
        console.log(`🔁 Cross-query loop detected: ${auth.machineId} → ${targetProject.name} (${recentCount} times in 5min)`);
        return reply.status(429).send({ error: `ループ検出: 同一マシンから ${targetProject.name} への問い合わせが5分以内に${recentCount}回発生しています。自分自身に問い合わせている可能性があります。${NO_RETRY_NOTE}` });
      }
    }

    // #294 レート制限（マシン横断の backstop）: 質問は読み取り専用のため teamexec より緩い閾値。
    // 転送ホップ自体は禁止しない（B が C に事実確認する正当な用途があるため）
    const askTargetRecent = await countRecentCrossSessions('crossquery_', auth.userId, targetProjectId);
    if (askTargetRecent >= ASK_TARGET_LIMIT) {
      console.log(`🔁 Cross-query rate limit (target): → ${targetProject.name} (${askTargetRecent} times in 5min)`);
      return reply.status(429).send({
        error: `レート制限: ${targetProject.name} への問い合わせが5分以内に${askTargetRecent}回発生しています（上限${ASK_TARGET_LIMIT}回）。問い合わせがループしている可能性があります。${NO_RETRY_NOTE}`,
      });
    }
    const askUserRecent = await countRecentCrossSessions('crossquery_', auth.userId);
    if (askUserRecent >= ASK_USER_LIMIT) {
      console.log(`🔁 Cross-query rate limit (user): ${auth.userId} (${askUserRecent} times in 5min)`);
      return reply.status(429).send({
        error: `レート制限: 問い合わせが5分以内に${askUserRecent}回発生しています（全プロジェクト合計の上限${ASK_USER_LIMIT}回）。問い合わせがプロジェクト間でループしている可能性があります。${NO_RETRY_NOTE}`,
      });
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

    // #295: 宛先は Team に登録済みのものだけ（Team 未作成ユーザーは移行措置で従来どおり）
    const execAllowed = await checkCrossTargetAllowed(auth.machineId, auth.userId, targetProjectId);
    if (!execAllowed.allowed) {
      console.log(`🚫 Team exec target not registered: ${auth.machineId} → ${targetProject.name}`);
      return reply.status(403).send({ error: await buildUnregisteredTargetMessage(auth.machineId, targetProject.name) });
    }
    if (execAllowed.legacy) {
      console.log(`⚠️ Team exec allowed without team registration (no teams yet): → ${targetProject.name}`);
    }

    if (targetProject.machine.status !== 'online' || !isAgentConnected(targetProject.machine.id)) {
      return reply.status(503).send({ error: `Agent for ${targetProject.name} is offline` });
    }

    // #294 ホップ制限: teamexec 実行中のマシンからの再依頼＝転送ホップ。A→B→A のピンポンを構造的に禁止する
    const inflightTeamExec = await findInflightTeamExec(auth.machineId);
    if (inflightTeamExec) {
      console.log(`🔁 Team exec hop blocked: ${auth.machineId} → ${targetProject.name} (inflight ${inflightTeamExec})`);
      return reply.status(429).send({
        error: `ホップ制限: teamexec で実行中のプロジェクトから、さらに他プロジェクト（${targetProject.name}）へ実行依頼を転送することはできません（ループ防止）。依頼を転送せず、自分で実行できない理由を依頼元への回答として返してください。${NO_RETRY_NOTE}`,
      });
    }

    // ループ検出: 同一マシンから同一ターゲットへの直近5分以内の teamexec セッションが3回以上あれば拒否
    if (targetProject.machine.id === auth.machineId) {
      const recentCount = await prisma.session.count({
        where: {
          projectId: targetProjectId,
          id: { startsWith: 'teamexec_' },
          startedAt: { gte: new Date(Date.now() - CROSS_RATE_WINDOW_MS) },
        },
      });
      if (recentCount >= 3) {
        console.log(`🔁 Team exec loop detected: ${auth.machineId} → ${targetProject.name} (${recentCount} times in 5min)`);
        return reply.status(429).send({ error: `ループ検出: 同一マシンから ${targetProject.name} への実行依頼が5分以内に${recentCount}回発生しています。自分自身に送信している可能性があります。${NO_RETRY_NOTE}` });
      }
    }

    // #294 レート制限（マシン横断の backstop）: 文面を変えた再送・宛先を変えた飛び火を止める
    const targetRecent = await countRecentCrossSessions('teamexec_', auth.userId, targetProjectId);
    if (targetRecent >= TEAMEXEC_TARGET_LIMIT) {
      console.log(`🔁 Team exec rate limit (target): → ${targetProject.name} (${targetRecent} times in 5min)`);
      return reply.status(429).send({
        error: `レート制限: ${targetProject.name} への実行依頼が5分以内に${targetRecent}回発生しています（上限${TEAMEXEC_TARGET_LIMIT}回）。依頼がループしている可能性があります。${NO_RETRY_NOTE}`,
      });
    }
    const userRecent = await countRecentCrossSessions('teamexec_', auth.userId);
    if (userRecent >= TEAMEXEC_USER_LIMIT) {
      console.log(`🔁 Team exec rate limit (user): ${auth.userId} (${userRecent} times in 5min)`);
      return reply.status(429).send({
        error: `レート制限: 実行依頼が5分以内に${userRecent}回発生しています（全プロジェクト合計の上限${TEAMEXEC_USER_LIMIT}回）。依頼がプロジェクト間でループしている可能性があります。${NO_RETRY_NOTE}`,
      });
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

    // テンプレート名チェック（SCAFFOLD_TEMPLATE_DEFS を単一ソースとして参照）
    const templateDef = getScaffoldTemplateDef(template);
    if (!templateDef) {
      const validTemplates = SCAFFOLD_TEMPLATE_DEFS.map((t) => t.id);
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

    // OS 制限チェック（テンプレートが対象マシンの OS に対応しているか）
    const machineOs = (machine.managementInfo as ManagementInfo | null)?.os;
    if (machineOs && !templateDef.os.includes(machineOs as any)) {
      const osLabels: Record<string, string> = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' };
      const allowed = templateDef.os.map((o) => osLabels[o] || o).join(' / ');
      const current = osLabels[machineOs] || machineOs;
      return reply.status(400).send({
        error: `テンプレート '${template}' は ${allowed} でのみ使用できます（マシン '${machineName}' は ${current}）`,
      });
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
