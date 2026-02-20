import * as readline from 'readline';
import os from 'os';
import path from 'path';
import { nanoid } from 'nanoid';
import chalk from 'chalk';
import { decodeTokenUrl } from '@devrelay/shared';
import { loadConfig, saveConfig, ensureConfigDir, getConfigDir } from '../../services/config.js';

export async function setupCommand() {
  console.log(chalk.blue(`
+--------------------------------------------------+
|  DevRelay Agent Setup (Windows)                  |
+--------------------------------------------------+
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
    console.log(chalk.yellow('='.repeat(50)));
    console.log(chalk.yellow(' Connection token is required to authenticate.'));
    console.log(chalk.yellow(''));
    console.log(chalk.yellow(' To get your token:'));
    console.log(chalk.cyan('  1. Go to the DevRelay dashboard'));
    console.log(chalk.cyan('  2. Navigate to "Machines"'));
    console.log(chalk.cyan('  3. Click "+ Add Machine"'));
    console.log(chalk.cyan('  4. Copy the generated token'));
    console.log(chalk.yellow(''));
    console.log(chalk.gray(' Dashboard URL: https://devrelay.io/machines'));
    console.log(chalk.gray('               (or your self-hosted URL)'));
    console.log(chalk.yellow('='.repeat(50)));
    console.log();

    const token = await question(
      'Connection token',
      existingConfig.token
    );

    if (!token) {
      console.log(chalk.red('\nToken is required. Setup cancelled.'));
      rl.close();
      return;
    }

    // トークンからサーバーURLを自動抽出（新形式トークンの場合）
    const tokenUrl = decodeTokenUrl(token);
    if (tokenUrl) {
      console.log(chalk.green(`✅ Server URL detected from token: ${tokenUrl}`));
    }

    // Use defaults for machine name and server URL (can be changed later in config.yaml)
    const machineName = existingConfig.machineName || os.hostname();
    const serverUrl = tokenUrl || existingConfig.serverUrl || 'wss://devrelay.io/ws/agent';

    // Default projects directories for Windows
    const projectsDirs = existingConfig.projectsDirs || [
      os.homedir(),
      path.join(os.homedir(), 'Documents')
    ];

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

    console.log(chalk.green('\nConfiguration saved!'));
    console.log(chalk.gray(`   Config: ${getConfigDir()}\\config.yaml`));
    console.log();

    // Ask about startup registration
    console.log();
    console.log(chalk.blue('Auto-start options:'));
    console.log(chalk.gray('  1. Add to Windows Startup (recommended) - starts when you log in'));
    console.log(chalk.gray('  2. Skip - start manually with "devrelay start"'));
    console.log();

    const startupChoice = await question(
      'Add to Windows Startup? (1/2)',
      '1'
    );

    if (startupChoice === '1') {
      await addToStartup();
    }

    console.log(chalk.green('\nSetup complete!'));
    console.log();
    console.log('Next steps:');
    if (startupChoice === '1') {
      console.log(chalk.cyan('  The agent will start automatically when you log in.'));
      console.log(chalk.cyan('  To start now: devrelay start'));
    } else {
      console.log(chalk.cyan('  Start agent: devrelay start'));
    }
    console.log();
  } finally {
    rl.close();
  }
}

async function addToStartup() {
  const fs = await import('fs/promises');
  const { fileURLToPath } = await import('url');

  // Find the agent directory (relative to this CLI file)
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const agentDir = path.resolve(__dirname, '../..');
  const agentIndex = path.join(agentDir, 'index.js');

  // Windows Startup folder path
  const startupPath = path.join(
    process.env.APPDATA || '',
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Startup'
  );

  // Create a VBScript to run the agent silently (no console window)
  const vbsPath = path.join(startupPath, 'devrelay-agent.vbs');
  const vbsContent = `Set WshShell = CreateObject("WScript.Shell")
WshShell.Run """${process.execPath}"" ""${agentIndex}""", 0, False
`;

  try {
    await fs.writeFile(vbsPath, vbsContent, 'utf-8');
    console.log(chalk.green('\nAdded to Windows Startup!'));
    console.log(chalk.gray(`   Startup script: ${vbsPath}`));
  } catch (err: any) {
    console.log(chalk.yellow('\nCould not add to Windows Startup automatically.'));
    console.log(chalk.yellow(`   You can manually create: ${vbsPath}`));
    console.log();
    console.log(chalk.gray('VBScript content:'));
    console.log(chalk.gray(vbsContent));
  }
}
