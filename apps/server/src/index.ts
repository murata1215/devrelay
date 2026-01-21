import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { setupAgentWebSocket, startHeartbeatMonitor, stopHeartbeatMonitor } from './services/agent-manager.js';
import { setupDiscordBot } from './platforms/discord.js';
import { setupTelegramBot } from './platforms/telegram.js';
import { prisma } from './db/client.js';
import { authRoutes } from './routes/auth.js';
import { apiRoutes } from './routes/api.js';

const PORT = parseInt(process.env.PORT || '3000');
const HOST = process.env.HOST || '0.0.0.0';

async function main() {
  const app = Fastify({ logger: true });

  // Reset all machines to offline on startup
  // (In case server crashed without proper disconnect handling)
  await prisma.machine.updateMany({
    data: { status: 'offline' }
  });

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

  // Start Discord bot
  if (process.env.DISCORD_BOT_TOKEN) {
    await setupDiscordBot();
    console.log('✅ Discord bot started');
  } else {
    console.log('⚠️  DISCORD_BOT_TOKEN not set, Discord bot disabled');
  }

  // Start Telegram bot
  if (process.env.TELEGRAM_BOT_TOKEN) {
    await setupTelegramBot();
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
