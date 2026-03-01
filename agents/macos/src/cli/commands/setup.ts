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

/** LaunchAgent の識別子 */
const PLIST_LABEL = 'io.devrelay.agent';

export async function setupCommand() {
  console.log(chalk.blue(`
┌─────────────────────────────────────────────────┐
│  DevRelay Agent Setup (macOS)                   │
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

    // macOS: LaunchAgent サービス登録オプション
    console.log();
    console.log(chalk.blue('Auto-start options:'));
    console.log(chalk.gray('  1. LaunchAgent (recommended) - starts agent at login'));
    console.log(chalk.gray('  2. Skip - start manually'));
    console.log();

    const serviceChoice = await question('Install LaunchAgent? (1/2)', '1');

    if (serviceChoice === '1') {
      await installLaunchAgent(machineName);
    }

    console.log(chalk.green('\n🎉 Setup complete!'));
    console.log();
    console.log('Next steps:');
    if (serviceChoice === '1') {
      console.log(chalk.cyan(`  1. Start agent:      launchctl start ${PLIST_LABEL}`));
      console.log(chalk.cyan(`  2. Check status:     launchctl list ${PLIST_LABEL}`));
      console.log(chalk.cyan(`  3. View logs:        tail -f ${path.join(getConfigDir(), 'logs', 'agent.log')}`));
    } else {
      console.log(chalk.cyan(`  1. Start agent:      cd agents/macos && pnpm start`));
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
 * macOS の LaunchAgent を登録する
 *
 * ~/Library/LaunchAgents/ に plist ファイルを配置し、
 * ログイン時に自動起動するよう設定する。
 * KeepAlive で異常終了時の自動再起動も有効。
 *
 * @param machineName - Agent のマシン名（表示用）
 */
async function installLaunchAgent(machineName: string) {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const agentDir = path.resolve(__dirname, '../..');
  const agentIndex = path.join(agentDir, 'index.js');
  const nodePath = process.execPath;
  const configDir = getConfigDir();
  const logFile = path.join(configDir, 'logs', 'agent.log');

  // logs ディレクトリを確保
  await fs.mkdir(path.join(configDir, 'logs'), { recursive: true });

  // plist XML を生成
  const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${agentIndex}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${agentDir}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logFile}</string>
  <key>StandardErrorPath</key>
  <string>${logFile}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key>
    <string>production</string>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
`;

  const launchAgentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
  const plistPath = path.join(launchAgentsDir, `${PLIST_LABEL}.plist`);

  try {
    // LaunchAgents ディレクトリを確保
    await fs.mkdir(launchAgentsDir, { recursive: true });

    // 既存の LaunchAgent があれば先にアンロード
    try {
      execSync(`launchctl unload "${plistPath}" 2>/dev/null`, { stdio: 'pipe' });
    } catch {
      // 未登録の場合は無視
    }

    // plist ファイルを書き込み
    await fs.writeFile(plistPath, plistContent);

    // LaunchAgent を登録・起動
    execSync(`launchctl load -w "${plistPath}"`, { stdio: 'inherit' });

    console.log(chalk.green('\n✅ LaunchAgent installed and started!'));
    console.log(chalk.gray(`   Plist: ${plistPath}`));
  } catch (err: any) {
    console.log(chalk.yellow('\n⚠️ Could not install LaunchAgent automatically.'));
    console.log(chalk.yellow(`   You can manually create: ${plistPath}`));
    console.log();
    console.log(chalk.gray(plistContent));
  }
}

/**
 * devrelay-claude ラッパーを作成する（macOS 版）
 *
 * Claude Code のプロセスを識別しやすくするためのシンボリックリンクを作成する。
 */
async function ensureDevrelaySymlinks() {
  const devrelayBinDir = getBinDir();
  const wrapperName = 'devrelay-claude';
  const devrelayClaude = path.join(devrelayBinDir, wrapperName);

  try {
    // ディレクトリが存在しない場合は作成
    await fs.mkdir(devrelayBinDir, { recursive: true });

    // claude バイナリのパスを取得
    const claudePathRaw = execSync('which claude', { encoding: 'utf-8' }).trim();
    const claudePath = claudePathRaw.split(/\r?\n/)[0];

    // 既存のラッパーがあれば削除
    try {
      await fs.unlink(devrelayClaude);
    } catch {
      // 存在しない場合は無視
    }

    // シンボリックリンクを作成
    await fs.symlink(claudePath, devrelayClaude);
    console.log(chalk.green(`✅ Wrapper created: ${wrapperName} -> ${claudePath}`));
  } catch (err) {
    // Claude Code がインストールされていない場合などはエラーにせず警告のみ
    console.log(chalk.yellow(`⚠️ Could not create ${wrapperName}: ${(err as Error).message}`));
    console.log(chalk.gray('   Claude Code がインストールされていない場合は無視できます。'));
    console.log(chalk.gray('   後でインストールした場合、Agent が自動的に検出・設定します。'));
  }
}
