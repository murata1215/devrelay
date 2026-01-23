import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { prisma } from '../db/client.js';

// トークン生成
function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

// セッション有効期限（30日）
const SESSION_EXPIRES_DAYS = 30;

// 認証ミドルウェア
export async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  // まずヘッダーからトークンを取得
  let token: string | undefined;
  const authHeader = request.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  }

  // ヘッダーになければクエリパラメータから取得（ダウンロード用）
  if (!token) {
    const query = request.query as { token?: string };
    token = query.token;
  }

  if (!token) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }

  const session = await prisma.authSession.findUnique({
    where: { token },
    include: { user: true },
  });

  if (!session || session.expiresAt < new Date()) {
    return reply.status(401).send({ error: 'Session expired' });
  }

  // @ts-ignore - Fastify リクエストにユーザー情報を追加
  request.user = session.user;
}

// ユーザー情報のレスポンス形式
function formatUser(user: { id: string; email: string | null; name: string | null }) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
  };
}

export async function authRoutes(app: FastifyInstance) {
  // 登録
  app.post('/api/auth/register', async (request, reply) => {
    const { email, password, name } = request.body as {
      email: string;
      password: string;
      name?: string;
    };

    if (!email || !password) {
      return reply.status(400).send({ error: 'Email and password are required' });
    }

    // 既存ユーザーチェック
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return reply.status(400).send({ error: 'Email already registered' });
    }

    // パスワードハッシュ化
    const passwordHash = await bcrypt.hash(password, 10);

    // ユーザー作成
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash,
        name: name || email.split('@')[0],
      },
    });

    // セッション作成
    const token = generateToken();
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + SESSION_EXPIRES_DAYS);

    await prisma.authSession.create({
      data: {
        userId: user.id,
        token,
        expiresAt,
      },
    });

    return {
      user: formatUser(user),
      token,
    };
  });

  // ログイン
  app.post('/api/auth/login', async (request, reply) => {
    const { email, password } = request.body as {
      email: string;
      password: string;
    };

    if (!email || !password) {
      return reply.status(400).send({ error: 'Email and password are required' });
    }

    // ユーザー検索
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !user.passwordHash) {
      return reply.status(401).send({ error: 'Invalid credentials' });
    }

    // パスワード検証
    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return reply.status(401).send({ error: 'Invalid credentials' });
    }

    // セッション作成
    const token = generateToken();
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + SESSION_EXPIRES_DAYS);

    await prisma.authSession.create({
      data: {
        userId: user.id,
        token,
        expiresAt,
      },
    });

    return {
      user: formatUser(user),
      token,
    };
  });

  // ログアウト
  app.post('/api/auth/logout', { preHandler: authenticate }, async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      await prisma.authSession.delete({ where: { token } }).catch(() => {});
    }
    return { success: true };
  });

  // 現在のユーザー情報
  app.get('/api/auth/me', { preHandler: authenticate }, async (request) => {
    // @ts-ignore
    const user = request.user;
    return { user: formatUser(user) };
  });

  // Google OAuth (プレースホルダー - 後で実装)
  app.get('/api/auth/google', async (request, reply) => {
    // TODO: Google OAuth 実装
    return reply.status(501).send({ error: 'Google OAuth not implemented yet' });
  });

  app.get('/api/auth/google/callback', async (request, reply) => {
    // TODO: Google OAuth コールバック実装
    return reply.status(501).send({ error: 'Google OAuth not implemented yet' });
  });
}
