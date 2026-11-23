/**
 * AI 回答契約サイクル（2026-11-23 第3版）: `splitAiResponse()`（純関数）の結果から、
 * 実際に配信する本文と詳細ページの URL を決定するサービス層（DB アクセス・トークン発行・
 * 要約 AI 呼び出しを含む）。
 *
 * 方針: **情報を落とさない**。詳細ページへのリンクが作れない場合（キルスイッチ OFF・
 * messageId 無し・一時セッション・トークン発行失敗・要約失敗）は、詳細を隠さずそのまま
 * 本文に含めて返す。
 *
 * 2段構え:
 * 1. AI が境界行（`<!-- devrelay:detail -->`）を書いていれば、それに従って分ける（無料・即時）
 * 2. 書いていなければ、本文が十分長い場合に限り、個人の AI プロバイダー設定で要約する
 *    （`reply-summary.ts`。境界行を書かない AI ツールでも同じ体験になる保険）
 */

import { isEphemeralSessionId } from './thread-scope.js';
import { isBriefReplyEnabled } from './brief-reply-rules.js';
import { isResponseShareEnabled, isShareExpired, buildShareUrl, daysRemaining } from './response-share-rules.js';
import { ensureShareToken, resolveShareTtlDaysForSession } from './response-share.js';
import { splitAiResponse, hasDetailSection, joinWithoutLink } from './response-split-rules.js';
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
 * ライブ配信用（`finalizeProgress()` から呼ぶ）。詳細があり条件が揃っていれば
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

  const result = splitAiResponse(rawContent);
  const ephemeral = isEphemeralSessionId(sessionId);

  if (hasDetailSection(result)) {
    // 1. AI が境界行を書いていた場合（無料の近道）
    if (isResponseShareEnabled(process.env.DEVRELAY_RESPONSE_SHARE) && messageId && !ephemeral) {
      try {
        const ttlDays = await resolveShareTtlDaysForSession(sessionId);
        const token = await ensureShareToken(messageId, ttlDays);
        if (token) {
          return { chatText: result.summary, shareUrl: buildShareUrl(token, process.env), ttlDays };
        }
      } catch (err) {
        console.error('[ResponseSplit] resolveLiveDeliveryContent: failed to issue share link:', (err as Error).message);
      }
    }
    // リンクを作れない場合は詳細を隠さない（情報を落とさないことを優先する）
    return { chatText: joinWithoutLink(result), shareUrl: null, ttlDays: null };
  }

  // 2. 境界行が無かった場合: 十分長ければ要約 AI で保険をかける
  const minChars = resolveSummaryMinChars(process.env.DEVRELAY_REPLY_SUMMARY_MIN_CHARS);
  if (
    isReplySummaryEnabled(process.env.DEVRELAY_REPLY_SUMMARY) &&
    messageId &&
    !ephemeral &&
    shouldSummarize({ length: result.summary.length, minChars })
  ) {
    const summary = await generateReplySummary({ messageId, sessionId, content: result.summary });
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
      // リンクを作れない場合、要約だけを見せると詳細が消えるため、元の本文をそのまま使う
    }
  }

  return { chatText: result.summary, shareUrl: null, ttlDays: null };
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

  const result = splitAiResponse(message.content);
  const shareable = isResponseShareEnabled(process.env.DEVRELAY_RESPONSE_SHARE) && !!message.shareToken && !isShareExpired(message.shareExpiresAt);

  if (hasDetailSection(result)) {
    if (shareable) {
      const ttlDays = daysRemaining(message.shareExpiresAt);
      return { chatText: result.summary, shareUrl: buildShareUrl(message.shareToken as string, process.env), ttlDays };
    }
    return { chatText: joinWithoutLink(result), shareUrl: null, ttlDays: null };
  }

  // 境界行が無い場合: 保存済みの AI 要約（summary 列）があればそれを使う
  if (message.summary && shareable) {
    const ttlDays = daysRemaining(message.shareExpiresAt);
    return { chatText: message.summary, shareUrl: buildShareUrl(message.shareToken as string, process.env), ttlDays };
  }

  return { chatText: message.content, shareUrl: null, ttlDays: null };
}
