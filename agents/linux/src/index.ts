import { loadConfig } from './services/config.js';
import { connectToServer, initializeTaskWatcher, startTaskWatcher } from './services/connection.js';
import { loadProjects, autoDiscoverProjects } from './services/projects.js';
import { execSync } from 'child_process';
import { existsSync, mkdirSync, symlinkSync, unlinkSync } from 'fs';
import { join } from 'path';

// Ensure devrelay-claude symlink exists for identifiable process names
function ensureDevrelaySymlinks() {
  const devrelayBinDir = join(process.env.HOME || '', '.devrelay', 'bin');
  const devrelayClaude = join(devrelayBinDir, 'devrelay-claude');

  try {
    // Create directory if not exists
    if (!existsSync(devrelayBinDir)) {
      mkdirSync(devrelayBinDir, { recursive: true });
    }

    // Find claude binary path
    const claudePath = execSync('which claude', { encoding: 'utf-8' }).trim();

    // Create or update symlink
    if (existsSync(devrelayClaude)) {
      unlinkSync(devrelayClaude);
    }
    symlinkSync(claudePath, devrelayClaude);
    console.log(`🔗 Symlink: devrelay-claude -> ${claudePath}`);
  } catch (err) {
    console.warn('⚠️ Could not create devrelay-claude symlink:', (err as Error).message);
  }
}

async function main() {
  console.log(`
┌─────────────────────────────────────────────────┐
│  DevRelay Agent                                │
└─────────────────────────────────────────────────┘
  `);

  // Load config
  const config = await loadConfig();

  if (!config.token) {
    console.error('❌ Token not configured. Run: devrelay setup');
    process.exit(1);
  }

  console.log(`📡 Machine: ${config.machineName}`);
  console.log(`🔗 Server: ${config.serverUrl}`);

  // Ensure devrelay-claude symlink exists
  ensureDevrelaySymlinks();

  // Auto-discover projects with CLAUDE.md
  for (const dir of config.projectsDirs) {
    await autoDiscoverProjects(dir);
  }

  // Load projects
  const projects = await loadProjects(config);
  console.log(`📁 Projects: ${projects.length}`);

  // Initialize task watcher callbacks
  initializeTaskWatcher();

  // Start task watchers for each project
  for (const project of projects) {
    await startTaskWatcher(project.path);
  }

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
