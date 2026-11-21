/**
 * Backlog（nulab）連携（2026-11-21）
 *
 * 方針（ユーザー決定）:
 * - API キーは人ごと（UserSettings `backlog_api_key`、暗号化）。Backlog 側の更新履歴に本人の名前が残り、
 *   本人が見られないプロジェクトには AI も触れない（Backlog の API キーは発行者と同じ権限で動くため）。
 * - さらに DevRelay 側で「使ってよいプロジェクト」を本人が選ぶ（UserSettings `backlog_projects`）。
 *   一覧・閲覧・状態変更のどれも、この許可リストにあるプロジェクトの課題に限る。
 * - 状態はプロジェクトごとに違う（ID も名前も）ため、作業の段階（start=着手 / test=テスト / done=完了報告）を
 *   プロジェクトごとの状態 ID に対応させる。対応は名前から自動推測し、設定画面で直せる。
 * - 1 人で複数の Backlog スペースを使える（接続 = スペース・API キー・使うプロジェクトの組。UserSettings
 *   `backlog_connections`、JSON 全体を暗号化）。課題キーのプロジェクトキーから接続を自動で決める。
 *   `DEVRELAY_BACKLOG_SPACE` は接続を追加するときの初期値（と、旧形式 1 件の読み替え）にだけ使う。
 *   API キーを任意のホストへ送らないよう、*.backlog.jp / *.backlog.com / *.backlogtool.com に限る。
 *
 * キルスイッチ: `DEVRELAY_BACKLOG=0` で全 API が 404、AI への課題 1 行も付けない。
 */

import { getUserSetting, setUserSetting, deleteUserSetting, SettingKeys } from './user-settings.js';

import {
  type BacklogPhase, type BacklogPhaseMap, type BacklogProjectSetting, type BacklogProjectsSetting, type BacklogStatus,
  type BacklogIssueSummary, type BacklogIssueDetail, type BacklogContext, type BacklogConnection,
  BacklogError, isBacklogEnabled, isBacklogIssueKey, projectKeyOfIssue, normalizeBacklogSpace, guessPhaseMap,
  resolveTargetStatus, FIXED_OPEN_ID, FIXED_CLOSED_ID,
  parseConnections, serializeConnections, legacyToConnections, pickConnectionForProject,
  type BacklogAssigneeScope, assigneeScopeLabel, filterByAssignee,
} from './backlog-rules.js';
export * from './backlog-rules.js';

// ========================================
// 設定の読み書き（複数接続）
// ========================================

/**
 * 接続の一覧を読む。新形式（backlog_connections）が無ければ旧形式（1 人 1 件）を接続 1 件として読む
 * （移行作業なしで今の設定を引き継ぐ。次に保存したときに新形式へ移る）。
 */
export async function loadConnections(userId: string): Promise<BacklogConnection[]> {
  const raw = await getUserSetting(userId, SettingKeys.BACKLOG_CONNECTIONS);
  if (raw !== null) return parseConnections(raw);
  const [space, apiKey, projectsRaw] = await Promise.all([
    getUserSetting(userId, SettingKeys.BACKLOG_SPACE),
    getUserSetting(userId, SettingKeys.BACKLOG_API_KEY),
    getUserSetting(userId, SettingKeys.BACKLOG_PROJECTS),
  ]);
  return legacyToConnections({ space, envSpace: process.env.DEVRELAY_BACKLOG_SPACE ?? null, apiKey, projectsRaw });
}

/** 接続の一覧を保存する（全体を暗号化）。旧形式のキーは消す */
export async function saveConnections(userId: string, list: BacklogConnection[]): Promise<void> {
  await setUserSetting(userId, SettingKeys.BACKLOG_CONNECTIONS, serializeConnections(list));
  await Promise.all([
    deleteUserSetting(userId, SettingKeys.BACKLOG_SPACE),
    deleteUserSetting(userId, SettingKeys.BACKLOG_API_KEY),
    deleteUserSetting(userId, SettingKeys.BACKLOG_PROJECTS),
  ]);
}

/** 組織既定のスペース（接続を追加するときの初期値。devrelay.io では未設定） */
export function defaultBacklogSpace(): string | null {
  return normalizeBacklogSpace(process.env.DEVRELAY_BACKLOG_SPACE);
}

function toContext(c: BacklogConnection): BacklogContext {
  return { id: c.id, space: c.space, apiKey: c.apiKey, setting: { projects: c.projects } };
}

/** 接続 ID で 1 件取り出す（設定画面のプロジェクト・状態の読み込み用） */
export async function requireConnection(userId: string, connId: string | undefined): Promise<BacklogContext> {
  const list = await loadConnections(userId);
  const c = connId ? list.find((x) => x.id === connId) : list.length === 1 ? list[0] : undefined;
  if (!c) throw new BacklogError(list.length === 0 ? 400 : 404, list.length === 0 ? 'Backlog の接続がありません（設定画面 → Backlog 連携）' : `接続 ${connId ?? ''} が見つかりません`);
  if (!c.apiKey) throw new BacklogError(400, `Backlog の API キーが未設定です（${c.space}）`);
  return toContext(c);
}

/** 課題キーから、その課題を扱ってよい接続を決める */
export async function resolveIssueContext(userId: string, issueKey: string): Promise<BacklogContext> {
  if (!isBacklogIssueKey(issueKey)) throw new BacklogError(400, `課題キーの形式が正しくありません: ${issueKey}`);
  const list = await loadConnections(userId);
  if (list.length === 0) throw new BacklogError(400, 'Backlog の接続がありません（設定画面 → Backlog 連携）');
  return resolveProjectContextFrom(list, projectKeyOfIssue(issueKey));
}

/** プロジェクトキーから、そのプロジェクトを使ってよい接続を決める */
export async function resolveProjectContext(userId: string, projectKey: string): Promise<BacklogContext> {
  const list = await loadConnections(userId);
  if (list.length === 0) throw new BacklogError(400, 'Backlog の接続がありません（設定画面 → Backlog 連携）');
  return resolveProjectContextFrom(list, projectKey);
}

function resolveProjectContextFrom(list: BacklogConnection[], pk: string): BacklogContext {
  const r = pickConnectionForProject(list, pk);
  if (r.ok) return toContext(r.conn);
  if (r.reason === 'ambiguous') {
    throw new BacklogError(409, `プロジェクト ${pk} が複数のスペース（${r.spaces.join(' / ')}）で使う設定になっていて、どちらの課題か決められません。設定画面でどちらか一方のチェックを外してください`);
  }
  throw new BacklogError(403, `プロジェクト ${pk} は DevRelay での利用が許可されていません（設定画面 → Backlog 連携でチェックを付けてください）`);
}

function allowedProject(ctx: BacklogContext, projectKey: string): BacklogProjectSetting | null {
  return ctx.setting.projects.find((p) => p.projectKey === projectKey) ?? null;
}

function requireAllowedIssue(ctx: BacklogContext, issueKey: string): BacklogProjectSetting {
  if (!isBacklogIssueKey(issueKey)) throw new BacklogError(400, `課題キーの形式が正しくありません: ${issueKey}`);
  const p = allowedProject(ctx, projectKeyOfIssue(issueKey));
  if (!p) throw new BacklogError(403, `プロジェクト ${projectKeyOfIssue(issueKey)} は DevRelay での利用が許可されていません（設定画面 → Backlog 連携でチェックを付けてください）`);
  return p;
}

// ========================================
// Backlog API 呼び出し
// ========================================

const TIMEOUT_MS = 15_000;

async function backlogFetch<T>(ctx: { space: string; apiKey: string }, method: 'GET' | 'PATCH', path: string, params: Record<string, string | number | (string | number)[] | undefined> = {}, timeoutMs = TIMEOUT_MS): Promise<T> {
  const url = new URL(`https://${ctx.space}/api/v2${path}`);
  const body = new URLSearchParams();
  const target = method === 'GET' ? url.searchParams : body;
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const x of v) target.append(`${k}[]`, String(x));
    else target.append(k, String(v));
  }
  url.searchParams.set('apiKey', ctx.apiKey);
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: method === 'PATCH' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : undefined,
      body: method === 'PATCH' ? body.toString() : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // URL（apiKey 入り）をログ・エラーに出さない
    throw new BacklogError(502, `Backlog に接続できません（${ctx.space}）: ${(err as Error).name}`);
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { errors?: { message?: string }[] };
      if (j.errors?.[0]?.message) msg = j.errors[0].message;
    } catch { /* ignore */ }
    if (res.status === 401) throw new BacklogError(400, `Backlog の API キーが無効です（${msg}）`);
    if (res.status === 404) throw new BacklogError(404, `Backlog で見つかりません（${msg}）`);
    if (res.status === 403) throw new BacklogError(403, `Backlog で権限がありません（${msg}）`);
    throw new BacklogError(502, `Backlog API エラー: ${msg}`);
  }
  return (await res.json()) as T;
}

// 小さなメモリキャッシュ（状態一覧 5 分・自分のユーザー 30 分）
const cache = new Map<string, { at: number; value: unknown }>();
async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 500) cache.delete(cache.keys().next().value as string);
  return value;
}
function cacheKey(ctx: { space: string; apiKey: string }, what: string) {
  return `${ctx.space}|${ctx.apiKey.slice(-8)}|${what}`;
}

export async function fetchMyself(ctx: { space: string; apiKey: string }): Promise<{ id: number; name: string }> {
  return cached(cacheKey(ctx, 'myself'), 30 * 60_000, async () => {
    const u = await backlogFetch<{ id: number; name: string }>(ctx, 'GET', '/users/myself');
    return { id: u.id, name: u.name };
  });
}

export async function fetchProjects(ctx: { space: string; apiKey: string }): Promise<{ projectId: number; projectKey: string; name: string }[]> {
  const list = await backlogFetch<{ id: number; projectKey: string; name: string; archived: boolean }[]>(ctx, 'GET', '/projects', { archived: 'false' });
  return list.map((p) => ({ projectId: p.id, projectKey: p.projectKey, name: p.name }));
}

export async function fetchStatuses(ctx: { space: string; apiKey: string }, projectKey: string): Promise<BacklogStatus[]> {
  return cached(cacheKey(ctx, `statuses:${projectKey}`), 5 * 60_000, async () => {
    const list = await backlogFetch<{ id: number; name: string; color?: string; displayOrder?: number }[]>(ctx, 'GET', `/projects/${encodeURIComponent(projectKey)}/statuses`);
    return list
      .map((s, i) => ({ id: s.id, name: s.name, color: s.color || '#888888', displayOrder: s.displayOrder ?? i }))
      .sort((a, b) => a.displayOrder - b.displayOrder);
  });
}

interface RawIssue {
  issueKey: string;
  summary: string;
  description?: string | null;
  status: { id: number; name: string; color?: string };
  issueType?: { name: string; color?: string } | null;
  assignee?: { id?: number; name: string } | null;
  priority?: { name: string } | null;
  dueDate?: string | null;
  updated?: string | null;
  created?: string | null;
  createdUser?: { name: string } | null;
}

function toSummary(space: string, i: RawIssue): BacklogIssueSummary {
  return {
    issueKey: i.issueKey,
    projectKey: projectKeyOfIssue(i.issueKey),
    summary: i.summary,
    status: { id: i.status.id, name: i.status.name, color: i.status.color || '#888888' },
    issueType: i.issueType ? { name: i.issueType.name, color: i.issueType.color || '#888888' } : null,
    assignee: i.assignee?.name ?? null,
    assigneeId: typeof i.assignee?.id === 'number' ? i.assignee.id : null,
    priority: i.priority?.name ?? null,
    dueDate: i.dueDate ? i.dueDate.slice(0, 10) : null,
    updated: i.updated ?? null,
    url: `https://${space}/view/${i.issueKey}`,
    space,
  };
}

export interface ListIssuesOptions {
  /** 絞り込むプロジェクトキー（未指定なら許可済み全プロジェクト） */
  project?: string;
  /**
   * 状態: 未指定 = 未対応＋着手（各プロジェクトの start 対応）、'open' = 完了以外、'all' = 全部、
   * それ以外はカンマ区切りの状態名（例: '未対応,処理中'）
   */
  status?: string;
  /** 担当者の絞り込み（既定 mine_unassigned = 自分＋担当なし） */
  assignee?: BacklogAssigneeScope;
  keyword?: string;
  count?: number;
}

export async function listIssues(ctx: BacklogContext, opts: ListIssuesOptions): Promise<{ issues: BacklogIssueSummary[]; projects: string[]; statusLabel: string; assigneeLabel: string }> {
  const scope: BacklogAssigneeScope = opts.assignee ?? 'mine_unassigned';
  const assigneeLabel = assigneeScopeLabel(scope);
  let projects = ctx.setting.projects;
  if (projects.length === 0) throw new BacklogError(400, '使ってよい Backlog プロジェクトが選ばれていません（設定画面 → Backlog 連携でチェックを付けてください）');
  if (opts.project) {
    const p = allowedProject(ctx, opts.project.trim().toUpperCase());
    if (!p) throw new BacklogError(403, `プロジェクト ${opts.project} は DevRelay での利用が許可されていません`);
    projects = [p];
  }

  const statusIds = new Set<number>();
  const rawStatus = (opts.status ?? '').trim();
  let statusLabel: string;
  if (rawStatus === 'all') {
    statusLabel = 'すべて';
  } else if (rawStatus === 'open') {
    statusLabel = '完了以外';
    for (const p of projects) {
      for (const s of await fetchStatuses(ctx, p.projectKey)) if (s.id !== FIXED_CLOSED_ID) statusIds.add(s.id);
    }
  } else if (rawStatus) {
    const names = rawStatus.split(',').map((x) => x.trim()).filter(Boolean);
    statusLabel = names.join('・');
    for (const p of projects) {
      for (const s of await fetchStatuses(ctx, p.projectKey)) if (names.some((n) => s.name === n || s.name.includes(n))) statusIds.add(s.id);
    }
    if (statusIds.size === 0) return { issues: [], projects: projects.map((p) => p.projectKey), statusLabel, assigneeLabel };
  } else {
    statusLabel = '未対応・着手';
    statusIds.add(FIXED_OPEN_ID);
    for (const p of projects) {
      const start = p.map.start ?? guessPhaseMap(await fetchStatuses(ctx, p.projectKey)).start;
      if (start) statusIds.add(start);
    }
  }

  const params: Record<string, string | number | (string | number)[] | undefined> = {
    projectId: projects.map((p) => p.projectId),
    statusId: statusIds.size ? [...statusIds] : undefined,
    keyword: opts.keyword?.trim() || undefined,
    count: Math.min(Math.max(opts.count ?? 50, 1), 100),
    sort: 'updated',
    order: 'desc',
  };
  // 「自分のみ」は Backlog 側で絞れる。「担当なし」を含む指定は Backlog API に該当パラメータが無いため、
  // 担当者を指定せずに最大 100 件取ってからサーバー側で絞る（更新の新しい順なので、漏れるのは古いものだけ）
  let myId: number | null = null;
  if (scope !== 'everyone') myId = (await fetchMyself(ctx)).id;
  if (scope === 'mine') params.assigneeId = [myId as number];
  else if (scope !== 'everyone') params.count = 100;
  const list = await backlogFetch<RawIssue[]>(ctx, 'GET', '/issues', params);
  const issues = filterByAssignee(list.map((i) => toSummary(ctx.space, i)), scope, myId).slice(0, Math.min(Math.max(opts.count ?? 50, 1), 100));
  return { issues, projects: projects.map((p) => p.projectKey), statusLabel, assigneeLabel };
}

export interface ListIssuesForUserOptions extends ListIssuesOptions {
  /** スペースのホスト名で絞る（例: 'xxx.backlog.jp'。部分一致） */
  space?: string;
  /** 接続 ID で絞る */
  conn?: string;
}

/**
 * 全接続の課題一覧をまとめて返す（更新の新しい順）。1 つの接続がエラーでも残りは返し、エラーは errors に入れる。
 * すべての接続がエラーなら最初のエラーを投げる。
 */
export async function listIssuesForUser(userId: string, opts: ListIssuesForUserOptions): Promise<{ issues: BacklogIssueSummary[]; projects: string[]; statusLabel: string; assigneeLabel: string; errors: string[]; spaces: string[] }> {
  let list = (await loadConnections(userId)).filter((c) => c.apiKey && c.projects.length > 0);
  if (list.length === 0) throw new BacklogError(400, '使ってよい Backlog プロジェクトが選ばれていません（設定画面 → Backlog 連携で接続を追加し、プロジェクトにチェックを付けてください）');
  if (opts.conn) list = list.filter((c) => c.id === opts.conn);
  if (opts.space) {
    const q = opts.space.trim().toLowerCase();
    list = list.filter((c) => c.space.includes(q));
  }
  if (opts.project) {
    const pk = opts.project.trim().toUpperCase();
    list = list.filter((c) => c.projects.some((p) => p.projectKey === pk));
  }
  if (list.length === 0) throw new BacklogError(404, '条件に合う接続・プロジェクトがありません（設定画面でチェックしたものだけが対象です）');

  const results = await Promise.allSettled(list.map((c) => listIssues(toContext(c), opts)));
  const issues: BacklogIssueSummary[] = [];
  const projects: string[] = [];
  const errors: string[] = [];
  let statusLabel = '';
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled') {
      issues.push(...r.value.issues);
      projects.push(...r.value.projects);
      statusLabel = r.value.statusLabel;
    } else {
      const e = r.reason;
      errors.push(`${list[i].space}: ${e instanceof BacklogError ? e.message : 'エラーが発生しました'}`);
    }
  }
  if (errors.length === results.length) {
    const first = (results[0] as PromiseRejectedResult).reason;
    throw first instanceof BacklogError ? first : new BacklogError(502, errors[0]);
  }
  issues.sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? ''));
  return { issues, projects, statusLabel, assigneeLabel: assigneeScopeLabel(opts.assignee ?? 'mine_unassigned'), errors, spaces: list.map((c) => c.space) };
}

export async function getIssue(ctx: BacklogContext, issueKey: string, opts: { comments?: number; timeoutMs?: number } = {}): Promise<BacklogIssueDetail> {
  requireAllowedIssue(ctx, issueKey);
  const i = await backlogFetch<RawIssue>(ctx, 'GET', `/issues/${encodeURIComponent(issueKey)}`, {}, opts.timeoutMs);
  let comments: BacklogIssueDetail['comments'] = [];
  const n = Math.min(Math.max(opts.comments ?? 0, 0), 100);
  if (n > 0) {
    const raw = await backlogFetch<{ content: string | null; created?: string; createdUser?: { name: string } | null }[]>(
      ctx, 'GET', `/issues/${encodeURIComponent(issueKey)}/comments`, { count: n, order: 'desc' },
    );
    comments = raw
      .filter((c) => c.content && c.content.trim())
      .map((c) => ({ author: c.createdUser?.name ?? null, created: c.created ?? null, content: c.content as string }))
      .reverse();
  }
  return {
    ...toSummary(ctx.space, i),
    description: i.description ?? '',
    createdUser: i.createdUser?.name ?? null,
    created: i.created ?? null,
    comments,
  };
}

export async function getProjectStatuses(ctx: BacklogContext, projectKey: string): Promise<{ statuses: BacklogStatus[]; map: BacklogPhaseMap; guessed: BacklogPhaseMap }> {
  const statuses = await fetchStatuses(ctx, projectKey);
  const guessed = guessPhaseMap(statuses);
  const p = allowedProject(ctx, projectKey);
  return { statuses, map: p?.map ?? guessed, guessed };
}

/**
 * 課題の状態を変える。
 * - to: 段階（start/test/done）または状態名、もしくは statusId
 * - 段階が逆戻りする変更（並び順で前の状態へ）は force が無い限り断る（AI の取り違え防止。画面からの変更は force 扱い）
 */
export async function moveIssue(
  ctx: BacklogContext,
  issueKey: string,
  input: { to?: string; statusId?: number; comment?: string; force?: boolean },
): Promise<{ issueKey: string; from: { id: number; name: string }; to: { id: number; name: string; color: string }; phase: BacklogPhase | null; changed: boolean; url: string; summary: string }> {
  const proj = requireAllowedIssue(ctx, issueKey);
  const statuses = await fetchStatuses(ctx, proj.projectKey);
  let target: BacklogStatus | undefined;
  let phase: BacklogPhase | null = null;
  if (typeof input.statusId === 'number') {
    target = statuses.find((s) => s.id === input.statusId);
    if (!target) throw new BacklogError(400, `状態 ID ${input.statusId} はこのプロジェクトにありません`);
  } else if (input.to) {
    const r = resolveTargetStatus(input.to, statuses, proj.map);
    if (!r.ok) throw new BacklogError(400, r.error);
    target = r.status;
    phase = r.phase;
  } else {
    throw new BacklogError(400, '変更先（to または statusId）を指定してください');
  }

  const current = await backlogFetch<RawIssue>(ctx, 'GET', `/issues/${encodeURIComponent(issueKey)}`);
  const from = { id: current.status.id, name: current.status.name };
  const url = `https://${ctx.space}/view/${issueKey}`;
  if (from.id === target.id && !input.comment?.trim()) {
    return { issueKey, from, to: { id: target.id, name: target.name, color: target.color }, phase, changed: false, url, summary: current.summary };
  }
  if (!input.force && from.id !== target.id) {
    const order = (id: number) => statuses.find((s) => s.id === id)?.displayOrder ?? 0;
    if (order(target.id) < order(from.id)) {
      throw new BacklogError(409, `「${from.name}」から前の状態「${target.name}」へ戻す変更です。人間に確認したうえで --force を付けてください`);
    }
  }
  const comment = input.comment?.trim() ? input.comment.trim().slice(0, 10_000) : undefined;
  await backlogFetch<RawIssue>(ctx, 'PATCH', `/issues/${encodeURIComponent(issueKey)}`, {
    ...(from.id !== target.id ? { statusId: target.id } : {}),
    comment,
  });
  return { issueKey, from, to: { id: target.id, name: target.name, color: target.color }, phase, changed: from.id !== target.id, url, summary: current.summary };
}

/**
 * AI に渡す「このスレッドの課題」1 行。課題キーでなければ null。
 * Backlog が遅くても送信を止めないよう短いタイムアウトで取り、失敗したらキーだけにする。
 */
export async function buildBacklogPromptLine(userId: string, usageCase: string | null | undefined): Promise<string | null> {
  if (!isBacklogEnabled() || !isBacklogIssueKey(usageCase)) return null;
  let ctx: BacklogContext;
  try {
    ctx = await resolveIssueContext(userId, usageCase);
  } catch {
    // 接続が無い・許可されていない課題キー（ただの案件名の可能性もある）は何も付けない
    return null;
  }
  const how = '内容の確認や状態の変更は devrelay-backlog スキル（使い方は ~/.claude/skills/devrelay-backlog/SKILL.md）で行ってください。';
  try {
    const i = await getIssue(ctx, usageCase, { timeoutMs: 3000 });
    return `【Backlog課題】このスレッドの課題は ${i.issueKey}「${i.summary}」（状態: ${i.status.name}）です。${how}`;
  } catch {
    return `【Backlog課題】このスレッドの課題は ${usageCase} です。${how}`;
  }
}
