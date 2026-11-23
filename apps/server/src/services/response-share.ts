/**
 * 応答の書式サイクル（2026-11-23）: AI 応答の公開共有リンクの DB 書き込み・トークン発行・
 * 期限切れ掃除を担うサービス。純粋な判定ロジックは `response-share-rules.ts` に分離してある。
 */

import crypto from 'crypto';
import { prisma } from '../db/client.js';
import { getUserSetting, SettingKeys } from './user-settings.js';
import { resolveShareTtlDays } from './response-share-rules.js';

/** 新規トークン文字列を発行する（Usage サイネージの `crypto.randomBytes(24).toString('base64url')` と同じ形式）。 */
function generateShareToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

/**
 * 指定メッセージに共有トークンが無ければ新規発行して DB に保存し、トークンを返す。
 * 既にトークンがある場合はそれをそのまま返す（再試行しても新しいトークンを発行しない＝
 * 一度配布した URL を変えない）。失敗時は null を返す（呼び出し側はリンクを付けずに続行する）。
 */
export async function ensureShareToken(messageId: string, ttlDays: number): Promise<string | null> {
  try {
    const existing = await prisma.message.findUnique({ where: { id: messageId }, select: { shareToken: true } });
    if (existing?.shareToken) return existing.shareToken;

    const token = generateShareToken();
    const shareExpiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
    await prisma.message.update({ where: { id: messageId }, data: { shareToken: token, shareExpiresAt } });
    return token;
  } catch (err) {
    console.error('[ResponseShare] ensureShareToken failed:', (err as Error).message);
    return null;
  }
}

/**
 * セッションの持ち主の個人設定（上書き）を考慮した有効 TTL（日数）を解決する。
 * 個人設定が無い/不正なら `DEVRELAY_SHARE_TTL_DAYS` → 既定 30 日の順にフォールバックする。
 * 失敗時も安全側（env/既定値）にフォールバックする。
 */
export async function resolveShareTtlDaysForSession(sessionId: string): Promise<number> {
  try {
    const session = await prisma.session.findUnique({ where: { id: sessionId }, select: { userId: true } });
    const userRaw = session ? await getUserSetting(session.userId, SettingKeys.RESPONSE_SHARE_TTL_DAYS) : null;
    return resolveShareTtlDays(process.env.DEVRELAY_SHARE_TTL_DAYS, userRaw);
  } catch (err) {
    console.error('[ResponseShare] resolveShareTtlDaysForSession failed:', (err as Error).message);
    return resolveShareTtlDays(process.env.DEVRELAY_SHARE_TTL_DAYS, null);
  }
}

/**
 * 期限切れの共有トークンを無効化する定期清掃。`shareExpiresAt` を過ぎた行の
 * `shareToken`/`shareExpiresAt` を null に戻す（= リンクが失効する）。
 * `Message.content` 本体は一切書き換えない（会話履歴・ナレッジ・コスト集計を保つため）。
 */
export async function cleanupExpiredShareTokens(): Promise<number> {
  const result = await prisma.message.updateMany({
    where: { shareToken: { not: null }, shareExpiresAt: { lt: new Date() } },
    data: { shareToken: null, shareExpiresAt: null },
  });
  return result.count;
}
