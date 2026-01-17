#!/usr/bin/env node

import { Command } from 'commander';
import { setupCommand } from './commands/setup.js';
import { statusCommand } from './commands/status.js';
import { projectsCommand } from './commands/projects.js';
import { startCommand } from './commands/start.js';
import { logsCommand } from './commands/logs.js';

const program = new Command();

program
  .name('devbridge')
  .description('DevBridge Agent - Remote AI CLI development hub')
  .version('0.1.0');

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
  .action(projectsCommand);

program
  .command('config')
  .description('Open config file in editor')
  .action(() => {
    const { execSync } = require('child_process');
    const editor = process.env.EDITOR || 'nano';
    const configPath = `${process.env.HOME}/.devbridge/config.yaml`;
    execSync(`${editor} ${configPath}`, { stdio: 'inherit' });
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
  .description('Uninstall DevBridge Agent')
  .action(() => {
    console.log('Uninstalling DevBridge Agent...');
    // TODO: Implement uninstall
  });

program.parse();
