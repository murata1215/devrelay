/**
 * 埋め込み（embedding）生成サービス
 *
 * MessageFile のテキスト内容から OpenAI text-embedding-3-small で
 * 1536 次元のベクトル埋め込みを生成し、pgvector カラムに保存する。
 *
 * - テキスト系ファイル（text/*, json, yaml 等）のみ処理
 * - バイナリファイル（画像, PDF, ZIP 等）は embeddingStatus = 'skipped'
 * - OpenAI API キーがない場合も 'skipped'
 * - fire-and-forget パターンで非同期実行（呼び出し元をブロックしない）
 */

import OpenAI from 'openai';
import { prisma } from '../db/client.js';
import { getOpenAiApiKey } from './user-settings.js';

/** embedding モデル名 */
const EMBEDDING_MODEL = 'text-embedding-3-small';

/** embedding 次元数 */
const EMBEDDING_DIMENSIONS = 1536;

/** テキスト抽出可能な MIME タイプのプレフィックス・完全一致リスト */
const TEXT_MIME_PREFIXES = ['text/'];
const TEXT_MIME_EXACT = [
  'application/json',
  'application/xml',
  'application/javascript',
  'application/typescript',
  'application/x-yaml',
  'application/x-sh',
];

/** テキスト抽出時の最大文字数（embedding モデルのトークン上限を考慮） */
const MAX_TEXT_LENGTH = 30000;

/**
 * MIME タイプがテキスト系かどうかを判定
 * @param mimeType - ファイルの MIME タイプ
 * @returns テキスト抽出可能なら true
 */
function isTextMimeType(mimeType: string): boolean {
  if (TEXT_MIME_PREFIXES.some(prefix => mimeType.startsWith(prefix))) {
    return true;
  }
  return TEXT_MIME_EXACT.includes(mimeType);
}

/**
 * MessageFile からテキストを抽出
 * @param content - ファイル内容（Buffer / Uint8Array）
 * @param mimeType - MIME タイプ
 * @returns 抽出テキスト。テキスト抽出不可の場合は null
 */
function extractText(content: Buffer | Uint8Array, mimeType: string): string | null {
  if (!isTextMimeType(mimeType)) {
    return null;
  }

  try {
    const text = Buffer.from(content).toString('utf-8');
    // 空ファイルはスキップ
    if (text.trim().length === 0) {
      return null;
    }
    // 最大文字数で切り詰め（embedding モデルのトークン上限対策）
    return text.length > MAX_TEXT_LENGTH ? text.substring(0, MAX_TEXT_LENGTH) : text;
  } catch {
    return null;
  }
}

/**
 * OpenAI API で埋め込みベクトルを生成
 * @param text - 埋め込み対象テキスト
 * @param apiKey - OpenAI API キー
 * @returns 1536 次元のベクトル配列
 */
async function generateEmbeddingVector(text: string, apiKey: string): Promise<number[]> {
  const openai = new OpenAI({ apiKey });
  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text,
    dimensions: EMBEDDING_DIMENSIONS,
  });
  return response.data[0].embedding;
}

/**
 * MessageFile の userId を取得（MessageFile → Message → Session → userId）
 * @param messageId - メッセージ ID
 * @returns ユーザー ID。見つからない場合は null
 */
async function getUserIdFromMessageId(messageId: string): Promise<string | null> {
  const message = await prisma.message.findUnique({
    where: { id: messageId },
    select: {
      session: {
        select: { userId: true },
      },
    },
  });
  return message?.session?.userId ?? null;
}

/**
 * 単一の MessageFile に対して埋め込みを生成・保存する
 * fire-and-forget で呼び出すため、エラーはログに出力して握りつぶす。
 *
 * @param messageFileId - 対象 MessageFile の ID
 */
export async function processMessageFileEmbedding(messageFileId: string): Promise<void> {
  try {
    // MessageFile を取得
    const file = await prisma.messageFile.findUnique({
      where: { id: messageFileId },
    });
    if (!file) {
      console.error(`[Embedding] MessageFile not found: ${messageFileId}`);
      return;
    }

    // 既に処理済みならスキップ
    if (file.embeddingStatus !== 'none') {
      return;
    }

    // テキスト抽出
    const textContent = extractText(file.content, file.mimeType);
    if (!textContent) {
      // バイナリファイルまたは空ファイル → skipped
      await prisma.messageFile.update({
        where: { id: messageFileId },
        data: { embeddingStatus: 'skipped' },
      });
      console.log(`[Embedding] Skipped (non-text): ${file.filename}`);
      return;
    }

    // ユーザー ID を取得して OpenAI API キーを確認
    const userId = await getUserIdFromMessageId(file.messageId);
    if (!userId) {
      await prisma.messageFile.update({
        where: { id: messageFileId },
        data: { textContent, embeddingStatus: 'skipped' },
      });
      console.log(`[Embedding] Skipped (no user): ${file.filename}`);
      return;
    }

    const apiKey = await getOpenAiApiKey(userId);
    if (!apiKey) {
      // API キーなし → テキストは保存するが embedding はスキップ
      await prisma.messageFile.update({
        where: { id: messageFileId },
        data: { textContent, embeddingStatus: 'skipped' },
      });
      console.log(`[Embedding] Skipped (no API key): ${file.filename}`);
      return;
    }

    // processing 状態に更新
    await prisma.messageFile.update({
      where: { id: messageFileId },
      data: { textContent, embeddingStatus: 'processing' },
    });

    // embedding 生成
    const vector = await generateEmbeddingVector(textContent, apiKey);

    // pgvector カラムに保存（Prisma 非対応型のため raw SQL）
    const vectorStr = `[${vector.join(',')}]`;
    await prisma.$executeRawUnsafe(
      `UPDATE "MessageFile" SET embedding = $1::vector, "embeddingStatus" = 'done' WHERE id = $2`,
      vectorStr,
      messageFileId,
    );

    console.log(`[Embedding] Done: ${file.filename} (${textContent.length} chars)`);
  } catch (error: any) {
    // エラー時は failed に更新
    console.error(`[Embedding] Failed for ${messageFileId}:`, error.message);
    try {
      await prisma.messageFile.update({
        where: { id: messageFileId },
        data: { embeddingStatus: 'failed' },
      });
    } catch {
      // 更新すら失敗した場合は無視
    }
  }
}

/**
 * メッセージに紐づく全 MessageFile の埋め込みを非同期で生成する
 * fire-and-forget パターン: 呼び出し元は await せずに呼ぶ。
 *
 * @param messageId - 対象メッセージの ID
 */
export async function processMessageFilesEmbedding(messageId: string): Promise<void> {
  try {
    const files = await prisma.messageFile.findMany({
      where: { messageId, embeddingStatus: 'none' },
      select: { id: true },
    });

    for (const file of files) {
      await processMessageFileEmbedding(file.id);
    }
  } catch (error: any) {
    console.error(`[Embedding] Failed to process files for message ${messageId}:`, error.message);
  }
}

/**
 * ベクトル類似検索: クエリテキストに類似する MessageFile を検索
 *
 * @param userId - 検索対象ユーザー ID
 * @param query - 検索クエリテキスト
 * @param apiKey - OpenAI API キー（クエリの embedding 生成用）
 * @param limit - 返却する最大件数（デフォルト 5）
 * @returns 類似度の高い順に並んだ検索結果
 */
export async function searchSimilarDocuments(
  userId: string,
  query: string,
  apiKey: string,
  limit: number = 5,
): Promise<Array<{
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  direction: string;
  textContent: string;
  similarity: number;
  createdAt: Date;
  sessionId: string;
  projectName: string;
}>> {
  // クエリの embedding を生成
  const queryVector = await generateEmbeddingVector(query, apiKey);
  const vectorStr = `[${queryVector.join(',')}]`;

  // pgvector cosine distance 検索（1 - cosine_distance = similarity）
  const results = await prisma.$queryRawUnsafe<Array<{
    id: string;
    filename: string;
    mimeType: string;
    size: number;
    direction: string;
    textContent: string;
    similarity: number;
    createdAt: Date;
    sessionId: string;
    projectName: string;
  }>>(
    `SELECT
       mf.id,
       mf.filename,
       mf."mimeType",
       mf.size,
       mf.direction,
       mf."textContent",
       1 - (mf.embedding <=> $1::vector) as similarity,
       mf."createdAt",
       s.id as "sessionId",
       p.name as "projectName"
     FROM "MessageFile" mf
     JOIN "Message" m ON m.id = mf."messageId"
     JOIN "Session" s ON s.id = m."sessionId"
     JOIN "Project" p ON p.id = s."projectId"
     WHERE mf."embeddingStatus" = 'done'
       AND s."userId" = $2
       AND mf.embedding IS NOT NULL
     ORDER BY mf.embedding <=> $1::vector
     LIMIT $3`,
    vectorStr,
    userId,
    limit,
  );

  return results;
}
