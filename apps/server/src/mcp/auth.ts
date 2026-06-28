/**
 * MCP エンドポイントの認証
 *
 * OAuth トークンも通常の AuthSession も、全て AuthSession テーブルで検証。
 * OAuth トークン発行時に AuthSession に永続化するため、メモリ Map は不要。
 */

import type { FastifyRequest } from 'fastify';
import { prisma } from '../db/client.js';

/**
 * MCP リクエストの Bearer トークンを検証し、userId を返す。
 * AuthSession テーブルで検証（OAuth トークンも通常 Bearer も同一テーブル）。
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
