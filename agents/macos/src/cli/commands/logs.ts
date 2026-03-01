import { getLogDir } from '../../services/config.js';
import { spawn, execSync } from 'child_process';
import path from 'path';
import fs from 'fs';

interface LogsOptions {
  follow?: boolean;
  lines?: string;
}

/**
 * ログ表示コマンド（クロスプラットフォーム対応）
 *
 * - Linux: tail コマンドを使用
 * - Windows: PowerShell の Get-Content を使用
 *
 * @param options - follow: ログを追従表示、lines: 表示行数
 */
export async function logsCommand(options: LogsOptions) {
  const logDir = getLogDir();
  const logFile = path.join(logDir, 'agent.log');
  const isWindows = process.platform === 'win32';

  // ログファイルの存在確認
  if (!fs.existsSync(logFile)) {
    console.log('📜 No logs found.');
    console.log(`   Log file: ${logFile}`);
    return;
  }

  const lines = options.lines || '50';

  if (options.follow) {
    // ログ追従表示
    console.log(`📜 Following logs (Ctrl+C to stop)...\n`);

    if (isWindows) {
      // Windows: PowerShell の Get-Content -Wait（tail -f 相当）
      const ps = spawn('powershell', [
        '-Command',
        `Get-Content -Path '${logFile}' -Tail ${lines} -Wait -Encoding UTF8`
      ], {
        stdio: 'inherit'
      });

      ps.on('error', (err) => {
        console.error('Failed to read logs:', err.message);
      });

      process.on('SIGINT', () => {
        ps.kill();
        process.exit(0);
      });
    } else {
      // Linux: tail -f
      const tail = spawn('tail', ['-f', '-n', lines, logFile], {
        stdio: 'inherit'
      });

      tail.on('error', (err) => {
        console.error('Failed to read logs:', err.message);
      });

      process.on('SIGINT', () => {
        tail.kill();
        process.exit(0);
      });
    }
  } else {
    // 末尾 N 行を表示
    try {
      let output: string;

      if (isWindows) {
        // Windows: PowerShell の Get-Content -Tail
        output = execSync(
          `powershell -Command "Get-Content -Path '${logFile}' -Tail ${lines} -Encoding UTF8"`,
          { encoding: 'utf-8' }
        );
      } else {
        // Linux: tail -n
        output = execSync(`tail -n ${lines} "${logFile}"`, { encoding: 'utf-8' });
      }

      console.log(`📜 Last ${lines} lines:\n`);
      console.log(output);
    } catch (err: any) {
      console.error('Failed to read logs:', err.message);
    }
  }
}
