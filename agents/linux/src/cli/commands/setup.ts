import * as readline from 'readline';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { execSync } from 'child_process';
import { nanoid } from 'nanoid';
import chalk from 'chalk';
import { loadConfig, saveConfig, ensureConfigDir } from '../../services/config.js';

export async function setupCommand() {
  console.log(chalk.blue(`
┌─────────────────────────────────────────────────┐
│  DevRelay Agent Setup                          │
└─────────────────────────────────────────────────┘
  `));

  await ensureConfigDir();
  const existingConfig = await loadConfig();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const question = (prompt: string, defaultValue?: string): Promise<string> => {
    const defaultText = defaultValue ? chalk.gray(` (${defaultValue})`) : '';
    return new Promise((resolve) => {
      rl.question(`${prompt}${defaultText}: `, (answer) => {
        resolve(answer.trim() || defaultValue || '');
      });
    });
  };

  try {
    // Connection token (required)
    console.log(chalk.yellow('━'.repeat(50)));
    console.log(chalk.yellow(' Connection token is required to authenticate.'));
    console.log(chalk.yellow(''));
    console.log(chalk.yellow(' To get your token:'));
    console.log(chalk.cyan('  1. Go to the DevRelay dashboard'));
    console.log(chalk.cyan('  2. Navigate to "Agents"'));
    console.log(chalk.cyan('  3. Click "+ Add Agent"'));
    console.log(chalk.cyan('  4. Copy the generated token'));
    console.log(chalk.yellow(''));
    console.log(chalk.gray(' Dashboard URL: https://ribbon-re.jp/devrelay/machines'));
    console.log(chalk.gray('               (or your self-hosted URL)'));
    console.log(chalk.yellow('━'.repeat(50)));
    console.log();

    const token = await question(
      'Connection token',
      existingConfig.token
    );

    if (!token) {
      console.log(chalk.red('\n❌ Token is required. Setup cancelled.'));
      rl.close();
      return;
    }

    // Use defaults for machine name and server URL (can be changed later in config.yaml)
    const machineName = existingConfig.machineName || `${os.hostname()}/${os.userInfo().username}`;
    const serverUrl = existingConfig.serverUrl || 'ws://localhost:3000/ws/agent';
    const projectsDirs = existingConfig.projectsDirs || [os.homedir()];

    // Generate machine ID if not exists
    const machineId = existingConfig.machineId || nanoid();

    // Save config
    const config = {
      ...existingConfig,
      machineName,
      machineId,
      serverUrl,
      token,
      projectsDirs,
    };

    await saveConfig(config);

    console.log(chalk.green('\n✅ Configuration saved!'));
    console.log(chalk.gray(`   Config: ~/.devrelay/config.yaml`));
    console.log();

    // Claude Code のシンボリックリンクを作成（プロセス識別用）
    await ensureDevrelaySymlinks();

    // Ask about systemd service
    console.log();
    console.log(chalk.blue('Systemd service options:'));
    console.log(chalk.gray('  1. User service (recommended) - no sudo required'));
    console.log(chalk.gray('  2. System service - requires sudo'));
    console.log(chalk.gray('  3. Skip - start manually with pnpm start'));
    console.log();

    const serviceChoice = await question(
      'Install systemd service? (1/2/3)',
      '1'
    );

    if (serviceChoice === '1') {
      await installUserService(machineName);
    } else if (serviceChoice === '2') {
      await installSystemService(machineName);
    }

    console.log(chalk.green('\n🎉 Setup complete!'));
    console.log();
    console.log('Next steps:');
    if (serviceChoice === '1') {
      console.log(chalk.cyan('  1. Start agent:      systemctl --user start devrelay-agent'));
      console.log(chalk.cyan('  2. Check status:     systemctl --user status devrelay-agent'));
      console.log(chalk.cyan('  3. View logs:        journalctl --user -u devrelay-agent -f'));
    } else if (serviceChoice === '2') {
      console.log(chalk.cyan('  1. Start agent:      sudo systemctl start devrelay-agent'));
      console.log(chalk.cyan('  2. Check status:     sudo systemctl status devrelay-agent'));
      console.log(chalk.cyan('  3. View logs:        sudo journalctl -u devrelay-agent -f'));
    } else {
      console.log(chalk.cyan('  1. Start agent:      cd agents/linux && pnpm start'));
    }
    console.log();
  } finally {
    rl.close();
  }
}

async function installUserService(machineName: string) {
  const { execSync } = await import('child_process');
  const fs = await import('fs/promises');
  const path = await import('path');
  const { fileURLToPath } = await import('url');

  // Find the agent directory (relative to this CLI file)
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const agentDir = path.resolve(__dirname, '../..');
  const agentIndex = path.join(agentDir, 'index.js');

  const serviceContent = `[Unit]
Description=DevRelay Agent (${machineName})
After=network.target

[Service]
Type=simple
WorkingDirectory=${agentDir}
ExecStart=${process.execPath} ${agentIndex}
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
`;

  const userServiceDir = path.join(process.env.HOME || '', '.config', 'systemd', 'user');
  const servicePath = path.join(userServiceDir, 'devrelay-agent.service');

  try {
    // Create user systemd directory if not exists
    await fs.mkdir(userServiceDir, { recursive: true });

    // Write service file (no sudo needed)
    await fs.writeFile(servicePath, serviceContent);

    execSync('systemctl --user daemon-reload', { stdio: 'inherit' });
    execSync('systemctl --user enable devrelay-agent', { stdio: 'inherit' });
    execSync('systemctl --user start devrelay-agent', { stdio: 'inherit' });

    // Enable lingering so service runs even when logged out
    execSync(`loginctl enable-linger ${process.env.USER}`, { stdio: 'pipe' });

    console.log(chalk.green('\n✅ User service installed and started!'));
    console.log(chalk.gray(`   Service file: ${servicePath}`));
  } catch (err: any) {
    console.log(chalk.yellow('\n⚠️ Could not install user service automatically.'));
    console.log(chalk.yellow(`   You can manually create: ${servicePath}`));
    console.log();
    console.log(chalk.gray(serviceContent));
  }
}

async function installSystemService(machineName: string) {
  const { execSync } = await import('child_process');
  const fs = await import('fs/promises');
  const path = await import('path');
  const { fileURLToPath } = await import('url');

  // Find the agent directory
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const agentDir = path.resolve(__dirname, '../..');
  const agentIndex = path.join(agentDir, 'index.js');

  const serviceContent = `[Unit]
Description=DevRelay Agent (${machineName})
After=network.target

[Service]
Type=simple
User=${process.env.USER}
WorkingDirectory=${agentDir}
ExecStart=${process.execPath} ${agentIndex}
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
`;

  const servicePath = '/etc/systemd/system/devrelay-agent.service';

  try {
    // Write service file (requires sudo)
    const tempPath = '/tmp/devrelay-agent.service';
    await fs.writeFile(tempPath, serviceContent);

    execSync(`sudo mv ${tempPath} ${servicePath}`, { stdio: 'inherit' });
    execSync('sudo systemctl daemon-reload', { stdio: 'inherit' });
    execSync('sudo systemctl enable devrelay-agent', { stdio: 'inherit' });
    execSync('sudo systemctl start devrelay-agent', { stdio: 'inherit' });

    console.log(chalk.green('\n✅ System service installed and started!'));
    console.log(chalk.gray(`   Service file: ${servicePath}`));
    console.log(chalk.gray('   Start with: sudo systemctl start devrelay-agent'));
  } catch (err: any) {
    console.log(chalk.yellow('\n⚠️ Could not install system service automatically.'));
    console.log(chalk.yellow(`   You can manually create: ${servicePath}`));
    console.log();
    console.log(chalk.gray(serviceContent));
  }
}

/**
 * devrelay-claude シンボリックリンクを作成する
 *
 * Claude Code のプロセスを識別しやすくするため、
 * ~/.devrelay/bin/devrelay-claude -> claude へのシンボリックリンクを作成する。
 * これにより ps コマンドで DevRelay 経由の Claude 実行を識別できる。
 */
async function ensureDevrelaySymlinks() {
  const devrelayBinDir = path.join(process.env.HOME || '', '.devrelay', 'bin');
  const devrelayClaude = path.join(devrelayBinDir, 'devrelay-claude');

  try {
    // ディレクトリが存在しない場合は作成
    await fs.mkdir(devrelayBinDir, { recursive: true });

    // claude バイナリのパスを取得
    const claudePath = execSync('which claude', { encoding: 'utf-8' }).trim();

    // 既存のシンボリックリンクがあれば削除
    try {
      await fs.unlink(devrelayClaude);
    } catch {
      // 存在しない場合は無視
    }

    // シンボリックリンクを作成
    await fs.symlink(claudePath, devrelayClaude);
    console.log(chalk.green(`✅ Symlink created: devrelay-claude -> ${claudePath}`));
  } catch (err) {
    // Claude Code がインストールされていない場合などはエラーにせず警告のみ
    console.log(chalk.yellow(`⚠️ Could not create devrelay-claude symlink: ${(err as Error).message}`));
    console.log(chalk.gray('   Claude Code がインストールされていない場合は無視できます。'));
    console.log(chalk.gray('   後でインストールした場合は、再度 devrelay setup を実行してください。'));
  }
}
