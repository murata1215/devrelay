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

  // ========================================
  // Google OAuth
  // ========================================

  const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
  const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

  /**
   * リダイレクト URI を動的に構築（リクエストの Host ヘッダーから）
   * Caddy プロキシ経由の場合は X-Forwarded-Proto/Host を考慮
   */
  function getGoogleCallbackUrl(request: FastifyRequest): string {
    const host = request.headers['x-forwarded-host'] || request.headers.host || 'localhost:3005';
    const proto = request.headers['x-forwarded-proto'] === 'https' || String(host).includes('devrelay.io') ? 'https' : 'http';
    return `${proto}://${host}/api/auth/google/callback`;
  }

  /** Google 認可 URL にリダイレクト */
  app.get('/api/auth/google', async (request, reply) => {
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
      return reply.status(501).send({ error: 'Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env' });
    }

    const callbackUrl = getGoogleCallbackUrl(request);
    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', GOOGLE_CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', callbackUrl);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', 'openid email profile');
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'select_account');

    return reply.redirect(authUrl.toString());
  });

  /** Google OAuth コールバック: code → token 交換 → userinfo → ユーザー作成/検索 → セッション発行 */
  app.get('/api/auth/google/callback', async (request, reply) => {
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
      return reply.status(501).send({ error: 'Google OAuth is not configured' });
    }

    const { code, error: oauthError } = request.query as { code?: string; error?: string };

    // ユーザーが承認を拒否した場合
    if (oauthError) {
      return reply.redirect('/login?error=google_denied');
    }

    if (!code) {
      return reply.redirect('/login?error=google_no_code');
    }

    try {
      const callbackUrl = getGoogleCallbackUrl(request);

      // 1. code → access_token 交換
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: GOOGLE_CLIENT_ID,
          client_secret: GOOGLE_CLIENT_SECRET,
          redirect_uri: callbackUrl,
          grant_type: 'authorization_code',
        }),
      });

      if (!tokenRes.ok) {
        console.error('Google token exchange failed:', await tokenRes.text());
        return reply.redirect('/login?error=google_token_failed');
      }

      const tokenData = await tokenRes.json() as { access_token: string };

      // 2. access_token → userinfo 取得
      const userinfoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });

      if (!userinfoRes.ok) {
        console.error('Google userinfo failed:', await userinfoRes.text());
        return reply.redirect('/login?error=google_userinfo_failed');
      }

      const userinfo = await userinfoRes.json() as {
        id: string;       // Google のユーザー ID
        email: string;
        name?: string;
        picture?: string;
      };

      // 3. ユーザー検索/作成
      // 3a. googleId で検索
      let user = await prisma.user.findUnique({ where: { googleId: userinfo.id } });

      if (!user && userinfo.email) {
        // 3b. email で検索 → googleId を紐付け
        user = await prisma.user.findUnique({ where: { email: userinfo.email } });
        if (user) {
          user = await prisma.user.update({
            where: { id: user.id },
            data: { googleId: userinfo.id },
          });
          console.log(`🔗 Google account linked to existing user: ${userinfo.email}`);
        }
      }

      if (!user) {
        // 3c. 新規ユーザー作成
        user = await prisma.user.create({
          data: {
            email: userinfo.email,
            googleId: userinfo.id,
            name: userinfo.name || userinfo.email.split('@')[0],
            // passwordHash は null（Google 認証のみ）
          },
        });
        console.log(`✅ New user created via Google OAuth: ${userinfo.email}`);
      }

      // 4. セッション作成
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

      // 5. WebUI にリダイレクト（token をクエリパラメータで渡す）
      return reply.redirect(`/auth/callback?token=${token}`);
    } catch (err) {
      console.error('Google OAuth error:', err);
      return reply.redirect('/login?error=google_error');
    }
  });

  /**
   * Flutter ネイティブ認証用: Google ID Token を検証してセッション発行
   * google_sign_in パッケージで取得した ID Token をサーバーで検証し、
   * DevRelay セッショントークンを発行する
   */
  app.post('/api/auth/google/token', async (request, reply) => {
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
      return reply.status(501).send({
        error: 'Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env',
      });
    }

    const { idToken } = request.body as { idToken?: string };
    if (!idToken) {
      return reply.status(400).send({ error: 'idToken is required' });
    }

    try {
      // 1. Google の tokeninfo エンドポイントで ID Token を検証
      const verifyRes = await fetch(
        `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`
      );

      if (!verifyRes.ok) {
        console.error('Google ID token verification failed:', await verifyRes.text());
        return reply.status(401).send({ error: 'Invalid Google ID token' });
      }

      const payload = await verifyRes.json() as {
        sub: string;      // Google ユーザー ID
        email?: string;
        name?: string;
        aud: string;       // audience（Client ID）
      };

      // 2. aud（audience）が自分の Client ID であることを検証
      if (payload.aud !== GOOGLE_CLIENT_ID) {
        console.error(`Google ID token aud mismatch: expected ${GOOGLE_CLIENT_ID}, got ${payload.aud}`);
        return reply.status(401).send({ error: 'Invalid Google ID token audience' });
      }

      const googleId = payload.sub;
      const email = payload.email;
      const name = payload.name || (email ? email.split('@')[0] : 'User');

      // 3. ユーザー検索/作成（既存コールバックと同じロジック）
      // 3a. googleId で検索
      let user = await prisma.user.findUnique({ where: { googleId } });

      if (!user && email) {
        // 3b. email で検索 → googleId を紐付け
        user = await prisma.user.findUnique({ where: { email } });
        if (user) {
          user = await prisma.user.update({
            where: { id: user.id },
            data: { googleId },
          });
          console.log(`🔗 Google account linked to existing user via ID token: ${email}`);
        }
      }

      if (!user) {
        // 3c. 新規ユーザー作成
        user = await prisma.user.create({
          data: {
            email,
            googleId,
            name,
            // passwordHash は null（Google 認証のみ）
          },
        });
        console.log(`✅ New user created via Google ID token: ${email}`);
      }

      // 4. セッション作成
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

      // 5. login/register と同じ形式でレスポンス
      return {
        user: formatUser(user),
        token,
      };
    } catch (err) {
      console.error('Google ID token auth error:', err);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });
}
