/**
 * 高辻ナレッジ サイクル1/2: 会話ターンのナレッジ化（embedding 生成・保存）とハイブリッド検索の
 * DB アクセス層。
 *
 * - `processTurnKnowledge` — AI メッセージ保存直後に fire-and-forget で呼ばれる（`agent-manager.ts`）
 * - `embedPendingChunks` — バックフィル CLI の Phase B（embedding 未生成分を後追いで埋める）
 * - `searchKnowledge` — MCP `search_knowledge` / REST `GET /api/knowledge/search` の共通実装
 * - `getKnowledgeThread` — MCP `get_knowledge_thread` / REST `GET /api/knowledge/threads/:sessionId`
 *   の共通実装（サイクル2: 可視判定つきで他人のスレッドを 1 件読む）
 * - `setThreadClassification` / `getThreadClassification` / `setProjectClassification` /
 *   `getProjectClassification` — サイクル2: 会話・案件の機密度（level/compartment）の取得・付与
 *
 * embedding の生成・保存パターンは `embedding-service.ts`（MessageFile/AgentDocument）と同じ流儀
 * （fire-and-forget・`embeddingStatus` ステートマシン・`$executeRawUnsafe` + `$1::vector`）。
 */

import { prisma } from '../db/client.js';
import { getOpenAiApiKey } from './user-settings.js';
import { generateEmbeddingVectors } from './embedding-service.js';
import { isEphemeralSessionId } from './thread-scope.js';
import { buildTurnChunks, KNOWLEDGE_SOURCE_TYPE_TURN } from './knowledge-chunker.js';
import { truncateOnLineBoundary, CONVERSATION_MAX_CONTENT_LENGTH } from './content-truncate.js';
import { recordSupervisionAudit } from './org-control.js';
import {
  escapeLikePattern,
  buildKnowledgeSnippet,
  decideKnowledgeCoverage,
  fuseKnowledgeCandidates,
  normalizeKnowledgeParams,
  isInputCausedEmbeddingError,
  resolveThreadPageOrder,
  type KnowledgeCoverage,
  type KnowledgeSearchMode,
  type KnowledgeSearchKind,
  type KnowledgeSearchScope,
  type KnowledgeRankCandidate,
  type RawKnowledgeParams,
} from './knowledge-rank.js';
import {
  resolveEffectiveClassification,
  isTurnVisible,
  buildVisibilityPredicate,
  buildClassificationFilterPredicate,
  canAssignClassification,
  decideAuditTargets,
  normalizeLevel,
  normalizeCompartment,
  type KnowledgeViewer,
  type TurnClassification,
  type ClassificationValue,
} from './knowledge-access.js';

/** バックフィル CLI の embedding 1 リクエストあたりのチャンク数（指示書 §4.2） */
const EMBEDDING_BATCH_SIZE = 32;

/** キーワード／ベクトル検索で DB から取得する候補チャンク数の上限（RRF 統合前） */
const KEYWORD_CANDIDATE_LIMIT = 50;
const VECTOR_CANDIDATE_LIMIT = 50;

/** embedding API 呼び出しのリトライ上限（429/5xx 用の指数バックオフ） */
const RETRY_MAX_ATTEMPTS = 3;

/** 他人のスレッド／不可視なスレッドのどちらでも返す同一文言（存在の有無を漏らさない。指示書 §5.2） */
const THREAD_NOT_FOUND_OR_VISIBLE = 'Thread not found or not visible';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 高辻ナレッジ サイクル2 D11: embedding 生成・検索に使う OpenAI API キーを解決する。
 * 個人キー（`UserSettings`）→ 組織共通キー（環境変数 `DEVRELAY_EMBEDDING_API_KEY`）の順に
 * フォールバックする。他の `getOpenAiApiKey` 利用箇所（文書検索・自然言語モード等）には
 * 影響しない（この関数は knowledge-service.ts 内でのみ使う）。
 *
 * キーの値はログに出さない（長さだけなら将来デバッグ用に出してよいが、本関数自体はログを出さない）。
 */
export async function getEmbeddingApiKey(userId: string): Promise<string | null> {
  const personalKey = await getOpenAiApiKey(userId);
  if (personalKey) return personalKey;
  const orgKey = process.env.DEVRELAY_EMBEDDING_API_KEY;
  if (orgKey && orgKey.length > 0) return orgKey;
  return null;
}

/**
 * 高辻ナレッジ サイクル2: 検索・閲覧を行う人の実効権限を読む（検索 1 回・閲覧 1 回につき
 * 1 回だけ呼ぶ。指示書 §4.1）。`OrganizationMember` と `UserClearance` を 1 クエリずつ読み、
 * 行が無ければ既定値（組織未所属 / readLevel=0 / writeLevel=0 / compartments=[]）とする。
 */
export async function loadKnowledgeViewer(userId: string): Promise<KnowledgeViewer> {
  const [membership, clearance] = await Promise.all([
    prisma.organizationMember.findUnique({ where: { userId }, select: { organizationId: true, role: true } }),
    prisma.userClearance.findUnique({
      where: { userId },
      select: { readLevel: true, writeLevel: true, compartments: true },
    }),
  ]);
  return {
    userId,
    organizationId: membership?.organizationId ?? null,
    readLevel: clearance?.readLevel ?? 0,
    writeLevel: clearance?.writeLevel ?? 0,
    compartments: clearance?.compartments ?? [],
    isOrgAdmin: membership?.role === 'admin',
  };
}

/**
 * 高辻ナレッジ サイクル2: スレッド／案件の分類（level/compartment）を「閲覧・付与」できるかを
 * 判定する共通ヘルパー（`get_knowledge_thread` の書き込み権限ではなく、
 * `set_thread_classification` / `set_project_classification` / REST の GET・PUT が共有する判定）。
 *
 * - 本人（viewer === owner）→ 常に許可（指示書 §5.3「セッション所有者」／§6「組織なしの場合はプロジェクト所有者」）
 * - 同じ組織の admin/manager → 許可
 * - それ以外（別組織・組織なしの他人・組織ありだが admin/manager でない member）→ 拒否
 *
 * @param viewerUserId 操作しようとする人の User.id
 * @param ownerUserId 対象（スレッドの Session.userId、またはプロジェクトの Machine.userId）
 */
async function canManageClassificationFor(viewerUserId: string, ownerUserId: string): Promise<boolean> {
  if (viewerUserId === ownerUserId) {
    return true;
  }
  const [ownerMembership, viewerMembership] = await Promise.all([
    prisma.organizationMember.findUnique({ where: { userId: ownerUserId }, select: { organizationId: true } }),
    prisma.organizationMember.findUnique({ where: { userId: viewerUserId }, select: { organizationId: true, role: true } }),
  ]);
  if (!ownerMembership || !viewerMembership) {
    return false;
  }
  if (ownerMembership.organizationId !== viewerMembership.organizationId) {
    return false;
  }
  return viewerMembership.role === 'admin' || viewerMembership.role === 'manager';
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

    const apiKey = await getEmbeddingApiKey(userId);
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

/** `searchKnowledge` の結果 1 件（指示書 §6 のレスポンス例と同形。サイクル2 で owner* / isOwn / level / compartment を追加）。 */
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
  /** 高辻ナレッジ サイクル2 */
  ownerUserId: string;
  ownerName: string;
  isOwn: boolean;
  level: number;
  compartment: string | null;
}

/** `search_knowledge` のレスポンス先頭に付ける viewer 情報（「なぜ見えないか」を利用者が判断できるように）。 */
export interface KnowledgeSearchViewerSummary {
  readLevel: number;
  compartments: string[];
  organization: boolean;
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
      viewer: KnowledgeSearchViewerSummary;
    }
  | { ok: false; error: string };

/**
 * キーワード候補を DB から取得する（ILIKE、上位 `KEYWORD_CANDIDATE_LIMIT` 件）。
 * 順位は出現回数（textContent 中の query の出現頻度）降順 → occurredAt 降順。
 *
 * 高辻ナレッジ サイクル2: 所有者条件を `kc."userId" = $1` の固定から
 * `buildVisibilityPredicate`（可視判定）＋ `buildClassificationFilterPredicate`（追加絞り込み）
 * の動的 SQL に差し替えた。`$n` の採番はこの 2 つの戻り値の `nextIndex` を引き継ぐ
 * （指示書 §4.3: 判定は SQL 側で済ませ、アプリ側で後から弾かない＝上位 50 件の候補を削らない）。
 */
async function fetchKeywordCandidates(input: {
  viewer: KnowledgeViewer;
  scope: KnowledgeSearchScope;
  query: string;
  projectId?: string;
  kind: KnowledgeSearchKind;
  sinceDate?: Date;
  untilDate?: Date;
  compartment?: string;
  maxLevel?: number;
}): Promise<KnowledgeRankCandidate[]> {
  const queryParams: unknown[] = [`%${escapeLikePattern(input.query)}%`];
  const conditions: string[] = [`kc."textContent" ILIKE $1 ESCAPE '\\'`];
  let paramIndex = 2;

  const visibility = buildVisibilityPredicate(input.viewer, input.scope, paramIndex);
  conditions.push(visibility.sql);
  queryParams.push(...visibility.params);
  paramIndex = visibility.nextIndex;

  const classificationFilter = buildClassificationFilterPredicate(
    { compartment: input.compartment, maxLevel: input.maxLevel },
    paramIndex
  );
  if (classificationFilter.sql) {
    conditions.push(classificationFilter.sql);
    queryParams.push(...classificationFilter.params);
    paramIndex = classificationFilter.nextIndex;
  }

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

  // 出現回数カウント用の小文字化した生クエリ（ORDER BY でのみ使用。WHERE には使わない）
  const occurrenceCountIndex = paramIndex;
  queryParams.push(input.query.toLowerCase());

  const sql = `
    SELECT kc."sourceId" AS "sourceId", kc."chunkIndex" AS "chunkIndex", kc."occurredAt" AS "occurredAt"
    FROM "KnowledgeChunk" kc
    JOIN "Session" s ON s.id = kc."sessionId"
    JOIN "Project" p ON p.id = s."projectId"
    LEFT JOIN "OrganizationMember" om ON om."userId" = kc."userId"
    WHERE ${conditions.join(' AND ')}
    ORDER BY
      (length(lower(kc."textContent")) - length(replace(lower(kc."textContent"), $${occurrenceCountIndex}, ''))) DESC,
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
 * 所有者条件の差し替えは `fetchKeywordCandidates` と同じ（サイクル2）。`$1` はベクトル文字列
 * （ORDER BY の `$1::vector` キャストで使う）固定のため、可視判定は `$2` から始める。
 */
async function fetchVectorCandidates(input: {
  viewer: KnowledgeViewer;
  scope: KnowledgeSearchScope;
  query: string;
  apiKey: string;
  projectId?: string;
  kind: KnowledgeSearchKind;
  sinceDate?: Date;
  untilDate?: Date;
  compartment?: string;
  maxLevel?: number;
}): Promise<KnowledgeRankCandidate[]> {
  const [queryVector] = await generateEmbeddingVectors([input.query], input.apiKey);
  const vectorStr = `[${queryVector.join(',')}]`;

  const queryParams: unknown[] = [vectorStr];
  const conditions: string[] = [`kc."embeddingStatus" = 'done'`, `kc.embedding IS NOT NULL`];
  let paramIndex = 2;

  const visibility = buildVisibilityPredicate(input.viewer, input.scope, paramIndex);
  conditions.push(visibility.sql);
  queryParams.push(...visibility.params);
  paramIndex = visibility.nextIndex;

  const classificationFilter = buildClassificationFilterPredicate(
    { compartment: input.compartment, maxLevel: input.maxLevel },
    paramIndex
  );
  if (classificationFilter.sql) {
    conditions.push(classificationFilter.sql);
    queryParams.push(...classificationFilter.params);
    paramIndex = classificationFilter.nextIndex;
  }

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
    JOIN "Project" p ON p.id = s."projectId"
    LEFT JOIN "OrganizationMember" om ON om."userId" = kc."userId"
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
 *
 * 高辻ナレッジ サイクル2: 検索対象を自分の会話だけでなく、同じ組織で可視判定を通る他人の会話にも
 * 広げる（既定 `scope='all'`。`scope='mine'` でサイクル1 と同じ単一ユーザー検索に戻せる）。
 * SQL 側の可視判定（§4.3）に加えて、hydration 後の最終行を `isTurnVisible` で再評価する
 * （fail-closed の二重化。SQL が正しければ 1 行も落ちないが、SQL 側のバグがあっても漏洩ではなく
 * ログとして現れるようにする）。他人のターンが結果に含まれたら所有者ごとに 1 行監査する（D9）。
 */
export async function searchKnowledge(params: KnowledgeSearchParams): Promise<SearchKnowledgeResult> {
  const normalized = normalizeKnowledgeParams(params);
  if (!normalized.ok) {
    return { ok: false, error: normalized.error };
  }
  const { query, mode, projectId, kind, since, until, limit, scope, compartment, maxLevel } = normalized.params;

  const viewer = await loadKnowledgeViewer(params.userId);
  const viewerSummary: KnowledgeSearchViewerSummary = {
    readLevel: viewer.readLevel,
    compartments: viewer.compartments,
    organization: viewer.organizationId !== null,
  };

  const apiKey = await getEmbeddingApiKey(params.userId);
  const coverageDecision = decideKnowledgeCoverage({ mode, hasApiKey: !!apiKey });
  if (!coverageDecision.ok) {
    return { ok: false, error: coverageDecision.error };
  }
  const { runKeyword, runVector, coverage } = coverageDecision;

  const sinceDate = since ? new Date(since) : undefined;
  const untilDate = until ? new Date(until) : undefined;

  const keywordCandidates = runKeyword
    ? await fetchKeywordCandidates({ viewer, scope, query, projectId, kind, sinceDate, untilDate, compartment, maxLevel })
    : [];
  const vectorCandidates = runVector
    ? await fetchVectorCandidates({
        viewer,
        scope,
        query,
        apiKey: apiKey as string,
        projectId,
        kind,
        sinceDate,
        untilDate,
        compartment,
        maxLevel,
      })
    : [];

  const fused = fuseKnowledgeCandidates(keywordCandidates, vectorCandidates, limit);
  if (fused.length === 0) {
    return { ok: true, query, mode, coverage, total: 0, results: [], viewer: viewerSummary };
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
          userId: true,
          level: true,
          compartment: true,
          project: { select: { name: true, displayName: true, defaultLevel: true, defaultCompartment: true } },
        },
      })
    : [];
  const sessionMap = new Map(sessions.map((s) => [s.id, s]));

  // 高辻ナレッジ サイクル2: 所有者の組織 ID・表示名を解決する（監査・結果フィールド用。1 回のクエリで済ます）
  const ownerIds = [...new Set(sessions.map((s) => s.userId))];
  const [ownerMemberships, owners] = await Promise.all([
    ownerIds.length
      ? prisma.organizationMember.findMany({
          where: { userId: { in: ownerIds } },
          select: { userId: true, organizationId: true },
        })
      : Promise.resolve([] as Array<{ userId: string; organizationId: string }>),
    ownerIds.length
      ? prisma.user.findMany({ where: { id: { in: ownerIds } }, select: { id: true, name: true, email: true } })
      : Promise.resolve([] as Array<{ id: string; name: string | null; email: string | null }>),
  ]);
  const ownerOrgMap = new Map(ownerMemberships.map((m) => [m.userId, m.organizationId]));
  const ownerNameMap = new Map(owners.map((u) => [u.id, u.name ?? u.email ?? u.id]));

  const results: KnowledgeSearchResultItem[] = [];
  const visibleOtherOwnerIds: string[] = [];

  fused.forEach((f, index) => {
    const chunkRow = chunkMap.get(`${f.sourceId}:${f.bestChunkIndex}`);
    if (!chunkRow) return;
    const session = sessionMap.get(chunkRow.sessionId);
    if (!session) return;

    const effective = resolveEffectiveClassification(
      { level: session.level, compartment: session.compartment },
      { defaultLevel: session.project.defaultLevel, defaultCompartment: session.project.defaultCompartment }
    );
    const turn: TurnClassification = {
      ownerUserId: session.userId,
      ownerOrganizationId: ownerOrgMap.get(session.userId) ?? null,
      effectiveLevel: effective.level,
      effectiveCompartment: effective.compartment,
    };

    // fail-closed の二重化: SQL 側の可視判定が正しければ 1 行も落ちない。落ちた場合は
    // 情報漏洩として返さず、ログだけ出す（SQL 側のバグをログで可視化する。プランの追加）。
    if (!isTurnVisible(viewer, turn)) {
      console.error('[Knowledge] visibility mismatch (dropped from results):', {
        viewerId: viewer.userId,
        ownerId: session.userId,
        sessionId: session.id,
      });
      return;
    }

    const isOwn = session.userId === viewer.userId;
    if (!isOwn) {
      visibleOtherOwnerIds.push(session.userId);
    }

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
      ownerUserId: session.userId,
      ownerName: ownerNameMap.get(session.userId) ?? session.userId,
      isOwn,
      level: effective.level,
      compartment: effective.compartment,
    });
  });

  // 高辻ナレッジ サイクル2 D9: 他人のターンが結果に含まれたら所有者ごとに 1 行監査する（fire-and-forget）
  const auditTargets = decideAuditTargets(viewer.userId, visibleOtherOwnerIds);
  for (const ownerId of auditTargets) {
    recordSupervisionAudit(
      viewer.userId,
      ownerId,
      'search_knowledge',
      JSON.stringify({ query, mode, count: results.length })
    );
  }

  return { ok: true, query, mode, coverage, total: results.length, results, viewer: viewerSummary };
}

/**
 * 高辻ナレッジ サイクル4: 検索結果カード（ターン）の全文を取得する。`searchKnowledge` が
 * hydration する `snippet` は最良チャンク 1 個の抜粋のみだが、ナレッジ回答の context には
 * 同一ターンの兄弟チャンク（`chunkIndex` 0..chunkCount-1）をすべて連結した全文が必要
 * （指示書 D2「同一ターンの複数チャンク連結」）。
 *
 * `isTurnVisible` で可視判定を再チェックする fail-closed の二重化（`searchKnowledge` 本体の
 * 二重チェックと同じ考え方。検索時点で可視だったはずだが、ここでも独立して守る）。
 *
 * @param viewerUserId 要求者（AI に渡してよいかの可視判定に使う）
 * @param turns 対象ターン（検索結果の `aiMessageId`/`sessionId` の組。重複は呼び出し側で排除不要）
 * @returns `aiMessageId` → 連結済み全文 の Map（不可視・不存在・チャンク無しのターンは含まれない）
 */
export async function loadKnowledgeTurnTexts(
  viewerUserId: string,
  turns: Array<{ sourceId: string; sessionId: string }>
): Promise<Map<string, string>> {
  if (turns.length === 0) {
    return new Map();
  }

  const viewer = await loadKnowledgeViewer(viewerUserId);

  const sessionIds = [...new Set(turns.map((t) => t.sessionId))];
  const sessions = await prisma.session.findMany({
    where: { id: { in: sessionIds } },
    select: {
      id: true,
      userId: true,
      level: true,
      compartment: true,
      project: { select: { defaultLevel: true, defaultCompartment: true } },
    },
  });
  const sessionMap = new Map(sessions.map((s) => [s.id, s]));

  const ownerIds = [...new Set(sessions.map((s) => s.userId))];
  const ownerMemberships = ownerIds.length
    ? await prisma.organizationMember.findMany({
        where: { userId: { in: ownerIds } },
        select: { userId: true, organizationId: true },
      })
    : [];
  const ownerOrgMap = new Map(ownerMemberships.map((m) => [m.userId, m.organizationId]));

  const chunkRows = await prisma.knowledgeChunk.findMany({
    where: {
      OR: turns.map((t) => ({ sourceType: KNOWLEDGE_SOURCE_TYPE_TURN, sourceId: t.sourceId })),
    },
    select: { sourceId: true, chunkIndex: true, textContent: true },
    orderBy: [{ sourceId: 'asc' }, { chunkIndex: 'asc' }],
  });

  const chunksByTurn = new Map<string, string[]>();
  for (const row of chunkRows) {
    const arr = chunksByTurn.get(row.sourceId) ?? [];
    arr[row.chunkIndex] = row.textContent;
    chunksByTurn.set(row.sourceId, arr);
  }

  const result = new Map<string, string>();
  for (const turn of turns) {
    const session = sessionMap.get(turn.sessionId);
    if (!session) continue;

    const effective = resolveEffectiveClassification(
      { level: session.level, compartment: session.compartment },
      { defaultLevel: session.project.defaultLevel, defaultCompartment: session.project.defaultCompartment }
    );
    const turnClassification: TurnClassification = {
      ownerUserId: session.userId,
      ownerOrganizationId: ownerOrgMap.get(session.userId) ?? null,
      effectiveLevel: effective.level,
      effectiveCompartment: effective.compartment,
    };

    if (!isTurnVisible(viewer, turnClassification)) {
      console.error('[Knowledge] loadKnowledgeTurnTexts: visibility mismatch (dropped):', {
        viewerId: viewerUserId,
        ownerId: session.userId,
        sessionId: turn.sessionId,
      });
      continue;
    }

    const chunks = chunksByTurn.get(turn.sourceId);
    if (!chunks || chunks.length === 0) continue;
    const joined = chunks.filter((c) => typeof c === 'string' && c.length > 0).join('\n\n');
    if (joined.length > 0) {
      result.set(turn.sourceId, joined);
    }
  }

  return result;
}

/** `getKnowledgeThread` の入力。 */
export interface GetKnowledgeThreadParams {
  viewerUserId: string;
  sessionId: string;
  /** 既定 50、最大 200（`get_conversation_history` と同じ規則） */
  limit?: number;
  before?: string;
  after?: string;
  /** true なら各メッセージ本文の末尾を残す（既定は先頭） */
  tail?: boolean;
}

/** `getKnowledgeThread` が返すメッセージ 1 件。 */
export interface KnowledgeThreadMessage {
  id: string;
  role: string;
  content: string;
  truncated: boolean;
  truncatedSide?: 'head' | 'tail';
  timestamp: string;
}

/** `getKnowledgeThread` の戻り値（判別可能ユニオン）。 */
export type GetKnowledgeThreadResult =
  | {
      ok: true;
      sessionId: string;
      threadTitle: string | null;
      kind: string | null;
      projectId: string;
      projectName: string;
      ownerUserId: string;
      ownerName: string;
      isOwn: boolean;
      level: number;
      compartment: string | null;
      messages: KnowledgeThreadMessage[];
      count: number;
      hasMore: boolean;
    }
  | { ok: false; error: string };

/**
 * 高辻ナレッジ サイクル2: 他人のスレッドを可視判定つきで 1 件読む（MCP `get_knowledge_thread` /
 * REST `GET /api/knowledge/threads/:sessionId` の共通実装。指示書 §5.2）。
 *
 * 不可視・不存在のどちらも同一文言（`THREAD_NOT_FOUND_OR_VISIBLE`）を返す（存在の有無を漏らさない）。
 * 他人のスレッドを読んだ場合は `recordSupervisionAudit` で監査する（本人操作では記録しない）。
 * 添付ファイル（images 等）は返さない（`get_attachment` が自分スコープのままのため。非スコープ）。
 */
export async function getKnowledgeThread(params: GetKnowledgeThreadParams): Promise<GetKnowledgeThreadResult> {
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);

  const session = await prisma.session.findUnique({
    where: { id: params.sessionId },
    select: {
      id: true,
      userId: true,
      title: true,
      kind: true,
      projectId: true,
      level: true,
      compartment: true,
      project: { select: { name: true, displayName: true, defaultLevel: true, defaultCompartment: true } },
    },
  });
  if (!session) {
    return { ok: false, error: THREAD_NOT_FOUND_OR_VISIBLE };
  }

  const [viewer, ownerMembership] = await Promise.all([
    loadKnowledgeViewer(params.viewerUserId),
    prisma.organizationMember.findUnique({ where: { userId: session.userId }, select: { organizationId: true } }),
  ]);

  const effective = resolveEffectiveClassification(
    { level: session.level, compartment: session.compartment },
    { defaultLevel: session.project.defaultLevel, defaultCompartment: session.project.defaultCompartment }
  );
  const turn: TurnClassification = {
    ownerUserId: session.userId,
    ownerOrganizationId: ownerMembership?.organizationId ?? null,
    effectiveLevel: effective.level,
    effectiveCompartment: effective.compartment,
  };

  if (!isTurnVisible(viewer, turn)) {
    // 存在の有無を漏らさない（不可視・不存在どちらも同一文言）
    return { ok: false, error: THREAD_NOT_FOUND_OR_VISIBLE };
  }

  const isOwn = session.userId === viewer.userId;
  const keepSide: 'head' | 'tail' = params.tail === true ? 'tail' : 'head';
  const createdAtFilter: Record<string, Date> = {};
  if (params.before) createdAtFilter.lt = new Date(params.before);
  if (params.after) createdAtFilter.gt = new Date(params.after);
  // サイクル3: `before` のみ指定時は「X の直前 limit 件」を返すため desc で取得し、下で reverse() して asc に戻す
  // （`before` のみでの asc+take は「全体の最古 limit 件」になってしまうバグの修正。knowledge-rank.ts 参照）。
  const pageOrder = resolveThreadPageOrder({ before: params.before, after: params.after });

  const [rows, owner] = await Promise.all([
    prisma.message.findMany({
      where: {
        sessionId: params.sessionId,
        role: { in: ['user', 'ai'] },
        ...(Object.keys(createdAtFilter).length > 0 ? { createdAt: createdAtFilter } : {}),
      },
      select: { id: true, role: true, content: true, createdAt: true },
      orderBy: { createdAt: pageOrder },
      take: limit,
    }),
    prisma.user.findUnique({ where: { id: session.userId }, select: { name: true, email: true } }),
  ]);
  const messages = pageOrder === 'desc' ? [...rows].reverse() : rows;
  const ownerName = owner?.name ?? owner?.email ?? session.userId;

  if (!isOwn) {
    recordSupervisionAudit(
      viewer.userId,
      session.userId,
      'view_messages',
      JSON.stringify({ via: 'knowledge', sessionId: params.sessionId })
    );
  }

  return {
    ok: true,
    sessionId: session.id,
    threadTitle: session.title,
    kind: session.kind,
    projectId: session.projectId,
    projectName: session.project.displayName || session.project.name,
    ownerUserId: session.userId,
    ownerName,
    isOwn,
    level: effective.level,
    compartment: effective.compartment,
    messages: messages.map((m) => {
      const t = truncateOnLineBoundary(m.content, CONVERSATION_MAX_CONTENT_LENGTH, keepSide);
      return {
        id: m.id,
        role: m.role,
        content: t.content,
        truncated: t.truncated,
        ...(t.truncatedSide ? { truncatedSide: t.truncatedSide } : {}),
        timestamp: m.createdAt.toISOString(),
      };
    }),
    count: messages.length,
    hasMore: messages.length === limit,
  };
}

/** `setThreadClassification` の入力（省略 = 変更なし、`null` = 継承に戻す）。 */
export interface SetThreadClassificationParams {
  viewerUserId: string;
  sessionId: string;
  level?: number | null;
  compartment?: string | null;
}

/** 分類の「生の値＋実効値」（変更前後をそれぞれ返す形）。 */
export interface ClassificationSnapshot {
  level: number | null;
  compartment: string | null;
  effectiveLevel: number;
  effectiveCompartment: string | null;
}

/** `setThreadClassification` の戻り値。 */
export type SetThreadClassificationResult =
  | { ok: true; before: ClassificationSnapshot; after: ClassificationSnapshot }
  | { ok: false; error: string };

/**
 * 高辻ナレッジ サイクル2: スレッド（Session）の機密度を付与・変更する（指示書 §5.3）。
 * 権限: セッション所有者、または同じ組織の admin/manager（`canManageClassificationFor`）。
 * 加えて `canAssignClassification`（指示書 §4.4: writeLevel/compartments による付与制限。
 * 7→3 のような引き下げも、現在値に対して同じ判定を行う。admin はバイパス）。
 */
export async function setThreadClassification(
  params: SetThreadClassificationParams
): Promise<SetThreadClassificationResult> {
  const session = await prisma.session.findUnique({
    where: { id: params.sessionId },
    select: {
      id: true,
      userId: true,
      level: true,
      compartment: true,
      project: { select: { defaultLevel: true, defaultCompartment: true } },
    },
  });
  if (!session) {
    return { ok: false, error: 'Session not found' };
  }

  const canManage = await canManageClassificationFor(params.viewerUserId, session.userId);
  if (!canManage) {
    return { ok: false, error: 'Forbidden: not the thread owner and not an organization admin/manager' };
  }

  let nextLevel = session.level;
  if (params.level !== undefined) {
    const levelCheck = normalizeLevel(params.level);
    if (!levelCheck.ok) return levelCheck;
    nextLevel = levelCheck.value;
  }
  let nextCompartment = session.compartment;
  if (params.compartment !== undefined) {
    const compartmentCheck = normalizeCompartment(params.compartment);
    if (!compartmentCheck.ok) return compartmentCheck;
    nextCompartment = compartmentCheck.value;
  }

  const current: ClassificationValue = { level: session.level, compartment: session.compartment };
  const next: ClassificationValue = { level: nextLevel, compartment: nextCompartment };

  const viewer = await loadKnowledgeViewer(params.viewerUserId);
  const permission = canAssignClassification(viewer, current, next);
  if (!permission.ok) {
    return permission;
  }

  await prisma.session.update({
    where: { id: params.sessionId },
    data: { level: next.level, compartment: next.compartment },
  });

  const beforeEffective = resolveEffectiveClassification(current, session.project);
  const afterEffective = resolveEffectiveClassification(next, session.project);

  return {
    ok: true,
    before: { ...current, effectiveLevel: beforeEffective.level, effectiveCompartment: beforeEffective.compartment },
    after: { ...next, effectiveLevel: afterEffective.level, effectiveCompartment: afterEffective.compartment },
  };
}

/** `getThreadClassification` の戻り値。 */
export type GetThreadClassificationResult =
  | { ok: true; snapshot: ClassificationSnapshot }
  | { ok: false; error: string };

/**
 * `GET /api/threads/:sessionId/classification` の実装。権限は `setThreadClassification` と同じ
 * （`canManageClassificationFor`）。
 */
export async function getThreadClassification(params: {
  viewerUserId: string;
  sessionId: string;
}): Promise<GetThreadClassificationResult> {
  const session = await prisma.session.findUnique({
    where: { id: params.sessionId },
    select: {
      userId: true,
      level: true,
      compartment: true,
      project: { select: { defaultLevel: true, defaultCompartment: true } },
    },
  });
  if (!session) {
    return { ok: false, error: 'Session not found' };
  }
  const canManage = await canManageClassificationFor(params.viewerUserId, session.userId);
  if (!canManage) {
    return { ok: false, error: 'Forbidden: not the thread owner and not an organization admin/manager' };
  }
  const effective = resolveEffectiveClassification(
    { level: session.level, compartment: session.compartment },
    session.project
  );
  return {
    ok: true,
    snapshot: {
      level: session.level,
      compartment: session.compartment,
      effectiveLevel: effective.level,
      effectiveCompartment: effective.compartment,
    },
  };
}

/** `setProjectClassification` の入力（省略 = 変更なし、`null` = level 0・壁なしに戻す）。 */
export interface SetProjectClassificationParams {
  viewerUserId: string;
  projectId: string;
  level?: number | null;
  compartment?: string | null;
}

/** `setProjectClassification` / `getProjectClassification` の戻り値。 */
export type ProjectClassificationResult =
  | { ok: true; before: ClassificationValue; after: ClassificationValue }
  | { ok: false; error: string };

/**
 * 高辻ナレッジ サイクル2: 案件（Project）の既定値（defaultLevel/defaultCompartment）を変更する
 * （指示書 §6）。権限: 組織 admin/manager、または（組織なしの場合）プロジェクト所有者
 * （`canManageClassificationFor` を Project.machine.userId に対して適用）。
 */
export async function setProjectClassification(
  params: SetProjectClassificationParams
): Promise<ProjectClassificationResult> {
  const project = await prisma.project.findUnique({
    where: { id: params.projectId },
    select: { defaultLevel: true, defaultCompartment: true, machine: { select: { userId: true } } },
  });
  if (!project) {
    return { ok: false, error: 'Project not found' };
  }

  const canManage = await canManageClassificationFor(params.viewerUserId, project.machine.userId);
  if (!canManage) {
    return { ok: false, error: 'Forbidden: not an organization admin/manager and not the project owner' };
  }

  let nextLevel = project.defaultLevel;
  if (params.level !== undefined) {
    const levelCheck = normalizeLevel(params.level);
    if (!levelCheck.ok) return levelCheck;
    nextLevel = levelCheck.value;
  }
  let nextCompartment = project.defaultCompartment;
  if (params.compartment !== undefined) {
    const compartmentCheck = normalizeCompartment(params.compartment);
    if (!compartmentCheck.ok) return compartmentCheck;
    nextCompartment = compartmentCheck.value;
  }

  const current: ClassificationValue = { level: project.defaultLevel, compartment: project.defaultCompartment };
  const next: ClassificationValue = { level: nextLevel, compartment: nextCompartment };

  const viewer = await loadKnowledgeViewer(params.viewerUserId);
  const permission = canAssignClassification(viewer, current, next);
  if (!permission.ok) {
    return permission;
  }

  await prisma.project.update({
    where: { id: params.projectId },
    data: { defaultLevel: next.level, defaultCompartment: next.compartment },
  });

  return { ok: true, before: current, after: next };
}

/**
 * `GET /api/projects/:projectId/classification` の実装。権限は `setProjectClassification` と同じ。
 */
export async function getProjectClassification(params: {
  viewerUserId: string;
  projectId: string;
}): Promise<ProjectClassificationResult> {
  const project = await prisma.project.findUnique({
    where: { id: params.projectId },
    select: { defaultLevel: true, defaultCompartment: true, machine: { select: { userId: true } } },
  });
  if (!project) {
    return { ok: false, error: 'Project not found' };
  }
  const canManage = await canManageClassificationFor(params.viewerUserId, project.machine.userId);
  if (!canManage) {
    return { ok: false, error: 'Forbidden: not an organization admin/manager and not the project owner' };
  }
  const current: ClassificationValue = { level: project.defaultLevel, compartment: project.defaultCompartment };
  return { ok: true, before: current, after: current };
}
