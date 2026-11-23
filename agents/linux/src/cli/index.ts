#!/usr/bin/env node

import { Command } from 'commander';
import { createRequire } from 'module';
import { setupCommand } from './commands/setup.js';
import { statusCommand } from './commands/status.js';
import { projectsCommand } from './commands/projects.js';
import { startCommand } from './commands/start.js';
import { logsCommand } from './commands/logs.js';
import { uninstallCommand } from './commands/uninstall.js';
import { sandboxStatusCommand, sandboxPrepCommand, sandboxSetTokenCommand, sandboxSelftestCommand } from './commands/sandbox.js';

// package.json からバージョンを動的に取得
const require = createRequire(import.meta.url);
const pkg = require('../../package.json');

const program = new Command();

program
  .name('devrelay')
  .description('DevRelay Agent - Remote AI CLI development hub')
  .version(pkg.version);

program
  .command('setup')
  .description('Initial setup and configuration')
  .action(setupCommand);

program
  .command('status')
  .description('Show agent status')
  .action(statusCommand);

program
  .command('start')
  .description('Start the agent')
  .action(startCommand);

program
  .command('stop')
  .description('Stop the agent')
  .action(() => {
    console.log('Stopping agent...');
    // TODO: Implement via systemctl
  });

program
  .command('restart')
  .description('Restart the agent')
  .action(() => {
    console.log('Restarting agent...');
    // TODO: Implement via systemctl
  });

program
  .command('logs')
  .description('View agent logs')
  .option('-f, --follow', 'Follow log output')
  .option('-n, --lines <number>', 'Number of lines to show', '50')
  .action(logsCommand);

program
  .command('projects')
  .description('Manage projects')
  .argument('[action]', 'Action: list, add, remove, scan')
  .argument('[path]', 'Project path (for add/remove)')
  .option('--ai <tool>', 'Default AI tool', 'claude')
  .option('--name <name>', 'Project name (default: directory name). Use for same-named folders.')
  .action(projectsCommand);

program
  .command('config')
  .description('Open config file in editor')
  .action(async () => {
    const { execSync } = await import('child_process');
    const path = await import('path');
    const { getConfigDir } = await import('../services/config.js');
    const configPath = path.join(getConfigDir(), 'config.yaml');
    // Windows: notepad をデフォルトエディタに、Linux: nano
    const defaultEditor = process.platform === 'win32' ? 'notepad' : 'nano';
    const editor = process.env.EDITOR || defaultEditor;
    execSync(`${editor} "${configPath}"`, { stdio: 'inherit' });
  });

program
  .command('token')
  .description('Show or regenerate connection token')
  .action(async () => {
    const { loadConfig } = await import('../services/config.js');
    const config = await loadConfig();
    console.log(`Current token: ${config.token || '(not set)'}`);
  });

program
  .command('uninstall')
  .description('Uninstall DevRelay Agent')
  .action(uninstallCommand);

// サイクル SB-1a-1: Sandbox 実行（仮想アカウント + 外向き通信制限、Windows + claude のみ）。
// ai-runner.ts / connection.ts には未配線（既存の実行経路は一切変更しない）。
const sandbox = program
  .command('sandbox')
  .description('Sandbox 実行（Windows + Claude Code 専用、未配線の単独検証用）');

sandbox
  .command('status')
  .description('Sandbox 実行前確認の結果を表示する')
  .option('--project <path>', 'プロジェクトパス（未指定なら現在のディレクトリ）')
  .action(sandboxStatusCommand);

sandbox
  .command('prep')
  .description('プロジェクトフォルダ・node_modules への ACL を設定する（Windows のみ）')
  .option('--project <path>', 'プロジェクトパス')
  .action(sandboxPrepCommand);

sandbox
  .command('set-token')
  .description('claude setup-token で発行したトークンを登録する（stdin から入力）')
  .action(sandboxSetTokenCommand);

sandbox
  .command('selftest')
  .description('Sandbox Host への接続・実行前確認・簡易プロセス起動を検証する')
  .option('--project <path>', 'プロジェクトパス（未指定なら現在のディレクトリ）')
  .option('--spawn', 'ホスト経由で簡単なコマンドを実行して確認する')
  .option('--network-probe', 'ネットワーク遮断の確認プローブ（curl、ホスト経由）を実行する')
  .option('--acl-audit', 'Sandbox 身元から Agent の設定・トークン等が読めないことを確認する（exit コードのみで判定）')
  .option('--claude-roundtrip', 'claude 本体をホスト経由で 1 往復させて確認する')
  .option('--bits-probe', '既知の回避経路（bitsadmin）の確認プローブを実行する（ウイルス対策ソフトに検知される可能性あり。既定では実行しない）')
  .action(sandboxSelftestCommand);

program.parse();
