import * as readline from 'readline';
import os from 'os';
import chalk from 'chalk';
import { loadConfig, getConfigDir } from '../../services/config.js';

/** LaunchAgent の識別子 */
const PLIST_LABEL = 'io.devrelay.agent';

export async function uninstallCommand() {
  console.log(chalk.red(`
┌─────────────────────────────────────────────────┐
│  DevRelay Agent Uninstall (macOS)               │
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
    const configDir = getConfigDir();

    console.log('This will:');
    console.log(chalk.gray('  • Stop and remove LaunchAgent (if installed)'));
    console.log(chalk.gray('  • Stop running agent processes'));
    console.log(chalk.gray(`  • Delete ${configDir} configuration directory`));
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

    // === macOS: LaunchAgent 削除 ===
    console.log(chalk.blue('\n📦 Removing LaunchAgent...'));
    const plistPath = path.join(
      os.homedir(),
      'Library',
      'LaunchAgents',
      `${PLIST_LABEL}.plist`
    );

    try {
      await fs.access(plistPath);

      // LaunchAgent をアンロード
      try {
        execSync(`launchctl unload "${plistPath}" 2>/dev/null`, { stdio: 'pipe' });
      } catch { /* 未ロードの場合は無視 */ }

      // plist ファイルを削除
      await fs.unlink(plistPath);
      console.log(chalk.green('  ✓ LaunchAgent removed'));
    } catch {
      console.log(chalk.gray('  ✓ No LaunchAgent found'));
    }

    // プロセス停止（LaunchAgent 以外で起動されている場合のフォールバック）
    console.log(chalk.blue('\n📦 Stopping agent processes...'));
    try {
      execSync('pgrep -f "devrelay.*agent" | xargs kill 2>/dev/null', { stdio: 'pipe' });
      console.log(chalk.green('  ✓ Agent processes stopped'));
    } catch {
      console.log(chalk.gray('  ✓ No running agent processes found'));
    }

    // 設定ディレクトリ削除
    console.log(chalk.blue('\n📦 Removing configuration...'));

    try {
      await fs.access(configDir);
      await fs.rm(configDir, { recursive: true, force: true });
      console.log(chalk.green('  ✓ Configuration directory removed'));
    } catch {
      console.log(chalk.gray('  ✓ No configuration directory found'));
    }

    // プロジェクトデータの削除
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
 * macOS: find コマンドを使用（BSD find、Linux と互換）
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
    // macOS (BSD find) でも Linux (GNU find) でも互換の構文
    const result = execSync(
      `find "${baseDir}" -maxdepth 6 -type d -name ".devrelay" 2>/dev/null || true`,
      { encoding: 'utf-8' }
    );
    const dirs = result.trim().split('\n').filter(Boolean);

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
