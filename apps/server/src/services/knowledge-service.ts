/**
 * 高辻ナレッジ サイクル1: 会話ターンのナレッジ化（embedding 生成・保存）とハイブリッド検索の
 * DB アクセス層。
 *
 * - `processTurnKnowledge` — AI メッセージ保存直後に fire-and-forget で呼ばれる（`agent-manager.ts`）
 * - `embedPendingChunks` — バックフィル CLI の Phase B（embedding 未生成分を後追いで埋める）
 * - `searchKnowledge` — MCP `search_knowledge` / REST `GET /api/knowledge/search` の共通実装
 *
 * embedding の生成・保存パターンは `embedding-service.ts`（MessageFile/AgentDocument）と同じ流儀
 * （fire-and-forget・`embeddingStatus` ステートマシン・`$executeRawUnsafe` + `$1::vector`）。
 */

import { prisma } from '../db/client.js';
import { getOpenAiApiKey } from './user-settings.js';
import { generateEmbeddingVectors } from './embedding-service.js';
import { isEphemeralSessionId } from './thread-scope.js';
import { buildTurnChunks, KNOWLEDGE_SOURCE_TYPE_TURN } from './knowledge-chunker.js';
import {
  escapeLikePattern,
  buildKnowledgeSnippet,
  decideKnowledgeCoverage,
  fuseKnowledgeCandidates,
  normalizeKnowledgeParams,
  isInputCausedEmbeddingError,
  type KnowledgeCoverage,
  type KnowledgeSearchMode,
  type KnowledgeSearchKind,
  type KnowledgeRankCandidate,
  type RawKnowledgeParams,
} from './knowledge-rank.js';

/** バックフィル CLI の embedding 1 リクエストあたりのチャンク数（指示書 §4.2） */
const EMBEDDING_BATCH_SIZE = 32;

/** キーワード／ベクトル検索で DB から取得する候補チャンク数の上限（RRF 統合前） */
const KEYWORD_CANDIDATE_LIMIT = 50;
const VECTOR_CANDIDATE_LIMIT = 50;

/** embedding API 呼び出しのリトライ上限（429/5xx 用の指数バックオフ） */
const RETRY_MAX_ATTEMPTS = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * pgvector の `embedding` 列を raw SQL で更新する（1 チャンク分）。
 * `embedding-service.ts` と同じ `$1::vector` キャストの書き方。
 */
async function updateChunkEmbedding(sourceId: string, chunkIndex: number, vector: number[]): Promise<void> {
  const vectorStr = `[${vector.join(',')}]`;
  await prisma.$executeRawUnsafe(
    `UPDATE "KnowledgeChunk" SET embedding = $1::vector, "embeddingStatus" = 'done' WHERE "sourceType" = $2 AND "sourceId" = $3 AND "chunkIndex" = $4`,
    vectorStr,
    KNOWLEDGE_SOURCE_TYPE_TURN,
    sourceId,
    chunkIndex
  );
}

/**
 * 会話ターンのチャンク行を作る（embedding には触れない）。オンライン経路（`processTurnKnowledge`）と
 * バックフィル CLI の Phase A が共有する。既存行の `embeddingStatus` は変更しない
 * （新規作成時のみ既定 `'none'`）。二重実行しても増殖しない（`(sourceType, sourceId, chunkIndex)` で upsert）。
 *
 * @param aiMessageId 対象の AI Message.id
 * @returns チャンクが作られた場合はチャンク本文配列とユーザーID、対象外（一時セッション・空応答等）なら null
 */
async function upsertTurnChunkRows(aiMessageId: string): Promise<{ chunks: string[]; userId: string } | null> {
  const aiMessage = await prisma.message.findUnique({
    where: { id: aiMessageId },
    select: {
      id: true,
      content: true,
      createdAt: true,
      sessionId: true,
      session: {
        select: {
          userId: true,
          projectId: true,
          title: true,
          project: { select: { name: true, displayName: true } },
        },
      },
    },
  });
  if (!aiMessage) {
    console.error(`[Knowledge] Message not found: ${aiMessageId}`);
    return null;
  }

  // raw-completion / teamexec / crossquery / askdesc の一時セッションはナレッジ対象外
  // （`/api/threads` のスレッド一覧にも出ないため、結果を返しても辿れない）
  if (isEphemeralSessionId(aiMessage.sessionId)) {
    return null;
  }

  // 対の user メッセージ: 同一セッション内で直前（createdAt <= ai.createdAt）の最新 1 件
  // （`GET /api/conversations` と同じ定義）
  const userMessage = await prisma.message.findFirst({
    where: {
      sessionId: aiMessage.sessionId,
      role: 'user',
      createdAt: { lte: aiMessage.createdAt },
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true, content: true },
  });

  const projectName = aiMessage.session.project.displayName || aiMessage.session.project.name;
  const chunks = buildTurnChunks({
    projectName,
    threadTitle: aiMessage.session.title,
    userContent: userMessage?.content ?? null,
    aiContent: aiMessage.content,
  });

  if (chunks.length === 0) {
    // 進捗ノイズのみ・空応答 → 対象外。再処理でチャンク数が 0 になったケースの残骸も掃除する。
    await prisma.knowledgeChunk.deleteMany({
      where: { sourceType: KNOWLEDGE_SOURCE_TYPE_TURN, sourceId: aiMessageId },
    });
    return null;
  }

  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
    await prisma.knowledgeChunk.upsert({
      where: {
        sourceType_sourceId_chunkIndex: {
          sourceType: KNOWLEDGE_SOURCE_TYPE_TURN,
          sourceId: aiMessageId,
          chunkIndex,
        },
      },
      create: {
        sourceType: KNOWLEDGE_SOURCE_TYPE_TURN,
        sourceId: aiMessageId,
        chunkIndex,
        chunkCount: chunks.length,
        userId: aiMessage.session.userId,
        projectId: aiMessage.session.projectId,
        sessionId: aiMessage.sessionId,
        userMessageId: userMessage?.id ?? null,
        textContent: chunks[chunkIndex],
        occurredAt: aiMessage.createdAt,
      },
      update: {
        chunkCount: chunks.length,
        userMessageId: userMessage?.id ?? null,
        textContent: chunks[chunkIndex],
        occurredAt: aiMessage.createdAt,
      },
    });
  }
  // 再処理でチャンク数が以前より減った場合の残骸（古い chunkIndex）を掃除
  await prisma.knowledgeChunk.deleteMany({
    where: {
      sourceType: KNOWLEDGE_SOURCE_TYPE_TURN,
      sourceId: aiMessageId,
      chunkIndex: { gte: chunks.length },
    },
  });

  return { chunks, userId: aiMessage.session.userId };
}

/**
 * バックフィル CLI の Phase A（行作成のみ。embedding には触れない）から呼ばれる公開版。
 *
 * @returns 作られたチャンク数。対象外（一時セッション・空応答等）なら null
 */
export async function createTurnChunkRows(aiMessageId: string): Promise<{ chunkCount: number } | null> {
  const result = await upsertTurnChunkRows(aiMessageId);
  return result ? { chunkCount: result.chunks.length } : null;
}

/**
 * 1 件の AI メッセージ（会話ターン）をナレッジ化する（オンライン経路）。fire-and-forget で
 * 呼び出すため、例外はログに出力して握りつぶす（呼び出し元の本線処理には伝播させない）。
 *
 * @param aiMessageId 対象の AI Message.id
 */
export async function processTurnKnowledge(aiMessageId: string): Promise<void> {
  try {
    const upserted = await upsertTurnChunkRows(aiMessageId);
    if (!upserted) return;
    const { chunks, userId } = upserted;

    const apiKey = await getOpenAiApiKey(userId);
    if (!apiKey) {
      // API キー無し → チャンク行は残したまま embedding だけ skipped（D8）
      await prisma.knowledgeChunk.updateMany({
        where: {
          sourceType: KNOWLEDGE_SOURCE_TYPE_TURN,
          sourceId: aiMessageId,
          embeddingStatus: { in: ['none', 'failed'] },
        },
        data: { embeddingStatus: 'skipped' },
      });
      return;
    }

    await prisma.knowledgeChunk.updateMany({
      where: {
        sourceType: KNOWLEDGE_SOURCE_TYPE_TURN,
        sourceId: aiMessageId,
        embeddingStatus: { in: ['none', 'failed', 'skipped'] },
      },
      data: { embeddingStatus: 'processing' },
    });

    const vectors = await generateEmbeddingVectors(chunks, apiKey);
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
      await updateChunkEmbedding(aiMessageId, chunkIndex, vectors[chunkIndex]);
    }

    console.log(`[Knowledge] Done: message=${aiMessageId} chunks=${chunks.length}`);
  } catch (error: any) {
    console.error(`[Knowledge] Failed for message ${aiMessageId}:`, error.message);
    try {
      await prisma.knowledgeChunk.updateMany({
        where: {
          sourceType: KNOWLEDGE_SOURCE_TYPE_TURN,
          sourceId: aiMessageId,
          embeddingStatus: { in: ['none', 'processing'] },
        },
        data: { embeddingStatus: 'failed' },
      });
    } catch {
      // 更新すら失敗した場合は無視
    }
  }
}

/**
 * 未 embedding（または再試行対象）のチャンクを持つユーザー ID の一覧を返す
 * （バックフィル CLI の `--user` 無指定時に「全ユーザー」を解決するため）。
 */
export async function listUserIdsWithPendingChunks(
  statuses: Array<'none' | 'failed' | 'skipped'>,
  projectId?: string
): Promise<string[]> {
  const rows = await prisma.knowledgeChunk.findMany({
    where: { embeddingStatus: { in: statuses }, ...(projectId ? { projectId } : {}) },
    select: { userId: true },
    distinct: ['userId'],
  });
  return rows.map((row) => row.userId);
}

/** `embedPendingChunks` の入力。 */
export interface EmbedPendingChunksParams {
  userId: string;
  apiKey: string;
  /** 対象にする embeddingStatus（既定 `['none']`。`--retry-failed` 時は `['none','failed','skipped']`） */
  statuses?: Array<'none' | 'failed' | 'skipped'>;
  /** 1 回に処理するチャンク数（既定 `EMBEDDING_BATCH_SIZE`=32） */
  limit?: number;
  /** 対象を 1 プロジェクトに絞る（バックフィル CLI の `--project` 用） */
  projectId?: string;
}

/** `embedPendingChunks` の戻り値。 */
export interface EmbedPendingChunksResult {
  attempted: number;
  done: number;
  failed: number;
  /** 実際に embedding API へ送った本文の文字数合計（バックフィル CLI のコスト目安表示用） */
  charsSubmitted: number;
}

/** `embedPendingChunks` が DB から取得する 1 行（embedding 対象チャンク）の形。 */
interface PendingChunkRow {
  sourceType: string;
  sourceId: string;
  chunkIndex: number;
  textContent: string;
}

/**
 * バッチ embedding が入力起因エラー（400/422）で失敗したときのフォールバック:
 * バッチをまとめて `failed` にせず、1 件ずつ個別に再試行する。失敗した個々のチャンクのみ
 * `failed` にし、成功したチャンクは `done` のまま確定させる（承認済み追加指示）。
 * 429/5xx 等の一時的なエラーは呼び出し元の指数バックオフに委ねているため、ここでは
 * 1 件あたり 1 回のみ試行する（個別リトライにさらにバックオフを重ねると複雑化するため）。
 */
async function embedRowsIndividually(rows: PendingChunkRow[], apiKey: string): Promise<EmbedPendingChunksResult> {
  let done = 0;
  let failed = 0;
  let charsSubmitted = 0;

  for (const row of rows) {
    try {
      const [vector] = await generateEmbeddingVectors([row.textContent], apiKey);
      await updateChunkEmbedding(row.sourceId, row.chunkIndex, vector);
      done++;
      charsSubmitted += row.textContent.length;
    } catch (error: any) {
      console.error(
        `[Knowledge] individual retry failed for ${row.sourceId}:${row.chunkIndex}:`,
        error.message
      );
      failed++;
      await prisma.knowledgeChunk.updateMany({
        where: { sourceType: row.sourceType, sourceId: row.sourceId, chunkIndex: row.chunkIndex },
        data: { embeddingStatus: 'failed' },
      });
    }
  }

  return { attempted: rows.length, done, failed, charsSubmitted };
}

/**
 * 指定ユーザーの未embedding（または再試行対象）チャンクを 1 バッチ（既定 32 件）だけ処理する。
 * バックフィル CLI の Phase B から呼ばれる（呼び出し側がループして全件処理する）。
 * 429/5xx は指数バックオフで最大 3 回リトライする。400/422（入力起因。例: 1 件のトークン数が
 * 入力上限超過）はバッチ全体を `failed` にせず、1 件ずつ個別に再試行する
 * （`embedRowsIndividually`、承認済み追加指示）。
 */
export async function embedPendingChunks(params: EmbedPendingChunksParams): Promise<EmbedPendingChunksResult> {
  const statuses = params.statuses ?? ['none'];
  const limit = params.limit ?? EMBEDDING_BATCH_SIZE;

  const rows = await prisma.knowledgeChunk.findMany({
    where: {
      userId: params.userId,
      embeddingStatus: { in: statuses },
      ...(params.projectId ? { projectId: params.projectId } : {}),
    },
    select: { sourceType: true, sourceId: true, chunkIndex: true, textContent: true },
    orderBy: { occurredAt: 'asc' },
    take: limit,
  });

  if (rows.length === 0) {
    return { attempted: 0, done: 0, failed: 0, charsSubmitted: 0 };
  }

  const charsSubmitted = rows.reduce((sum, row) => sum + row.textContent.length, 0);

  const markStatus = async (status: string) => {
    await prisma.knowledgeChunk.updateMany({
      where: {
        OR: rows.map((row) => ({
          sourceType: row.sourceType,
          sourceId: row.sourceId,
          chunkIndex: row.chunkIndex,
        })),
      },
      data: { embeddingStatus: status },
    });
  };

  await markStatus('processing');

  let vectors: number[][] | null = null;
  for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      vectors = await generateEmbeddingVectors(rows.map((row) => row.textContent), params.apiKey);
      break;
    } catch (error: any) {
      if (isInputCausedEmbeddingError(error?.status)) {
        console.error(
          `[Knowledge] embedPendingChunks batch rejected as input error (status=${error?.status}), ` +
          `falling back to per-chunk retry:`,
          error.message
        );
        return await embedRowsIndividually(rows, params.apiKey);
      }
      console.error(`[Knowledge] embedPendingChunks attempt ${attempt} failed:`, error.message);
      if (attempt >= RETRY_MAX_ATTEMPTS) {
        await markStatus('failed');
        return { attempted: rows.length, done: 0, failed: rows.length, charsSubmitted: 0 };
      }
      await sleep(2 ** attempt * 1000);
    }
  }

  if (!vectors) {
    await markStatus('failed');
    return { attempted: rows.length, done: 0, failed: rows.length, charsSubmitted: 0 };
  }

  for (let i = 0; i < rows.length; i++) {
    await updateChunkEmbedding(rows[i].sourceId, rows[i].chunkIndex, vectors[i]);
  }

  return { attempted: rows.length, done: rows.length, failed: 0, charsSubmitted };
}

/** `searchKnowledge` の入力（MCP の zod パース結果 / REST のクエリ文字列パース結果を渡す）。 */
export interface KnowledgeSearchParams extends RawKnowledgeParams {
  userId: string;
}

/** `searchKnowledge` の結果 1 件（指示書 §6 のレスポンス例と同形）。 */
export interface KnowledgeSearchResultItem {
  rank: number;
  score: number;
  matchedBy: Array<'keyword' | 'vector'>;
  sessionId: string;
  threadTitle: string | null;
  kind: string | null;
  projectId: string;
  projectName: string;
  aiTool: string;
  aiMessageId: string;
  userMessageId: string | null;
  occurredAt: string;
  snippet: string;
  chunkIndex: number;
  chunkCount: number;
}

/** `searchKnowledge` の戻り値（判別可能ユニオン）。 */
export type SearchKnowledgeResult =
  | {
      ok: true;
      query: string;
      mode: KnowledgeSearchMode;
      coverage: KnowledgeCoverage;
      total: number;
      results: KnowledgeSearchResultItem[];
    }
  | { ok: false; error: string };

/**
 * キーワード候補を DB から取得する（ILIKE、上位 `KEYWORD_CANDIDATE_LIMIT` 件）。
 * 順位は出現回数（textContent 中の query の出現頻度）降順 → occurredAt 降順。
 */
async function fetchKeywordCandidates(input: {
  userId: string;
  query: string;
  projectId?: string;
  kind: KnowledgeSearchKind;
  sinceDate?: Date;
  untilDate?: Date;
}): Promise<KnowledgeRankCandidate[]> {
  const conditions: string[] = [`kc."userId" = $1`, `kc."textContent" ILIKE $2 ESCAPE '\\'`];
  // $3 は出現回数カウント用の小文字化した生クエリ（ILIKE パターンのエスケープは不要）
  const queryParams: unknown[] = [input.userId, `%${escapeLikePattern(input.query)}%`, input.query.toLowerCase()];
  let paramIndex = 4;

  if (input.projectId) {
    conditions.push(`kc."projectId" = $${paramIndex}`);
    queryParams.push(input.projectId);
    paramIndex++;
  }
  if (input.kind === 'instruction') {
    conditions.push(`s."kind" IS NULL`);
  } else if (input.kind === 'question') {
    conditions.push(`s."kind" = 'question'`);
  }
  if (input.sinceDate) {
    conditions.push(`kc."occurredAt" >= $${paramIndex}`);
    queryParams.push(input.sinceDate);
    paramIndex++;
  }
  if (input.untilDate) {
    conditions.push(`kc."occurredAt" <= $${paramIndex}`);
    queryParams.push(input.untilDate);
    paramIndex++;
  }

  const sql = `
    SELECT kc."sourceId" AS "sourceId", kc."chunkIndex" AS "chunkIndex", kc."occurredAt" AS "occurredAt"
    FROM "KnowledgeChunk" kc
    JOIN "Session" s ON s.id = kc."sessionId"
    WHERE ${conditions.join(' AND ')}
    ORDER BY
      (length(lower(kc."textContent")) - length(replace(lower(kc."textContent"), $3, ''))) DESC,
      kc."occurredAt" DESC
    LIMIT ${KEYWORD_CANDIDATE_LIMIT}
  `;

  const rows = await prisma.$queryRawUnsafe<Array<{ sourceId: string; chunkIndex: number; occurredAt: Date }>>(
    sql,
    ...queryParams
  );
  return rows.map((row) => ({
    sourceId: row.sourceId,
    chunkIndex: row.chunkIndex,
    occurredAtMs: new Date(row.occurredAt).getTime(),
  }));
}

/**
 * ベクトル候補を DB から取得する（cosine distance 昇順、上位 `VECTOR_CANDIDATE_LIMIT` 件）。
 * `embedding-service.ts` の `searchSimilarDocuments` と同じ `<=>` 演算子の書き方。
 */
async function fetchVectorCandidates(input: {
  userId: string;
  query: string;
  apiKey: string;
  projectId?: string;
  kind: KnowledgeSearchKind;
  sinceDate?: Date;
  untilDate?: Date;
}): Promise<KnowledgeRankCandidate[]> {
  const [queryVector] = await generateEmbeddingVectors([input.query], input.apiKey);
  const vectorStr = `[${queryVector.join(',')}]`;

  const conditions: string[] = [
    `kc."userId" = $2`,
    `kc."embeddingStatus" = 'done'`,
    `kc.embedding IS NOT NULL`,
  ];
  const queryParams: unknown[] = [vectorStr, input.userId];
  let paramIndex = 3;

  if (input.projectId) {
    conditions.push(`kc."projectId" = $${paramIndex}`);
    queryParams.push(input.projectId);
    paramIndex++;
  }
  if (input.kind === 'instruction') {
    conditions.push(`s."kind" IS NULL`);
  } else if (input.kind === 'question') {
    conditions.push(`s."kind" = 'question'`);
  }
  if (input.sinceDate) {
    conditions.push(`kc."occurredAt" >= $${paramIndex}`);
    queryParams.push(input.sinceDate);
    paramIndex++;
  }
  if (input.untilDate) {
    conditions.push(`kc."occurredAt" <= $${paramIndex}`);
    queryParams.push(input.untilDate);
    paramIndex++;
  }

  const sql = `
    SELECT kc."sourceId" AS "sourceId", kc."chunkIndex" AS "chunkIndex", kc."occurredAt" AS "occurredAt"
    FROM "KnowledgeChunk" kc
    JOIN "Session" s ON s.id = kc."sessionId"
    WHERE ${conditions.join(' AND ')}
    ORDER BY kc.embedding <=> $1::vector ASC
    LIMIT ${VECTOR_CANDIDATE_LIMIT}
  `;

  const rows = await prisma.$queryRawUnsafe<Array<{ sourceId: string; chunkIndex: number; occurredAt: Date }>>(
    sql,
    ...queryParams
  );
  return rows.map((row) => ({
    sourceId: row.sourceId,
    chunkIndex: row.chunkIndex,
    occurredAtMs: new Date(row.occurredAt).getTime(),
  }));
}

/**
 * ハイブリッド検索（キーワード ILIKE ＋ ベクトル cosine を RRF で統合）。
 * MCP `search_knowledge` / REST `GET /api/knowledge/search` の共通実装。
 */
export async function searchKnowledge(params: KnowledgeSearchParams): Promise<SearchKnowledgeResult> {
  const normalized = normalizeKnowledgeParams(params);
  if (!normalized.ok) {
    return { ok: false, error: normalized.error };
  }
  const { query, mode, projectId, kind, since, until, limit } = normalized.params;

  const apiKey = await getOpenAiApiKey(params.userId);
  const coverageDecision = decideKnowledgeCoverage({ mode, hasApiKey: !!apiKey });
  if (!coverageDecision.ok) {
    return { ok: false, error: coverageDecision.error };
  }
  const { runKeyword, runVector, coverage } = coverageDecision;

  const sinceDate = since ? new Date(since) : undefined;
  const untilDate = until ? new Date(until) : undefined;

  const keywordCandidates = runKeyword
    ? await fetchKeywordCandidates({ userId: params.userId, query, projectId, kind, sinceDate, untilDate })
    : [];
  const vectorCandidates = runVector
    ? await fetchVectorCandidates({
        userId: params.userId,
        query,
        apiKey: apiKey as string,
        projectId,
        kind,
        sinceDate,
        untilDate,
      })
    : [];

  const fused = fuseKnowledgeCandidates(keywordCandidates, vectorCandidates, limit);
  if (fused.length === 0) {
    return { ok: true, query, mode, coverage, total: 0, results: [] };
  }

  // 最良チャンクの本文・Session・Project を取得して結果を組み立てる
  const chunkRows = await prisma.knowledgeChunk.findMany({
    where: {
      OR: fused.map((f) => ({
        sourceType: KNOWLEDGE_SOURCE_TYPE_TURN,
        sourceId: f.sourceId,
        chunkIndex: f.bestChunkIndex,
      })),
    },
    select: {
      sourceId: true,
      chunkIndex: true,
      chunkCount: true,
      sessionId: true,
      projectId: true,
      userMessageId: true,
      textContent: true,
      occurredAt: true,
    },
  });
  const chunkMap = new Map(chunkRows.map((row) => [`${row.sourceId}:${row.chunkIndex}`, row]));

  const sessionIds = [...new Set(chunkRows.map((row) => row.sessionId))];
  const sessions = sessionIds.length
    ? await prisma.session.findMany({
        where: { id: { in: sessionIds } },
        select: {
          id: true,
          title: true,
          kind: true,
          aiTool: true,
          project: { select: { name: true, displayName: true } },
        },
      })
    : [];
  const sessionMap = new Map(sessions.map((s) => [s.id, s]));

  const results: KnowledgeSearchResultItem[] = [];
  fused.forEach((f, index) => {
    const chunkRow = chunkMap.get(`${f.sourceId}:${f.bestChunkIndex}`);
    if (!chunkRow) return;
    const session = sessionMap.get(chunkRow.sessionId);
    if (!session) return;
    results.push({
      rank: index + 1,
      score: f.score,
      matchedBy: f.matchedBy,
      sessionId: chunkRow.sessionId,
      threadTitle: session.title,
      kind: session.kind,
      projectId: chunkRow.projectId,
      projectName: session.project.displayName || session.project.name,
      aiTool: session.aiTool,
      aiMessageId: f.sourceId,
      userMessageId: chunkRow.userMessageId,
      occurredAt: chunkRow.occurredAt.toISOString(),
      snippet: buildKnowledgeSnippet(chunkRow.textContent, query),
      chunkIndex: chunkRow.chunkIndex,
      chunkCount: chunkRow.chunkCount,
    });
  });

  return { ok: true, query, mode, coverage, total: results.length, results };
}
