/**
 * 高辻ナレッジ サイクル1 — 既存会話の全件バックフィル CLI。
 *
 * 実行方法: `pnpm --filter server knowledge:backfill [options]`
 * （`package.json` の `knowledge:backfill` スクリプトが `node dist/scripts/knowledge-backfill.js` を実行。
 * ビルド済み dist から動かすため、事前に `pnpm build` が必要）
 *
 * オプション:
 *   --user <userId>       対象を 1 ユーザーに絞る（省略時は全ユーザー）
 *   --project <projectId> 対象を 1 プロジェクトに絞る
 *   --since <ISO>         この日時以降の AI メッセージのみ対象
 *   --limit <N>           Phase A で新規に行を作るターン数の上限
 *   --dry-run             件数と推定トークン数だけ出す（文字数 ÷ 2 の概算）。DB へは書き込まない
 *   --no-embed            Phase A（行作成）のみ実行し、Phase B（embedding）は行わない
 *   --retry-failed        Phase B で 'failed' / 'skipped' も再試行対象にする
 *
 * 対象: `role='ai'` の Message のうち `KnowledgeChunk(sourceType='turn', sourceId=id)` が
 * 存在しないもの。`occurredAt` 昇順に処理。冪等・再開可能（途中で止めて再実行しても重複しない）。
 * `DEVRELAY_KNOWLEDGE` は見ない（明示実行なのでキルスイッチの対象外。D9）。
 */

import { prisma } from '../db/client.js';
import { buildEphemeralSessionIdExclusion } from '../services/thread-scope.js';
import { createTurnChunkRows, embedPendingChunks, listUserIdsWithPendingChunks } from '../services/knowledge-service.js';
import { getOpenAiApiKey } from '../services/user-settings.js';
import { KNOWLEDGE_SOURCE_TYPE_TURN } from '../services/knowledge-chunker.js';

/** Phase A で 1 回に DB から取得する Message のページサイズ */
const PAGE_SIZE = 200;

/** Phase B で 1 回の embedding API 呼び出しに渡すチャンク数（指示書 §4.2） */
const EMBED_BATCH_SIZE = 32;

/** text-embedding-3-small の概算単価（USD / 100万トークン） */
const EMBEDDING_PRICE_PER_MILLION_TOKENS = 0.02;

interface Args {
  userId: string | null;
  projectId: string | null;
  since: string | null;
  limit: number | null;
  dryRun: boolean;
  noEmbed: boolean;
  retryFailed: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    userId: null,
    projectId: null,
    since: null,
    limit: null,
    dryRun: false,
    noEmbed: false,
    retryFailed: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--user') args.userId = argv[++i] ?? null;
    else if (a === '--project') args.projectId = argv[++i] ?? null;
    else if (a === '--since') args.since = argv[++i] ?? null;
    else if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--no-embed') args.noEmbed = true;
    else if (a === '--retry-failed') args.retryFailed = true;
  }
  return args;
}

function log(msg: string): void {
  console.log(msg);
}

function fail(msg: string): never {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

/** Phase A の候補となる Message の `where` を組み立てる（一時セッション除外・--user/--project/--since）。 */
function buildEligibleMessageWhere(args: Args) {
  return {
    role: 'ai' as const,
    session: {
      ...buildEphemeralSessionIdExclusion(),
      ...(args.userId ? { userId: args.userId } : {}),
      ...(args.projectId ? { projectId: args.projectId } : {}),
    },
    ...(args.since ? { createdAt: { gte: new Date(args.since) } } : {}),
  };
}

/** `--dry-run`: 件数と推定トークン数（文字数 ÷ 2 の概算）だけ出す。DB へは書き込まない。 */
async function runDryRun(args: Args): Promise<void> {
  const where = buildEligibleMessageWhere(args);
  let cursor: string | undefined;
  let scanned = 0;
  let eligibleNew = 0;
  let totalChars = 0;

  for (;;) {
    const batch = await prisma.message.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      take: PAGE_SIZE,
      select: { id: true, content: true },
    });
    if (batch.length === 0) break;
    cursor = batch[batch.length - 1].id;
    scanned += batch.length;

    const existing = await prisma.knowledgeChunk.findMany({
      where: { sourceType: KNOWLEDGE_SOURCE_TYPE_TURN, sourceId: { in: batch.map((m) => m.id) } },
      select: { sourceId: true },
      distinct: ['sourceId'],
    });
    const existingIds = new Set(existing.map((e) => e.sourceId));

    for (const msg of batch) {
      if (existingIds.has(msg.id)) continue;
      eligibleNew++;
      totalChars += msg.content.length;
      if (args.limit !== null && eligibleNew >= args.limit) break;
    }
    if (args.limit !== null && eligibleNew >= args.limit) break;
  }

  const estimatedTokens = Math.round(totalChars / 2);
  const estimatedCostUsd = (estimatedTokens / 1_000_000) * EMBEDDING_PRICE_PER_MILLION_TOKENS;
  log(`📊 dry-run（概算。実際のチャンク分割・ヘッダ追加前の AI 本文長が基準）`);
  log(`  スキャンした AI メッセージ: ${scanned}`);
  log(`  新規作成対象のターン数: ${eligibleNew}`);
  log(`  推定トークン数（文字数 ÷ 2）: ${estimatedTokens.toLocaleString()}`);
  log(`  推定 embedding コスト: $${estimatedCostUsd.toFixed(4)}（text-embedding-3-small, $${EMBEDDING_PRICE_PER_MILLION_TOKENS}/1M tokens 換算、概算）`);
}

/** Phase A: チャンク行の作成のみ（embedding には触れない）。 */
async function runPhaseA(args: Args): Promise<{ scanned: number; created: number; chunksCreated: number; skippedExisting: number; skippedIneligible: number }> {
  const where = buildEligibleMessageWhere(args);
  let cursor: string | undefined;
  let scanned = 0;
  let created = 0;
  let chunksCreated = 0;
  let skippedExisting = 0;
  let skippedIneligible = 0;

  log('— Phase A: チャンク行の作成 —');

  outer: for (;;) {
    const batch = await prisma.message.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      take: PAGE_SIZE,
      select: { id: true },
    });
    if (batch.length === 0) break;
    cursor = batch[batch.length - 1].id;

    const existing = await prisma.knowledgeChunk.findMany({
      where: { sourceType: KNOWLEDGE_SOURCE_TYPE_TURN, sourceId: { in: batch.map((m) => m.id) } },
      select: { sourceId: true },
      distinct: ['sourceId'],
    });
    const existingIds = new Set(existing.map((e) => e.sourceId));

    for (const msg of batch) {
      scanned++;
      if (existingIds.has(msg.id)) {
        skippedExisting++;
        continue;
      }
      const result = await createTurnChunkRows(msg.id);
      if (!result) {
        skippedIneligible++;
        continue;
      }
      created++;
      chunksCreated += result.chunkCount;

      if (created % 100 === 0) {
        log(`  処理済み(新規作成): ${created} / 作成チャンク数: ${chunksCreated}`);
      }
      if (args.limit !== null && created >= args.limit) {
        break outer;
      }
    }
  }

  log(`Phase A 完了: scanned=${scanned} created=${created} chunksCreated=${chunksCreated} skippedExisting=${skippedExisting} skippedIneligible=${skippedIneligible}`);
  return { scanned, created, chunksCreated, skippedExisting, skippedIneligible };
}

/** Phase B: 未 embedding（または再試行対象）のチャンクを 32 件ずつ埋める。ユーザーごとにキーを切り替える。 */
async function runPhaseB(args: Args): Promise<{ processed: number; done: number; failed: number; skippedNoKey: number; charsSubmitted: number }> {
  const statuses: Array<'none' | 'failed' | 'skipped'> = args.retryFailed ? ['none', 'failed', 'skipped'] : ['none'];
  const userIds = args.userId ? [args.userId] : await listUserIdsWithPendingChunks(statuses, args.projectId ?? undefined);

  let processed = 0;
  let done = 0;
  let failed = 0;
  let skippedNoKey = 0;
  let charsSubmitted = 0;

  log('— Phase B: embedding の生成 —');
  log(`  対象ユーザー数: ${userIds.length}`);

  for (const userId of userIds) {
    const apiKey = await getOpenAiApiKey(userId);
    if (!apiKey) {
      const result = await prisma.knowledgeChunk.updateMany({
        where: {
          userId,
          embeddingStatus: { in: statuses },
          ...(args.projectId ? { projectId: args.projectId } : {}),
        },
        data: { embeddingStatus: 'skipped' },
      });
      skippedNoKey += result.count;
      continue;
    }

    for (;;) {
      const result = await embedPendingChunks({
        userId,
        apiKey,
        statuses,
        limit: EMBED_BATCH_SIZE,
        projectId: args.projectId ?? undefined,
      });
      if (result.attempted === 0) break;
      processed += result.attempted;
      done += result.done;
      failed += result.failed;
      charsSubmitted += result.charsSubmitted;
      if (processed % 100 < EMBED_BATCH_SIZE) {
        log(`  処理済み: ${processed} / done: ${done} / failed: ${failed}`);
      }
    }
  }

  log(`Phase B 完了: processed=${processed} done=${done} failed=${failed} skippedNoKey=${skippedNoKey}`);
  return { processed, done, failed, skippedNoKey, charsSubmitted };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.limit !== null && (!Number.isInteger(args.limit) || args.limit < 1)) {
    fail('--limit must be a positive integer');
  }
  if (args.since !== null && Number.isNaN(Date.parse(args.since))) {
    fail('--since must be a valid ISO date string');
  }

  if (args.dryRun) {
    await runDryRun(args);
    return;
  }

  const phaseA = await runPhaseA(args);

  if (args.noEmbed) {
    log('--no-embed 指定のため Phase B（embedding）はスキップしました。');
    return;
  }

  const phaseB = await runPhaseB(args);

  const actualTokens = Math.round(phaseB.charsSubmitted / 2);
  const actualCostUsd = (actualTokens / 1_000_000) * EMBEDDING_PRICE_PER_MILLION_TOKENS;
  log('— サマリ —');
  log(`Phase A: scanned=${phaseA.scanned} created=${phaseA.created} chunksCreated=${phaseA.chunksCreated} skippedExisting=${phaseA.skippedExisting} skippedIneligible=${phaseA.skippedIneligible}`);
  log(`Phase B: processed=${phaseB.processed} done=${phaseB.done} failed=${phaseB.failed} skippedNoKey=${phaseB.skippedNoKey}`);
  log(`実コスト目安: 送信文字数=${phaseB.charsSubmitted.toLocaleString()} 推定トークン数(÷2)=${actualTokens.toLocaleString()} 推定コスト=$${actualCostUsd.toFixed(4)}（text-embedding-3-small, $${EMBEDDING_PRICE_PER_MILLION_TOKENS}/1M tokens 換算、概算）`);
}

main()
  .catch((err) => {
    fail(err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err));
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
