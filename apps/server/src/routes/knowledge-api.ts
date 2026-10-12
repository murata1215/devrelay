/**
 * 高辻ナレッジ サイクル1/2 — `GET /api/knowledge/search`（次サイクルの WebUI 用。本サイクルは API のみ）。
 * サイクル2: `scope` / `compartment` / `maxLevel` を追加、レスポンスに `viewer` を追加
 * （既存パラメータ・既定値は不変）。可視判定の付与・閲覧 API は `routes/knowledge-admin-api.ts`。
 *
 * WebUI の他エンドポイントと同じ認証（`routes/sites-api.ts` と同形: `addHook('preHandler', authenticate)`、
 * `Authorization: Bearer <AuthSession.token>`、Cookie は使わない）。
 * killswitch（`DEVRELAY_KNOWLEDGE=0`）のときは 404 を返す。
 */

import { FastifyInstance } from 'fastify';
import crypto from 'crypto';
import { authenticate } from './auth.js';
import { searchKnowledge } from '../services/knowledge-service.js';
import { isKnowledgeEnabled } from '../services/knowledge-rank.js';
import { answerKnowledge, type AnswerSink, type KnowledgeAnswerDoneResult } from '../services/knowledge-answer.js';
import {
  isKnowledgeAnswerEnabled,
  normalizeQuestion,
  normalizeAnswerId,
  decideDelivery,
  acquireAnswerSlot,
  releaseAnswerSlot,
  type KnownSourceRef,
  type AnswerHistoryTurn,
} from '../services/knowledge-answer-rules.js';
import { answerGuardState } from '../services/knowledge-answer-slot.js';
import { isWebClientConnected, sendWebRawMessage } from '../platforms/web.js';
import { resolveUserLanguage } from '../services/user-settings.js';

/** `POST /api/knowledge/answer` のリクエストボディ（未検証。`searchKnowledge` と同形のフィルタ）。 */
interface KnowledgeAnswerRequestBody {
  answerId?: string;
  question?: string;
  stream?: boolean;
  /** WS 配信先を `web:${userId}:${tabId}` として組み立てるための tabId（ブラウザが送る）。 */
  tabId?: string;
  mode?: string;
  scope?: string;
  projectId?: string;
  kind?: string;
  compartment?: string;
  maxLevel?: number;
  since?: string;
  until?: string;
  limit?: number;
  /** サイクル4.5: 追い質問（会話継続）。直近の Q/A・会話で既に番号を振った根拠・検索クエリ連結用の前回質問。 */
  history?: AnswerHistoryTurn[];
  knownSources?: KnownSourceRef[];
  previousQuestion?: string;
}

export async function knowledgeApiRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  app.get('/api/knowledge/search', async (request, reply) => {
    if (!isKnowledgeEnabled(process.env.DEVRELAY_KNOWLEDGE)) {
      return reply.status(404).send({ error: 'Knowledge search is disabled (DEVRELAY_KNOWLEDGE=0)' });
    }

    // @ts-ignore - authenticate フックが request.user を付与する
    const userId = request.user.id as string;
    const query = request.query as {
      query?: string;
      mode?: string;
      projectId?: string;
      kind?: string;
      since?: string;
      until?: string;
      limit?: string;
      scope?: string;
      compartment?: string;
      maxLevel?: string;
    };

    const result = await searchKnowledge({
      userId,
      query: query.query,
      mode: query.mode,
      projectId: query.projectId,
      kind: query.kind,
      since: query.since,
      until: query.until,
      limit: query.limit !== undefined ? Number(query.limit) : undefined,
      scope: query.scope,
      compartment: query.compartment,
      maxLevel: query.maxLevel !== undefined ? Number(query.maxLevel) : undefined,
    });

    if (!result.ok) {
      return reply.status(400).send({ error: result.error });
    }

    return reply.send({
      viewer: result.viewer,
      query: result.query,
      mode: result.mode,
      coverage: result.coverage,
      total: result.total,
      results: result.results,
    });
  });

  /**
   * 高辻ナレッジ サイクル4: `POST /api/knowledge/answer`（指示書 D1〜D11）。
   * killswitch（`DEVRELAY_KNOWLEDGE_ANSWER=0`）のときは 404。`DEVRELAY_KNOWLEDGE=0`（検索の
   * killswitch）とは独立（検索は常に使える、D9）。
   *
   * レスポンスは常に 200（HTTP ステータスではなく body の `delivery` で分岐させる。
   * `request()` がステータスを捨てる既存 WebUI クライアントの流儀に合わせる）:
   * - `stream:true` かつ利用者の WS（`tabId` から組み立てた `web:${userId}:${tabId}`）が接続中
   *   → `{ delivery: 'ws', answerId }` を即返し、以降は WS の `knowledge:answer:*` で配信
   * - それ以外 → 生成を待って完成形 `{ delivery: 'http', ...done }` を返す
   */
  app.post('/api/knowledge/answer', async (request, reply) => {
    if (!isKnowledgeAnswerEnabled(process.env.DEVRELAY_KNOWLEDGE_ANSWER)) {
      return reply.status(404).send({ error: 'Knowledge answer is disabled (DEVRELAY_KNOWLEDGE_ANSWER=0)' });
    }

    // @ts-ignore - authenticate フックが request.user を付与する
    const userId = request.user.id as string;
    const body = (request.body || {}) as KnowledgeAnswerRequestBody;

    const questionCheck = normalizeQuestion(body.question);
    if (!questionCheck.ok) {
      return reply.status(400).send({ error: questionCheck.error });
    }

    const answerId = normalizeAnswerId(body.answerId, crypto.randomUUID());

    const rateDecision = acquireAnswerSlot(answerGuardState, { userId, answerId, nowMs: Date.now() });
    if (!rateDecision.ok) {
      return reply.status(429).send({
        error: rateDecision.reason,
        ...(rateDecision.reason !== 'answerBusy' ? { retryAfterSec: rateDecision.retryAfterSec } : {}),
      });
    }

    const language = await resolveUserLanguage(userId);
    const chatId = body.tabId ? `web:${userId}:${body.tabId}` : null;
    const wsConnected = chatId ? isWebClientConnected(chatId) : false;
    const delivery = decideDelivery({ stream: body.stream === true, wsConnected });

    const answerParams = {
      userId,
      answerId,
      question: questionCheck.value,
      language,
      mode: body.mode,
      scope: body.scope,
      projectId: body.projectId,
      kind: body.kind,
      compartment: body.compartment,
      maxLevel: body.maxLevel,
      since: body.since,
      until: body.until,
      limit: body.limit,
      history: body.history,
      knownSources: body.knownSources,
      previousQuestion: body.previousQuestion,
    };

    if (delivery === 'http') {
      try {
        let doneResult: KnowledgeAnswerDoneResult | null = null;
        let errorMessage: string | null = null;
        const sink: AnswerSink = {
          delta: () => {},
          done: (result) => { doneResult = result; },
          error: (message) => { errorMessage = message; },
        };
        await answerKnowledge(answerParams, sink);
        if (!doneResult) {
          return reply.status(503).send({ error: errorMessage || 'Unknown error' });
        }
        // TS の制御フロー解析はクロージャ内で代入された let 変数の narrowing を保持しないため、
        // 直前の null チェックを踏まえた非 null アサーション。
        return reply.send({ delivery: 'http', ...(doneResult as KnowledgeAnswerDoneResult) });
      } finally {
        releaseAnswerSlot(answerGuardState, userId);
      }
    }

    // ws 配信: 生成は裏で進め、delta/done/error は chatId 宛に WS で流す（fire-and-forget）。
    const wsChatId = chatId as string;
    const sink: AnswerSink = {
      delta: (text) => {
        sendWebRawMessage(wsChatId, { type: 'knowledge:answer:delta', payload: { answerId, text } });
      },
      done: (result) => {
        sendWebRawMessage(wsChatId, { type: 'knowledge:answer:done', payload: result });
      },
      error: (message) => {
        sendWebRawMessage(wsChatId, { type: 'knowledge:answer:error', payload: { answerId, message } });
      },
    };
    answerKnowledge(answerParams, sink)
      .catch((err: any) => {
        sendWebRawMessage(wsChatId, {
          type: 'knowledge:answer:error',
          payload: { answerId, message: err?.message || 'Unknown error' },
        });
      })
      .finally(() => {
        releaseAnswerSlot(answerGuardState, userId);
      });

    return reply.send({ delivery: 'ws', answerId });
  });
}
