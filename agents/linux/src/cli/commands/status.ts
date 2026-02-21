import { loadConfig, getConfigDir } from '../../services/config.js';
import { loadProjects } from '../../services/projects.js';
import { execSync } from 'child_process';

export async function statusCommand() {
  console.log('\n📊 DevRelay Agent Status\n');

  const config = await loadConfig();
  const isWindows = process.platform === 'win32';

  // Basic info
  console.log(`Machine:    ${config.machineName}`);
  console.log(`Server:     ${config.serverUrl}`);
  console.log(`Config:     ${getConfigDir()}`);
  console.log('');

  // サービスステータス確認（OS 別）
  let serviceStatus = 'unknown';

  if (isWindows) {
    // Windows: タスクスケジューラ + tasklist で確認
    try {
      const result = execSync('schtasks /Query /TN "DevRelay Agent" /FO CSV /NH 2>nul', { encoding: 'utf-8' });
      serviceStatus = result.includes('Running') ? 'running (task)' : 'registered (task)';
    } catch {
      try {
        // タスクスケジューラに登録がなくても node プロセスとして実行中かチェック
        const taskList = execSync('tasklist /FI "IMAGENAME eq node.exe" /FO CSV /NH 2>nul', { encoding: 'utf-8' });
        if (taskList.includes('node.exe')) {
          serviceStatus = 'running (process)';
        } else {
          serviceStatus = 'stopped';
        }
      } catch {
        serviceStatus = 'stopped';
      }
    }
  } else {
    // Linux: systemctl + pgrep で確認
    try {
      const result = execSync('systemctl is-active devrelay-agent 2>/dev/null', { encoding: 'utf-8' }).trim();
      serviceStatus = result;
    } catch {
      try {
        execSync('pgrep -f "devrelay.*agent"', { encoding: 'utf-8' });
        serviceStatus = 'running (process)';
      } catch {
        serviceStatus = 'stopped';
      }
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

  // AI ツールの存在確認（Linux: which, Windows: where）
  const findCmd = isWindows ? 'where' : 'which';
  const nullDev = isWindows ? '2>nul' : '2>/dev/null';

  const tools = ['claude', 'gemini', 'codex', 'aider'] as const;
  for (const tool of tools) {
    const toolConfig = config.aiTools[tool];
    if (toolConfig) {
      let available = false;
      try {
        execSync(`${findCmd} ${toolConfig.command} ${nullDev}`, { stdio: 'pipe' });
        available = true;
      } catch {}

      const emoji = available ? '✅' : '❌';
      console.log(`   ${tool}: ${emoji} ${toolConfig.command}`);
    }
  }

  console.log('');
}
