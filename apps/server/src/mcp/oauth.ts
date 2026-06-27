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

  // OAuth のトークンエンドポイントは application/x-www-form-urlencoded で送信される（RFC 6749）
  // Fastify はデフォルトで application/json のみ受け付けるため、カスタムパーサーを追加
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    try {
      const params = new URLSearchParams(body as string);
      const result: Record<string, string> = {};
      for (const [key, value] of params.entries()) {
        result[key] = value;
      }
      done(null, result);
    } catch (err) {
      done(err as Error);
    }
  });

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
    // Google ログイン用: 現在の認可 URL を mcp_redirect パラメータとして渡す
    const currentAuthorizeUrl = request.url;
    const googleLoginUrl = `/api/auth/google?mcp_redirect=${encodeURIComponent(currentAuthorizeUrl)}`;

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
    .google-btn { background: #fff; color: #333; display: flex; align-items: center; justify-content: center; gap: 0.5rem; text-decoration: none; }
    .google-btn:hover { background: #f0f0f0; }
    .divider { display: flex; align-items: center; margin: 1rem 0; color: #666; font-size: 0.85rem; }
    .divider::before, .divider::after { content: ''; flex: 1; border-top: 1px solid #333; }
    .divider::before { margin-right: 0.75rem; }
    .divider::after { margin-left: 0.75rem; }
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
    <a href="${googleLoginUrl}" class="google-btn" style="width:100%;padding:0.75rem;border-radius:8px;font-size:1rem;font-weight:bold;display:flex;align-items:center;justify-content:center;gap:0.5rem;text-decoration:none;margin-top:0.5rem;box-sizing:border-box;">
      <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#4285F4" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#34A853" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#EA4335" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
      Google でログイン
    </a>
    <div class="divider">または</div>
    <form id="loginForm">
      <input type="email" id="email" placeholder="メールアドレス" required>
      <input type="password" id="password" placeholder="パスワード" required>
      <div class="error" id="error"></div>
      <button type="submit">メール/パスワードでログイン</button>
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
