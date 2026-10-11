/**
 * 高辻ナレッジ サイクル3（WebUI）: `/knowledge` ページの URL 状態の往復・ハイライト・
 * 機密度バッジ色・coverage/viewer 表示・エラー文言判定・スレッドページングを決める
 * 純関数群（外部 import ゼロ。node:test から dist-test/ を直接 import する、
 * thread-list-rules.ts / machine-display-rules.ts と同じ流儀）。
 *
 * この分離が必要な理由: `GET /api/knowledge/search` のクエリには 2 つの罠がある
 * （`maxLevel=''` → `Number('')===0` で静かに level 0 だけに絞られる／`limit=''` → 400）。
 * クエリ文字列の組み立てを `buildKnowledgeSearchQuery` 1 箇所に閉じ込め、空値を一切出さない
 * 構造にすることで、呼び出し側（React コンポーネント）がこの罠を再発させる余地を無くす。
 *
 * もう一つの理由: `/knowledge` は URL を唯一の真実（single source of truth）として扱う
 * （D6）。URL ↔ 状態の往復をコンポーネントから切り離して純関数として固定することで、
 * 「スレッドを開いても検索条件の参照は変わらない（再検索ループに陥らない）」という
 * 設計上の保証を guard テストでデータとして検証できるようにする（§ buildKnowledgeSearchQuery
 * が thread/anchor の値に依存しないことを単体テストで固定）。
 *
 * `tsconfig.test.json`（`lib:["ES2022"], types:[]`）には DOM 型が無いため、
 * `URLSearchParams` はこのモジュール内で使えない。パースは getter 関数を受け取る形、
 * シリアライズは `Array<[string,string]>` を返す形にする（呼び出し側で
 * `URLSearchParams`/`react-router` の `useSearchParams` に接続する）。
 */

// ---- URL 状態 ----

export type KnowledgeMode = 'hybrid' | 'keyword' | 'vector';
export type KnowledgeScope = 'all' | 'mine';
export type KnowledgeKind = 'all' | 'instruction' | 'question';
export type LevelTone = 'open' | 'low' | 'mid' | 'high';

export const KNOWLEDGE_LEVEL_MIN = 0;
export const KNOWLEDGE_LEVEL_MAX = 10;
export const KNOWLEDGE_LIMIT_MIN = 1;
export const KNOWLEDGE_LIMIT_MAX = 30;
export const KNOWLEDGE_LIMIT_DEFAULT = 20;
export const KNOWLEDGE_THREAD_PAGE_SIZE = 25;

/** killswitch（`DEVRELAY_KNOWLEDGE=0`）のときに全ルートが返す 404 文言（サーバーと同一文言）。 */
export const KNOWLEDGE_DISABLED_MESSAGE = 'Knowledge search is disabled (DEVRELAY_KNOWLEDGE=0)';
/** `mode=vector` で OpenAI キー未設定のときの 400 文言。 */
export const KNOWLEDGE_VECTOR_NO_KEY_MESSAGE = 'OpenAI API key not configured. Set it in WebUI Settings.';
/** スレッドが不可視・不存在のときの 404 文言（存在の有無を漏らさないための同一文言）。 */
export const KNOWLEDGE_THREAD_NOT_FOUND_MESSAGE = 'Thread not found or not visible';

/** `/knowledge` の URL に乗る状態（既定値は URL に出さない。D6）。 */
export interface KnowledgeUrlState {
  q: string;
  mode: KnowledgeMode;
  scope: KnowledgeScope;
  kind: KnowledgeKind;
  projectId: string | null;
  compartment: string | null;
  maxLevel: number | null;
  since: string | null;
  until: string | null;
  thread: string | null;
  anchor: string | null;
}

/** `KnowledgeUrlState` のうち検索条件を構成する軸（`thread`/`anchor` を除く）。 */
export const KNOWLEDGE_QUERY_AXES: ReadonlyArray<keyof KnowledgeUrlState> = [
  'q',
  'mode',
  'scope',
  'kind',
  'projectId',
  'compartment',
  'maxLevel',
  'since',
  'until',
];

/** URL キーの出力順（`serializeKnowledgeUrlState` が一貫した順序で返すための固定順）。 */
export const KNOWLEDGE_URL_KEYS: readonly string[] = [
  'q',
  'mode',
  'scope',
  'kind',
  'project',
  'compartment',
  'maxLevel',
  'since',
  'until',
  'thread',
  'anchor',
];

export function defaultKnowledgeUrlState(): KnowledgeUrlState {
  return {
    q: '',
    mode: 'hybrid',
    scope: 'all',
    kind: 'all',
    projectId: null,
    compartment: null,
    maxLevel: null,
    since: null,
    until: null,
    thread: null,
    anchor: null,
  };
}

export function isKnowledgeMode(v: unknown): v is KnowledgeMode {
  return v === 'hybrid' || v === 'keyword' || v === 'vector';
}

export function isKnowledgeScope(v: unknown): v is KnowledgeScope {
  return v === 'all' || v === 'mine';
}

export function isKnowledgeKind(v: unknown): v is KnowledgeKind {
  return v === 'all' || v === 'instruction' || v === 'question';
}

/** `''` は未指定（`null`）として扱う。`0` にしてしまう罠（`Number('')===0`）を踏まない。 */
export function parseMaxLevel(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined || raw.trim() === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < KNOWLEDGE_LEVEL_MIN || n > KNOWLEDGE_LEVEL_MAX) return null;
  return n;
}

/** `YYYY-MM-DD` 形式の日付のみを許容する（時刻は持たない）。不正なら `null`。 */
export function parseIsoDateOnly(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  if (Number.isNaN(Date.parse(trimmed))) return null;
  return trimmed;
}

function normalizeNonEmptyString(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * `URLSearchParams.get` 相当の getter から `KnowledgeUrlState` を組み立てる。
 * 不正な値（許可されない enum・範囲外の level・不正な日付）は例外を投げず既定値へ落とす
 * （fail-soft。ブックマークや共有 URL が将来の仕様変更で壊れても画面自体は壊れない）。
 */
export function parseKnowledgeUrlState(get: (key: string) => string | null | undefined): KnowledgeUrlState {
  const d = defaultKnowledgeUrlState();
  const modeRaw = get('mode');
  const scopeRaw = get('scope');
  const kindRaw = get('kind');
  return {
    q: get('q')?.slice(0, 500) ?? d.q,
    mode: isKnowledgeMode(modeRaw) ? modeRaw : d.mode,
    scope: isKnowledgeScope(scopeRaw) ? scopeRaw : d.scope,
    kind: isKnowledgeKind(kindRaw) ? kindRaw : d.kind,
    projectId: normalizeNonEmptyString(get('project')),
    compartment: normalizeNonEmptyString(get('compartment')),
    maxLevel: parseMaxLevel(get('maxLevel')),
    since: parseIsoDateOnly(get('since')),
    until: parseIsoDateOnly(get('until')),
    thread: normalizeNonEmptyString(get('thread')),
    anchor: normalizeNonEmptyString(get('anchor')),
  };
}

/**
 * `KnowledgeUrlState` を URL クエリのエントリ列へ変換する。既定値・`null`・空文字は出力しない
 * （D6: 既定値は URL に書かない）。`parseKnowledgeUrlState(get-from(serializeKnowledgeUrlState(s)))`
 * は `s` と深い等価になる（往復保証。単体テストで固定）。
 */
export function serializeKnowledgeUrlState(state: KnowledgeUrlState): Array<[string, string]> {
  const d = defaultKnowledgeUrlState();
  const out: Array<[string, string]> = [];
  if (state.q !== d.q && state.q.trim() !== '') out.push(['q', state.q]);
  if (state.mode !== d.mode) out.push(['mode', state.mode]);
  if (state.scope !== d.scope) out.push(['scope', state.scope]);
  if (state.kind !== d.kind) out.push(['kind', state.kind]);
  if (state.projectId) out.push(['project', state.projectId]);
  if (state.compartment) out.push(['compartment', state.compartment]);
  if (state.maxLevel !== null) out.push(['maxLevel', String(state.maxLevel)]);
  if (state.since) out.push(['since', state.since]);
  if (state.until) out.push(['until', state.until]);
  if (state.thread) out.push(['thread', state.thread]);
  if (state.anchor) out.push(['anchor', state.anchor]);
  return out;
}

export function knowledgeUrlStateEquals(a: KnowledgeUrlState, b: KnowledgeUrlState): boolean {
  return (
    a.q === b.q &&
    a.mode === b.mode &&
    a.scope === b.scope &&
    a.kind === b.kind &&
    a.projectId === b.projectId &&
    a.compartment === b.compartment &&
    a.maxLevel === b.maxLevel &&
    a.since === b.since &&
    a.until === b.until &&
    a.thread === b.thread &&
    a.anchor === b.anchor
  );
}

/**
 * `prev` に `patch` を適用した新しい状態を返す（非破壊）。
 * `KNOWLEDGE_QUERY_AXES` のいずれかが実際に値を変える場合は `thread`/`anchor` をクリアする
 * （フィルタを変えたら開いていたスレッドビューアは閉じる、という画面方針を 1 箇所に集約する）。
 * `thread`/`anchor` だけを変える patch（スレッドを開く/閉じる）では検索条件は一切変わらない。
 */
export function patchKnowledgeUrlState(
  prev: KnowledgeUrlState,
  patch: Partial<KnowledgeUrlState>
): KnowledgeUrlState {
  const next: KnowledgeUrlState = { ...prev, ...patch };
  const axisChanged = KNOWLEDGE_QUERY_AXES.some((key) => prev[key] !== next[key]);
  if (axisChanged && patch.thread === undefined && patch.anchor === undefined) {
    next.thread = null;
    next.anchor = null;
  }
  return next;
}

/** `q` が 1〜500 文字（trim 後）のときだけ検索可能とみなす。 */
export function isSearchable(state: KnowledgeUrlState): boolean {
  const trimmed = state.q.trim();
  return trimmed.length > 0 && trimmed.length <= 500;
}

/**
 * `GET /api/knowledge/search` へ渡すクエリエントリを構築する。
 * 空値（`''`）のペアを一切出さない（`maxLevel=''`→level 0 の罠・`limit=''`→400 の罠を
 * 構造的に封じる）。`limit` は常に `KNOWLEDGE_LIMIT_MIN`〜`KNOWLEDGE_LIMIT_MAX` にクランプして
 * 必ず出力する。
 */
export function buildKnowledgeSearchQuery(
  state: KnowledgeUrlState,
  limit: number = KNOWLEDGE_LIMIT_DEFAULT
): Array<[string, string]> {
  const clampedLimit = Math.min(KNOWLEDGE_LIMIT_MAX, Math.max(KNOWLEDGE_LIMIT_MIN, Math.trunc(limit)));
  const out: Array<[string, string]> = [['query', state.q.trim()]];
  if (state.mode !== 'hybrid') out.push(['mode', state.mode]);
  if (state.scope !== 'all') out.push(['scope', state.scope]);
  if (state.kind !== 'all') out.push(['kind', state.kind]);
  if (state.projectId) out.push(['projectId', state.projectId]);
  if (state.compartment) out.push(['compartment', state.compartment]);
  if (state.maxLevel !== null) out.push(['maxLevel', String(state.maxLevel)]);
  if (state.since) out.push(['since', state.since]);
  if (state.until) out.push(['until', state.until]);
  out.push(['limit', String(clampedLimit)]);
  return out;
}

// ---- ハイライト ----

export interface HighlightSegment {
  text: string;
  match: boolean;
}

/** 正規表現のメタ文字をリテラルとしてマッチさせるためにエスケープする。 */
export function escapeRegExpLiteral(source: string): string {
  return source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * `text` 中の `query` に一致する部分をハイライト用セグメントに分割する。
 * 大文字小文字を無視し、複数ヒットに対応し、`query` の正規表現メタ文字はリテラル扱いにする。
 * 一致が無い・`query` が空白のみの場合は `[{text, match:false}]` を返す。
 * `segments.map(s => s.text).join('') === text` が常に成り立つ（文字を落とさない）。
 */
export function buildHighlightSegments(text: string, query: string): HighlightSegment[] {
  const trimmedQuery = query.trim();
  if (trimmedQuery.length === 0 || text.length === 0) {
    return [{ text, match: false }];
  }

  const pattern = new RegExp(escapeRegExpLiteral(trimmedQuery), 'gi');
  const segments: HighlightSegment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ text: text.slice(lastIndex, match.index), match: false });
    }
    segments.push({ text: match[0], match: true });
    lastIndex = match.index + match[0].length;
    // 空マッチ（query が空文字のとき等）で無限ループしないためのガード。
    if (match[0].length === 0) pattern.lastIndex++;
  }
  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex), match: false });
  }
  return segments.length > 0 ? segments : [{ text, match: false }];
}

// ---- 機密度バッジ ----

/** 0=公開（組織内） / 1-3=低 / 4-6=中 / 7-10=高。範囲外はクランプする（throw しない）。 */
export function levelTone(level: number): LevelTone {
  const clamped = Math.max(KNOWLEDGE_LEVEL_MIN, Math.min(KNOWLEDGE_LEVEL_MAX, Math.trunc(level)));
  if (clamped === 0) return 'open';
  if (clamped <= 3) return 'low';
  if (clamped <= 6) return 'mid';
  return 'high';
}

// ---- coverage / viewer / owner 表示 ----

export interface CoverageLike {
  keyword: boolean;
  vector: boolean;
  vectorSkippedReason?: string | null;
}

export type CoverageDescriptionKind = 'both' | 'keywordOnly' | 'vectorOnly' | 'none';

export interface CoverageDescription {
  kind: CoverageDescriptionKind;
  /** `coverage.vector === false` のときだけ理由が入る（画面側で説明文に使う）。 */
  skippedReason: string | null;
}

/**
 * `coverage` から、画面に出す coverage 文言の種類を決める。
 * `mode` は呼び出し側の文脈情報として受け取るが判定には使わない（coverage の内容自体が
 * 実際に何を実行したかの最終的な真実のため）。将来 mode 依存の文言分岐が必要になった際の
 * 拡張点として引数は残す。
 */
export function describeCoverage(coverage: CoverageLike, mode: KnowledgeMode): CoverageDescription {
  void mode;
  if (coverage.keyword && coverage.vector) {
    return { kind: 'both', skippedReason: null };
  }
  if (coverage.keyword && !coverage.vector) {
    return { kind: 'keywordOnly', skippedReason: coverage.vectorSkippedReason ?? null };
  }
  if (!coverage.keyword && coverage.vector) {
    return { kind: 'vectorOnly', skippedReason: null };
  }
  return { kind: 'none', skippedReason: coverage.vectorSkippedReason ?? null };
}

export interface ViewerLike {
  readLevel: number;
  compartments: string[];
  organization: boolean;
}

export interface ViewerDescription {
  readLevel: number;
  tone: LevelTone;
  /** 重複除去済み。`'*'` が含まれる場合は先頭に来る。 */
  compartments: string[];
  hasWildcard: boolean;
  orgLess: boolean;
}

/** 自分の権限表示（検索レスポンスの `viewer`、または組織なし=`null`）を画面用に整形する。 */
export function describeViewer(viewer: ViewerLike | null | undefined): ViewerDescription {
  if (!viewer) {
    return { readLevel: 0, tone: 'open', compartments: [], hasWildcard: false, orgLess: true };
  }
  const unique = Array.from(new Set(viewer.compartments));
  const hasWildcard = unique.includes('*');
  const compartments = hasWildcard
    ? ['*', ...unique.filter((c) => c !== '*').sort()]
    : [...unique].sort();
  return {
    readLevel: viewer.readLevel,
    tone: levelTone(viewer.readLevel),
    compartments,
    hasWildcard,
    orgLess: !viewer.organization,
  };
}

export interface OwnerLike {
  isOwn: boolean;
  ownerName: string | null;
  ownerUserId: string;
}

/** `isOwn` なら「自分」扱い、他人は `ownerName`（無ければ `ownerUserId`）。 */
export function ownerLabel(r: OwnerLike): { isOwn: boolean; text: string } {
  if (r.isOwn) return { isOwn: true, text: '' };
  const name = r.ownerName?.trim();
  return { isOwn: false, text: name && name.length > 0 ? name : r.ownerUserId };
}

// ---- エラー文言判定（`request()` がステータスを捨てるため文言完全一致で判定する） ----

export function isKnowledgeDisabledError(message: string | null | undefined): boolean {
  return message === KNOWLEDGE_DISABLED_MESSAGE;
}

export function isVectorKeyMissingError(message: string | null | undefined): boolean {
  return message === KNOWLEDGE_VECTOR_NO_KEY_MESSAGE;
}

export function isThreadNotVisibleError(message: string | null | undefined): boolean {
  return message === KNOWLEDGE_THREAD_NOT_FOUND_MESSAGE;
}

// ---- スレッドページング ----

export type ThreadPageDirection = 'initial' | 'older' | 'newer' | 'anchor';

export interface ThreadPageRequest {
  limit: number;
  before?: string;
  after?: string;
}

/** ISO 文字列に `deltaMs` ミリ秒を加算した ISO 文字列を返す（`Date` は ES2022 lib に含まれる）。 */
export function shiftIsoMillis(iso: string, deltaMs: number): string {
  return new Date(new Date(iso).getTime() + deltaMs).toISOString();
}

/**
 * スレッドビューアの 1 回の取得リクエストを組み立てる。
 * - `initial`: 先頭から `pageSize` 件
 * - `anchor`: `anchorTimestamp` を含む直前 `pageSize` 件（サーバー側 `resolveThreadPageOrder` の
 *   `before`-only-desc 修正を前提に、ヒットが窓の末尾に来るよう `before = anchorTimestamp + 1ms`）。
 *   `anchorTimestamp` が無ければ `initial` にフォールバックする（コールド直リンクで発生する）
 * - `older`: `firstLoadedTimestamp` の直前 `pageSize` 件
 * - `newer`: `lastLoadedTimestamp` の直後 `pageSize` 件
 */
export function buildThreadPageRequest(input: {
  direction: ThreadPageDirection;
  anchorTimestamp?: string | null;
  firstLoadedTimestamp?: string | null;
  lastLoadedTimestamp?: string | null;
  pageSize?: number;
}): ThreadPageRequest {
  const limit = input.pageSize ?? KNOWLEDGE_THREAD_PAGE_SIZE;
  if (input.direction === 'anchor') {
    if (!input.anchorTimestamp) return { limit };
    return { limit, before: shiftIsoMillis(input.anchorTimestamp, 1) };
  }
  if (input.direction === 'older') {
    if (!input.firstLoadedTimestamp) return { limit };
    return { limit, before: input.firstLoadedTimestamp };
  }
  if (input.direction === 'newer') {
    if (!input.lastLoadedTimestamp) return { limit };
    return { limit, after: input.lastLoadedTimestamp };
  }
  return { limit };
}

interface TimestampedItem {
  id: string;
  timestamp: string;
}

/**
 * 既に読み込んだメッセージ配列へ新しいページを統合する。`id` で重複排除し、
 * `timestamp` 昇順（同値は `id` でタイブレーク）に並べ直す。入力配列は変更しない。
 */
export function mergeThreadMessages<T extends TimestampedItem>(loaded: readonly T[], page: readonly T[]): T[] {
  const byId = new Map<string, T>();
  for (const m of loaded) byId.set(m.id, m);
  for (const m of page) byId.set(m.id, m);
  return Array.from(byId.values()).sort((a, b) => {
    const diff = Date.parse(a.timestamp) - Date.parse(b.timestamp);
    if (diff !== 0) return diff;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export function deriveThreadCursors<T extends TimestampedItem>(
  msgs: readonly T[]
): { first: string | null; last: string | null } {
  if (msgs.length === 0) return { first: null, last: null };
  return { first: msgs[0].timestamp, last: msgs[msgs.length - 1].timestamp };
}
