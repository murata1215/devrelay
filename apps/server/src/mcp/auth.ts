/**
 * MCP エンドポイントの認証
 *
 * OAuth トークンも通常の AuthSession も、全て AuthSession テーブルで検証。
 * OAuth トークン発行時に AuthSession に永続化するため、メモリ Map は不要。
 */

import type { FastifyRequest } from 'fastify';
import crypto from 'crypto';
import { prisma } from '../db/client.js';
import { checkIpAllowed } from '../services/org-control.js';

/** PAT プレフィクス（devrelay_pat_ で始まるトークンは PAT として検証） */
const PAT_PREFIX = 'devrelay_pat_';

/** lastUsedAt 更新の最小間隔（5分） — 高頻度アクセスで毎回 UPDATE しないための閾値 */
const LAST_USED_UPDATE_INTERVAL_MS = 5 * 60 * 1000;

// セッションのスライド延長設定（auth.ts と同一ポリシー）
const SESSION_EXPIRES_DAYS = 30;
const SESSION_RENEW_THRESHOLD_DAYS = 15;

/**
 * セッションのスライド延長（MCP 経路用）。
 * 残り有効期限が閾値未満のとき expiresAt を now+30日 に延長する。
 * fire-and-forget で認証レイテンシに影響を与えない。
 */
function maybeExtendSession(sessionId: string, currentExpiresAt: Date): void {
  const now = Date.now();
  const renewThresholdMs = SESSION_RENEW_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;
  if (currentExpiresAt.getTime() - now >= renewThresholdMs) {
    return;
  }
  const newExpiresAt = new Date();
  newExpiresAt.setDate(newExpiresAt.getDate() + SESSION_EXPIRES_DAYS);
  prisma.authSession
    .update({ where: { id: sessionId }, data: { expiresAt: newExpiresAt } })
    .catch(() => {
      /* 延長失敗は致命的でない */
    });
}

/**
 * MCP リクエストの Bearer トークンを検証し、userId を返す。
 * - devrelay_pat_ プレフィクス → PersonalAccessToken テーブルで SHA-256 検証（#271）
 * - それ以外 → AuthSession テーブルで検証（OAuth トークンも通常 Bearer も同一テーブル）
 */
export async function authenticateMcp(request: FastifyRequest): Promise<string | null> {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }

  const token = authHeader.substring(7);
  if (!token) return null;

  try {
    let userId: string | null;

    // PAT（Personal Access Token）の場合
    if (token.startsWith(PAT_PREFIX)) {
      userId = await authenticateWithPat(token);
    } else {
      // 既存の AuthSession 検証
      const session = await prisma.authSession.findUnique({
        where: { token },
        include: { user: true },
      });

      if (!session || session.expiresAt < new Date()) {
        return null;
      }

      // 利用中のセッションはスライド延長する
      maybeExtendSession(session.id, session.expiresAt);
      userId = session.user.id;
    }

    if (!userId) return null;

    // 組織 IP アクセス制限（#285）: 許可レンジ外なら認証失敗として扱う
    const ipCheck = await checkIpAllowed(userId, request.ip);
    if (!ipCheck.allowed) {
      return null;
    }

    return userId;
  } catch {
    return null;
  }
}

/**
 * Personal Access Token を SHA-256 ハッシュで検証し、userId を返す。
 * lastUsedAt は前回更新から 5 分以上経過時のみ fire-and-forget で更新。
 */
async function authenticateWithPat(token: string): Promise<string | null> {
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

  const pat = await prisma.personalAccessToken.findUnique({
    where: { tokenHash },
    select: { id: true, userId: true, revokedAt: true, lastUsedAt: true },
  });

  if (!pat || pat.revokedAt) {
    return null;
  }

  // lastUsedAt を閾値方式で更新（fire-and-forget）
  const now = Date.now();
  const lastUsed = pat.lastUsedAt?.getTime() ?? 0;
  if (now - lastUsed >= LAST_USED_UPDATE_INTERVAL_MS) {
    prisma.personalAccessToken
      .update({ where: { id: pat.id }, data: { lastUsedAt: new Date() } })
      .catch(() => { /* 更新失敗は致命的でない */ });
  }

  return pat.userId;
}
