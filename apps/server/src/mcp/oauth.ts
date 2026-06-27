/**
 * MCP OAuth 2.1 エンドポイント
 *
 * Claude.ai のカスタムコネクタが要求する OAuth 2.1 フローを実装。
 * DevRelay の既存認証（AuthSession）を OAuth のアクセストークンとして活用する。
 *
 * フロー:
 *   1. /.well-known/oauth-protected-resource → リソースメタデータ
 *   2. /.well-known/oauth-authorization-server → 認可サーバーメタデータ
 *   3. POST /oauth/register → Dynamic Client Registration
 *   4. GET /oauth/authorize → 認可画面（DevRelay ログイン）
 *   5. POST /oauth/token → トークン交換（code → access_token）
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'crypto';
import { prisma } from '../db/client.js';

/** サーバーの公開 URL */
const SERVER_URL = process.env.PUBLIC_URL || 'https://app.devrelay.io';

/** 認可コード: code → { userId, clientId, redirectUri, codeChallenge, expiresAt } */
const authorizationCodes = new Map<string, {
  userId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  expiresAt: number;
}>();

/** 登録済みクライアント: clientId → { clientSecret, redirectUris, clientName } */
const registeredClients = new Map<string, {
  clientSecret: string;
  redirectUris: string[];
  clientName: string;
}>();

/** アクセストークン → userId のマッピング（OAuth 経由で発行したトークン） */
const oauthAccessTokens = new Map<string, { userId: string; expiresAt: number }>();

/**
 * OAuth 2.1 ルートを Fastify に登録する
 */
export async function oauthRoutes(app: FastifyInstance) {

  // ============================================================
  // Well-Known メタデータ
  // ============================================================

  /** RFC 9728: OAuth Protected Resource Metadata */
  app.get('/.well-known/oauth-protected-resource', async (_request, reply) => {
    return reply.send({
      resource: SERVER_URL,
      authorization_servers: [SERVER_URL],
      bearer_methods_supported: ['header'],
      scopes_supported: ['devrelay:read', 'devrelay:write'],
    });
  });

  /** RFC 8414: OAuth Authorization Server Metadata */
  app.get('/.well-known/oauth-authorization-server', async (_request, reply) => {
    return reply.send({
      issuer: SERVER_URL,
      authorization_endpoint: `${SERVER_URL}/oauth/authorize`,
      token_endpoint: `${SERVER_URL}/oauth/token`,
      registration_endpoint: `${SERVER_URL}/oauth/register`,
      scopes_supported: ['devrelay:read', 'devrelay:write'],
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
      code_challenge_methods_supported: ['S256'],
      service_documentation: `${SERVER_URL}`,
    });
  });

  // ============================================================
  // Dynamic Client Registration (RFC 7591)
  // ============================================================

  app.post('/oauth/register', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as Record<string, unknown> || {};
    const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris as string[] : [];
    const clientName = (body.client_name as string) || 'Unknown Client';

    // クライアント ID とシークレットを生成
    const clientId = `devrelay_${crypto.randomBytes(16).toString('hex')}`;
    const clientSecret = crypto.randomBytes(32).toString('hex');

    registeredClients.set(clientId, {
      clientSecret,
      redirectUris,
      clientName,
    });

    console.log(`🔐 [OAuth] Client registered: ${clientName} (${clientId.slice(0, 20)}...)`);

    return reply.status(201).send({
      client_id: clientId,
      client_secret: clientSecret,
      client_name: clientName,
      redirect_uris: redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_post',
    });
  });

  // ============================================================
  // Authorization Endpoint
  // ============================================================

  app.get('/oauth/authorize', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as Record<string, string>;
    const {
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: responseType,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: codeChallengeMethod,
      scope,
    } = query;

    // バリデーション
    if (responseType !== 'code') {
      return reply.status(400).send({ error: 'unsupported_response_type' });
    }

    if (!clientId || !redirectUri || !codeChallenge) {
      return reply.status(400).send({ error: 'invalid_request', error_description: 'Missing required parameters' });
    }

    // ログイン済み認証トークンの確認（cookie or query）
    const token = query.auth_token || (request.headers.cookie?.match(/devrelay_token=([^;]+)/)?.[1]);

    if (token) {
      // 認証済み → 認可コード発行
      const session = await prisma.authSession.findUnique({
        where: { token },
        include: { user: true },
      });

      if (session && session.expiresAt > new Date()) {
        // 認可コードを生成
        const code = crypto.randomBytes(32).toString('hex');
        authorizationCodes.set(code, {
          userId: session.user.id,
          clientId,
          redirectUri,
          codeChallenge,
          codeChallengeMethod: codeChallengeMethod || 'S256',
          expiresAt: Date.now() + 5 * 60 * 1000, // 5分
        });

        console.log(`🔐 [OAuth] Authorization code issued for user ${session.user.id.slice(0, 8)}...`);

        // リダイレクト
        const redirectUrl = new URL(redirectUri);
        redirectUrl.searchParams.set('code', code);
        if (state) redirectUrl.searchParams.set('state', state);
        return reply.redirect(redirectUrl.toString());
      }
    }

    // 未認証 → ログイン画面を表示
    const loginHtml = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DevRelay - MCP 接続許可</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #1a1a2e; color: #e0e0e0; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
    .card { background: #16213e; border-radius: 12px; padding: 2rem; max-width: 400px; width: 90%; box-shadow: 0 4px 20px rgba(0,0,0,0.3); }
    h1 { color: #4fc3f7; font-size: 1.5rem; margin-top: 0; }
    .info { background: #0d1b2a; border-radius: 8px; padding: 1rem; margin: 1rem 0; font-size: 0.9rem; line-height: 1.5; }
    input { width: 100%; padding: 0.75rem; margin: 0.5rem 0; border: 1px solid #333; border-radius: 8px; background: #0d1b2a; color: #e0e0e0; font-size: 1rem; box-sizing: border-box; }
    button { width: 100%; padding: 0.75rem; background: #4fc3f7; color: #000; border: none; border-radius: 8px; font-size: 1rem; font-weight: bold; cursor: pointer; margin-top: 0.5rem; }
    button:hover { background: #29b6f6; }
    .error { color: #ef5350; font-size: 0.9rem; display: none; }
  </style>
</head>
<body>
  <div class="card">
    <h1>DevRelay MCP 接続</h1>
    <div class="info">
      Claude がDevRelayに接続しようとしています。<br>
      DevRelayアカウントでログインして許可してください。
    </div>
    <form id="loginForm">
      <input type="email" id="email" placeholder="メールアドレス" required>
      <input type="password" id="password" placeholder="パスワード" required>
      <div class="error" id="error"></div>
      <button type="submit">ログインして許可</button>
    </form>
  </div>
  <script>
    document.getElementById('loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('email').value;
      const password = document.getElementById('password').value;
      const errorEl = document.getElementById('error');
      errorEl.style.display = 'none';

      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
        });
        const data = await res.json();
        if (!res.ok) {
          errorEl.textContent = data.error || 'Login failed';
          errorEl.style.display = 'block';
          return;
        }
        // ログイン成功 → 認可エンドポイントに token 付きでリダイレクト
        const currentUrl = new URL(window.location.href);
        currentUrl.searchParams.set('auth_token', data.token);
        window.location.href = currentUrl.toString();
      } catch (err) {
        errorEl.textContent = 'Connection error';
        errorEl.style.display = 'block';
      }
    });
  </script>
</body>
</html>`;

    return reply.type('text/html').send(loginHtml);
  });

  // ============================================================
  // Token Endpoint
  // ============================================================

  app.post('/oauth/token', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as Record<string, string> || {};
    const { grant_type: grantType, code, code_verifier: codeVerifier, redirect_uri: redirectUri, client_id: clientId } = body;

    if (grantType === 'authorization_code') {
      if (!code) {
        return reply.status(400).send({ error: 'invalid_request', error_description: 'Missing code' });
      }

      const authCode = authorizationCodes.get(code);
      if (!authCode || authCode.expiresAt < Date.now()) {
        authorizationCodes.delete(code);
        return reply.status(400).send({ error: 'invalid_grant', error_description: 'Code expired or invalid' });
      }

      // PKCE 検証
      if (codeVerifier && authCode.codeChallengeMethod === 'S256') {
        const expectedChallenge = crypto
          .createHash('sha256')
          .update(codeVerifier)
          .digest('base64url');
        if (expectedChallenge !== authCode.codeChallenge) {
          authorizationCodes.delete(code);
          return reply.status(400).send({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
        }
      }

      // 認可コードを消費
      authorizationCodes.delete(code);

      // アクセストークンを生成
      const accessToken = crypto.randomBytes(32).toString('hex');
      const expiresIn = 3600; // 1時間
      oauthAccessTokens.set(accessToken, {
        userId: authCode.userId,
        expiresAt: Date.now() + expiresIn * 1000,
      });

      // リフレッシュトークンも生成（長命）
      const refreshToken = crypto.randomBytes(32).toString('hex');
      oauthAccessTokens.set(`refresh_${refreshToken}`, {
        userId: authCode.userId,
        expiresAt: Date.now() + 30 * 24 * 3600 * 1000, // 30日
      });

      console.log(`🔐 [OAuth] Access token issued for user ${authCode.userId.slice(0, 8)}...`);

      return reply.send({
        access_token: accessToken,
        token_type: 'bearer',
        expires_in: expiresIn,
        refresh_token: refreshToken,
        scope: 'devrelay:read devrelay:write',
      });
    }

    if (grantType === 'refresh_token') {
      const refreshToken = body.refresh_token;
      if (!refreshToken) {
        return reply.status(400).send({ error: 'invalid_request' });
      }

      const refreshData = oauthAccessTokens.get(`refresh_${refreshToken}`);
      if (!refreshData || refreshData.expiresAt < Date.now()) {
        return reply.status(400).send({ error: 'invalid_grant', error_description: 'Refresh token expired' });
      }

      // 新しいアクセストークンを発行
      const newAccessToken = crypto.randomBytes(32).toString('hex');
      const expiresIn = 3600;
      oauthAccessTokens.set(newAccessToken, {
        userId: refreshData.userId,
        expiresAt: Date.now() + expiresIn * 1000,
      });

      console.log(`🔐 [OAuth] Token refreshed for user ${refreshData.userId.slice(0, 8)}...`);

      return reply.send({
        access_token: newAccessToken,
        token_type: 'bearer',
        expires_in: expiresIn,
        refresh_token: refreshToken, // 同じ refresh token を返す
        scope: 'devrelay:read devrelay:write',
      });
    }

    return reply.status(400).send({ error: 'unsupported_grant_type' });
  });
}

/**
 * OAuth アクセストークンを検証して userId を返す。
 * 既存の AuthSession (Bearer) も引き続きサポート。
 */
export function verifyOAuthToken(token: string): string | null {
  const tokenData = oauthAccessTokens.get(token);
  if (tokenData && tokenData.expiresAt > Date.now()) {
    return tokenData.userId;
  }
  return null;
}
