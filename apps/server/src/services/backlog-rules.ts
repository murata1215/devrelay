/**
 * Backlog 連携（2026-11-21）の純関数・型（DB や fetch に触れない。単体テストは dist を直接 import する）。
 * 本体は services/backlog.ts。
 */

// ========================================
// 型
// ========================================

export type BacklogPhase = 'start' | 'test' | 'done';
export const BACKLOG_PHASES: BacklogPhase[] = ['start', 'test', 'done'];

export interface BacklogPhaseMap {
  start: number | null;
  test: number | null;
  done: number | null;
}

export interface BacklogProjectSetting {
  projectId: number;
  projectKey: string;
  name: string;
  map: BacklogPhaseMap;
}

export interface BacklogProjectsSetting {
  projects: BacklogProjectSetting[];
}

export interface BacklogStatus {
  id: number;
  name: string;
  color: string;
  displayOrder: number;
}

export interface BacklogIssueSummary {
  issueKey: string;
  projectKey: string;
  summary: string;
  status: { id: number; name: string; color: string };
  issueType: { name: string; color: string } | null;
  assignee: string | null;
  /** 担当者の Backlog ユーザー ID（担当なしは null。「自分＋担当なし」の絞り込みに使う） */
  assigneeId: number | null;
  priority: string | null;
  dueDate: string | null;
  updated: string | null;
  url: string;
  /** どのスペースの課題か（接続が複数あるときの表示用） */
  space: string;
}

export interface BacklogIssueDetail extends BacklogIssueSummary {
  description: string;
  createdUser: string | null;
  created: string | null;
  comments: { author: string | null; created: string | null; content: string }[];
}

/** 1 つの接続 = 1 つのスペースへの API 呼び出しに必要なもの一式 */
export interface BacklogContext {
  /** 接続 ID（同じ人の接続の中で一意） */
  id: string;
  space: string;
  apiKey: string;
  setting: BacklogProjectsSetting;
}

/**
 * 保存形式（UserSettings `backlog_connections`。JSON 全体を暗号化して保存）。
 * 1 人で複数の Backlog スペース（会社・お客様ごと）を使えるように、接続を何件でも持てる。
 */
export interface BacklogConnection {
  id: string;
  space: string;
  apiKey: string;
  projects: BacklogProjectSetting[];
}

/** WebUI に返す形（API キーは返さない） */
export interface BacklogConnectionView {
  id: string;
  space: string;
  hasKey: boolean;
  projects: BacklogProjectSetting[];
}

export const MAX_BACKLOG_CONNECTIONS = 20;

export class BacklogError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// ========================================
// 小さな純関数（単体テスト対象）
// ========================================

export function isBacklogEnabled(raw: string | undefined = process.env.DEVRELAY_BACKLOG): boolean {
  return raw !== '0';
}

/** 課題キー（例: ATG_39_P_0002-1167）か */
const ISSUE_KEY_RE = /^[A-Z][A-Z0-9_]*-\d+$/;
export function isBacklogIssueKey(v: unknown): v is string {
  return typeof v === 'string' && ISSUE_KEY_RE.test(v);
}

/** 課題キー → プロジェクトキー */
export function projectKeyOfIssue(issueKey: string): string {
  return issueKey.slice(0, issueKey.lastIndexOf('-'));
}

/**
 * スペースのホスト名を正規化・検証する。
 * 'https://xxx.backlog.jp/' や 'xxx.backlog.jp/projects/ABC' → 'xxx.backlog.jp'
 * 許可ドメイン以外は null（API キーを任意のホストへ送らないため）
 */
export function normalizeBacklogSpace(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let s = raw.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^https?:\/\//, '');
  s = s.split(/[/?#]/)[0];
  if (!/^[a-z0-9-]+\.(backlog\.jp|backlog\.com|backlogtool\.com)$/.test(s)) return null;
  return s;
}

const START_WORDS = ['処理中', '対応中', '作業中', '進行中', '着手', 'in progress', 'doing'];
const TEST_WORDS = ['テスト', 'test', '検証', '確認中', 'レビュー', 'review'];
const DONE_WORDS = ['リリース待ち', 'リリース', 'release', '処理済', '対応済', 'resolved'];
export const FIXED_OPEN_ID = 1; // 未対応（全プロジェクト共通の既定状態）
export const FIXED_CLOSED_ID = 4; // 完了（全プロジェクト共通の既定状態）

function pickByWords(statuses: BacklogStatus[], words: string[], exclude: Set<number>): number | null {
  for (const w of words) {
    const hit = statuses.find((s) => !exclude.has(s.id) && s.name.toLowerCase().includes(w.toLowerCase()));
    if (hit) return hit.id;
  }
  return null;
}

/**
 * 状態の名前から段階の対応を推測する。
 * - 着手: 「処理中」等。無ければ既定の ID 2（処理中）
 * - テスト: 「テスト」「検証」等。無ければ null（そのプロジェクトはテスト段階を飛ばす）
 * - 完了報告: 「リリース待ち」→「処理済み」等。無ければ既定の ID 3（処理済み）
 * 未対応（1）と完了（4）はどの段階にも当てない。
 */
export function guessPhaseMap(statuses: BacklogStatus[]): BacklogPhaseMap {
  const sorted = [...statuses].sort((a, b) => a.displayOrder - b.displayOrder);
  const base = new Set<number>([FIXED_OPEN_ID, FIXED_CLOSED_ID]);
  const has = (id: number) => sorted.some((s) => s.id === id);

  const start = pickByWords(sorted, START_WORDS, base) ?? (has(2) ? 2 : null);
  const ex1 = new Set(base);
  if (start !== null) ex1.add(start);
  // 完了報告を先に決め、テストと同じ状態にならないようにする
  const done = pickByWords(sorted, DONE_WORDS, ex1) ?? (has(3) && !ex1.has(3) ? 3 : null);
  const ex2 = new Set(ex1);
  if (done !== null) ex2.add(done);
  let test = pickByWords(sorted, TEST_WORDS, ex2);
  // テストは着手と完了報告の間にある状態に限る（並び順で外れていたら採らない）
  if (test !== null && start !== null && done !== null) {
    const order = (id: number) => sorted.find((s) => s.id === id)?.displayOrder ?? 0;
    if (!(order(start) < order(test) && order(test) < order(done))) test = null;
  }
  return { start, test, done };
}

/** 保存済み設定（JSON 文字列）を安全に読む */
export function parseProjectsSetting(raw: string | null | undefined): BacklogProjectsSetting {
  if (!raw) return { projects: [] };
  try {
    const v = JSON.parse(raw);
    return sanitizeProjectsSetting(v) ?? { projects: [] };
  } catch {
    return { projects: [] };
  }
}

function toIdOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null;
}

/** WebUI から来た値を検証して正規化する（不正なら null） */
export function sanitizeProjectsSetting(v: unknown): BacklogProjectsSetting | null {
  if (!v || typeof v !== 'object') return null;
  const list = (v as { projects?: unknown }).projects;
  if (!Array.isArray(list)) return null;
  const out: BacklogProjectSetting[] = [];
  const seen = new Set<string>();
  for (const p of list.slice(0, 100)) {
    if (!p || typeof p !== 'object') continue;
    const o = p as Record<string, unknown>;
    const projectKey = typeof o.projectKey === 'string' ? o.projectKey.trim() : '';
    const projectId = toIdOrNull(o.projectId);
    if (!/^[A-Z][A-Z0-9_]*$/.test(projectKey) || projectId === null || seen.has(projectKey)) continue;
    seen.add(projectKey);
    const m = (o.map && typeof o.map === 'object' ? o.map : {}) as Record<string, unknown>;
    out.push({
      projectId,
      projectKey,
      name: typeof o.name === 'string' ? o.name.slice(0, 200) : projectKey,
      map: { start: toIdOrNull(m.start), test: toIdOrNull(m.test), done: toIdOrNull(m.done) },
    });
  }
  return { projects: out };
}

/**
 * 段階名または状態名 → 状態 ID。
 * to が 'start'|'test'|'done' なら対応表（無ければ推測）、それ以外は状態名の完全一致→部分一致。
 */
export function resolveTargetStatus(
  to: string,
  statuses: BacklogStatus[],
  map: BacklogPhaseMap | null,
): { ok: true; status: BacklogStatus; phase: BacklogPhase | null } | { ok: false; error: string } {
  const t = to.trim();
  if ((BACKLOG_PHASES as string[]).includes(t)) {
    const phase = t as BacklogPhase;
    // 設定画面で決めた対応があればそれだけを使う（「なし」を選んだ段階を推測で埋め戻さない）
    const id = (map ?? guessPhaseMap(statuses))[phase];
    const st = statuses.find((s) => s.id === id);
    if (!st) {
      const label = { start: '着手', test: 'テスト', done: '完了報告' }[phase];
      return { ok: false, error: `このプロジェクトには「${label}」にあたる状態がありません（状態: ${statuses.map((s) => s.name).join(' / ')}）` };
    }
    return { ok: true, status: st, phase };
  }
  const exact = statuses.find((s) => s.name === t);
  const partial = exact ?? statuses.find((s) => s.name.includes(t));
  if (!partial) return { ok: false, error: `状態「${t}」が見つかりません（状態: ${statuses.map((s) => s.name).join(' / ')}）` };
  return { ok: true, status: partial, phase: null };
}


// ========================================
// 複数接続（2026-11-21 追加: 1 人で複数の Backlog スペースを使う）
// ========================================

const CONN_ID_RE = /^[a-z0-9]{1,16}$/;
const API_KEY_RE = /^[A-Za-z0-9]{20,128}$/;

export function isValidConnectionId(v: unknown): v is string {
  return typeof v === 'string' && CONN_ID_RE.test(v);
}

export function isPlausibleBacklogApiKey(v: unknown): v is string {
  return typeof v === 'string' && API_KEY_RE.test(v);
}

/** 保存済みの接続一覧（JSON 文字列）を安全に読む。壊れた要素は捨てる */
export function parseConnections(raw: string | null | undefined): BacklogConnection[] {
  if (!raw) return [];
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = (v as { connections?: unknown } | null)?.connections;
  if (!Array.isArray(list)) return [];
  const out: BacklogConnection[] = [];
  const ids = new Set<string>();
  for (const c of list.slice(0, MAX_BACKLOG_CONNECTIONS)) {
    if (!c || typeof c !== 'object') continue;
    const o = c as Record<string, unknown>;
    const space = normalizeBacklogSpace(o.space);
    if (!isValidConnectionId(o.id) || ids.has(o.id) || !space) continue;
    ids.add(o.id);
    out.push({
      id: o.id,
      space,
      apiKey: typeof o.apiKey === 'string' ? o.apiKey : '',
      projects: sanitizeProjectsSetting({ projects: o.projects })?.projects ?? [],
    });
  }
  return out;
}

export function serializeConnections(list: BacklogConnection[]): string {
  return JSON.stringify({ connections: list });
}

/**
 * 旧形式（1 人 1 件: backlog_space / backlog_api_key / backlog_projects）を接続 1 件として読む。
 * スペースは本人設定 → 組織既定（DEVRELAY_BACKLOG_SPACE）の順。キーもスペースも無ければ空配列。
 */
export function legacyToConnections(input: { space: string | null; envSpace: string | null; apiKey: string | null; projectsRaw: string | null }): BacklogConnection[] {
  const space = normalizeBacklogSpace(input.space) ?? normalizeBacklogSpace(input.envSpace);
  if (!space || !input.apiKey) return [];
  return [{ id: 'c1', space, apiKey: input.apiKey, projects: parseProjectsSetting(input.projectsRaw).projects }];
}

/** 新しい接続 ID（既存と重ならない c<番号>） */
export function nextConnectionId(list: { id: string }[]): string {
  let n = 1;
  const ids = new Set(list.map((c) => c.id));
  while (ids.has(`c${n}`)) n++;
  return `c${n}`;
}

export function toConnectionView(c: BacklogConnection): BacklogConnectionView {
  return { id: c.id, space: c.space, hasKey: !!c.apiKey, projects: c.projects };
}

/**
 * 課題キー（のプロジェクトキー）から、それを使ってよい接続を決める。
 * - 0 件: 許可されていない
 * - 2 件以上: 別スペースに同じプロジェクトキーがあり、どちらか決められない
 */
export function pickConnectionForProject(
  list: BacklogConnection[],
  projectKey: string,
): { ok: true; conn: BacklogConnection } | { ok: false; reason: 'none' | 'ambiguous'; spaces: string[] } {
  const hits = list.filter((c) => c.apiKey && c.projects.some((p) => p.projectKey === projectKey));
  if (hits.length === 1) return { ok: true, conn: hits[0] };
  return { ok: false, reason: hits.length === 0 ? 'none' : 'ambiguous', spaces: hits.map((c) => c.space) };
}

// ========================================
// 担当者の絞り込み（2026-11-21 追加: 初期表示を「自分＋担当なし」に）
// ========================================

/**
 * - mine_unassigned: 自分が担当 + 担当者なし（既定）
 * - mine: 自分が担当のみ
 * - unassigned: 担当者なしのみ
 * - everyone: 担当者で絞らない
 */
export type BacklogAssigneeScope = 'mine_unassigned' | 'mine' | 'unassigned' | 'everyone';
export const BACKLOG_ASSIGNEE_SCOPES: BacklogAssigneeScope[] = ['mine_unassigned', 'mine', 'unassigned', 'everyone'];

/** クエリの assignee（新）と everyone=1（旧・互換）から決める。未指定は mine_unassigned */
export function parseAssigneeScope(raw: unknown, everyoneFlag?: boolean): BacklogAssigneeScope {
  if (typeof raw === 'string' && (BACKLOG_ASSIGNEE_SCOPES as string[]).includes(raw)) return raw as BacklogAssigneeScope;
  return everyoneFlag ? 'everyone' : 'mine_unassigned';
}

export function assigneeScopeLabel(scope: BacklogAssigneeScope): string {
  return { mine_unassigned: '自分＋担当なし', mine: '自分が担当', unassigned: '担当なし', everyone: '全員' }[scope];
}

/** 担当者で絞る（Backlog API に「担当者なし」の指定が無いため、取ってきた後にサーバー側で絞る） */
export function filterByAssignee<T extends { assigneeId: number | null }>(list: T[], scope: BacklogAssigneeScope, myId: number | null): T[] {
  switch (scope) {
    case 'everyone':
      return list;
    case 'mine':
      return list.filter((i) => myId !== null && i.assigneeId === myId);
    case 'unassigned':
      return list.filter((i) => i.assigneeId === null);
    default:
      return list.filter((i) => i.assigneeId === null || (myId !== null && i.assigneeId === myId));
  }
}

// ========================================
// 状態変更時の自動コメント・担当者（2026-11-21 追加）
// ========================================

/** 日本時間の 'YYYY/MM/DD HH:mm:ss' */
export function formatJstTimestamp(d: Date): string {
  const p = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? '00';
  const hh = g('hour') === '24' ? '00' : g('hour');
  return `${g('year')}/${g('month')}/${g('day')} ${hh}:${g('minute')}:${g('second')}`;
}

/** note が無いときの段階ごとの既定文 */
export function defaultMoveNote(phase: BacklogPhase | null, statusName: string): string {
  if (phase === 'start') return '着手しました';
  if (phase === 'test') return `テストを開始しました（状態: ${statusName}）`;
  if (phase === 'done') return `完了報告：${statusName}にしました`;
  return `状態を「${statusName}」に変更しました`;
}

/**
 * 状態変更と一緒に付けるコメント。
 * - AI（スキル）: `*AI自動追記 2026/11/21 18:29:30：内容`
 * - 人間（画面の状態バッジ）: `*DevRelay 2026/11/21 18:29:30：内容`
 */
export function formatAutoComment(source: 'ai' | 'human', at: Date, text: string): string {
  const head = source === 'ai' ? '*AI自動追記' : '*DevRelay';
  const body = text.replace(/\r\n?/g, '\n').trim();
  return `${head} ${formatJstTimestamp(at)}：${body}`.slice(0, 10_000);
}

/**
 * 着手（start）にするとき担当者をどうするか。
 * - assign: 担当者が空なので自分にする
 * - already_mine: もう自分が担当
 * - keep_other: 他の人が担当なので上書きしない
 * - skip: 着手以外の変更（担当者は触らない）
 */
export function decideAssignee(isStart: boolean, currentAssigneeId: number | null, myId: number | null): 'assign' | 'already_mine' | 'keep_other' | 'skip' {
  if (!isStart || myId === null) return 'skip';
  if (currentAssigneeId === null) return 'assign';
  return currentAssigneeId === myId ? 'already_mine' : 'keep_other';
}
