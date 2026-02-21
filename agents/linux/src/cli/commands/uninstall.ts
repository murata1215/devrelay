import * as readline from 'readline';
import os from 'os';
import chalk from 'chalk';
import { loadConfig, getConfigDir } from '../../services/config.js';

export async function uninstallCommand() {
  console.log(chalk.red(`
┌─────────────────────────────────────────────────┐
│  DevRelay Agent Uninstall                       │
└─────────────────────────────────────────────────┘
  `));

  const isWindows = process.platform === 'win32';

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
    const configDir = getConfigDir();

    console.log('This will:');
    if (isWindows) {
      console.log(chalk.gray('  • Remove Task Scheduler auto-start task (if registered)'));
      console.log(chalk.gray('  • Stop running agent processes'));
      console.log(chalk.gray(`  • Delete ${configDir} configuration directory`));
    } else {
      console.log(chalk.gray('  • Stop and remove systemd service (if installed)'));
      console.log(chalk.gray(`  • Delete ${configDir} configuration directory`));
    }
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

    if (isWindows) {
      // === Windows: タスクスケジューラ削除 + プロセス停止 ===
      console.log(chalk.blue('\n📦 Removing scheduled task...'));
      try {
        execSync('schtasks /Delete /TN "DevRelay Agent" /F', { stdio: 'pipe' });
        console.log(chalk.green('  ✓ Scheduled task removed'));
      } catch {
        console.log(chalk.gray('  ✓ No scheduled task found'));
      }

      console.log(chalk.blue('\n📦 Stopping agent processes...'));
      try {
        // devrelay 関連の node プロセスを停止
        // wmic は非推奨だが PowerShell の Get-Process よりシンプル
        execSync('taskkill /F /FI "WINDOWTITLE eq DevRelay*" 2>nul', { stdio: 'pipe' });
        console.log(chalk.green('  ✓ Agent processes stopped'));
      } catch {
        console.log(chalk.gray('  ✓ No running agent processes found'));
      }
    } else {
      // === Linux: systemd サービス削除 ===
      console.log(chalk.blue('\n📦 Removing user service...'));
      const userServicePath = path.join(
        os.homedir(),
        '.config',
        'systemd',
        'user',
        'devrelay-agent.service'
      );

      try {
        await fs.access(userServicePath);

        try {
          execSync('systemctl --user stop devrelay-agent 2>/dev/null', { stdio: 'pipe' });
        } catch { /* ignore if not running */ }

        try {
          execSync('systemctl --user disable devrelay-agent 2>/dev/null', { stdio: 'pipe' });
        } catch { /* ignore if not enabled */ }

        await fs.unlink(userServicePath);
        execSync('systemctl --user daemon-reload', { stdio: 'pipe' });

        console.log(chalk.green('  ✓ User service removed'));
      } catch {
        console.log(chalk.gray('  ✓ No user service found'));
      }

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
    }

    // 設定ディレクトリ削除（OS 共通）
    console.log(chalk.blue('\n📦 Removing configuration...'));

    try {
      await fs.access(configDir);
      await fs.rm(configDir, { recursive: true, force: true });
      console.log(chalk.green('  ✓ Configuration directory removed'));
    } catch {
      console.log(chalk.gray('  ✓ No configuration directory found'));
    }

    // プロジェクトデータの削除（OS 共通）
    console.log();
    const deleteProjectData = await question(
      chalk.yellow('Delete project data (.devrelay/ in each project)? (y/N): ')
    );

    if (deleteProjectData === 'y' || deleteProjectData === 'yes') {
      console.log(chalk.blue('\n📦 Removing project data...'));

      try {
        const config = await loadConfig();
        const projectsDirs = config.projectsDirs || [os.homedir()];

        for (const baseDir of projectsDirs) {
          await deleteProjectDevrelayDirs(baseDir, fs, path);
        }
      } catch {
        // 設定ファイルが存在しない場合はホームディレクトリをスキャン
        await deleteProjectDevrelayDirs(os.homedir(), fs, path);
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

/**
 * プロジェクト内の .devrelay/ ディレクトリを再帰検索して削除する
 *
 * - Linux: find コマンドを使用
 * - Windows: PowerShell の Get-ChildItem を使用
 *
 * @param baseDir - 検索開始ディレクトリ
 * @param fs - fs/promises モジュール
 * @param path - path モジュール
 */
async function deleteProjectDevrelayDirs(
  baseDir: string,
  fs: typeof import('fs/promises'),
  path: typeof import('path')
) {
  const { execSync } = await import('child_process');
  const configDir = getConfigDir();

  try {
    let dirs: string[] = [];

    if (process.platform === 'win32') {
      // Windows: PowerShell で .devrelay ディレクトリを再帰検索
      const result = execSync(
        `powershell -Command "Get-ChildItem -Path '${baseDir}' -Filter '.devrelay' -Directory -Recurse -Depth 5 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName"`,
        { encoding: 'utf-8' }
      );
      dirs = result.trim().split(/\r?\n/).filter(Boolean);
    } else {
      // Linux: find コマンドで .devrelay ディレクトリを再帰検索
      const result = execSync(
        `find "${baseDir}" -maxdepth 6 -type d -name ".devrelay" 2>/dev/null || true`,
        { encoding: 'utf-8' }
      );
      dirs = result.trim().split('\n').filter(Boolean);
    }

    for (const dir of dirs) {
      // メイン設定ディレクトリはスキップ
      if (path.resolve(dir) === path.resolve(configDir)) {
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
    // コマンド実行失敗は無視
  }
}
