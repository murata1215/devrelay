/**
 * AI 回答契約サイクル（2026-11-23 第3版）: `splitAiResponse()`（純関数）の結果から、
 * 実際に配信する本文と詳細ページの URL を決定するサービス層（DB アクセス・トークン発行・
 * 要約 AI 呼び出しを含む）。
 *
 * 方針: **情報を落とさない**。DB の `Message.content` は要約前の元文として保持し、
 * 本文用の要約は `Message.summary` に別保存する。詳細ページへのリンクが作れない場合
 * （キルスイッチ OFF・messageId 無し・一時セッション・トークン発行失敗・要約失敗）は、
 * 元文をそのまま本文に含めて返す。
 *
 * 本文と詳細の二重表示を防ぐため、AI が書いた境界行の前半を本文として再利用しない。
 * 十分長い元文は常に個人の AI プロバイダー設定で要約し、共有ページには元文を出す。
 */

import { isEphemeralSessionId } from './thread-scope.js';
import { isBriefReplyEnabled } from './brief-reply-rules.js';
import { isResponseShareEnabled, isShareExpired, buildShareUrl, daysRemaining } from './response-share-rules.js';
import { ensureShareToken, resolveShareTtlDaysForSession } from './response-share.js';
import { cleanAiResponse } from './response-split-rules.js';
import { isReplySummaryEnabled, resolveSummaryMinChars, shouldSummarize } from './reply-summary-rules.js';
import { generateReplySummary } from './reply-summary.js';

export interface DeliveryContent {
  /** チャット/WebUI に表示する本文（詳細を分けられた場合は人間向け本文のみ）。 */
  chatText: string;
  /** 詳細ページの URL（無ければ null）。 */
  shareUrl: string | null;
  /** 共有トークンの有効日数（`shareUrl` が無ければ null）。案内文に使う。 */
  ttlDays: number | null;
}

/**
 * ライブ配信用（`finalizeProgress()` から呼ぶ）。元文の要約が作れて条件が揃っていれば
 * 共有トークンを新規発行する（既存トークンがあれば再利用、`ensureShareToken` 参照）。
 */
export async function resolveLiveDeliveryContent(
  rawContent: string,
  sessionId: string,
  messageId: string | undefined,
): Promise<DeliveryContent> {
  if (!isBriefReplyEnabled(process.env.DEVRELAY_BRIEF_REPLY)) {
    return { chatText: rawContent, shareUrl: null, ttlDays: null };
  }

  const original = cleanAiResponse(rawContent);
  const ephemeral = isEphemeralSessionId(sessionId);
  const minChars = resolveSummaryMinChars(process.env.DEVRELAY_REPLY_SUMMARY_MIN_CHARS);
  if (
    isReplySummaryEnabled(process.env.DEVRELAY_REPLY_SUMMARY) &&
    messageId &&
    !ephemeral &&
    shouldSummarize({ length: original.length, minChars })
  ) {
    const summary = await generateReplySummary({ messageId, sessionId, content: original });
    if (summary) {
      if (isResponseShareEnabled(process.env.DEVRELAY_RESPONSE_SHARE)) {
        try {
          const ttlDays = await resolveShareTtlDaysForSession(sessionId);
          const token = await ensureShareToken(messageId, ttlDays);
          if (token) {
            return { chatText: summary, shareUrl: buildShareUrl(token, process.env), ttlDays };
          }
        } catch (err) {
          console.error('[ResponseSplit] resolveLiveDeliveryContent: failed to issue share link for AI summary:', (err as Error).message);
        }
      }
      // リンクを作れない場合、要約だけを見せると元文が読めなくなるため、元文を使う
    }
  }

  return { chatText: original, shareUrl: null, ttlDays: null };
}

/**
 * 保存済みメッセージの読み出し用（REST 履歴 API）。新規に要約 AI は呼ばず、既存の
 * `summary`/`shareToken`/`shareExpiresAt`（DB に保存済みなら）だけを見る。
 */
export function resolveStoredDeliveryContent(message: {
  content: string;
  summary: string | null;
  shareToken: string | null;
  shareExpiresAt: Date | null;
}): DeliveryContent {
  if (!isBriefReplyEnabled(process.env.DEVRELAY_BRIEF_REPLY)) {
    return { chatText: message.content, shareUrl: null, ttlDays: null };
  }

  const shareable = isResponseShareEnabled(process.env.DEVRELAY_RESPONSE_SHARE) && !!message.shareToken && !isShareExpired(message.shareExpiresAt);
  // 保存済みの AI 要約があり、元文を開ける場合だけ本文を短くする。
  if (message.summary && shareable) {
    const ttlDays = daysRemaining(message.shareExpiresAt);
    return { chatText: message.summary, shareUrl: buildShareUrl(message.shareToken as string, process.env), ttlDays };
  }

  return { chatText: cleanAiResponse(message.content), shareUrl: null, ttlDays: null };
}
