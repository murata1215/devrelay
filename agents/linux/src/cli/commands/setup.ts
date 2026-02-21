import * as readline from 'readline';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { execSync } from 'child_process';
import { nanoid } from 'nanoid';
import chalk from 'chalk';
import { fileURLToPath } from 'url';
import { decodeTokenUrl } from '@devrelay/shared';
import { loadConfig, saveConfig, ensureConfigDir, getConfigDir, getBinDir } from '../../services/config.js';

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
    console.log(chalk.gray(' Dashboard URL: https://devrelay.io/machines'));
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

    // トークンからサーバーURLを自動抽出（新形式トークンの場合）
    const tokenUrl = decodeTokenUrl(token);
    if (tokenUrl) {
      console.log(chalk.green(`✅ Server URL detected from token: ${tokenUrl}`));
    }

    // Use defaults for machine name and server URL (can be changed later in config.yaml)
    const machineName = existingConfig.machineName || `${os.hostname()}/${os.userInfo().username}`;
    const serverUrl = tokenUrl || existingConfig.serverUrl || 'wss://devrelay.io/ws/agent';
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
    console.log(chalk.gray(`   Config: ${path.join(getConfigDir(), 'config.yaml')}`));
    console.log();

    // Claude Code のラッパーを作成（プロセス識別用）
    await ensureDevrelaySymlinks();

    // OS に応じたサービス登録オプションを表示
    let serviceChoice = '3'; // デフォルト: スキップ

    if (process.platform === 'win32') {
      // Windows: タスクスケジューラ
      console.log();
      console.log(chalk.blue('Auto-start options:'));
      console.log(chalk.gray('  1. Task Scheduler (recommended) - starts agent at logon'));
      console.log(chalk.gray('  2. Skip - start manually'));
      console.log();

      serviceChoice = await question('Install auto-start? (1/2)', '1');

      if (serviceChoice === '1') {
        await installWindowsScheduledTask(machineName);
      }

      console.log(chalk.green('\n🎉 Setup complete!'));
      console.log();
      console.log('Next steps:');
      if (serviceChoice === '1') {
        console.log(chalk.cyan('  1. Check status:     schtasks /Query /TN "DevRelay Agent"'));
        console.log(chalk.cyan(`  2. View logs:        type "${path.join(getConfigDir(), 'logs', 'agent.log')}"`));
      } else {
        const agentIndex = getAgentIndexPath();
        console.log(chalk.cyan(`  1. Start agent:      node "${agentIndex}"`));
      }
    } else {
      // Linux: systemd
      console.log();
      console.log(chalk.blue('Systemd service options:'));
      console.log(chalk.gray('  1. User service (recommended) - no sudo required'));
      console.log(chalk.gray('  2. System service - requires sudo'));
      console.log(chalk.gray('  3. Skip - start manually with pnpm start'));
      console.log();

      serviceChoice = await question('Install systemd service? (1/2/3)', '1');

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
    }

    console.log();
  } finally {
    rl.close();
  }
}

/**
 * Agent の index.js パスを取得するヘルパー
 * CLI ファイルからの相対パスで dist/index.js を解決する
 */
function getAgentIndexPath(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  return path.join(path.resolve(__dirname, '../..'), 'index.js');
}

/**
 * Windows タスクスケジューラに自動起動タスクを登録する
 *
 * schtasks コマンドを使用（全 PowerShell バージョンで動作）。
 * ログオン時に Agent を自動起動するタスクを作成し、即座に実行する。
 *
 * @param machineName - Agent のマシン名（タスク説明に使用）
 */
async function installWindowsScheduledTask(machineName: string) {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const agentDir = path.resolve(__dirname, '../..');
  const agentIndex = path.join(agentDir, 'index.js');
  const nodePath = process.execPath;

  try {
    const taskName = 'DevRelay Agent';

    // schtasks でログオン時自動起動タスクを登録
    // /RL LIMITED: 管理者権限不要で実行
    // /F: 既存タスクがあれば上書き
    const createCmd = `schtasks /Create /TN "${taskName}" /TR "\\"${nodePath}\\" \\"${agentIndex}\\"" /SC ONLOGON /F /RL LIMITED`;
    execSync(createCmd, { stdio: 'pipe' });

    // タスクを即座に実行
    try {
      execSync(`schtasks /Run /TN "${taskName}"`, { stdio: 'pipe' });
    } catch {
      // タスク実行に失敗しても登録自体は成功
      console.log(chalk.yellow('  ⚠️ Could not start task immediately. It will start at next logon.'));
    }

    console.log(chalk.green('\n✅ Task Scheduler task registered and started!'));
    console.log(chalk.gray(`   Task name: ${taskName}`));
    console.log(chalk.gray(`   Check status: schtasks /Query /TN "${taskName}"`));
  } catch (err: any) {
    console.log(chalk.yellow('\n⚠️ Could not register scheduled task automatically.'));
    console.log(chalk.yellow('You can register it manually via Task Scheduler or run:'));
    console.log(chalk.gray(`   node "${agentIndex}"`));
  }
}

async function installUserService(machineName: string) {
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
  // Agent ディレクトリを解決（CLIファイルからの相対パス）
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
 * devrelay-claude ラッパーを作成する（クロスプラットフォーム対応）
 *
 * Claude Code のプロセスを識別しやすくするためのラッパーを作成する。
 * - Linux: シンボリックリンク（devrelay-claude -> claude）
 * - Windows: .cmd バッチファイル（管理者権限不要）
 */
async function ensureDevrelaySymlinks() {
  const isWindows = process.platform === 'win32';
  const devrelayBinDir = getBinDir();
  const wrapperName = isWindows ? 'devrelay-claude.cmd' : 'devrelay-claude';
  const devrelayClaude = path.join(devrelayBinDir, wrapperName);

  try {
    // ディレクトリが存在しない場合は作成
    await fs.mkdir(devrelayBinDir, { recursive: true });

    // claude バイナリのパスを取得（Linux: which, Windows: where）
    const findCmd = isWindows ? 'where' : 'which';
    const claudePathRaw = execSync(`${findCmd} claude`, { encoding: 'utf-8' }).trim();
    const claudePath = claudePathRaw.split(/\r?\n/)[0];

    // 既存のラッパーがあれば削除
    try {
      await fs.unlink(devrelayClaude);
    } catch {
      // 存在しない場合は無視
    }

    if (isWindows) {
      // Windows: .cmd バッチファイルを作成
      await fs.writeFile(devrelayClaude, `@echo off\r\n"${claudePath}" %*\r\n`);
    } else {
      // Linux: シンボリックリンクを作成
      await fs.symlink(claudePath, devrelayClaude);
    }
    console.log(chalk.green(`✅ Wrapper created: ${wrapperName} -> ${claudePath}`));
  } catch (err) {
    // Claude Code がインストールされていない場合などはエラーにせず警告のみ
    console.log(chalk.yellow(`⚠️ Could not create ${wrapperName}: ${(err as Error).message}`));
    console.log(chalk.gray('   Claude Code がインストールされていない場合は無視できます。'));
    console.log(chalk.gray('   後でインストールした場合、Agent が自動的に検出・設定します。'));
  }
}
