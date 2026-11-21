/**
 * Backlog 連携 API（2026-11-21。同日、1 人で複数の Backlog スペースを使える「接続」形式に拡張）
 *
 * 1. `backlogUserRoutes`（ログイン必須。設定画面・チャットの案件欄用）
 *    - GET    /api/backlog/config                                   接続の一覧（キーは hasKey のみ）・組織既定スペース
 *    - POST   /api/backlog/connections                              { space, apiKey } 接続を追加
 *    - PUT    /api/backlog/connections/:id                          { space?, apiKey?, projects? } 接続を更新
 *    - DELETE /api/backlog/connections/:id                          接続を削除
 *    - GET    /api/backlog/connections/:id/projects                 キーで見えるプロジェクト一覧（許可リスト選択用）
 *    - GET    /api/backlog/connections/:id/projects/:key/statuses   状態一覧と段階の推測
 *    - GET    /api/backlog/issues                                   課題一覧（全接続・許可プロジェクトのみ）
 *    - GET    /api/backlog/issues/:key                              件名・状態・状態一覧（案件欄の右の表示用）
 *    - POST   /api/backlog/issues/:key/status                       { statusId } 人間が画面から状態を変える
 *
 * 2. `registerBacklogAgentRoutes`（マシントークン認証。スキル devrelay-backlog 用。マシンの持ち主の設定で動く）
 *    - GET  /api/agent/backlog/issues                 （space= でスペースを絞れる）
 *    - GET  /api/agent/backlog/issues/:key?comments=N
 *    - GET  /api/agent/backlog/projects/:key/statuses
 *    - POST /api/agent/backlog/issues/:key/move     { to, comment?, force?, sessionId? }
 *    - GET  /api/agent/backlog/current?sessionId=   このスレッドの案件が課題キーならそれを返す
 *
 * 課題キーからどの接続かは、プロジェクトキーと各接続でチェックしたプロジェクトを照らして自動で決める。
 * キルスイッチ: `DEVRELAY_BACKLOG=0` で全ルート 404。API キーはどのレスポンスにも含めない。
 */

import { FastifyInstance, FastifyReply } from 'fastify';
import { prisma } from '../db/client.js';
import { authenticate } from './auth.js';
import { authenticateByMachineTokenFull } from './document-api.js';
import {
  BacklogError,
  getIssue,
  getProjectStatuses,
  isBacklogEnabled,
  isBacklogIssueKey,
  listIssuesForUser,
  moveIssue,
  normalizeBacklogSpace,
  sanitizeProjectsSetting,
  fetchProjects,
  fetchStatuses,
  guessPhaseMap,
  fetchMyself,
  projectKeyOfIssue,
  loadConnections,
  saveConnections,
  defaultBacklogSpace,
  requireConnection,
  resolveIssueContext,
  resolveProjectContext,
  toConnectionView,
  nextConnectionId,
  isPlausibleBacklogApiKey,
  MAX_BACKLOG_CONNECTIONS,
  parseAssigneeScope,
} from '../services/backlog.js';
import { clearUsageCache } from '../services/usage-service.js';

function sendDisabled(reply: FastifyReply) {
  return reply.status(404).send({ error: 'Backlog 連携は無効です（DEVRELAY_BACKLOG=0）' });
}

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof BacklogError) return reply.status(err.status).send({ error: err.message });
  console.error('❌ Backlog API error:', (err as Error)?.message);
  return reply.status(500).send({ error: 'Backlog 連携でエラーが発生しました' });
}

function parseListQuery(q: Record<string, string | undefined>) {
  return {
    project: q.project || undefined,
    status: q.status || undefined,
    // assignee=mine_unassigned|mine|unassigned|everyone（未指定は自分＋担当なし）。旧 everyone=1 は「全員」として受ける
    assignee: parseAssigneeScope(q.assignee, q.everyone === '1' || q.everyone === 'true'),
    keyword: q.keyword || undefined,
    count: q.count ? Number(q.count) : undefined,
    space: q.space || undefined,
    conn: q.conn || undefined,
  };
}

/**
 * 着手（start）にしたとき、スレッドの案件を課題キーにする。
 * 上書きするのは案件が空か、すでに課題キーのときだけ（人が手で付けた案件名は残す）。
 */
async function linkSessionToIssue(userId: string, sessionId: string | undefined, issueKey: string): Promise<boolean> {
  if (!sessionId) return false;
  const session = await prisma.session.findUnique({ where: { id: sessionId }, select: { userId: true, usageCase: true } });
  if (!session || session.userId !== userId) return false;
  if (session.usageCase === issueKey) return true;
  if (session.usageCase && !isBacklogIssueKey(session.usageCase)) return false;
  await prisma.session.update({ where: { id: sessionId }, data: { usageCase: issueKey } });
  clearUsageCache();
  return true;
}

/**
 * このスレッドで AI が応答した回数（完了報告のコメントに添える。利用料は出さない）。
 * スキルは AI の応答の途中で呼ばれ、その応答はまだ保存されていないため +1 する。
 * スレッドが無い・持ち主が違う・取得失敗なら null（何も添えない）
 */
async function countAiTurns(userId: string, sessionId: string | undefined): Promise<number | null> {
  if (!sessionId) return null;
  try {
    const session = await prisma.session.findUnique({ where: { id: sessionId }, select: { userId: true } });
    if (!session || session.userId !== userId) return null;
    const n = await prisma.message.count({ where: { sessionId, role: 'ai' } });
    return n + 1;
  } catch {
    return null;
  }
}

const SPACE_ERROR = 'スペース URL は xxx.backlog.jp / xxx.backlog.com 形式で入力してください';

// ========================================
// ログイン必須（WebUI）
// ========================================

export async function backlogUserRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  app.get('/api/backlog/config', async (request, reply) => {
    if (!isBacklogEnabled()) return reply.send({ enabled: false });
    // @ts-ignore
    const userId = request.user.id as string;
    const list = await loadConnections(userId);
    return {
      enabled: true,
      configured: list.some((c) => c.apiKey && c.projects.length > 0),
      defaultSpace: defaultBacklogSpace(),
      connections: list.map(toConnectionView),
    };
  });

  app.post('/api/backlog/connections', async (request, reply) => {
    if (!isBacklogEnabled()) return sendDisabled(reply);
    // @ts-ignore
    const userId = request.user.id as string;
    const body = (request.body ?? {}) as { space?: unknown; apiKey?: unknown };
    const space = normalizeBacklogSpace(body.space);
    if (!space) return reply.status(400).send({ error: SPACE_ERROR });
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
    if (!isPlausibleBacklogApiKey(apiKey)) return reply.status(400).send({ error: 'API キーの形式が正しくありません' });
    const list = await loadConnections(userId);
    if (list.length >= MAX_BACKLOG_CONNECTIONS) return reply.status(400).send({ error: `接続は ${MAX_BACKLOG_CONNECTIONS} 件までです` });
    const conn = { id: nextConnectionId(list), space, apiKey, projects: [] };
    await saveConnections(userId, [...list, conn]);
    return toConnectionView(conn);
  });

  app.put('/api/backlog/connections/:id', async (request, reply) => {
    if (!isBacklogEnabled()) return sendDisabled(reply);
    // @ts-ignore
    const userId = request.user.id as string;
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { space?: unknown; apiKey?: unknown; projects?: unknown };
    const list = await loadConnections(userId);
    const idx = list.findIndex((c) => c.id === id);
    if (idx < 0) return reply.status(404).send({ error: '接続が見つかりません' });
    const conn = { ...list[idx] };
    if (body.space !== undefined) {
      const space = normalizeBacklogSpace(body.space);
      if (!space) return reply.status(400).send({ error: SPACE_ERROR });
      // スペースを変えたら、古いスペースのプロジェクト設定は意味がないので消す
      if (space !== conn.space) conn.projects = [];
      conn.space = space;
    }
    if (body.apiKey !== undefined) {
      const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
      if (!isPlausibleBacklogApiKey(apiKey)) return reply.status(400).send({ error: 'API キーの形式が正しくありません' });
      conn.apiKey = apiKey;
    }
    if (body.projects !== undefined) {
      const p = sanitizeProjectsSetting({ projects: body.projects });
      if (!p) return reply.status(400).send({ error: 'projects が不正です' });
      conn.projects = p.projects;
    }
    const next = [...list];
    next[idx] = conn;
    await saveConnections(userId, next);
    return toConnectionView(conn);
  });

  app.delete('/api/backlog/connections/:id', async (request, reply) => {
    if (!isBacklogEnabled()) return sendDisabled(reply);
    // @ts-ignore
    const userId = request.user.id as string;
    const { id } = request.params as { id: string };
    const list = await loadConnections(userId);
    if (!list.some((c) => c.id === id)) return reply.status(404).send({ error: '接続が見つかりません' });
    await saveConnections(userId, list.filter((c) => c.id !== id));
    return { success: true };
  });

  app.get('/api/backlog/connections/:id/projects', async (request, reply) => {
    if (!isBacklogEnabled()) return sendDisabled(reply);
    // @ts-ignore
    const userId = request.user.id as string;
    const { id } = request.params as { id: string };
    try {
      const ctx = await requireConnection(userId, id);
      const [projects, me] = await Promise.all([fetchProjects(ctx), fetchMyself(ctx)]);
      return { projects, me: me.name };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/api/backlog/connections/:id/projects/:key/statuses', async (request, reply) => {
    if (!isBacklogEnabled()) return sendDisabled(reply);
    // @ts-ignore
    const userId = request.user.id as string;
    const { id, key } = request.params as { id: string; key: string };
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) return reply.status(400).send({ error: 'プロジェクトキーが不正です' });
    try {
      const ctx = await requireConnection(userId, id);
      const statuses = await fetchStatuses(ctx, key);
      return { statuses, guessed: guessPhaseMap(statuses) };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/api/backlog/issues', async (request, reply) => {
    if (!isBacklogEnabled()) return sendDisabled(reply);
    // @ts-ignore
    const userId = request.user.id as string;
    try {
      return await listIssuesForUser(userId, parseListQuery(request.query as Record<string, string | undefined>));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/api/backlog/issues/:key', async (request, reply) => {
    if (!isBacklogEnabled()) return sendDisabled(reply);
    // @ts-ignore
    const userId = request.user.id as string;
    const { key } = request.params as { key: string };
    try {
      const ctx = await resolveIssueContext(userId, key);
      const issue = await getIssue(ctx, key);
      const { statuses } = await getProjectStatuses(ctx, issue.projectKey);
      return {
        issueKey: issue.issueKey,
        summary: issue.summary,
        status: issue.status,
        assignee: issue.assignee,
        url: issue.url,
        space: issue.space,
        statuses,
        // ?detail=1: 課題一覧で行を開いたときの中身（本文・種別・登録者・期限）。コメントは返さない
        ...(((request.query as { detail?: string }).detail === '1')
          ? {
              description: issue.description,
              issueType: issue.issueType,
              createdUser: issue.createdUser,
              created: issue.created,
              dueDate: issue.dueDate,
            }
          : {}),
      };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/backlog/issues/:key/status', async (request, reply) => {
    if (!isBacklogEnabled()) return sendDisabled(reply);
    // @ts-ignore
    const userId = request.user.id as string;
    const { key } = request.params as { key: string };
    const { statusId } = (request.body ?? {}) as { statusId?: unknown };
    if (typeof statusId !== 'number') return reply.status(400).send({ error: 'statusId が必要です' });
    try {
      const ctx = await resolveIssueContext(userId, key);
      // 人間が画面で選んだ変更なので逆戻りも許可する
      return await moveIssue(ctx, key, { statusId, force: true, source: 'human' });
    } catch (err) {
      return sendError(reply, err);
    }
  });
}

// ========================================
// スキル向けのテキスト整形（jq の無い Windows 端末でもそのまま読めるように、format=text で平文を返す）
// ========================================

type ListResult = Awaited<ReturnType<typeof listIssuesForUser>>;
type DetailResult = Awaited<ReturnType<typeof getIssue>>;
type MoveResult = Awaited<ReturnType<typeof moveIssue>> & { linkedToThread: boolean };
type StatusesResult = Awaited<ReturnType<typeof getProjectStatuses>>;

export function formatIssueListText(r: ListResult): string {
  const multi = r.spaces.length > 1;
  const head = `=== Backlog 課題一覧（${r.assigneeLabel}・${r.statusLabel}・${r.projects.join(', ')}${multi ? `・スペース ${r.spaces.join(', ')}` : ''}）${r.issues.length} 件 ===`;
  const warn = r.errors.map((e) => `⚠ 取得できなかったスペース: ${e}`);
  if (r.issues.length === 0) return [head, ...warn, '該当する課題はありません。'].join('\n');
  const lines = r.issues.map((i) =>
    `- ${i.issueKey} [${i.status.name}] ${i.summary}`
    + (multi ? ` @${i.space}` : '')
    + `（${[i.issueType?.name, i.assignee ? `担当: ${i.assignee}` : '担当なし', i.dueDate ? `期限: ${i.dueDate}` : null].filter(Boolean).join(' / ')}）`,
  );
  return [head, ...warn, ...lines].join('\n');
}

export function formatIssueDetailText(i: DetailResult): string {
  const out = [
    `=== ${i.issueKey} ${i.summary} ===`,
    `状態: ${i.status.name} / 種別: ${i.issueType?.name ?? '-'} / 担当: ${i.assignee ?? 'なし'} / 優先度: ${i.priority ?? '-'} / 期限: ${i.dueDate ?? '-'}`,
    `登録: ${i.createdUser ?? '-'} ${i.created?.slice(0, 10) ?? ''} / URL: ${i.url}`,
    '',
    '--- 本文 ---',
    i.description.trim() || '（本文なし）',
  ];
  if (i.comments.length) {
    out.push('', `--- コメント（新しい ${i.comments.length} 件、古い順） ---`);
    for (const c of i.comments) out.push(`[${c.created?.slice(0, 16).replace('T', ' ') ?? ''} ${c.author ?? ''}]`, c.content.trim(), '');
  }
  return out.join('\n');
}

export function formatMoveText(r: MoveResult): string {
  const head = r.changed
    ? `${r.issueKey} の状態を「${r.from.name}」→「${r.to.name}」に変更しました。`
    : `${r.issueKey} はすでに「${r.to.name}」です（状態は変えていません）。`;
  const assignee =
    r.assignee.action === 'assign' ? `担当者を ${r.assignee.name ?? '自分'} にしました。`
    : r.assignee.action === 'keep_other' ? `担当者は ${r.assignee.name ?? '他の人'} のままです（上書きしていません）。人間に伝えてください。`
    : null;
  return [
    head,
    assignee,
    r.startDateSet ? `開始日を ${r.startDateSet.replace(/-/g, '/')} にしました。` : null,
    r.commented ? `Backlog にコメントを付けました: ${r.commented}` : null,
    r.linkedToThread ? 'このスレッドの案件にも課題キーを設定しました。' : null,
    r.url,
  ].filter(Boolean).join('\n');
}

export function formatStatusesText(projectKey: string, r: StatusesResult): string {
  const name = (id: number | null) => (id === null ? 'なし（この段階は飛ばす）' : r.statuses.find((s) => s.id === id)?.name ?? `ID ${id}`);
  return [
    `=== ${projectKey} の状態（並び順） ===`,
    r.statuses.map((s) => s.name).join(' → '),
    '',
    '段階の対応:',
    `  start（着手）     : ${name(r.map.start)}`,
    `  test（テスト）    : ${name(r.map.test)}`,
    `  done（完了報告）  : ${name(r.map.done)}`,
  ].join('\n');
}

// ========================================
// マシントークン（スキル devrelay-backlog）
// ========================================

export function registerBacklogAgentRoutes(app: FastifyInstance) {
  const wantsText = (request: { query: unknown }) => (request.query as { format?: string } | undefined)?.format === 'text';

  /** スキルは format=text のときエラーも平文で受け取る（そのまま AI に見せる） */
  const fail = (request: { query: unknown }, reply: FastifyReply, err: unknown) => {
    if (!wantsText(request)) return sendError(reply, err);
    const status = err instanceof BacklogError ? err.status : 500;
    const msg = err instanceof BacklogError ? err.message : 'Backlog 連携でエラーが発生しました';
    if (!(err instanceof BacklogError)) console.error('❌ Backlog API error:', (err as Error)?.message);
    return reply.status(status).type('text/plain; charset=utf-8').send(`エラー: ${msg}\n`);
  };
  const ok = (request: { query: unknown }, reply: FastifyReply, json: unknown, text: () => string) =>
    wantsText(request) ? reply.type('text/plain; charset=utf-8').send(text() + '\n') : json;

  const auth = async (request: Parameters<typeof authenticateByMachineTokenFull>[0], reply: FastifyReply) => {
    if (!isBacklogEnabled()) {
      fail(request, reply, new BacklogError(404, 'Backlog 連携は無効です（DEVRELAY_BACKLOG=0）'));
      return null;
    }
    const a = await authenticateByMachineTokenFull(request);
    if (!a) {
      fail(request, reply, new BacklogError(401, 'マシントークンが無効です'));
      return null;
    }
    return a;
  };

  app.get('/api/agent/backlog/issues', async (request, reply) => {
    const a = await auth(request, reply);
    if (!a) return;
    try {
      const r = await listIssuesForUser(a.userId, parseListQuery(request.query as Record<string, string | undefined>));
      return ok(request, reply, r, () => formatIssueListText(r));
    } catch (err) {
      return fail(request, reply, err);
    }
  });

  app.get('/api/agent/backlog/issues/:key', async (request, reply) => {
    const a = await auth(request, reply);
    if (!a) return;
    const { key } = request.params as { key: string };
    const q = request.query as { comments?: string };
    try {
      const ctx = await resolveIssueContext(a.userId, key);
      const r = await getIssue(ctx, key, { comments: q.comments ? Number(q.comments) : 10 });
      return ok(request, reply, r, () => formatIssueDetailText(r));
    } catch (err) {
      return fail(request, reply, err);
    }
  });

  app.get('/api/agent/backlog/projects/:key/statuses', async (request, reply) => {
    const a = await auth(request, reply);
    if (!a) return;
    const { key } = request.params as { key: string };
    try {
      const ctx = await resolveProjectContext(a.userId, key);
      const r = await getProjectStatuses(ctx, key);
      return ok(request, reply, r, () => formatStatusesText(key, r));
    } catch (err) {
      return fail(request, reply, err);
    }
  });

  /**
   * 状態変更。パラメータは JSON 本文かクエリ文字列のどちらでも受ける
   * （スキルのスクリプトは jq 無しで日本語コメントを安全に渡すため curl --data-urlencode でクエリに載せる）
   */
  app.post('/api/agent/backlog/issues/:key/move', async (request, reply) => {
    const a = await auth(request, reply);
    if (!a) return;
    const { key } = request.params as { key: string };
    const body = (request.body && typeof request.body === 'object' ? request.body : {}) as Record<string, unknown>;
    const query = (request.query ?? {}) as Record<string, unknown>;
    const pick = (k: string) => (body[k] !== undefined ? body[k] : query[k]);
    const to = pick('to');
    // note = 自動コメントに書く「やったこと」。旧スキルの comment も同じ扱い
    const note = pick('note') ?? pick('comment');
    const force = pick('force');
    const sessionId = pick('sessionId');
    try {
      if (typeof to !== 'string' || !to.trim()) throw new BacklogError(400, 'to（start / test / done または状態名）が必要です');
      const ctx = await resolveIssueContext(a.userId, key);
      const sid = typeof sessionId === 'string' && sessionId ? sessionId : undefined;
      const r = await moveIssue(ctx, key, {
        to,
        note: typeof note === 'string' ? note : undefined,
        force: force === true || force === '1' || force === 'true',
        source: 'ai',
        aiTurns: await countAiTurns(a.userId, sid),
      });
      let linked = false;
      // 着手（段階 start、または状態名で着手の状態を指定した場合）ならスレッドの案件を課題キーにする
      const startId = ctx.setting.projects.find((p) => p.projectKey === projectKeyOfIssue(key))?.map.start;
      if (r.phase === 'start' || (startId != null && r.to.id === startId)) {
        linked = await linkSessionToIssue(a.userId, sid, key).catch(() => false);
      }
      console.log(`📋 Backlog move: ${key} ${r.from.name} → ${r.to.name}${r.changed ? '' : ' (no change)'} by user ${a.userId}`);
      const result = { ...r, linkedToThread: linked };
      return ok(request, reply, result, () => formatMoveText(result));
    } catch (err) {
      return fail(request, reply, err);
    }
  });

  app.get('/api/agent/backlog/current', async (request, reply) => {
    const a = await auth(request, reply);
    if (!a) return;
    const { sessionId } = request.query as { sessionId?: string };
    let issueKey: string | null = null;
    if (sessionId) {
      const session = await prisma.session.findUnique({ where: { id: sessionId }, select: { userId: true, usageCase: true } });
      if (session && session.userId === a.userId && isBacklogIssueKey(session.usageCase)) issueKey = session.usageCase;
    }
    return ok(request, reply, { issueKey }, () => (issueKey ? `このスレッドの課題: ${issueKey}` : 'このスレッドには Backlog の課題が設定されていません。'));
  });
}
