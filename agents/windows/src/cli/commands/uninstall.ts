import * as readline from 'readline';
import path from 'path';
import chalk from 'chalk';
import { loadConfig, getConfigDir } from '../../services/config.js';

export async function uninstallCommand() {
  console.log(chalk.red(`
+--------------------------------------------------+
|  DevRelay Agent Uninstall (Windows)              |
+--------------------------------------------------+
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
    console.log(chalk.gray('  * Remove from Windows Startup (if added)'));
    console.log(chalk.gray(`  * Delete ${getConfigDir()} configuration directory`));
    console.log(chalk.gray('  * Optionally delete project .devrelay/ directories'));
    console.log();

    const confirmed = await question(chalk.yellow('Are you sure you want to uninstall? (y/N): '));
    if (confirmed !== 'y' && confirmed !== 'yes') {
      console.log(chalk.gray('\nUninstall cancelled.'));
      return;
    }

    const fs = await import('fs/promises');
    const fsSync = await import('fs');

    // Remove from Windows Startup
    console.log(chalk.blue('\nRemoving from Windows Startup...'));
    const startupVbs = path.join(
      process.env.APPDATA || '',
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs',
      'Startup',
      'devrelay-agent.vbs'
    );

    try {
      if (fsSync.existsSync(startupVbs)) {
        await fs.unlink(startupVbs);
        console.log(chalk.green('  [OK] Removed from Windows Startup'));
      } else {
        console.log(chalk.gray('  [OK] Not in Windows Startup'));
      }
    } catch (err: any) {
      console.log(chalk.yellow(`  [!!] Could not remove from Startup: ${err.message}`));
    }

    // Remove config directory
    console.log(chalk.blue('\nRemoving configuration...'));
    const configDir = getConfigDir();

    try {
      if (fsSync.existsSync(configDir)) {
        await fs.rm(configDir, { recursive: true, force: true });
        console.log(chalk.green('  [OK] Configuration directory removed'));
      } else {
        console.log(chalk.gray('  [OK] No configuration directory found'));
      }
    } catch (err: any) {
      console.log(chalk.yellow(`  [!!] Could not remove config directory: ${err.message}`));
    }

    // Ask about project data
    console.log();
    const deleteProjectData = await question(
      chalk.yellow('Delete project data (.devrelay/ in each project)? (y/N): ')
    );

    if (deleteProjectData === 'y' || deleteProjectData === 'yes') {
      console.log(chalk.blue('\nRemoving project data...'));

      // Load config to get projectsDirs (if still exists)
      try {
        const config = await loadConfig();
        const projectsDirs = config.projectsDirs || [process.env.USERPROFILE || ''];

        for (const baseDir of projectsDirs) {
          await deleteProjectDevrelayDirs(baseDir);
        }
      } catch {
        // Config doesn't exist, scan home directory
        const homeDir = process.env.USERPROFILE || '';
        await deleteProjectDevrelayDirs(homeDir);
      }

      console.log(chalk.green('  [OK] Project data removed'));
    } else {
      console.log(chalk.gray('\n  Skipping project data removal.'));
    }

    console.log(chalk.green('\nDevRelay Agent uninstalled!'));
    console.log();
    console.log('Note: The agent binary/source files were not removed.');
    console.log('To completely remove, delete the devrelay directory manually.');
    console.log();
  } finally {
    rl.close();
  }
}

async function deleteProjectDevrelayDirs(baseDir: string) {
  const fs = await import('fs/promises');
  const fsSync = await import('fs');

  // Recursively find .devrelay directories
  async function findAndDelete(dir: string, depth: number = 0) {
    if (depth > 5) return; // Max depth

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const fullPath = path.join(dir, entry.name);

        // Skip certain directories
        if (entry.name === 'node_modules') continue;
        if (entry.name.startsWith('.') && entry.name !== '.devrelay') continue;

        if (entry.name === '.devrelay') {
          // Don't delete the main config directory
          if (fullPath === getConfigDir()) continue;

          try {
            await fs.rm(fullPath, { recursive: true, force: true });
            console.log(`    Removed: ${fullPath}`);
          } catch {
            console.log(`    Could not remove: ${fullPath}`);
          }
        } else {
          // Recurse into subdirectories
          await findAndDelete(fullPath, depth + 1);
        }
      }
    } catch {
      // Permission denied or other error, skip
    }
  }

  await findAndDelete(baseDir);
}
