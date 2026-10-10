/**
 * 高辻ナレッジ サイクル1: `search_knowledge`（MCP）/ `GET /api/knowledge/search`（REST）が共有する
 * 純関数モジュール。外部 import ゼロ（`ask-guard.ts` / `thread-list-filter.ts` と同じ流儀。
 * `packages/shared` ではなく `apps/server` に置く＝#310 白画面事故の回避）。
 *
 * - パラメータ検証（`normalizeKnowledgeParams`）
 * - キルスイッチ判定（`isKnowledgeEnabled`）
 * - coverage 判定（`decideKnowledgeCoverage`）
 * - キーワード／ベクトル候補の RRF 統合（`fuseKnowledgeCandidates`）
 * - スニペット生成（`buildKnowledgeSnippet`）
 * - ILIKE 用エスケープ（`escapeLikePattern`）
 */

/** `DEVRELAY_KNOWLEDGE` 環境変数を解釈する。既定 ON（'0' が明示されたときのみ無効）。`isMcpAskEnabled` と同じ流儀。 */
export function isKnowledgeEnabled(raw: string | undefined): boolean {
  return raw !== '0';
}

/** 検索モード。既定 'hybrid'。 */
export type KnowledgeSearchMode = 'hybrid' | 'keyword' | 'vector';

/** `Session.kind` によるフィルタ。既定 'all'。 */
export type KnowledgeSearchKind = 'instruction' | 'question' | 'all';

/** 検証済みパラメータ。 */
export interface NormalizedKnowledgeParams {
  query: string;
  mode: KnowledgeSearchMode;
  projectId?: string;
  kind: KnowledgeSearchKind;
  since?: string;
  until?: string;
  limit: number;
}

/** `normalizeKnowledgeParams` の戻り値（成功/失敗の判別可能ユニオン）。 */
export type NormalizeKnowledgeParamsResult =
  | { ok: true; params: NormalizedKnowledgeParams }
  | { ok: false; error: string };

/** 検証前の生パラメータ（MCP の zod パース後 or REST のクエリ文字列パース後）。 */
export interface RawKnowledgeParams {
  query?: unknown;
  mode?: unknown;
  projectId?: unknown;
  kind?: unknown;
  since?: unknown;
  until?: unknown;
  limit?: unknown;
}

const QUERY_MAX_LENGTH = 500;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 30;

/**
 * ISO 日時パラメータを検証する。未指定（undefined/null/空文字）は許容し `value: undefined` を返す。
 */
function parseIsoDateParam(raw: unknown, fieldName: string): { value?: string; error?: string } {
  if (raw === undefined || raw === null || raw === '') return {};
  if (typeof raw !== 'string') return { error: `${fieldName} must be an ISO date string` };
  if (Number.isNaN(Date.parse(raw))) return { error: `${fieldName} must be a valid ISO date string` };
  return { value: raw };
}

/**
 * `search_knowledge` / `GET /api/knowledge/search` の入力パラメータを検証・正規化する。
 * 切り詰めず明示エラーで拒否する（静かなフォールバック禁止、#325 の流儀）。
 */
export function normalizeKnowledgeParams(raw: RawKnowledgeParams): NormalizeKnowledgeParamsResult {
  const query = typeof raw.query === 'string' ? raw.query.trim() : '';
  if (query.length === 0) {
    return { ok: false, error: 'query is required' };
  }
  if (query.length > QUERY_MAX_LENGTH) {
    return { ok: false, error: `query must be ${QUERY_MAX_LENGTH} characters or fewer` };
  }

  let mode: KnowledgeSearchMode = 'hybrid';
  if (raw.mode !== undefined) {
    if (raw.mode !== 'hybrid' && raw.mode !== 'keyword' && raw.mode !== 'vector') {
      return { ok: false, error: `invalid mode: ${String(raw.mode)}` };
    }
    mode = raw.mode;
  }

  let kind: KnowledgeSearchKind = 'all';
  if (raw.kind !== undefined) {
    if (raw.kind !== 'all' && raw.kind !== 'instruction' && raw.kind !== 'question') {
      return { ok: false, error: `invalid kind: ${String(raw.kind)}` };
    }
    kind = raw.kind;
  }

  const projectId = typeof raw.projectId === 'string' && raw.projectId.length > 0 ? raw.projectId : undefined;

  const since = parseIsoDateParam(raw.since, 'since');
  if (since.error) return { ok: false, error: since.error };
  const until = parseIsoDateParam(raw.until, 'until');
  if (until.error) return { ok: false, error: until.error };

  let limit = DEFAULT_LIMIT;
  if (raw.limit !== undefined) {
    const n = Number(raw.limit);
    if (!Number.isInteger(n) || n < 1) {
      return { ok: false, error: 'limit must be a positive integer' };
    }
    limit = Math.min(n, MAX_LIMIT);
  }

  return {
    ok: true,
    params: { query, mode, projectId, kind, since: since.value, until: until.value, limit },
  };
}

/** coverage レスポンス（指示書 §6 の `coverage` フィールドと同形）。 */
export interface KnowledgeCoverage {
  keyword: boolean;
  vector: boolean;
  vectorSkippedReason?: 'no_openai_api_key';
}

/** `decideKnowledgeCoverage` の戻り値。 */
export type DecideKnowledgeCoverageResult =
  | { ok: true; runKeyword: boolean; runVector: boolean; coverage: KnowledgeCoverage }
  | { ok: false; error: string };

/**
 * mode と OpenAI API キーの有無から、実際にキーワード検索／ベクトル検索を実行すべきかを決める
 * （指示書 §5 の coverage 表に対応する 5 通り）。
 *
 * | mode | キー有 | キー無 |
 * |---|---|---|
 * | hybrid | keyword✓ vector✓ | keyword✓ vector✗（`vectorSkippedReason`） |
 * | keyword | keyword✓ | keyword✓ |
 * | vector | vector✓ | エラー |
 */
export function decideKnowledgeCoverage(input: {
  mode: KnowledgeSearchMode;
  hasApiKey: boolean;
}): DecideKnowledgeCoverageResult {
  const { mode, hasApiKey } = input;

  if (mode === 'vector') {
    if (!hasApiKey) {
      return { ok: false, error: 'OpenAI API key not configured. Set it in WebUI Settings.' };
    }
    return { ok: true, runKeyword: false, runVector: true, coverage: { keyword: false, vector: true } };
  }

  if (mode === 'keyword') {
    return { ok: true, runKeyword: true, runVector: false, coverage: { keyword: true, vector: false } };
  }

  // hybrid
  if (hasApiKey) {
    return { ok: true, runKeyword: true, runVector: true, coverage: { keyword: true, vector: true } };
  }
  return {
    ok: true,
    runKeyword: true,
    runVector: false,
    coverage: { keyword: true, vector: false, vectorSkippedReason: 'no_openai_api_key' },
  };
}

/** ILIKE パターン中の `\` `%` `_` をエスケープする（`ESCAPE '\'` と組み合わせて使う）。 */
export function escapeLikePattern(query: string): string {
  return query.replace(/([\\%_])/g, '\\$1');
}

/**
 * OpenAI embeddings API のエラーが「入力起因」（= リトライしても同じ結果になる）かを判定する
 * （バックフィル承認時の追加指示）。
 *
 * 400（Bad Request、例: 1 件のトークン数が embedding モデルの入力上限を超過）と
 * 422（Unprocessable Entity）は、32 件バッチのどれか 1 件が原因でバッチ全体が失敗する典型例。
 * これらは `embedPendingChunks` でバッチ全体を `failed` にせず、1 件ずつ再試行して
 * 失敗した個々のチャンクのみ `failed` にするためのトリガーとして使う。
 * 429（Rate Limit）・5xx（サーバー側）・`undefined`（ネットワーク断等でステータス自体が無い）は
 * 入力起因ではない（再試行すれば成功する可能性がある）ため false を返し、従来のバックオフ処理に委ねる。
 *
 * @param status OpenAI SDK の `APIError.status`（HTTP ステータスコード）
 */
export function isInputCausedEmbeddingError(status: number | null | undefined): boolean {
  return status === 400 || status === 422;
}

/** RRF の定数 k。スコアの正規化不要で単純なため採用（指示書 D5）。 */
export const KNOWLEDGE_RRF_K = 60;

/** キーワード／ベクトル検索の 1 候補（チャンク単位。`sourceId` = AI Message.id）。 */
export interface KnowledgeRankCandidate {
  sourceId: string;
  chunkIndex: number;
  occurredAtMs: number;
}

/** RRF 統合後の 1 ターン分の結果。 */
export interface FusedKnowledgeResult {
  sourceId: string;
  score: number;
  matchedBy: Array<'keyword' | 'vector'>;
  bestChunkIndex: number;
  occurredAtMs: number;
}

/**
 * 検索順位（rank 昇順＝先頭が最良）で並んだチャンク候補リストを、同一 `sourceId`（ターン）単位に
 * 集約する。先頭に出現した候補がそのターンの最良順位なので、以降の同一 `sourceId` は捨てる。
 */
function collapseToBestRankPerTurn(list: KnowledgeRankCandidate[]): KnowledgeRankCandidate[] {
  const seen = new Set<string>();
  const result: KnowledgeRankCandidate[] = [];
  for (const candidate of list) {
    if (seen.has(candidate.sourceId)) continue;
    seen.add(candidate.sourceId);
    result.push(candidate);
  }
  return result;
}

/**
 * キーワード候補・ベクトル候補を RRF（Reciprocal Rank Fusion、k=60）で統合する。
 * 同一ターンの複数チャンクは「最良順位（= リスト内で最初に出現したもの）」に集約してから
 * ランク付けするため、同じターンが同じリスト内で二重に加点されることはない。
 *
 * @param keyword キーワード検索候補（既に順位付けされた配列。先頭が最良）
 * @param vector ベクトル検索候補（既に順位付けされた配列。先頭が最良）
 * @param limit 返す件数の上限
 * @returns スコア降順（同点は occurredAt 降順）に並んだ上位 `limit` 件
 */
export function fuseKnowledgeCandidates(
  keyword: KnowledgeRankCandidate[],
  vector: KnowledgeRankCandidate[],
  limit: number
): FusedKnowledgeResult[] {
  const keywordTurns = collapseToBestRankPerTurn(keyword);
  const vectorTurns = collapseToBestRankPerTurn(vector);

  const scores = new Map<string, FusedKnowledgeResult>();

  const applyList = (list: KnowledgeRankCandidate[], tag: 'keyword' | 'vector') => {
    list.forEach((candidate, index) => {
      const rank = index + 1;
      const contribution = 1 / (KNOWLEDGE_RRF_K + rank);
      const existing = scores.get(candidate.sourceId);
      if (existing) {
        existing.score += contribution;
        if (!existing.matchedBy.includes(tag)) existing.matchedBy.push(tag);
        if (candidate.occurredAtMs > existing.occurredAtMs) existing.occurredAtMs = candidate.occurredAtMs;
      } else {
        scores.set(candidate.sourceId, {
          sourceId: candidate.sourceId,
          score: contribution,
          matchedBy: [tag],
          bestChunkIndex: candidate.chunkIndex,
          occurredAtMs: candidate.occurredAtMs,
        });
      }
    });
  };

  applyList(keywordTurns, 'keyword');
  applyList(vectorTurns, 'vector');

  return Array.from(scores.values()).sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.occurredAtMs - a.occurredAtMs;
  }).slice(0, limit);
}

const SNIPPET_MATCH_CONTEXT_LENGTH = 200;
const SNIPPET_FALLBACK_LENGTH = 300;
const ANSWER_LABEL = '【回答】';

/** 連続する空白文字（改行含む）を単一スペースに畳み、前後を trim する。 */
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * チャンク本文からスニペットを作る。
 * キーワード一致があれば最初の一致位置の前後 200 文字、無ければ `【回答】` 以降の先頭 300 文字。
 * 改行は空白に畳む。
 */
export function buildKnowledgeSnippet(textContent: string, query: string): string {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length > 0) {
    const matchIndex = textContent.toLowerCase().indexOf(normalizedQuery);
    if (matchIndex >= 0) {
      const start = Math.max(0, matchIndex - SNIPPET_MATCH_CONTEXT_LENGTH);
      const end = Math.min(
        textContent.length,
        matchIndex + normalizedQuery.length + SNIPPET_MATCH_CONTEXT_LENGTH
      );
      return collapseWhitespace(textContent.slice(start, end));
    }
  }

  const answerIndex = textContent.indexOf(ANSWER_LABEL);
  const fallbackStart = answerIndex >= 0 ? answerIndex + ANSWER_LABEL.length : 0;
  return collapseWhitespace(textContent.slice(fallbackStart, fallbackStart + SNIPPET_FALLBACK_LENGTH));
}
