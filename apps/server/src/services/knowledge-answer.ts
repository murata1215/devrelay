/**
 * 高辻ナレッジ サイクル4: ナレッジ回答（RAG）のオーケストレーション。
 *
 * `searchKnowledge`（既存。カード＝根拠）と同じクエリ・同じフィルタで検索した上位ターンの全文を
 * `loadKnowledgeTurnTexts` で取得し、OpenAI（`DEVRELAY_ANSWER_API_KEY` 専用鍵）にストリーミングで
 * 生成させる。可視判定・監査は `searchKnowledge` / `loadKnowledgeTurnTexts` に委譲する
 * （見えないものは AI にも渡らない。D2）。
 */

import { searchKnowledge, loadKnowledgeTurnTexts, type KnowledgeSearchResultItem } from './knowledge-service.js';
import { decideAuditTargets } from './knowledge-access.js';
import { recordSupervisionAudit } from './org-control.js';
import { resolveChatProvider } from './chat-provider.js';
import {
  buildKnowledgeContext,
  buildKnowledgePrompt,
  buildEmptyContextAnswer,
  sanitizeCitations,
  resolveAnswerKey,
  type KnowledgeContextItem,
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

/** `sink.done` が受け取る 1 件の根拠ソース。 */
export interface KnowledgeAnswerSource {
  rank: number;
  sourceType: string;
  sessionId: string;
  aiMessageId: string;
  title: string | null;
  projectName: string;
  ownerName: string;
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

    // 検索クエリは質問文そのもの（ただし検索側の文字数上限 500 文字に合わせて切り詰める。
    // AI へ渡す質問文自体は切り詰めない）。
    const searchQuery = params.question.slice(0, SEARCH_QUERY_MAX_LENGTH);

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

    const turnTexts = await loadKnowledgeTurnTexts(
      params.userId,
      topResults.map((r) => ({ sourceId: r.aiMessageId, sessionId: r.sessionId }))
    );

    const contextInputItems: KnowledgeContextItem[] = topResults
      .map((r) => {
        const text = turnTexts.get(r.aiMessageId);
        if (text === undefined) return null;
        return {
          rank: r.rank,
          sourceType: 'turn',
          sessionId: r.sessionId,
          aiMessageId: r.aiMessageId,
          title: r.threadTitle,
          projectName: r.projectName,
          ownerName: r.ownerName,
          occurredAt: r.occurredAt,
          level: r.level,
          compartment: r.compartment,
          text,
        };
      })
      .filter((item): item is KnowledgeContextItem => item !== null);

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
        context: { items: 0, omitted: context.omitted, chars: 0 },
        elapsedMs: Date.now() - startedAt,
        audited: false,
      });
      return;
    }

    const prompt = buildKnowledgePrompt({ language: params.language, question: params.question, items: context.items });
    const chatProvider = await resolveChatProvider(params.userId, keyResolution.provider, keyResolution.apiKey, keyResolution.model);

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), ANSWER_TIMEOUT_MS);

    try {
      let fullText = '';
      let usage: { input: number; output: number } | undefined;

      const chatParams = {
        system: prompt.system,
        messages: [{ role: 'user' as const, content: prompt.user }],
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
          sourceType: item.sourceType,
          sessionId: item.sessionId,
          aiMessageId: item.aiMessageId,
          title: item.title,
          projectName: item.projectName,
          ownerName: item.ownerName,
          occurredAt: item.occurredAt,
          level: item.level,
          compartment: item.compartment,
        }));

      // 高辻ナレッジ サイクル4 D8: context に他人のターンが含まれたら所有者ごとに 1 行監査する
      // （fire-and-forget。`search_knowledge` の監査とは別アクション 'summarize'）。`sink.done` を
      // 呼ぶ前に対象を確定させ、`audited` フラグを結果に含める（WebUI の監査記録バナー表示用）。
      const otherOwnerIds = context.items
        .map((item) => resultByMessageId.get(item.aiMessageId))
        .filter((r): r is KnowledgeSearchResultItem => !!r && !r.isOwn)
        .map((r) => r.ownerUserId);
      const auditTargets = decideAuditTargets(params.userId, otherOwnerIds);

      sink.done({
        answerId: params.answerId,
        answer: sanitized.answer,
        sources,
        model: keyResolution.model,
        provider: 'openai',
        usage,
        context: { items: context.items.length, omitted: context.omitted, chars: context.chars },
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
