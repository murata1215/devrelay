import { loadConfig } from './services/config.js';
import { connectToServer } from './services/connection.js';
import { loadProjects } from './services/projects.js';

async function main() {
  console.log(`
┌─────────────────────────────────────────────────┐
│  DevBridge Agent                                │
└─────────────────────────────────────────────────┘
  `);

  // Load config
  const config = await loadConfig();
  
  if (!config.token) {
    console.error('❌ Token not configured. Run: devbridge setup');
    process.exit(1);
  }

  console.log(`📡 Machine: ${config.machineName}`);
  console.log(`🔗 Server: ${config.serverUrl}`);

  // Load projects
  const projects = await loadProjects(config);
  console.log(`📁 Projects: ${projects.length}`);

  // Connect to server
  await connectToServer(config, projects);
}

// Handle shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n👋 Shutting down...');
  process.exit(0);
});

main().catch(console.error);
