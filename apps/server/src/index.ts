import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { setupAgentWebSocket, startHeartbeatMonitor, stopHeartbeatMonitor } from './services/agent-manager.js';
import { restoreSessionParticipants } from './services/session-manager.js';
import { setupDiscordBot } from './platforms/discord.js';
import { setupTelegramBot } from './platforms/telegram.js';
import { prisma } from './db/client.js';
import { authRoutes } from './routes/auth.js';
import { apiRoutes } from './routes/api.js';
import { decrypt } from './services/user-settings.js';

const PORT = parseInt(process.env.PORT || '3000');
const HOST = process.env.HOST || '0.0.0.0';

async function main() {
  const app = Fastify({ logger: true });

  // Reset all machines to offline on startup
  // (In case server crashed without proper disconnect handling)
  await prisma.machine.updateMany({
    data: { status: 'offline' }
  });

  // Restore session participants from ChannelSession
  // (So users can continue conversations after server restart)
  await restoreSessionParticipants();

  // Plugins
  await app.register(cors, { origin: true });
  await app.register(websocket);

  // Health check
  app.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

  // API routes
  await app.register(authRoutes);
  await app.register(apiRoutes);

  // Agent WebSocket endpoint
  app.register(async (fastify) => {
    fastify.get('/ws/agent', { websocket: true }, (connection, req) => {
      setupAgentWebSocket(connection, req);
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
