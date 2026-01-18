import { loadConfig, getConfigDir } from '../../services/config.js';
import { loadProjects } from '../../services/projects.js';
import { execSync } from 'child_process';

export async function statusCommand() {
  console.log('\nDevRelay Agent Status (Windows)\n');

  const config = await loadConfig();

  // Basic info
  console.log(`Machine:    ${config.machineName}`);
  console.log(`Server:     ${config.serverUrl}`);
  console.log(`Config:     ${getConfigDir()}`);
  console.log('');

  // Check if agent is running
  let processStatus = 'stopped';
  try {
    // Use tasklist to find node processes running devrelay
    const result = execSync('tasklist /FI "IMAGENAME eq node.exe" /FO CSV /NH', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    });

    // Check if any node process is running (we can't easily identify which one is devrelay)
    if (result.includes('node.exe')) {
      // Try to find devrelay specifically using wmic
      try {
        const wmicResult = execSync('wmic process where "name=\'node.exe\'" get commandline', {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe']
        });
        if (wmicResult.toLowerCase().includes('devrelay')) {
          processStatus = 'running';
        } else {
          processStatus = 'unknown (node running, may be devrelay)';
        }
      } catch {
        processStatus = 'unknown (node running)';
      }
    }
  } catch {
    processStatus = 'stopped';
  }

  const statusEmoji = processStatus.includes('running') ? '[OK]' : '[--]';
  console.log(`Process:    ${statusEmoji} ${processStatus}`);

  // Check startup registration
  const fs = await import('fs');
  const path = await import('path');
  const startupVbs = path.join(
    process.env.APPDATA || '',
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Startup',
    'devrelay-agent.vbs'
  );

  const startupEnabled = fs.existsSync(startupVbs);
  console.log(`Startup:    ${startupEnabled ? '[OK] enabled' : '[--] not enabled'}`);

  // Token status
  if (config.token) {
    console.log(`Token:      [OK] configured`);
  } else {
    console.log(`Token:      [!!] not configured (run: devrelay setup)`);
  }

  // Projects
  const projects = await loadProjects(config);
  console.log(`Projects:   ${projects.length}`);

  if (projects.length > 0) {
    console.log('');
    console.log('Registered Projects:');
    projects.forEach((p, i) => {
      console.log(`   ${i + 1}. ${p.name} (${p.defaultAi})`);
      console.log(`      ${p.path}`);
    });
  }

  // AI Tools
  console.log('');
  console.log('AI Tools:');
  console.log(`   Default: ${config.aiTools.default}`);

  const tools = ['claude', 'gemini', 'codex', 'aider'] as const;
  for (const tool of tools) {
    const toolConfig = config.aiTools[tool];
    if (toolConfig) {
      // Check if command exists on Windows
      let available = false;
      try {
        execSync(`where ${toolConfig.command}`, { stdio: ['pipe', 'pipe', 'pipe'] });
        available = true;
      } catch {}

      const status = available ? '[OK]' : '[--]';
      console.log(`   ${tool}: ${status} ${toolConfig.command}`);
    }
  }

  console.log('');
}
