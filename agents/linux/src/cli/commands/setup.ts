import * as readline from 'readline';
import os from 'os';
import { nanoid } from 'nanoid';
import chalk from 'chalk';
import { loadConfig, saveConfig, ensureConfigDir } from '../../services/config.js';

export async function setupCommand() {
  console.log(chalk.blue(`
┌─────────────────────────────────────────────────┐
│  DevBridge Agent Setup                          │
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
    // Machine name
    const machineName = await question(
      'Machine name',
      existingConfig.machineName || os.hostname()
    );

    // Server URL
    const serverUrl = await question(
      'Server URL',
      existingConfig.serverUrl || 'wss://devbridge.io/ws/agent'
    );

    // Connection token
    console.log(chalk.yellow('\nConnection token is required to authenticate with the server.'));
    console.log(chalk.yellow('You can get it from: https://devbridge.io/dashboard\n'));
    
    const token = await question(
      'Connection token',
      existingConfig.token
    );

    if (!token) {
      console.log(chalk.red('\n❌ Token is required. Setup cancelled.'));
      rl.close();
      return;
    }

    // Projects directory
    const projectsDir = await question(
      'Projects directory',
      existingConfig.projectsDir || `${os.homedir()}/projects`
    );

    // Generate machine ID if not exists
    const machineId = existingConfig.machineId || nanoid();

    // Save config
    const config = {
      ...existingConfig,
      machineName,
      machineId,
      serverUrl,
      token,
      projectsDir,
    };

    await saveConfig(config);

    console.log(chalk.green('\n✅ Configuration saved!'));
    console.log(chalk.gray(`   Config: ~/.devbridge/config.yaml`));
    console.log();

    // Ask about systemd service
    const installService = await question(
      'Install as systemd service? (y/n)',
      'y'
    );

    if (installService.toLowerCase() === 'y') {
      await installSystemdService(machineName);
    }

    console.log(chalk.green('\n🎉 Setup complete!'));
    console.log();
    console.log('Next steps:');
    console.log(chalk.cyan('  1. Add projects:     devbridge projects add ~/projects/my-app'));
    console.log(chalk.cyan('  2. Start agent:      devbridge start'));
    console.log(chalk.cyan('  3. Check status:     devbridge status'));
    console.log();
  } finally {
    rl.close();
  }
}

async function installSystemdService(machineName: string) {
  const { execSync } = await import('child_process');
  const fs = await import('fs/promises');
  const path = await import('path');

  const serviceContent = `[Unit]
Description=DevBridge Agent (${machineName})
After=network.target

[Service]
Type=simple
User=${process.env.USER}
WorkingDirectory=${process.env.HOME}
ExecStart=${process.execPath} ${path.resolve(__dirname, '../../index.js')}
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
`;

  const servicePath = '/etc/systemd/system/devbridge.service';

  try {
    // Write service file (requires sudo)
    const tempPath = '/tmp/devbridge.service';
    await fs.writeFile(tempPath, serviceContent);
    
    execSync(`sudo mv ${tempPath} ${servicePath}`, { stdio: 'inherit' });
    execSync('sudo systemctl daemon-reload', { stdio: 'inherit' });
    execSync('sudo systemctl enable devbridge', { stdio: 'inherit' });
    
    console.log(chalk.green('\n✅ Systemd service installed!'));
    console.log(chalk.gray('   Start with: sudo systemctl start devbridge'));
  } catch (err: any) {
    console.log(chalk.yellow('\n⚠️ Could not install systemd service automatically.'));
    console.log(chalk.yellow('   You can manually create: /etc/systemd/system/devbridge.service'));
    console.log();
    console.log(chalk.gray(serviceContent));
  }
}
