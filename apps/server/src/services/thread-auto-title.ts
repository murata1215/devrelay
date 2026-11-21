/**
 * スレッドタイトル自動命名（0033、2026-11-21）の I/O 本体。
 *
 * `agent-manager.ts` の `handleAiOutput()` が AI 応答を保存した直後に fire-and-forget で呼ぶ。
 * 判定・プロンプト・整形は `thread-auto-title-rules.ts`（純関数）に置き、ここは DB と AI 呼び出しだけ。
 *
 * - 鍵は `DEVRELAY_ANSWER_API_KEY`（組織共通・用途別の専用キー）のみ。未設定なら何もしない
 *   （個人キーや OPENAI_API_KEY にはフォールバックしない＝ナレッジ回答と同じ方針）。
 * - 失敗はすべて握りつぶしてログ 1 行（応答の配信や保存には一切影響させない）。
 * - 保存は `title IS NULL` を条件に `autoTitle` 列だけへ書く（ユーザー命名を絶対に上書きしない）。
 */
import { isTraditionalCommand } from '@devrelay/shared';
import { prisma } from '../db/client.js';
import { resolveChatProvider } from './chat-provider.js';
import { resolveAnswerKey } from './knowledge-answer-rules.js';
import { isEphemeralSessionId } from './thread-scope.js';
import { stripAiNoise, stripCommandTag } from './thread-label-source.js';
import {
  isThreadAutoTitleEnabled,
  shouldGenerateAutoTitle,
  pickTitleSourceMessages,
  hasAutoTitleMaterial,
  buildAutoTitleUserPrompt,
  parseAutoTitle,
  AUTO_TITLE_SYSTEM_PROMPT,
} from './thread-auto-title-rules.js';

const AI_TIMEOUT_MS = 30_000;

/** 同じスレッドで生成が並走しないためのガード（プロセス内）。 */
const inFlight = new Set<string>();

/** 鍵未設定のログは起動後 1 回だけ出す。 */
let loggedNoKey = false;

/**
 * 1 ターン分の AI 応答保存後に呼ぶ。節目でなければ DB を 2 回読むだけで終わる。
 */
export async function maybeGenerateThreadAutoTitle(sessionId: string): Promise<void> {
  if (!isThreadAutoTitleEnabled(process.env.DEVRELAY_THREAD_AUTO_TITLE)) return;
  if (isEphemeralSessionId(sessionId)) return;
  if (inFlight.has(sessionId)) return;

  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { id: true, title: true, autoTitleTurns: true, handoverNote: true },
  });
  if (!session) return;

  const aiTurnCount = await prisma.message.count({ where: { sessionId, role: 'ai' } });
  if (!shouldGenerateAutoTitle({ aiTurnCount, title: session.title, autoTitleTurns: session.autoTitleTurns })) return;

  const key = resolveAnswerKey({ envAnswerKey: process.env.DEVRELAY_ANSWER_API_KEY, envModel: process.env.DEVRELAY_ANSWER_MODEL });
  if (!key.ok) {
    if (!loggedNoKey) {
      loggedNoKey = true;
      console.log('ℹ️  [AutoTitle] DEVRELAY_ANSWER_API_KEY が未設定のため、スレッドタイトルの自動命名は行いません');
    }
    return;
  }

  inFlight.add(sessionId);
  try {
    const userRows = await prisma.message.findMany({
      where: { sessionId, role: 'user' },
      orderBy: { createdAt: 'asc' },
      take: 50,
      select: { content: true },
    });
    const userMessages = userRows
      .map((r) => stripCommandTag(r.content))
      .filter((c): c is string => !!c && !isTraditionalCommand(c));

    const lastAi = await prisma.message.findFirst({
      where: { sessionId, role: 'ai' },
      orderBy: { createdAt: 'desc' },
      select: { content: true },
    });
    const aiExcerpt = stripAiNoise(lastAi?.content?.slice(0, 4000) ?? null);

    const material = { handoverNote: session.handoverNote, userMessages: pickTitleSourceMessages(userMessages) };
    if (!hasAutoTitleMaterial(material)) return;

    const provider = await resolveChatProvider('thread-auto-title', key.provider, key.apiKey, key.model);
    const result = await Promise.race([
      provider.chat({
        system: AUTO_TITLE_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildAutoTitleUserPrompt({ ...material, aiExcerpt }) }],
        jsonMode: true,
        maxTokens: 100,
        temperature: 0.2,
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timeout ${AI_TIMEOUT_MS}ms`)), AI_TIMEOUT_MS)),
    ]);
    const autoTitle = parseAutoTitle(result.text);
    if (!autoTitle) {
      console.warn(`⚠️  [AutoTitle] AI の応答を題名として解釈できませんでした: session=${sessionId}`);
      return;
    }
    // ユーザーが生成中に手動命名した場合に備え、title IS NULL を条件に書く
    const updated = await prisma.session.updateMany({
      where: { id: sessionId, title: null },
      data: { autoTitle, autoTitleAt: new Date(), autoTitleTurns: aiTurnCount },
    });
    if (updated.count > 0) {
      console.log(`🏷️  [AutoTitle] session=${sessionId} turn=${aiTurnCount} → ${autoTitle}`);
    }
  } finally {
    inFlight.delete(sessionId);
  }
}
