/**
 * 高辻ナレッジ サイクル4: ナレッジ回答（RAG）パネルの純ロジック。
 *
 * 外部 import ゼロ・DOM 非依存（`knowledge-search-rules.ts` / `clearance-rules.ts` と同じ流儀。
 * `tsconfig.test.json` の `lib:["ES2022"]` には DOM が無いため、`localStorage`/`window` 等は
 * ここでは一切参照しない — I/O は呼び出し側（`KnowledgePage.tsx`）が行い、ここでは
 * 文字列 ⇄ 既定値のロジックだけを持つ）。
 */

// ============================================================
// Markdown トークナイザ（D11: 最小の安全レンダラ。生 HTML はテキストのまま）
// ============================================================

export type AnswerInlineSegment =
  | { kind: 'text'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'citation'; rank: number; raw: string };

export type AnswerBlock =
  | { kind: 'heading'; level: number; segments: AnswerInlineSegment[] }
  | { kind: 'bullet'; segments: AnswerInlineSegment[] }
  | { kind: 'paragraph'; segments: AnswerInlineSegment[] }
  | { kind: 'blank' };

const INLINE_PATTERN = /`([^`]+)`|\*\*([^*]+)\*\*|\[(\d+)\]/g;

/**
 * 1 行分のインライン装飾（`code`・`**bold**`・`[n]`）をセグメントに分割する。
 * マッチしない部分は常に `{ kind: 'text' }` として残す（生 HTML タグも含め、一切解釈せず
 * テキストとして扱う＝実行されない）。`segments.map(s => s.text ?? s.raw).join('') === line` が
 * 常に成り立つ（文字を落とさない）。
 */
function tokenizeInline(line: string): AnswerInlineSegment[] {
  const segments: AnswerInlineSegment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  INLINE_PATTERN.lastIndex = 0;
  while ((match = INLINE_PATTERN.exec(line)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ kind: 'text', text: line.slice(lastIndex, match.index) });
    }
    if (match[1] !== undefined) {
      segments.push({ kind: 'code', text: match[1] });
    } else if (match[2] !== undefined) {
      segments.push({ kind: 'bold', text: match[2] });
    } else if (match[3] !== undefined) {
      segments.push({ kind: 'citation', rank: Number(match[3]), raw: match[0] });
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < line.length) {
    segments.push({ kind: 'text', text: line.slice(lastIndex) });
  }
  return segments.length > 0 ? segments : [{ kind: 'text', text: line }];
}

/**
 * ナレッジ回答本文を最小限のブロック構造（見出し・箇条書き・段落・空行）にトークナイズする。
 * 見出し（`#`〜`######`）・箇条書き（`-`/`*`）・段落のみに対応し、他は全て段落として扱う
 * （コードブロック・テーブル等は非対応。D11「最小の安全レンダラ」）。
 */
export function tokenizeAnswerMarkdown(markdown: string): AnswerBlock[] {
  const lines = markdown.split('\n');
  const blocks: AnswerBlock[] = [];

  for (const line of lines) {
    if (line.trim().length === 0) {
      blocks.push({ kind: 'blank' });
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      blocks.push({ kind: 'heading', level: headingMatch[1].length, segments: tokenizeInline(headingMatch[2]) });
      continue;
    }

    const bulletMatch = line.match(/^[-*]\s+(.*)$/);
    if (bulletMatch) {
      blocks.push({ kind: 'bullet', segments: tokenizeInline(bulletMatch[1]) });
      continue;
    }

    blocks.push({ kind: 'paragraph', segments: tokenizeInline(line) });
  }

  return blocks;
}

// ============================================================
// ストリーミング状態のリデューサ
// ============================================================

export type AnswerStatus = 'idle' | 'loading' | 'streaming' | 'done' | 'error' | 'disabled';

/**
 * `KnowledgeAnswerDoneResult`（サーバー）の WebUI 側の写し。
 * サイクル4.5: `ref`（会話一意の番号。会話でないときは `rank` と同値）/`projectId`/`isOwn` を追加。
 */
export interface AnswerSource {
  rank: number;
  ref: number;
  sourceType: string;
  sessionId: string;
  aiMessageId: string;
  projectId: string;
  title: string | null;
  projectName: string;
  ownerName: string;
  isOwn: boolean;
  occurredAt: string;
  level: number;
  compartment: string | null;
}

export interface AnswerDoneData {
  answer: string;
  sources: AnswerSource[];
  model: string;
  provider: string;
  usage?: { input: number; output: number };
  context: { items: number; omitted: number; chars: number };
  elapsedMs: number;
  audited: boolean;
}

export interface AnswerState {
  status: AnswerStatus;
  /** 進行中（または最後に完了・失敗した）回答の ID。`null` は何も始まっていない。 */
  answerId: string | null;
  /** 画面に出す本文（streaming 中は delta の連結、done で確定版に置き換える）。 */
  text: string;
  sources: AnswerSource[];
  model: string | null;
  provider: string | null;
  usage: { input: number; output: number } | null;
  elapsedMs: number | null;
  audited: boolean;
  errorMessage: string | null;
}

/** `answerId` 未開始の初期状態。 */
export const IDLE_ANSWER_STATE: AnswerState = {
  status: 'idle',
  answerId: null,
  text: '',
  sources: [],
  model: null,
  provider: null,
  usage: null,
  elapsedMs: null,
  audited: false,
  errorMessage: null,
};

/** 新しい質問を送信した直後の状態（`answerId` だけ分かっている）。 */
export function startingAnswerState(answerId: string): AnswerState {
  return { ...IDLE_ANSWER_STATE, status: 'loading', answerId };
}

/** 回答機能が killswitch で無効、またはトグル OFF のときの状態。 */
export const DISABLED_ANSWER_STATE: AnswerState = { ...IDLE_ANSWER_STATE, status: 'disabled' };

/** `reduceAnswerStream` に渡すイベント。すべて `answerId` を持ち、状態側の `answerId` と比較して無視判定する。 */
export type AnswerStreamEvent =
  | { type: 'delta'; answerId: string; text: string }
  | { type: 'done'; answerId: string; data: AnswerDoneData }
  | { type: 'error'; answerId: string; message: string };

/**
 * ストリーミングイベントを状態に適用する。
 *
 * - `state.answerId` と `event.answerId` が不一致なら無視して現在の state をそのまま返す
 *   （新しい検索が始まり前の回答が破棄された後に届く遅延 delta/done/error を無視する。指示書 §3）
 * - `done`/`error` で確定した後に同じ `answerId` の `delta` が届いても、`status` が
 *   `done`/`error` なら無視する（確定後に追加のストリームが来ても上書きしない）
 */
export function reduceAnswerStream(state: AnswerState, event: AnswerStreamEvent): AnswerState {
  if (state.answerId !== event.answerId) {
    return state;
  }
  if (state.status === 'done' || state.status === 'error') {
    return state;
  }

  switch (event.type) {
    case 'delta':
      return { ...state, status: 'streaming', text: state.text + event.text };
    case 'done':
      return {
        ...state,
        status: 'done',
        text: event.data.answer,
        sources: event.data.sources,
        model: event.data.model,
        provider: event.data.provider,
        usage: event.data.usage ?? null,
        elapsedMs: event.data.elapsedMs,
        audited: event.data.audited,
        errorMessage: null,
      };
    case 'error':
      return { ...state, status: 'error', errorMessage: event.message };
    default:
      return state;
  }
}

// ============================================================
// 会話継続（サイクル4.5 D1〜D3）
// ============================================================

/** 会話 1 往復。`answer` は既存 `AnswerState`/`reduceAnswerStream` をそのまま再利用する。 */
export interface ConversationTurn {
  question: string;
  answer: AnswerState;
}

/** 会話全体の状態。`sources` は往復を通して蓄積された根拠リスト（`ref` 順・一意）。 */
export interface ConversationState {
  status: AnswerStatus;
  turns: ConversationTurn[];
  sources: AnswerSource[];
}

/** 会話未開始の初期状態。 */
export const IDLE_CONVERSATION: ConversationState = { status: 'idle', turns: [], sources: [] };

/** 回答機能が killswitch で無効、またはトグル OFF のときの状態。 */
export const DISABLED_CONVERSATION: ConversationState = { status: 'disabled', turns: [], sources: [] };

/** `reduceConversation` に渡すイベント。`ask` 以外は `AnswerStreamEvent` をそのまま使う（末尾ターンに適用）。 */
export type ConversationEvent = { type: 'ask'; answerId: string; question: string } | AnswerStreamEvent | { type: 'clear' };

/** `existing`/`incoming` を `ref` で統合する（重複は `incoming` を優先、`ref` 昇順で返す）。 */
function mergeAnswerSources(existing: readonly AnswerSource[], incoming: readonly AnswerSource[]): AnswerSource[] {
  const byRef = new Map<number, AnswerSource>();
  for (const s of existing) byRef.set(s.ref, s);
  for (const s of incoming) byRef.set(s.ref, s);
  return [...byRef.values()].sort((a, b) => a.ref - b.ref);
}

/**
 * 会話イベントを状態に適用する（D1）。
 *
 * - `ask`: 新しい往復を末尾に積む（質問文を記録し、回答は `startingAnswerState` で `loading` 開始）
 * - `delta`/`done`/`error`: 常に**末尾ターンにのみ**適用する（進行中なのは常に最後の往復だけ）。
 *   `answerId` 不一致、または末尾ターンが既に `done`/`error` で確定済みなら `reduceAnswerStream` が
 *   state をそのまま返すため、ここでも無視される（他の `turns` は不変のまま）
 * - `done`: 末尾ターンの回答が確定した根拠（`AnswerDoneData.sources`）を会話全体の `sources` に統合する
 *   （`mergeAnswerSources`。既出の `ref` は新しい方で上書き、未出の `ref` は追加）
 * - `clear`: `IDLE_CONVERSATION` に戻す（新しい検索・フィルタ変更・トグル OFF・「会話をクリア」で呼ぶ）
 */
export function reduceConversation(state: ConversationState, event: ConversationEvent): ConversationState {
  if (event.type === 'clear') {
    return IDLE_CONVERSATION;
  }

  if (event.type === 'ask') {
    const turn: ConversationTurn = { question: event.question, answer: startingAnswerState(event.answerId) };
    return { status: 'loading', turns: [...state.turns, turn], sources: state.sources };
  }

  const lastIndex = state.turns.length - 1;
  if (lastIndex < 0) return state;
  const lastTurn = state.turns[lastIndex];
  const nextAnswer = reduceAnswerStream(lastTurn.answer, event);
  if (nextAnswer === lastTurn.answer) {
    // answerId 不一致、または既に done/error で確定済み（`reduceAnswerStream` が無視した）。
    return state;
  }

  const nextTurns = [...state.turns];
  nextTurns[lastIndex] = { ...lastTurn, answer: nextAnswer };
  const nextSources = event.type === 'done' ? mergeAnswerSources(state.sources, nextAnswer.sources) : state.sources;

  return { status: nextAnswer.status, turns: nextTurns, sources: nextSources };
}

/** `POST /api/knowledge/answer` に渡す「追い質問」部分（`history`/`knownSources`/`previousQuestion`）。 */
export interface FollowUpRequestParts {
  history: { question: string; answer: string }[];
  knownSources: { sourceType: string; sourceId: string; sessionId: string; ref: number }[];
  previousQuestion: string;
}

/**
 * 会話状態から追い質問のリクエスト部分を組み立てる（D2/D3）。`history` は確定済み（`done`）の往復のみ
 * （進行中・失敗した往復は含めない）。`knownSources` は会話で蓄積済みの根拠リストをそのまま渡す
 * （サーバー側の `normalizeHistory`/`normalizeKnownSources` が件数・文字数を最終的に切り詰める）。
 * `question`（これから送る新しい質問）自体は呼び出し側が別途 `question` フィールドで渡す。
 */
export function buildFollowUpRequest(conversation: ConversationState, question: string): FollowUpRequestParts {
  void question;
  const doneTurns = conversation.turns.filter((t) => t.answer.status === 'done');
  const history = doneTurns.map((t) => ({ question: t.question, answer: t.answer.text }));
  const knownSources = conversation.sources.map((s) => ({
    sourceType: s.sourceType,
    sourceId: s.aiMessageId,
    sessionId: s.sessionId,
    ref: s.ref,
  }));
  const previousQuestion = doneTurns.length > 0 ? doneTurns[doneTurns.length - 1].question : '';
  return { history, knownSources, previousQuestion };
}

/** `resolveCitationTarget` が参照するカード 1 件（検索結果 `results` から渡す）。 */
export interface CitationCardResult {
  sessionId: string;
  aiMessageId: string;
  occurredAt: string;
  rank: number;
}

/** `resolveCitationTarget` の結果。`card` はカードへスクロール、`viewer` はスレッドビューアへ直行する。 */
export type CitationTarget =
  | { kind: 'card'; sessionId: string; aiMessageId: string; occurredAt: string; rank: number }
  | { kind: 'viewer'; sessionId: string; aiMessageId: string; occurredAt: string };

/**
 * 回答本文の `[n]` クリック先を決める。会話の根拠リストから `ref` に対応するソースを引き、
 * その `(sessionId, aiMessageId)` と同じカードが検索結果に存在すればそのカード、無ければ
 * （会話で新たに増えた根拠はカード一覧には無い）スレッドビューア直行とする。
 * `ref` に対応するソースが見つからない場合（無効な引用番号）は `null`。
 */
export function resolveCitationTarget(
  conversationSources: readonly AnswerSource[],
  cardResults: readonly CitationCardResult[],
  ref: number
): CitationTarget | null {
  const source = conversationSources.find((s) => s.ref === ref);
  if (!source) return null;

  const card = cardResults.find((c) => c.sessionId === source.sessionId && c.aiMessageId === source.aiMessageId);
  if (card) {
    return { kind: 'card', sessionId: card.sessionId, aiMessageId: card.aiMessageId, occurredAt: card.occurredAt, rank: card.rank };
  }
  return { kind: 'viewer', sessionId: source.sessionId, aiMessageId: source.aiMessageId, occurredAt: source.occurredAt };
}

// ============================================================
// 「AI 回答」トグルの既定値ロジック（I/O は呼び出し側）
// ============================================================

/** 既定 ON（指示書 D1）。 */
export const ANSWER_TOGGLE_DEFAULT = true;

/** localStorage から読んだ生値（文字列 or null）をトグルの真偽値に変換する。不正値は既定値。 */
export function parseAnswerToggleValue(raw: string | null | undefined): boolean {
  if (raw === '0') return false;
  if (raw === '1') return true;
  return ANSWER_TOGGLE_DEFAULT;
}

/** トグルの真偽値を localStorage へ書き込む文字列に変換する。 */
export function serializeAnswerToggleValue(value: boolean): string {
  return value ? '1' : '0';
}

// ============================================================
// エラー文言判定（`request()` がステータスを捨てるため文言完全一致で判定する。
// `knowledge-search-rules.ts` の `isKnowledgeDisabledError` と同じ流儀）
// ============================================================

export const KNOWLEDGE_ANSWER_DISABLED_MESSAGE = 'Knowledge answer is disabled (DEVRELAY_KNOWLEDGE_ANSWER=0)';
export const KNOWLEDGE_ANSWER_KEY_MISSING_MESSAGE = 'Knowledge answer API key not configured (DEVRELAY_ANSWER_API_KEY).';

export function isKnowledgeAnswerDisabledError(message: string | null | undefined): boolean {
  return message === KNOWLEDGE_ANSWER_DISABLED_MESSAGE;
}

export function isKnowledgeAnswerKeyMissingError(message: string | null | undefined): boolean {
  return message === KNOWLEDGE_ANSWER_KEY_MISSING_MESSAGE;
}

// ============================================================
// リクエストボディの組み立て（検索と同じクエリ・同じフィルタ、D1）
// ============================================================

/** `buildKnowledgeSearchQuery` が返すエントリ配列から `POST /api/knowledge/answer` のボディを作る。 */
export interface AnswerRequestFilters {
  mode?: string;
  scope?: string;
  projectId?: string;
  kind?: string;
  compartment?: string;
  maxLevel?: number;
  since?: string;
  until?: string;
  limit?: number;
}

/**
 * 検索クエリエントリ（`[key, value][]`）から回答リクエストのフィルタ部分を取り出す。
 * `query`（検索語）は `question` として別途渡すため、ここでは除外する。
 * `limit`/`maxLevel` は数値に変換する。
 */
export function buildAnswerRequestFilters(queryEntries: ReadonlyArray<[string, string]>): AnswerRequestFilters {
  const filters: AnswerRequestFilters = {};
  for (const [key, value] of queryEntries) {
    switch (key) {
      case 'mode':
        filters.mode = value;
        break;
      case 'scope':
        filters.scope = value;
        break;
      case 'projectId':
        filters.projectId = value;
        break;
      case 'kind':
        filters.kind = value;
        break;
      case 'compartment':
        filters.compartment = value;
        break;
      case 'maxLevel':
        filters.maxLevel = Number(value);
        break;
      case 'since':
        filters.since = value;
        break;
      case 'until':
        filters.until = value;
        break;
      case 'limit':
        filters.limit = Number(value);
        break;
      default:
        break;
    }
  }
  return filters;
}
