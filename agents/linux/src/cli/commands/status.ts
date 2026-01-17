import { loadConfig, getConfigDir } from '../../services/config.js';
import { loadProjects } from '../../services/projects.js';
import { execSync } from 'child_process';

export async function statusCommand() {
  console.log('\n📊 DevRelay Agent Status\n');
  
  const config = await loadConfig();
  
  // Basic info
  console.log(`Machine:    ${config.machineName}`);
  console.log(`Server:     ${config.serverUrl}`);
  console.log(`Config:     ${getConfigDir()}`);
  console.log('');
  
  // Check if service is running
  let serviceStatus = 'unknown';
  try {
    const result = execSync('systemctl is-active devrelay-agent 2>/dev/null', { encoding: 'utf-8' }).trim();
    serviceStatus = result;
  } catch {
    try {
      // Check if running as process
      execSync('pgrep -f "devrelay.*agent"', { encoding: 'utf-8' });
      serviceStatus = 'running (process)';
    } catch {
      serviceStatus = 'stopped';
    }
  }
  
  const statusEmoji = serviceStatus === 'active' || serviceStatus.includes('running') ? '🟢' : '🔴';
  console.log(`Service:    ${statusEmoji} ${serviceStatus}`);
  
  // Token status
  if (config.token) {
    console.log(`Token:      ✅ configured`);
  } else {
    console.log(`Token:      ⚠️  not configured (run: devrelay setup)`);
  }
  
  // Projects
  const projects = await loadProjects(config);
  console.log(`Projects:   ${projects.length}`);
  
  if (projects.length > 0) {
    console.log('');
    console.log('📁 Registered Projects:');
    projects.forEach((p, i) => {
      console.log(`   ${i + 1}. ${p.name} (${p.defaultAi})`);
      console.log(`      ${p.path}`);
    });
  }
  
  // AI Tools
  console.log('');
  console.log('🤖 AI Tools:');
  console.log(`   Default: ${config.aiTools.default}`);
  
  const tools = ['claude', 'gemini', 'codex', 'aider'] as const;
  for (const tool of tools) {
    const toolConfig = config.aiTools[tool];
    if (toolConfig) {
      // Check if command exists
      let available = false;
      try {
        execSync(`which ${toolConfig.command} 2>/dev/null`);
        available = true;
      } catch {}
      
      const emoji = available ? '✅' : '❌';
      console.log(`   ${tool}: ${emoji} ${toolConfig.command}`);
    }
  }
  
  console.log('');
}
