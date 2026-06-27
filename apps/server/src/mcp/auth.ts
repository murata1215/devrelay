/**
 * MCP エンドポイントの認証
 *
 * v1: Bearer トークン（既存 AuthSession テーブルで検証）
 * v2: OAuth 2.1 + Dynamic Client Registration
 */

import type { FastifyRequest } from 'fastify';
import { prisma } from '../db/client.js';

/**
 * MCP リクエストの Bearer トークンを検証し、userId を返す。
 * 認証失敗時は null を返す。
 */
export async function authenticateMcp(request: FastifyRequest): Promise<string | null> {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }

  const token = authHeader.substring(7);
  if (!token) return null;

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
