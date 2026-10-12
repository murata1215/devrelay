/**
 * 高辻ナレッジ サイクル4: ナレッジ回答（RAG）のオーケストレーション。
 * サイクル4.5: 会話として続けられるように拡張（D1〜D5）。`history`/`knownSources` が両方空のときは
 * サイクル4 と完全に同じコードパス（検索→`loadKnowledgeTurnTexts`→`buildKnowledgeContext` を素通し）
 * を通る。いずれか一方でもあれば「会話」として `mergeConversationSources`/`evictForBudget` を経由する
 * （会話一意の根拠番号 `ref` を付け直す。D3）。
 *
 * `searchKnowledge`（既存。カード＝根拠）と同じクエリ・同じフィルタで検索した上位ターンの全文を
 * `loadKnowledgeTurnTexts` で取得し、OpenAI（`DEVRELAY_ANSWER_API_KEY` 専用鍵）にストリーミングで
 * 生成させる。可視判定・監査は `searchKnowledge` / `loadKnowledgeTurnTexts` / `loadKnowledgeTurnDetails`
 * に委譲する（見えないものは AI にも渡らない。D2）。
 */

import { searchKnowledge, loadKnowledgeTurnTexts, loadKnowledgeTurnDetails, type KnowledgeSearchResultItem } from './knowledge-service.js';
import { decideAuditTargets } from './knowledge-access.js';
import { recordSupervisionAudit } from './org-control.js';
import { resolveChatProvider } from './chat-provider.js';
import {
  buildKnowledgeContext,
  buildKnowledgePrompt,
  buildEmptyContextAnswer,
  sanitizeCitations,
  resolveAnswerKey,
  normalizeHistory,
  normalizeKnownSources,
  buildConversationSearchQuery,
  mergeConversationSources,
  extractCitedRefs,
  evictForBudget,
  type KnowledgeContextItem,
  type AnswerHistoryTurn,
  type KnownSourceRef,
  type BudgetEntry,
} from './knowledge-answer-rules.js';

/** context 構築の予算（指示書 D2）。 */
const ANSWER_CONTEXT_PER_ITEM_CHARS = 1500;
const ANSWER_CONTEXT_TOTAL_CHARS = 18000;
/** AI に渡す最大ターン数（指示書: 上位 12 ターン）。 */
const ANSWER_MAX_TURNS = 12;
/** 生成パラメータ（指示書 D3）。 */
const ANSWER_MAX_TOKENS = 1500;
const ANSWER_TEMPERATURE = 0.2;
/** 生成タイムアウト（指示書 D3: 60 秒）。 */
const ANSWER_TIMEOUT_MS = 60000;
/**
 * 検索クエリ自体の文字数上限（`normalizeKnowledgeParams` の `QUERY_MAX_LENGTH`=500）。
 * 質問の文字数上限（D9: 1,000 文字）より小さいため、検索に渡す分だけ切り詰める
 * （AI に渡すプロンプトの `question` は切り詰めない。検索ヒット用の近似でよいため）。
 */
const SEARCH_QUERY_MAX_LENGTH = 500;

/** `answerKnowledge` が生成の進行を通知するシンク。 */
export interface AnswerSink {
  delta(text: string): void;
  done(result: KnowledgeAnswerDoneResult): void;
  error(message: string): void;
}

/**
 * `sink.done` が受け取る 1 件の根拠ソース。
 * サイクル4.5: `ref`（会話一意の番号。会話でないときは `rank` と同値）/`projectId`/`isOwn` を追加。
 * `rank` は既存クライアント（検索カードの `rank` フィールド）との互換のため同値のまま残す。
 */
export interface KnowledgeAnswerSource {
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

/** `sink.done` が受け取る完成結果。`audited`: 他人のターンを context に含んだため監査ログに記録したか。 */
export interface KnowledgeAnswerDoneResult {
  answerId: string;
  answer: string;
  sources: KnowledgeAnswerSource[];
  model: string;
  provider: 'openai';
  usage?: { input: number; output: number };
  context: { items: number; omitted: number; chars: number };
  elapsedMs: number;
  audited: boolean;
}

/** `answerKnowledge` の入力。検索フィルタは `searchKnowledge` と同形（画面と同一の値を受ける）。 */
export interface AnswerKnowledgeParams {
  userId: string;
  answerId: string;
  question: string;
  language: 'ja' | 'en';
  mode?: string;
  scope?: string;
  projectId?: string;
  kind?: string;
  compartment?: string;
  maxLevel?: number;
  since?: string;
  until?: string;
  limit?: number;
  /** サイクル4.5 D1/D4: 直近の会話（クライアント申告、未検証。本関数内で `normalizeHistory` する）。 */
  history?: AnswerHistoryTurn[];
  /** サイクル4.5 D3: 会話で既に番号を振った根拠（クライアント申告、未検証）。 */
  knownSources?: KnownSourceRef[];
  /** サイクル4.5 D2: 検索クエリ連結用の直前の質問（未指定なら `history` の末尾から取る）。 */
  previousQuestion?: string;
}

/** 1 件の KnowledgeContextItem を AI context の文字数予算（粗い見積り）に変換する。 */
function estimateItemChars(text: string): number {
  return Math.min(text.length, ANSWER_CONTEXT_PER_ITEM_CHARS);
}

/**
 * ナレッジ回答を生成する。例外は内部で捕捉し `sink.error()` に集約する（呼び出し元は
 * `await` した場合でも reject されない。ただし DB 接続断等の真に異常なケースは稀に
 * 投げ直す可能性があるため、呼び出し元も `.catch()` で保険をかけること）。
 */
export async function answerKnowledge(params: AnswerKnowledgeParams, sink: AnswerSink): Promise<void> {
  const startedAt = Date.now();

  try {
    const keyResolution = resolveAnswerKey({
      envAnswerKey: process.env.DEVRELAY_ANSWER_API_KEY,
      envModel: process.env.DEVRELAY_ANSWER_MODEL,
    });
    if (!keyResolution.ok) {
      sink.error(keyResolution.error);
      return;
    }

    // サイクル4.5 D4: history・knownSources はクライアント申告（未検証）のため、まず正規化する。
    // 両方空なら「会話でない」＝サイクル4 と同一コードパスを通る（isConversation の分岐で判定）。
    const history = normalizeHistory(params.history);
    const knownSources = normalizeKnownSources(params.knownSources);
    const isConversation = history.length > 0 || knownSources.length > 0;

    // サイクル4.5 D2: 検索クエリは「直前の質問 ＋ 今回の質問」の連結（前の質問が無ければ質問文そのまま）。
    // `previousQuestion` 未指定時は `history` の末尾（直前の往復）から取る。
    const previousQuestionForSearch = params.previousQuestion ?? history[history.length - 1]?.question;
    const searchQuery = buildConversationSearchQuery({
      previousQuestion: previousQuestionForSearch,
      question: params.question,
    }).slice(0, SEARCH_QUERY_MAX_LENGTH);

    const searchResult = await searchKnowledge({
      userId: params.userId,
      query: searchQuery,
      mode: params.mode,
      projectId: params.projectId,
      kind: params.kind,
      since: params.since,
      until: params.until,
      limit: params.limit,
      scope: params.scope,
      compartment: params.compartment,
      maxLevel: params.maxLevel,
    });
    if (!searchResult.ok) {
      sink.error(searchResult.error);
      return;
    }

    const topResults = searchResult.results.slice(0, ANSWER_MAX_TURNS);
    const resultByMessageId = new Map<string, KnowledgeSearchResultItem>(topResults.map((r) => [r.aiMessageId, r]));

    let contextInputItems: KnowledgeContextItem[];
    /** 会話でないときの `omitted`/`chars` はサイクル4 と同一の `buildKnowledgeContext` 呼び出し 1 回で決まる。
     * 会話のときは `evictForBudget` で先に間引いた分も合算する。 */
    let preEvictOmitted = 0;

    if (!isConversation) {
      // サイクル4 と完全に同一のコードパス（ランク＝検索結果の `rank` をそのまま維持。欠番が出ても
      // 詰め直さない＝カードの `rank` とこの後の引用番号が一致し続ける、既存のクリック挙動の前提）。
      const turnTexts = await loadKnowledgeTurnTexts(
        params.userId,
        topResults.map((r) => ({ sourceId: r.aiMessageId, sessionId: r.sessionId }))
      );

      contextInputItems = topResults
        .map((r) => {
          const text = turnTexts.get(r.aiMessageId);
          if (text === undefined) return null;
          return {
            rank: r.rank,
            sourceType: 'turn',
            sessionId: r.sessionId,
            aiMessageId: r.aiMessageId,
            projectId: r.projectId,
            title: r.threadTitle,
            projectName: r.projectName,
            ownerUserId: r.ownerUserId,
            ownerName: r.ownerName,
            isOwn: r.isOwn,
            occurredAt: r.occurredAt,
            level: r.level,
            compartment: r.compartment,
            text,
          } satisfies KnowledgeContextItem;
        })
        .filter((item): item is KnowledgeContextItem => item !== null);
    } else {
      // サイクル4.5: 会話。既知の根拠（knownSources）は全文・表示用メタデータを再取得・再可視判定し直す
      // （D3: クライアント申告の title/level/compartment を信用せず、サーバーで再導出する）。
      const [knownDetails, turnTexts] = await Promise.all([
        loadKnowledgeTurnDetails(params.userId, knownSources.map((k) => ({ sourceId: k.sourceId, sessionId: k.sessionId }))),
        loadKnowledgeTurnTexts(params.userId, topResults.map((r) => ({ sourceId: r.aiMessageId, sessionId: r.sessionId }))),
      ]);

      const visibleSourceIds = [...knownDetails.keys(), ...turnTexts.keys()];
      const merged = mergeConversationSources({
        known: knownSources,
        newHits: topResults.map((r) => ({ sourceType: 'turn', sourceId: r.aiMessageId, sessionId: r.sessionId })),
        visibleSourceIds,
      });

      const mergedItems: KnowledgeContextItem[] = merged.items
        .map((m): KnowledgeContextItem | null => {
          if (m.origin === 'known') {
            const detail = knownDetails.get(m.sourceId);
            if (!detail) return null;
            return {
              rank: m.ref,
              sourceType: m.sourceType,
              sessionId: detail.sessionId,
              aiMessageId: detail.sourceId,
              projectId: detail.projectId,
              title: detail.title,
              projectName: detail.projectName,
              ownerUserId: detail.ownerUserId,
              ownerName: detail.ownerName,
              isOwn: detail.isOwn,
              occurredAt: detail.occurredAt,
              level: detail.level,
              compartment: detail.compartment,
              text: detail.text,
            } satisfies KnowledgeContextItem;
          }
          const r = resultByMessageId.get(m.sourceId);
          const text = turnTexts.get(m.sourceId);
          if (!r || text === undefined) return null;
          return {
            rank: m.ref,
            sourceType: m.sourceType,
            sessionId: r.sessionId,
            aiMessageId: r.aiMessageId,
            projectId: r.projectId,
            title: r.threadTitle,
            projectName: r.projectName,
            ownerUserId: r.ownerUserId,
            ownerName: r.ownerName,
            isOwn: r.isOwn,
            occurredAt: r.occurredAt,
            level: r.level,
            compartment: r.compartment,
            text,
          } satisfies KnowledgeContextItem;
        })
        .filter((item): item is KnowledgeContextItem => item !== null);

      // D3-b（ユーザー承認）: 「引用済みか」はクライアント申告に頼らず、正規化済み history の
      // 回答本文に実際に出現する [n] からサーバー側で導出する。
      const citedRefs = extractCitedRefs(history.map((h) => h.answer));
      const originByRef = new Map(merged.items.map((m) => [m.ref, m.origin]));
      const budgetEntries: BudgetEntry[] = mergedItems.map((item) => ({
        ref: item.rank,
        origin: originByRef.get(item.rank) ?? 'new',
        chars: estimateItemChars(item.text),
        cited: citedRefs.has(item.rank),
      }));
      const evictResult = evictForBudget(budgetEntries, ANSWER_CONTEXT_TOTAL_CHARS);
      preEvictOmitted = evictResult.droppedRefs.length;

      const keptRefs = new Set(evictResult.keptRefs);
      contextInputItems = mergedItems.filter((item) => keptRefs.has(item.rank));
    }

    const context = buildKnowledgeContext(contextInputItems, {
      perItemChars: ANSWER_CONTEXT_PER_ITEM_CHARS,
      totalChars: ANSWER_CONTEXT_TOTAL_CHARS,
    });

    if (context.items.length === 0) {
      sink.done({
        answerId: params.answerId,
        answer: buildEmptyContextAnswer(params.language),
        sources: [],
        model: keyResolution.model,
        provider: 'openai',
        context: { items: 0, omitted: context.omitted + preEvictOmitted, chars: 0 },
        elapsedMs: Date.now() - startedAt,
        audited: false,
      });
      return;
    }

    const prompt = buildKnowledgePrompt({
      language: params.language,
      question: params.question,
      items: context.items,
      history,
    });
    const chatProvider = await resolveChatProvider(params.userId, keyResolution.provider, keyResolution.apiKey, keyResolution.model);

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), ANSWER_TIMEOUT_MS);

    try {
      let fullText = '';
      let usage: { input: number; output: number } | undefined;

      const chatParams = {
        system: prompt.system,
        messages: prompt.messages,
        jsonMode: false,
        maxTokens: ANSWER_MAX_TOKENS,
        temperature: ANSWER_TEMPERATURE,
        signal: controller.signal,
      };

      if (chatProvider.chatStream) {
        const result = await chatProvider.chatStream(chatParams, (deltaText) => {
          fullText += deltaText;
          sink.delta(deltaText);
        });
        usage = result.usage;
      } else {
        // ストリーミング未実装のプロバイダー: 完成形を 1 回の delta として流す（指示書 §2.1-4）。
        const result = await chatProvider.chat(chatParams);
        fullText = result.text;
        usage = result.usage;
        sink.delta(fullText);
      }

      const validRanks = context.items.map((item) => item.rank);
      const sanitized = sanitizeCitations(fullText, validRanks);

      const sources: KnowledgeAnswerSource[] = context.items
        .filter((item) => sanitized.cited.includes(item.rank))
        .map((item) => ({
          rank: item.rank,
          ref: item.rank,
          sourceType: item.sourceType,
          sessionId: item.sessionId,
          aiMessageId: item.aiMessageId,
          projectId: item.projectId,
          title: item.title,
          projectName: item.projectName,
          ownerName: item.ownerName,
          isOwn: item.isOwn,
          occurredAt: item.occurredAt,
          level: item.level,
          compartment: item.compartment,
        }));

      // 高辻ナレッジ サイクル4 D8: context に他人のターンが含まれたら所有者ごとに 1 行監査する
      // （fire-and-forget。`search_knowledge` の監査とは別アクション 'summarize'）。`sink.done` を
      // 呼ぶ前に対象を確定させ、`audited` フラグを結果に含める（WebUI の監査記録バナー表示用）。
      // サイクル4.5: `item.ownerUserId`/`item.isOwn` は会話経路（既知の根拠含む）でも再導出済みのため、
      // そのまま使う（`resultByMessageId` に無い既知の根拠でも監査対象を正しく拾える）。
      const otherOwnerIds = context.items.filter((item) => !item.isOwn).map((item) => item.ownerUserId);
      const auditTargets = decideAuditTargets(params.userId, otherOwnerIds);

      sink.done({
        answerId: params.answerId,
        answer: sanitized.answer,
        sources,
        model: keyResolution.model,
        provider: 'openai',
        usage,
        context: { items: context.items.length, omitted: context.omitted + preEvictOmitted, chars: context.chars },
        elapsedMs: Date.now() - startedAt,
        audited: auditTargets.length > 0,
      });

      for (const ownerId of auditTargets) {
        recordSupervisionAudit(
          params.userId,
          ownerId,
          'summarize',
          JSON.stringify({ via: 'knowledge_answer', answerId: params.answerId, refs: context.items.map((i) => i.rank) })
        );
      }
    } finally {
      clearTimeout(timeoutHandle);
    }
  } catch (err: any) {
    const message = err?.name === 'AbortError' ? 'timeout' : (err?.message || 'Unknown error');
    sink.error(message);
  }
}
