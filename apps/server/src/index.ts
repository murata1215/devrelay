import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { setupAgentWebSocket } from './services/agent-manager.js';
import { setupDiscordBot } from './platforms/discord.js';
import { prisma } from './db/client.js';

const PORT = parseInt(process.env.PORT || '3000');
const HOST = process.env.HOST || '0.0.0.0';

async function main() {
  const app = Fastify({ logger: true });

  // Plugins
  await app.register(cors, { origin: true });
  await app.register(websocket);

  // Health check
  app.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

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
  await prisma.$disconnect();
  process.exit(0);
});

main();
