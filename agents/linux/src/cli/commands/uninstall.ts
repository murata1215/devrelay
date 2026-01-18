import * as readline from 'readline';
import chalk from 'chalk';
import { loadConfig } from '../../services/config.js';

export async function uninstallCommand() {
  console.log(chalk.red(`
┌─────────────────────────────────────────────────┐
│  DevRelay Agent Uninstall                       │
└─────────────────────────────────────────────────┘
  `));

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const question = (prompt: string): Promise<string> => {
    return new Promise((resolve) => {
      rl.question(prompt, (answer) => {
        resolve(answer.trim().toLowerCase());
      });
    });
  };

  try {
    console.log('This will:');
    console.log(chalk.gray('  • Stop and remove systemd service (if installed)'));
    console.log(chalk.gray('  • Delete ~/.devrelay/ configuration directory'));
    console.log(chalk.gray('  • Optionally delete project .devrelay/ directories'));
    console.log();

    const confirmed = await question(chalk.yellow('Are you sure you want to uninstall? (y/N): '));
    if (confirmed !== 'y' && confirmed !== 'yes') {
      console.log(chalk.gray('\nUninstall cancelled.'));
      return;
    }

    const { execSync } = await import('child_process');
    const fs = await import('fs/promises');
    const path = await import('path');

    // Stop and remove user service
    console.log(chalk.blue('\n📦 Removing user service...'));
    const userServicePath = path.join(
      process.env.HOME || '',
      '.config',
      'systemd',
      'user',
      'devrelay-agent.service'
    );

    try {
      // Check if user service exists
      await fs.access(userServicePath);

      // Stop and disable
      try {
        execSync('systemctl --user stop devrelay-agent 2>/dev/null', { stdio: 'pipe' });
      } catch { /* ignore if not running */ }

      try {
        execSync('systemctl --user disable devrelay-agent 2>/dev/null', { stdio: 'pipe' });
      } catch { /* ignore if not enabled */ }

      // Remove service file
      await fs.unlink(userServicePath);
      execSync('systemctl --user daemon-reload', { stdio: 'pipe' });

      console.log(chalk.green('  ✓ User service removed'));
    } catch {
      console.log(chalk.gray('  ✓ No user service found'));
    }

    // Stop and remove system service
    console.log(chalk.blue('\n📦 Checking system service...'));
    const systemServicePath = '/etc/systemd/system/devrelay-agent.service';

    try {
      await fs.access(systemServicePath);

      console.log(chalk.yellow('  System service found. Attempting to remove (may require sudo)...'));

      try {
        execSync('sudo systemctl stop devrelay-agent 2>/dev/null', { stdio: 'pipe' });
      } catch { /* ignore if not running */ }

      try {
        execSync('sudo systemctl disable devrelay-agent 2>/dev/null', { stdio: 'pipe' });
      } catch { /* ignore if not enabled */ }

      try {
        execSync(`sudo rm ${systemServicePath}`, { stdio: 'pipe' });
        execSync('sudo systemctl daemon-reload', { stdio: 'pipe' });
        console.log(chalk.green('  ✓ System service removed'));
      } catch {
        console.log(chalk.yellow(`  ⚠ Could not remove system service. Run manually:`));
        console.log(chalk.gray(`    sudo rm ${systemServicePath}`));
        console.log(chalk.gray('    sudo systemctl daemon-reload'));
      }
    } catch {
      console.log(chalk.gray('  ✓ No system service found'));
    }

    // Remove ~/.devrelay/ directory
    console.log(chalk.blue('\n📦 Removing configuration...'));
    const configDir = path.join(process.env.HOME || '', '.devrelay');

    try {
      await fs.access(configDir);
      await fs.rm(configDir, { recursive: true, force: true });
      console.log(chalk.green('  ✓ Configuration directory removed'));
    } catch {
      console.log(chalk.gray('  ✓ No configuration directory found'));
    }

    // Ask about project data
    console.log();
    const deleteProjectData = await question(
      chalk.yellow('Delete project data (.devrelay/ in each project)? (y/N): ')
    );

    if (deleteProjectData === 'y' || deleteProjectData === 'yes') {
      console.log(chalk.blue('\n📦 Removing project data...'));

      // Load config to get projectsDirs (if still exists)
      try {
        const config = await loadConfig();
        const projectsDirs = config.projectsDirs || [process.env.HOME || ''];

        for (const baseDir of projectsDirs) {
          await deleteProjectDevrelayDirs(baseDir, fs, path);
        }
      } catch {
        // Config doesn't exist, scan home directory
        const homeDir = process.env.HOME || '';
        await deleteProjectDevrelayDirs(homeDir, fs, path);
      }

      console.log(chalk.green('  ✓ Project data removed'));
    } else {
      console.log(chalk.gray('\n  Skipping project data removal.'));
    }

    console.log(chalk.green('\n✅ DevRelay Agent uninstalled!'));
    console.log();
    console.log('Note: The agent binary/source files were not removed.');
    console.log('To completely remove, delete the devrelay directory manually.');
    console.log();
  } finally {
    rl.close();
  }
}

async function deleteProjectDevrelayDirs(
  baseDir: string,
  fs: typeof import('fs/promises'),
  path: typeof import('path')
) {
  const { execSync } = await import('child_process');

  try {
    // Find all .devrelay directories under baseDir (max depth 5)
    const result = execSync(
      `find "${baseDir}" -maxdepth 6 -type d -name ".devrelay" 2>/dev/null || true`,
      { encoding: 'utf-8' }
    );

    const dirs = result.trim().split('\n').filter(Boolean);

    for (const dir of dirs) {
      // Skip the main config directory
      if (dir === path.join(process.env.HOME || '', '.devrelay')) {
        continue;
      }

      try {
        await fs.rm(dir, { recursive: true, force: true });
        console.log(chalk.gray(`    Removed: ${dir}`));
      } catch {
        console.log(chalk.yellow(`    Could not remove: ${dir}`));
      }
    }
  } catch {
    // find command failed, ignore
  }
}
