import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { setupAgentWebSocket, startHeartbeatMonitor, stopHeartbeatMonitor } from './services/agent-manager.js';
import { setupWebClientWebSocket } from './platforms/web.js';
import { restoreSessionParticipants } from './services/session-manager.js';
import { setupDiscordBot } from './platforms/discord.js';
import { setupTelegramBot } from './platforms/telegram.js';
import { prisma } from './db/client.js';
import { authRoutes } from './routes/auth.js';
import { apiRoutes } from './routes/api.js';
import { organizationRoutes } from './routes/organization.js';
import { publicApiRoutes } from './routes/public-api.js';
import { registerDocumentApiRoutes } from './routes/document-api.js';
import { registerAgentDocumentApiRoutes } from './routes/agent-document-api.js';
import { decrypt } from './services/user-settings.js';
import { initVapid } from './services/push-notification-service.js';
import { initFcm } from './services/fcm-service.js';
import { mcpRoutes } from './mcp/server.js';

const PORT = parseInt(process.env.PORT || '3000');
const HOST = process.env.HOST || '0.0.0.0';

/**
 * 期限切れ AuthSession を定期削除するクリーンアップを開始する。
 * 起動直後に1回実行し、以降24時間間隔で expiresAt < now のセッションを deleteMany で除去する。
 * 失敗しても致命的でないため握りつぶす。
 */
function startExpiredSessionCleanup() {
  const runCleanup = async () => {
    try {
      const result = await prisma.authSession.deleteMany({
        where: { expiresAt: { lt: new Date() } },
      });
      if (result.count > 0) {
        console.log(`🧹 Cleaned up ${result.count} expired auth sessions`);
      }
    } catch (err) {
      console.error('⚠️  Expired auth session cleanup failed:', err);
    }
  };
  // 起動時に1回実行（await しない fire-and-forget）
  void runCleanup();
  // 以降24時間間隔で実行。unref でプロセス終了を妨げない
  const timer = setInterval(() => void runCleanup(), 24 * 60 * 60 * 1000);
  timer.unref();
}

async function main() {
  // trustProxy: Caddy 経由の X-Forwarded-For を信頼し request.ip を実クライアント IP にする（#285 IP 制限用）
  const app = Fastify({ logger: true, trustProxy: true });

  // Reset all machines to offline on startup
  // (In case server crashed without proper disconnect handling)
  await prisma.machine.updateMany({
    where: { deletedAt: null },
    data: { status: 'offline' }
  });

  // Stale セッションクリーンアップ（24時間以上活動がない active セッション → ended）
  {
    const staleThreshold = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const staleSessions = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT s.id FROM "Session" s
      WHERE s.status = 'active'
      AND COALESCE((SELECT MAX(m."createdAt") FROM "Message" m WHERE m."sessionId" = s.id), s."startedAt") < ${staleThreshold}
    `;
    if (staleSessions.length > 0) {
      const staleIds = staleSessions.map(s => s.id);
      await prisma.session.updateMany({ where: { id: { in: staleIds } }, data: { status: 'ended' } });
      // stale セッションの ChannelSession も削除
      await prisma.channelSession.deleteMany({ where: { currentSessionId: { in: staleIds } } });
      console.log(`🧹 Cleaned up ${staleSessions.length} stale active sessions (24h+ inactive)`);
    }
    // #294: 取り残されたクロスプロジェクトセッション（teamexec_ / crossquery_）を ended に
    // これらは HTTP リクエストの生存期間しか意味を持たず、サーバー再起動をまたいで active のままだと
    // document-api.ts の転送ホップ判定（findInflightTeamExec）が誤検知するため確実に閉じる
    const crossResult = await prisma.session.updateMany({
      where: {
        status: 'active',
        OR: [{ id: { startsWith: 'teamexec_' } }, { id: { startsWith: 'crossquery_' } }],
      },
      data: { status: 'ended' },
    });
    if (crossResult.count > 0) {
      console.log(`🧹 Closed ${crossResult.count} stale cross-project session(s) (teamexec/crossquery)`);
    }

    // 30分以上経過した pending ツール承認を timeout に
    const approvalResult = await prisma.toolApproval.updateMany({
      where: { status: 'pending', createdAt: { lt: new Date(Date.now() - 30 * 60 * 1000) } },
      data: { status: 'timeout' },
    });
    if (approvalResult.count > 0) {
      console.log(`🧹 Timed out ${approvalResult.count} pending tool approval(s)`);
    }
  }

  // Restore session participants from ChannelSession
  // (So users can continue conversations after server restart)
  await restoreSessionParticipants();

  // Web Push 通知の VAPID キー初期化
  initVapid();

  // FCM（Firebase Cloud Messaging）初期化
  await initFcm();

  // Plugins
  await app.register(cors, { origin: true });
  await app.register(websocket);

  // Health check
  app.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

  // API routes
  await app.register(publicApiRoutes);  // 認証不要のパブリック API（インストーラー用トークン検証など）
  await app.register(authRoutes);
  await app.register(apiRoutes);
  await app.register(organizationRoutes);  // エンタープライズモード（組織）API
  await app.register(mcpRoutes);  // MCP エンドポイント（/mcp）— 認証は MCP 内部で処理
  registerDocumentApiRoutes(app);  // Agent 向けドキュメント検索 API（マシントークン認証）
  registerAgentDocumentApiRoutes(app);  // エージェントドキュメント CRUD API（WebUI 認証）

  // Agent WebSocket endpoint
  app.register(async (fastify) => {
    fastify.get('/ws/agent', { websocket: true }, (connection, req) => {
      setupAgentWebSocket(connection, req);
    });
  });

  // Web Client WebSocket endpoint（ブラウザチャット用）
  app.register(async (fastify) => {
    fastify.get('/ws/web', { websocket: true }, (connection, req) => {
      setupWebClientWebSocket(connection, req);
    });
  });

  // Bot Token の取得（UserSettings > 環境変数 の優先順）
  // ユーザーに依存せず、設定されているトークンを直接検索
  async function getBotTokenFromSettings(key: string): Promise<string | null> {
    const setting = await prisma.userSettings.findFirst({
      where: { key },
    });
    if (!setting) return null;

    // 暗号化されている場合は復号化
    if (setting.encrypted) {
      try {
        return decrypt(setting.value);
      } catch {
        console.error(`Failed to decrypt ${key}`);
        return null;
      }
    }
    return setting.value;
  }

  // Discord Bot Token を取得
  let discordToken = await getBotTokenFromSettings('discord_bot_token');
  if (discordToken) {
    console.log('📝 Using Discord bot token from user settings');
  } else {
    discordToken = process.env.DISCORD_BOT_TOKEN || null;
  }

  // Telegram Bot Token を取得
  let telegramToken = await getBotTokenFromSettings('telegram_bot_token');
  if (telegramToken) {
    console.log('📝 Using Telegram bot token from user settings');
  } else {
    telegramToken = process.env.TELEGRAM_BOT_TOKEN || null;
  }

  // Start Discord bot
  if (discordToken) {
    await setupDiscordBot(discordToken);
    console.log('✅ Discord bot started');
  } else {
    console.log('⚠️  DISCORD_BOT_TOKEN not set, Discord bot disabled');
  }

  // Start Telegram bot
  if (telegramToken) {
    await setupTelegramBot(telegramToken);
    console.log('✅ Telegram bot started');
  } else {
    console.log('⚠️  TELEGRAM_BOT_TOKEN not set, Telegram bot disabled');
  }

  // Start heartbeat monitor for agent connection health
  startHeartbeatMonitor();

  // 期限切れ AuthSession の定期クリーンアップ（起動時 + 24時間間隔）
  startExpiredSessionCleanup();

  // Start server
  try {
    await app.listen({ port: PORT, host: HOST });
    console.log(`
┌─────────────────────────────────────────────────┐
│                                                 │
│   🌉 DevRelay Server                           │
│                                                 │
│   HTTP:      http://${HOST}:${PORT}              │
│   WebSocket: ws://${HOST}:${PORT}/ws/agent       │
│                                                 │
│   Status: Running ✅                            │
│                                                 │
└─────────────────────────────────────────────────┘
    `);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n👋 Shutting down...');
  stopHeartbeatMonitor();
  await prisma.$disconnect();
  process.exit(0);
});

main();
