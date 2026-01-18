import { loadConfig } from '../../services/config.js';
import { loadProjects, autoDiscoverProjects } from '../../services/projects.js';
import { connectToServer, disconnect } from '../../services/connection.js';

export async function startCommand() {
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
  console.log(`Server:  ${config.serverUrl}`);

  // Auto-discover projects with CLAUDE.md
  for (const dir of config.projectsDirs) {
    await autoDiscoverProjects(dir);
  }

  // Load projects
  const projects = await loadProjects(config);
  console.log(`Projects: ${projects.length}`);
  console.log('');

  // Connect to server
  try {
    await connectToServer(config, projects);
    console.log('');
    console.log('Agent started successfully');
    console.log('   Press Ctrl+C to stop');
  } catch (err: any) {
    console.error('Failed to connect:', err.message);
    process.exit(1);
  }
}

// Handle shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  disconnect();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\nShutting down...');
  disconnect();
  process.exit(0);
});
