import { loadConfig } from './services/config.js';
import { connectToServer } from './services/connection.js';
import { loadProjects, autoDiscoverProjects } from './services/projects.js';
import { execSync } from 'child_process';
import { existsSync, mkdirSync, symlinkSync, unlinkSync } from 'fs';
import { join } from 'path';

// Ensure devbridge-claude symlink exists for identifiable process names
function ensureDevbridgeSymlinks() {
  const devbridgeBinDir = join(process.env.HOME || '', '.devbridge', 'bin');
  const devbridgeClaude = join(devbridgeBinDir, 'devbridge-claude');

  try {
    // Create directory if not exists
    if (!existsSync(devbridgeBinDir)) {
      mkdirSync(devbridgeBinDir, { recursive: true });
    }

    // Find claude binary path
    const claudePath = execSync('which claude', { encoding: 'utf-8' }).trim();

    // Create or update symlink
    if (existsSync(devbridgeClaude)) {
      unlinkSync(devbridgeClaude);
    }
    symlinkSync(claudePath, devbridgeClaude);
    console.log(`🔗 Symlink: devbridge-claude -> ${claudePath}`);
  } catch (err) {
    console.warn('⚠️ Could not create devbridge-claude symlink:', (err as Error).message);
  }
}

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

  // Ensure devbridge-claude symlink exists
  ensureDevbridgeSymlinks();

  // Auto-discover projects with CLAUDE.md
  for (const dir of config.projectsDirs) {
    await autoDiscoverProjects(dir);
  }

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
