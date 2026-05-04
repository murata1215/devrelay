import { loadConfig, getConfigDir } from '../../services/config.js';
import { loadProjects } from '../../services/projects.js';
import { execSync } from 'child_process';

/** LaunchAgent の識別子 */
const PLIST_LABEL = 'io.devrelay.agent';

export async function statusCommand() {
  console.log('\n📊 DevRelay Agent Status (macOS)\n');

  const config = await loadConfig();

  // Basic info
  console.log(`Machine:    ${config.machineName}`);
  console.log(`Server:     ${config.serverUrl}`);
  console.log(`Config:     ${getConfigDir()}`);
  console.log('');

  // サービスステータス確認（macOS: launchctl + pgrep）
  let serviceStatus = 'unknown';

  try {
    // launchctl list で LaunchAgent の状態を確認
    const result = execSync(`launchctl list ${PLIST_LABEL} 2>/dev/null`, { encoding: 'utf-8' });
    // PID が存在すれば実行中
    const pidMatch = result.match(/"PID"\s*=\s*(\d+)/);
    if (pidMatch) {
      serviceStatus = `running (launchd, PID: ${pidMatch[1]})`;
    } else {
      serviceStatus = 'registered (launchd, not running)';
    }
  } catch {
    // LaunchAgent 未登録の場合、プロセスとして実行中かチェック
    try {
      execSync('pgrep -f "devrelay.*agent"', { encoding: 'utf-8' });
      serviceStatus = 'running (process)';
    } catch {
      serviceStatus = 'stopped';
    }
  }

  const statusEmoji = serviceStatus.includes('running') ? '🟢' : '🔴';
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

  // AI ツールの存在確認（macOS: which）
  const tools = ['claude', 'gemini', 'codex', 'aider', 'devin'] as const;
  for (const tool of tools) {
    const toolConfig = config.aiTools[tool];
    if (toolConfig) {
      let available = false;
      try {
        execSync(`which ${toolConfig.command} 2>/dev/null`, { stdio: 'pipe' });
        available = true;
      } catch {}

      const emoji = available ? '✅' : '❌';
      console.log(`   ${tool}: ${emoji} ${toolConfig.command}`);
    }
  }

  console.log('');
}
