import { loadConfig } from './services/config.js';
import { connectToServer } from './services/connection.js';
import { loadProjects, autoDiscoverProjects } from './services/projects.js';
import { execSync } from 'child_process';

// Check if Claude CLI is available
function checkClaudeAvailable(): boolean {
  try {
    execSync('where claude', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  console.log(`
+--------------------------------------------------+
|  DevRelay Agent (Windows)                        |
+--------------------------------------------------+
  `);

  // Load config
  const config = await loadConfig();

  if (!config.token) {
    console.error('Token not configured. Run: devrelay setup');
    process.exit(1);
  }

  console.log(`Machine: ${config.machineName}`);
  console.log(`Server: ${config.serverUrl}`);

  // Check if Claude is available
  if (checkClaudeAvailable()) {
    console.log(`Claude: Available`);
  } else {
    console.warn(`Claude: Not found in PATH`);
    console.warn(`   Make sure Claude CLI is installed and in your PATH`);
  }

  // Auto-discover projects with CLAUDE.md
  for (const dir of config.projectsDirs) {
    await autoDiscoverProjects(dir);
  }

  // Load projects
  const projects = await loadProjects(config);
  console.log(`Projects: ${projects.length}`);

  // Connect to server
  await connectToServer(config, projects);
}

// Handle shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\nShutting down...');
  process.exit(0);
});

// Handle uncaught errors
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

main().catch(console.error);
