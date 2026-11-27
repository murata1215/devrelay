/**
 * AI 回答契約サイクル（2026-11-27）: 保存された AI 応答の元文から、個人の AI プロバイダー設定
 * （設定画面「返事の要約」、未設定なら Build Summary を流用）で本文用要約を作る I/O 本体。
 *
 * - 鍵は本人（セッションの持ち主）の個人設定のみ（`getApiKeyForReplySummary`）。
 *   組織共通キー（`DEVRELAY_ANSWER_API_KEY`）にはフォールバックしない
 *   （費用の持ち主を「各自の作業は各自の財布で」と明確にするため）。
 * - 失敗・鍵未設定はすべて握りつぶして null を返す（呼び出し側は元の本文を使う＝情報を落とさない）。
 * - 成功したら `Message.summary` に保存する（履歴 API 再取得時に再要約しないため）。
 */

import { prisma } from '../db/client.js';
import { resolveChatProvider } from './chat-provider.js';
import { getApiKeyForReplySummary } from './user-settings.js';
import { REPLY_SUMMARY_SYSTEM_PROMPT, buildReplySummaryUserPrompt, normalizeSummary } from './reply-summary-rules.js';

const AI_TIMEOUT_MS = 30_000;
const SUMMARY_MAX_TOKENS = 1500;

/** 鍵未設定のログは起動後 1 回だけ出す。 */
let loggedNoKey = false;

/**
 * AI 応答の元文（進捗ノイズ除去済み）を人間向けに要約する。
 *
 * @param input.messageId 要約を保存する対象の `Message.id`
 * @param input.sessionId セッションの持ち主（個人キー解決用）
 * @param input.content 要約対象の本文
 * @returns 要約文。鍵未設定・生成失敗・検証 NG のいずれかなら null（呼び出し側は元の本文を使う）
 */
export async function generateReplySummary(input: { messageId: string; sessionId: string; content: string }): Promise<string | null> {
  try {
    const session = await prisma.session.findUnique({ where: { id: input.sessionId }, select: { userId: true } });
    if (!session) return null;

    const key = await getApiKeyForReplySummary(session.userId);
    if (!key) {
      if (!loggedNoKey) {
        loggedNoKey = true;
        console.log('ℹ️  [ReplySummary] 返事の要約に使う AI プロバイダーが未設定のため、要約は行いません（設定画面「返事の要約」または「Build Summary」）');
      }
      return null;
    }

    const provider = await resolveChatProvider('reply-summary', key.provider, key.apiKey);
    const result = await Promise.race([
      provider.chat({
        system: REPLY_SUMMARY_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildReplySummaryUserPrompt(input.content) }],
        jsonMode: false,
        maxTokens: SUMMARY_MAX_TOKENS,
        temperature: 0.3,
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timeout ${AI_TIMEOUT_MS}ms`)), AI_TIMEOUT_MS)),
    ]);

    const summary = normalizeSummary(result.text, input.content);
    if (!summary) return null;

    await prisma.message.update({ where: { id: input.messageId }, data: { summary } }).catch((err) => {
      console.error('[ReplySummary] failed to save summary:', (err as Error).message);
    });

    return summary;
  } catch (err) {
    console.error('[ReplySummary] generateReplySummary failed:', (err as Error).message);
    return null;
  }
}
