/**
 * 高辻ナレッジ サイクル4: ナレッジ回答（RAG）の純ロジック。
 *
 * 外部 import ゼロの純関数のみで構成する（`raw-completion-guard.ts` / `knowledge-access.ts` と
 * 同じ流儀）。状態（`AnswerGuardState`）は呼び出し側（`routes/knowledge-api.ts`）がモジュールスコープの
 * シングルトンとして 1 個だけ保持し、本ファイルの関数へ毎回渡す（`state` を内部に隠し持たない）。
 * `nowMs` は必ず引数で注入する（テストの決定性のため）。
 *
 * D3（ユーザー承認の最終決定。指示書 D3 の「個人キー優先」は取り下げ）: 鍵は
 * `DEVRELAY_ANSWER_API_KEY` 専用・共有のみ。個人の Chat AI キーにも `OPENAI_API_KEY` にも
 * フォールバックしない（費用をキー単位で用途別に分けるため）。provider は常に 'openai' 固定。
 */

// ============================================================
// キルスイッチ（D10）
// ============================================================

/** `DEVRELAY_KNOWLEDGE_ANSWER` 環境変数を解釈する。既定 ON（'0' が明示されたときのみ無効）。 */
export function isKnowledgeAnswerEnabled(raw: string | undefined): boolean {
  return raw !== '0';
}

// ============================================================
// 会話継続（サイクル4.5 D1〜D5）
// ============================================================

/** 会話の 1 往復（直前の質問と、それに対する確定済み回答）。 */
export interface AnswerHistoryTurn {
  question: string;
  answer: string;
}

/** `normalizeHistory` が保持する往復数の上限（D4）。 */
export const ANSWER_HISTORY_MAX_TURNS = 6;
/** `normalizeHistory` が各質問に許す文字数上限（D4、行境界打ち切り）。 */
export const ANSWER_HISTORY_QUESTION_CHARS = 1000;
/** `normalizeHistory` が各回答に許す文字数上限（D4、行境界打ち切り）。 */
export const ANSWER_HISTORY_ANSWER_CHARS = 1500;

/**
 * クライアント申告の `history` を検証・正規化する（D4）。不正な要素（文字列でない
 * question/answer を持つ等）は黒く捨てる。直近 `ANSWER_HISTORY_MAX_TURNS` 往復のみ残し
 * （古いものを先頭から捨てる）、各質問・各回答を行境界で打ち切る。
 */
export function normalizeHistory(raw: unknown): AnswerHistoryTurn[] {
  if (!Array.isArray(raw)) return [];

  const valid: AnswerHistoryTurn[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const question = (entry as Record<string, unknown>).question;
    const answer = (entry as Record<string, unknown>).answer;
    if (typeof question !== 'string' || typeof answer !== 'string') continue;
    const trimmedQuestion = question.trim();
    const trimmedAnswer = answer.trim();
    if (trimmedQuestion.length === 0 || trimmedAnswer.length === 0) continue;
    valid.push({
      question: truncateToLineBoundary(trimmedQuestion, ANSWER_HISTORY_QUESTION_CHARS),
      answer: truncateToLineBoundary(trimmedAnswer, ANSWER_HISTORY_ANSWER_CHARS),
    });
  }

  return valid.length > ANSWER_HISTORY_MAX_TURNS ? valid.slice(valid.length - ANSWER_HISTORY_MAX_TURNS) : valid;
}

/**
 * 追い質問の検索クエリ（D2）: 「直前の質問 ＋ 今回の質問」を連結する。短い追い質問
 * （「それはいつ？」等）でも前の質問の語が検索に残るようにする。`previousQuestion` が
 * 無ければ `question` のみ。500 文字で切る（`searchKnowledge` 側の `QUERY_MAX_LENGTH` と同じ上限）。
 */
export function buildConversationSearchQuery(input: { previousQuestion?: string; question: string }): string {
  const previous = input.previousQuestion?.trim();
  const combined = previous ? `${previous} ${input.question}` : input.question;
  return combined.slice(0, 500);
}

/** 会話で既に番号を振った根拠 1 件（クライアントから渡される）。 */
export interface KnownSourceRef {
  sourceType: string;
  sourceId: string;
  sessionId: string;
  ref: number;
}

/** `normalizeKnownSources` が保持する `knownSources` 件数の上限（安全弁。D4 の 6 往復 ×上位 12 件より十分広い）。 */
export const ANSWER_KNOWN_SOURCES_MAX = 60;

/**
 * クライアント申告の `knownSources` を検証・正規化する。不正な要素（文字列でない
 * sourceType/sourceId/sessionId、数値でない ref 等）は捨てる。`sourceId` 重複は先に出てきた方を残す。
 * `ANSWER_KNOWN_SOURCES_MAX` を超える分は末尾を切る（安全弁。実運用では history 6 往復・1 往復あたり
 * 上位 12 件の累積で自然に収まる想定）。
 */
export function normalizeKnownSources(raw: unknown): KnownSourceRef[] {
  if (!Array.isArray(raw)) return [];

  const seen = new Set<string>();
  const valid: KnownSourceRef[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.sourceType !== 'string' || typeof e.sourceId !== 'string' || typeof e.sessionId !== 'string' || typeof e.ref !== 'number') {
      continue;
    }
    if (!Number.isFinite(e.ref) || e.ref <= 0) continue;
    if (seen.has(e.sourceId)) continue;
    seen.add(e.sourceId);
    valid.push({ sourceType: e.sourceType, sourceId: e.sourceId, sessionId: e.sessionId, ref: e.ref });
    if (valid.length >= ANSWER_KNOWN_SOURCES_MAX) break;
  }

  return valid;
}

/** `mergeConversationSources` が返す統合済み 1 件。`origin` は番号付け直しの判定に使う。 */
export interface MergedSourceRef extends KnownSourceRef {
  origin: 'known' | 'new';
}

/** `mergeConversationSources` の入力。 */
export interface MergeConversationSourcesInput {
  /** 会話で既に番号を振った根拠（クライアント申告）。 */
  known: readonly KnownSourceRef[];
  /** 今回の検索でヒットした新しい根拠（カード順位を維持した配列）。 */
  newHits: readonly { sourceType: string; sourceId: string; sessionId: string }[];
  /** 再取得・可視判定し直した結果、実際に見える `sourceId` の集合（`known` ∪ `newHits` 両方の判定に使う）。 */
  visibleSourceIds: readonly string[];
}

/** `mergeConversationSources` の結果。 */
export interface MergeConversationSourcesResult {
  items: MergedSourceRef[];
  added: number;
  droppedInvisible: number;
}

/**
 * 会話の根拠リストを統合する（D3）。既知（`known`）は番号をそのまま維持して先頭に並べ、
 * 新ヒット（`newHits`）のうち既出でないものを `max(ref)+1` から続き番号で追加する。
 * 既出判定は `(sourceType, sourceId)` の組（会話を跨いで同じ発言が異なる `sessionId` を
 * 持つことは無いが、念のため両方見る必要はない＝`sourceId` はグローバルに一意）。
 * `visibleSourceIds` に無い既知は結果から落とす（番号は欠番になる＝再利用しない）。
 */
export function mergeConversationSources(input: MergeConversationSourcesInput): MergeConversationSourcesResult {
  const visible = new Set(input.visibleSourceIds);
  const seenSourceIds = new Set<string>();
  const items: MergedSourceRef[] = [];
  let droppedInvisible = 0;

  for (const k of input.known) {
    if (!visible.has(k.sourceId)) {
      droppedInvisible++;
      continue;
    }
    if (seenSourceIds.has(k.sourceId)) continue;
    seenSourceIds.add(k.sourceId);
    items.push({ ...k, origin: 'known' });
  }

  // 続き番号は「実際に残った既知」ではなく「クライアント申告の known 全体」の最大 ref から
  // 算出する（不可視で落ちた既知の番号を、同じ呼び出しの新ヒットに再利用しないため）。
  let nextRef = input.known.reduce((max, k) => Math.max(max, k.ref), 0) + 1;
  let added = 0;
  for (const hit of input.newHits) {
    if (!visible.has(hit.sourceId)) continue;
    if (seenSourceIds.has(hit.sourceId)) continue;
    seenSourceIds.add(hit.sourceId);
    items.push({ ...hit, ref: nextRef, origin: 'new' });
    nextRef++;
    added++;
  }

  return { items, added, droppedInvisible };
}

/**
 * 正規化済み `history` の各回答本文から、実際に引用された `[n]` の集合を抽出する
 * （D3-b: クライアント申告に頼らず、サーバー側で再導出する）。
 */
export function extractCitedRefs(answers: readonly string[]): Set<number> {
  const cited = new Set<number>();
  for (const answer of answers) {
    const matches = answer.matchAll(/\[(\d+)\]/g);
    for (const m of matches) {
      cited.add(Number(m[1]));
    }
  }
  return cited;
}

/** `evictForBudget` が受け取る 1 件（`buildKnowledgeContext` に渡す前の予算判定用エントリ）。 */
export interface BudgetEntry {
  ref: number;
  origin: 'known' | 'new';
  /** `buildKnowledgeContext` に渡す前の見積り文字数（実際の打ち切りは `buildKnowledgeContext` 側）。 */
  chars: number;
  /** 会話の過去の回答で実際に引用されたか（`extractCitedRefs` の結果から判定）。 */
  cited: boolean;
}

/** `evictForBudget` の結果。 */
export interface EvictForBudgetResult {
  keptRefs: number[];
  droppedRefs: number[];
}

/**
 * 合計文字数予算を超える場合に落とす対象を選ぶ（D3）。優先順位（落とす側から):
 * 1. 未引用の既知（`origin==='known' && !cited`）
 * 2. 新ヒットの下位（`origin==='new'`、`ref` の大きい方＝順位の低い方から）
 * 3. 引用済みの既知（`origin==='known' && cited`、最後まで残す）
 * 同じ優先度内では配列の末尾側から落とす。合計が予算内に収まるまで落とし続ける。
 */
export function evictForBudget(entries: readonly BudgetEntry[], totalChars: number): EvictForBudgetResult {
  const byRef = new Map(entries.map((e) => [e.ref, e]));
  let remaining = entries.reduce((sum, e) => sum + e.chars, 0);
  const dropped = new Set<number>();

  const tierUnkownKnown = entries.filter((e) => e.origin === 'known' && !e.cited);
  const tierNewLowToHigh = [...entries.filter((e) => e.origin === 'new')].sort((a, b) => b.ref - a.ref);
  const tierCitedKnown = entries.filter((e) => e.origin === 'known' && e.cited);

  for (const tier of [tierUnkownKnown, tierNewLowToHigh, tierCitedKnown]) {
    for (const entry of tier) {
      if (remaining <= totalChars) break;
      dropped.add(entry.ref);
      remaining -= entry.chars;
    }
    if (remaining <= totalChars) break;
  }

  const keptRefs = entries.map((e) => e.ref).filter((ref) => !dropped.has(ref));
  const droppedRefs = [...dropped].filter((ref) => byRef.has(ref));
  return { keptRefs, droppedRefs };
}

// ============================================================
// context 構築（D2）
// ============================================================

/** AI に渡す context 1 件（D7: ソース非依存の契約）。`rank` はカード番号＝引用番号 [n]。 */
export interface KnowledgeContextItem {
  rank: number;
  sourceType: string;
  sessionId: string;
  aiMessageId: string;
  /** サイクル4.5: `KnowledgeAnswerSource`/MCP `ask_knowledge` の戻り値に必要（D6）。 */
  projectId: string;
  title: string | null;
  projectName: string;
  ownerUserId: string;
  ownerName: string;
  isOwn: boolean;
  occurredAt: string;
  level: number;
  compartment: string | null;
  /** 同一ターンの複数チャンクを連結した全文（打ち切り前）。呼び出し側で連結してから渡す。 */
  text: string;
}

/** `buildKnowledgeContext` のオプション（D2: 1 件 1,500 文字・合計 18,000 文字）。 */
export interface BuildKnowledgeContextOptions {
  perItemChars: number;
  totalChars: number;
}

/** `buildKnowledgeContext` の結果。 */
export interface BuildKnowledgeContextResult {
  items: KnowledgeContextItem[];
  omitted: number;
  chars: number;
}

/**
 * `maxChars` を超える場合、行境界（直前の改行）まで切り詰める。改行が見つからない場合は
 * 単純に `maxChars` でハードカットする。`maxChars <= 0` は空文字を返す。
 */
function truncateToLineBoundary(text: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  if (text.length <= maxChars) return text;
  const sliced = text.slice(0, maxChars);
  const lastNewline = sliced.lastIndexOf('\n');
  return lastNewline > 0 ? sliced.slice(0, lastNewline) : sliced;
}

/**
 * カード順位（配列順）を維持したまま、1 件あたり `perItemChars`・合計 `totalChars` で
 * 行境界打ち切りする（D2）。合計予算は先頭から消費するため、打ち切り対象（`omitted`）は
 * 常に末尾側の連続区間になる＝残った項目の `rank` 番号に欠番は生じない。
 */
export function buildKnowledgeContext(
  items: readonly KnowledgeContextItem[],
  opts: BuildKnowledgeContextOptions
): BuildKnowledgeContextResult {
  const out: KnowledgeContextItem[] = [];
  let chars = 0;
  let omitted = 0;

  for (const item of items) {
    const remaining = opts.totalChars - chars;
    if (remaining <= 0) {
      omitted++;
      continue;
    }
    const perItemLimit = Math.min(opts.perItemChars, remaining);
    const truncated = truncateToLineBoundary(item.text, perItemLimit);
    if (truncated.length === 0) {
      omitted++;
      continue;
    }
    out.push({ ...item, text: truncated });
    chars += truncated.length;
  }

  return { items: out, omitted, chars };
}

// ============================================================
// プロンプト構築（D5）
// ============================================================

const SYSTEM_PROMPT_JA = `あなたは社内のナレッジ検索アシスタントです。
以下に渡された抜粋だけを根拠にして、質問に答えてください。

## ルール
- 渡された抜粋に書かれていないことは絶対に推測しない。抜粋に答えが無い場合は「見つかりませんでした」と明言する
- 根拠にした主張の直後に、その抜粋の番号を [n] の形式で付ける（例: 「Nim に変更された[2]」）
- 存在しない番号を作らない（[n] は必ず渡された抜粋の番号と一致させる）
- 経緯・決定・問題点・未解決事項のように整理が必要な質問には、見出し（##）を使って整理して答える
- それ以外の単純な質問には、簡潔な文章で答える`;

const SYSTEM_PROMPT_EN = `You are an internal knowledge search assistant.
Answer the question using ONLY the excerpts provided below.

## Rules
- Never guess beyond what is written in the excerpts. If the answer isn't in the excerpts, say so explicitly ("Not found.")
- Immediately after each claim you make, cite the excerpt number in [n] form (e.g. "switched to Nim[2]")
- Never invent a number — every [n] must match a number from the excerpts provided
- For questions that need structure (history, decisions, issues, open items), organize the answer with headings (##)
- For simple questions, answer in plain prose`;

/**
 * サイクル4.5 D5: `history` があるときだけ system プロンプトに追加する 1 段落（会話の続きであることと、
 * 既出の根拠にも同じ番号を使うことを明示する）。
 */
const CONVERSATION_SUFFIX_JA =
  '\n\nこれは会話の続きです。これまでの質問と回答（history）を踏まえて答えてください。' +
  '[n] は根拠リストの番号です。以前の回答で使った根拠と同じものを引用するときは、必ず同じ番号を使ってください。';
const CONVERSATION_SUFFIX_EN =
  "\n\nThis is a continuation of a conversation. Answer taking the previous questions and answers (history) into account. " +
  '[n] refers to the numbered source list. When citing a source you already cited in a previous answer, reuse the same number.';

/** `buildKnowledgePrompt` の入力。 */
export interface BuildKnowledgePromptInput {
  language: 'ja' | 'en';
  question: string;
  /** 既に `buildKnowledgeContext` で打ち切り済みの context（カード順位維持）。 */
  items: readonly KnowledgeContextItem[];
  /** サイクル4.5: 直近の会話（D4 で正規化済み）。省略時はサイクル4 と完全同一の出力になる。 */
  history?: readonly AnswerHistoryTurn[];
}

/** `buildKnowledgePrompt` の結果。 */
export interface BuildKnowledgePromptResult {
  system: string;
  user: string;
  /** サイクル4.5: `history` を user/assistant ペアに展開し、末尾に今回の `user` を積んだもの。
   * `ChatParams.messages` にそのまま渡せる（`history` 無しなら `[{role:'user', content: user}]` の 1 件）。 */
  messages: { role: 'user' | 'assistant'; content: string }[];
}

/**
 * D5 の固定システムプロンプト（ja/en）＋ 抜粋を番号付きで並べた user プロンプトを組み立てる。
 * `history` は分岐の外（system 段落・messages 構成）で扱う — `items` が空のときの早期 return
 * （`user === question` のみを返す、既存テストでバイト一致固定）には一切影響しない。
 */
export function buildKnowledgePrompt(input: BuildKnowledgePromptInput): BuildKnowledgePromptResult {
  const baseSystem = input.language === 'en' ? SYSTEM_PROMPT_EN : SYSTEM_PROMPT_JA;
  const history = input.history ?? [];
  const system = history.length > 0 ? baseSystem + (input.language === 'en' ? CONVERSATION_SUFFIX_EN : CONVERSATION_SUFFIX_JA) : baseSystem;

  let user: string;
  if (input.items.length === 0) {
    user = input.question;
  } else {
    const excerptLines: string[] = [];
    for (const item of input.items) {
      excerptLines.push(`[${item.rank}] ${item.title ?? '(no title)'} / ${item.projectName} / ${item.ownerName} / ${item.occurredAt}`);
      excerptLines.push(item.text);
      excerptLines.push('');
    }
    user = `${input.question}\n\n--- excerpts ---\n${excerptLines.join('\n')}`;
  }

  const messages: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const turn of history) {
    messages.push({ role: 'user', content: turn.question });
    messages.push({ role: 'assistant', content: turn.answer });
  }
  messages.push({ role: 'user', content: user });

  return { system, user, messages };
}

/** context が 1 件も無い（検索結果 0 件）ときに返す固定回答（AI 呼び出し自体を省略する）。 */
const NO_CONTEXT_ANSWER_JA = '見つかりませんでした。関連する会話がナレッジ検索にヒットしませんでした。';
const NO_CONTEXT_ANSWER_EN = 'Not found. No related conversation was found in the knowledge search.';

export function buildEmptyContextAnswer(language: 'ja' | 'en'): string {
  return language === 'en' ? NO_CONTEXT_ANSWER_EN : NO_CONTEXT_ANSWER_JA;
}

// ============================================================
// 引用のサニタイズ（D6）
// ============================================================

/** `sanitizeCitations` の結果。`cited` は本文中に実際に残った有効な [n]（初出順・重複除去）。 */
export interface SanitizeCitationsResult {
  answer: string;
  cited: number[];
}

/**
 * 本文中の `[n]` のうち、`validRefs` に無い番号を除去する（D6）。有効な番号はそのまま残す
 * （`[1][2]` のような連続表記・同じ番号の複数回引用も妥当な表記としてそのまま許容する）。
 * 無効参照の除去で生じた連続空白は 1 つに畳む。
 */
export function sanitizeCitations(answer: string, validRefs: readonly number[]): SanitizeCitationsResult {
  const validSet = new Set(validRefs);
  const seen = new Set<number>();
  const cited: number[] = [];

  const sanitized = answer.replace(/\[(\d+)\]/g, (match, numStr: string) => {
    const n = Number(numStr);
    if (!validSet.has(n)) return '';
    if (!seen.has(n)) {
      seen.add(n);
      cited.push(n);
    }
    return match;
  });

  return { answer: sanitized.replace(/[ \t]{2,}/g, ' ').trimEnd(), cited };
}

// ============================================================
// 入力検証（D9）
// ============================================================

/** 質問文字数の上限（D9: 1〜1,000 文字）。 */
export const ANSWER_QUESTION_MAX_LENGTH = 1000;

/** `normalizeQuestion` の戻り値。 */
export type NormalizeQuestionResult = { ok: true; value: string } | { ok: false; error: string };

/** 質問文を検証・正規化する（trim 後 1〜1,000 文字）。 */
export function normalizeQuestion(raw: unknown): NormalizeQuestionResult {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (trimmed.length === 0) {
    return { ok: false, error: 'question is required' };
  }
  if (trimmed.length > ANSWER_QUESTION_MAX_LENGTH) {
    return { ok: false, error: `question must be ${ANSWER_QUESTION_MAX_LENGTH} characters or fewer` };
  }
  return { ok: true, value: trimmed };
}

/** `answerId` として許容する文字種（UUID 等を素通しする緩めのパターン）。 */
const ANSWER_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * クライアント生成の `answerId` を検証する。不正・未指定の場合は `fallback`（呼び出し側が
 * `crypto.randomUUID()` 等で生成した値）を使う（本ファイルは `crypto` を import しないため、
 * 呼び出し側で生成して渡すこと）。
 */
export function normalizeAnswerId(raw: unknown, fallback: string): string {
  return typeof raw === 'string' && ANSWER_ID_PATTERN.test(raw) ? raw : fallback;
}

// ============================================================
// 鍵解決（D3、ユーザー承認の最終決定）
// ============================================================

/** `DEVRELAY_ANSWER_MODEL` 未設定時の既定モデル。 */
export const DEFAULT_ANSWER_MODEL = 'gpt-4o-mini';

/**
 * 鍵未設定時にクライアントへそのまま返す固定文言（英語。既存 `KNOWLEDGE_VECTOR_NO_KEY_MESSAGE` と
 * 同じ流儀 — サーバーは固定の英語文言を返し、WebUI 側が文言完全一致で判定して i18n 表示する）。
 */
export const ANSWER_KEY_MISSING_MESSAGE = 'Knowledge answer API key not configured (DEVRELAY_ANSWER_API_KEY).';

/** `resolveAnswerKey` の戻り値。 */
export type ResolveAnswerKeyResult =
  | { ok: true; provider: 'openai'; apiKey: string; model: string }
  | { ok: false; error: string };

/**
 * ナレッジ回答生成用の鍵を解決する。
 *
 * ユーザー承認の最終決定（指示書 D3 の「個人キー優先」は取り下げ）: `DEVRELAY_ANSWER_API_KEY`
 * 専用・共有のみを使う。個人の Chat AI キーにも汎用 `OPENAI_API_KEY` にもフォールバックしない
 * （費用をキー単位で用途別に分けて見るため）。provider は常に `'openai'` 固定。
 * 未設定なら `{ ok: false }`（呼び出し側はこの `error` をそのまま `sink.error()` に渡す）。
 */
export function resolveAnswerKey(input: {
  envAnswerKey: string | undefined;
  envModel: string | undefined;
}): ResolveAnswerKeyResult {
  const apiKey = input.envAnswerKey;
  if (!apiKey || apiKey.length === 0) {
    return { ok: false, error: ANSWER_KEY_MISSING_MESSAGE };
  }
  const model = input.envModel && input.envModel.length > 0 ? input.envModel : DEFAULT_ANSWER_MODEL;
  return { ok: true, provider: 'openai', apiKey, model };
}

// ============================================================
// 流量制御・同時実行制御（D9）
// ============================================================

/** レート制限のスライディング窓（1 分）。 */
export const ANSWER_MINUTE_WINDOW_MS = 60 * 1000;
/** レート制限のスライディング窓（1 日）。 */
export const ANSWER_DAY_WINDOW_MS = 24 * 60 * 60 * 1000;
/** ユーザーあたりの 1 分間レート上限（D9: 5 回/分）。 */
export const ANSWER_MINUTE_RATE_LIMIT = 5;
/** ユーザーあたりの 1 日レート上限（D9: 100 回/日）。 */
export const ANSWER_DAY_RATE_LIMIT = 100;
/**
 * 占有スロットを強制解放するまでの経過時間（ミリ秒）。生成タイムアウト（60 秒、D4）+ 30 秒の余裕。
 * `raw-completion-guard.ts` の `RAW_SLOT_STALE_MS` と同じ考え方（`finally` を経由しない異常終了の保険）。
 */
export const ANSWER_SLOT_STALE_MS = 90 * 1000;

/** 流量制御の状態。key はいずれも `userId`（D9 は座席の概念を持たず、ユーザー単位のみ）。 */
export interface AnswerGuardState {
  slots: Map<string, { answerId: string; startedAt: number }>;
  minuteHits: Map<string, number[]>;
  dayHits: Map<string, number[]>;
}

/** 空の `AnswerGuardState` を作る（呼び出し側がモジュールスコープで 1 個だけ保持する）。 */
export function createAnswerGuardState(): AnswerGuardState {
  return { slots: new Map(), minuteHits: new Map(), dayHits: new Map() };
}

/** stale な占有スロットと、窓外に出たレート集計エントリを掃除する。 */
export function pruneAnswerGuardState(state: AnswerGuardState, nowMs: number): void {
  for (const [key, occupant] of state.slots) {
    if (nowMs - occupant.startedAt > ANSWER_SLOT_STALE_MS) {
      state.slots.delete(key);
    }
  }

  const minuteCutoff = nowMs - ANSWER_MINUTE_WINDOW_MS;
  for (const [key, hits] of state.minuteHits) {
    const kept = hits.filter((t) => t >= minuteCutoff);
    if (kept.length > 0) state.minuteHits.set(key, kept);
    else state.minuteHits.delete(key);
  }

  const dayCutoff = nowMs - ANSWER_DAY_WINDOW_MS;
  for (const [key, hits] of state.dayHits) {
    const kept = hits.filter((t) => t >= dayCutoff);
    if (kept.length > 0) state.dayHits.set(key, kept);
    else state.dayHits.delete(key);
  }
}

/** `acquireAnswerSlot` の戻り値。 */
export type AcquireAnswerSlotDecision =
  | { ok: true }
  | { ok: false; status: 429; reason: 'answerBusy' }
  | { ok: false; status: 429; reason: 'minuteRateLimited'; retryAfterSec: number }
  | { ok: false; status: 429; reason: 'dailyRateLimited'; retryAfterSec: number };

/**
 * 回答生成スロットの取得を試みる（D9: 同時 1・5 回/分・100 回/日）。
 *
 * 判定順（この順序を変えないこと。テストで固定している）:
 * 1. stale reap（`pruneAnswerGuardState`）
 * 2. busy（`answerBusy` → 429） — 同一ユーザーが既に生成中なら拒否（同時実行 1 の強制）
 * 3. 1 分レート（`minuteRateLimited` → 429）
 * 4. 1 日レート（`dailyRateLimited` → 429）
 * 5. それ以外は取得成功（スロットを占有し、レート記録に今回の時刻を追加する）
 *
 * 検索（`searchKnowledge`）自体はこの制限の対象外（D9: 「検索だけは常に使える」）。
 */
export function acquireAnswerSlot(
  state: AnswerGuardState,
  input: { userId: string; answerId: string; nowMs: number }
): AcquireAnswerSlotDecision {
  const { userId, answerId, nowMs } = input;
  pruneAnswerGuardState(state, nowMs);

  if (state.slots.has(userId)) {
    return { ok: false, status: 429, reason: 'answerBusy' };
  }

  const minuteHits = state.minuteHits.get(userId) ?? [];
  if (minuteHits.length >= ANSWER_MINUTE_RATE_LIMIT) {
    const oldest = Math.min(...minuteHits);
    return {
      ok: false,
      status: 429,
      reason: 'minuteRateLimited',
      retryAfterSec: Math.max(1, Math.ceil((oldest + ANSWER_MINUTE_WINDOW_MS - nowMs) / 1000)),
    };
  }

  const dayHits = state.dayHits.get(userId) ?? [];
  if (dayHits.length >= ANSWER_DAY_RATE_LIMIT) {
    const oldest = Math.min(...dayHits);
    return {
      ok: false,
      status: 429,
      reason: 'dailyRateLimited',
      retryAfterSec: Math.max(1, Math.ceil((oldest + ANSWER_DAY_WINDOW_MS - nowMs) / 1000)),
    };
  }

  state.slots.set(userId, { answerId, startedAt: nowMs });
  state.minuteHits.set(userId, [...minuteHits, nowMs]);
  state.dayHits.set(userId, [...dayHits, nowMs]);
  return { ok: true };
}

/**
 * 回答生成スロットを解放する。`finally` から必ず呼び出すこと（`acquireRawSlot` と同じ理由:
 * クライアント切断・例外経路でもスロットが固まらないようにする。stale reap はその保険）。
 */
export function releaseAnswerSlot(state: AnswerGuardState, userId: string): void {
  state.slots.delete(userId);
}

// ============================================================
// 配信経路（D4）
// ============================================================

/**
 * ストリーミング配信を WS で行うか、完成形を HTTP で返すかを決める。
 * `stream` が false、または WS が未接続なら HTTP（非ストリーミング）にフォールバックする。
 */
export function decideDelivery(input: { stream: boolean; wsConnected: boolean }): 'ws' | 'http' {
  return input.stream && input.wsConnected ? 'ws' : 'http';
}
