/**
 * MCP エンドポイントの認証
 *
 * OAuth 2.1 アクセストークン → 既存 AuthSession (Bearer) の順で検証。
 * OAuth トークンはメモリ Map で管理（oauth.ts の oauthAccessTokens）。
 * AuthSession トークンは DB で検証（後方互換）。
 */

import type { FastifyRequest } from 'fastify';
import { prisma } from '../db/client.js';
import { verifyOAuthToken } from './oauth.js';

/**
 * MCP リクエストの Bearer トークンを検証し、userId を返す。
 * OAuth アクセストークン → 既存 AuthSession の順でフォールバック。
 * 認証失敗時は null を返す。
 */
export async function authenticateMcp(request: FastifyRequest): Promise<string | null> {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }

  const token = authHeader.substring(7);
  if (!token) return null;

  // 1. OAuth アクセストークンを検証（メモリ Map）
  const oauthUserId = verifyOAuthToken(token);
  if (oauthUserId) {
    return oauthUserId;
  }

  // 2. 既存 AuthSession (Bearer) で検証（後方互換）
  try {
    const session = await prisma.authSession.findUnique({
      where: { token },
      include: { user: true },
    });

    if (!session || session.expiresAt < new Date()) {
      return null;
    }

    return session.user.id;
  } catch {
    return null;
  }
}
