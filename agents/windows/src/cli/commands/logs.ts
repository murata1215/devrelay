import { getLogDir } from '../../services/config.js';
import { spawn, execSync } from 'child_process';
import path from 'path';
import fs from 'fs';

interface LogsOptions {
  follow?: boolean;
  lines?: string;
}

export async function logsCommand(options: LogsOptions) {
  const logDir = getLogDir();
  const logFile = path.join(logDir, 'agent.log');

  // Check if log file exists
  if (!fs.existsSync(logFile)) {
    console.log('No logs found.');
    console.log(`   Log file: ${logFile}`);
    return;
  }

  const lines = parseInt(options.lines || '50', 10);

  if (options.follow) {
    // Use PowerShell's Get-Content -Wait for following logs on Windows
    console.log(`Following logs (Ctrl+C to stop)...\n`);

    const ps = spawn('powershell', [
      '-Command',
      `Get-Content -Path "${logFile}" -Tail ${lines} -Wait`
    ], {
      stdio: 'inherit'
    });

    ps.on('error', (err) => {
      console.error('Failed to read logs:', err.message);
      console.log('Trying alternative method...');

      // Fallback: just show last N lines
      showLastLines(logFile, lines);
    });

    // Handle Ctrl+C
    process.on('SIGINT', () => {
      ps.kill();
      process.exit(0);
    });
  } else {
    // Just show last N lines using PowerShell
    showLastLines(logFile, lines);
  }
}

function showLastLines(logFile: string, lines: number) {
  try {
    const output = execSync(
      `powershell -Command "Get-Content -Path '${logFile}' -Tail ${lines}"`,
      { encoding: 'utf-8' }
    );
    console.log(`Last ${lines} lines:\n`);
    console.log(output);
  } catch (err: any) {
    // Fallback to reading the file directly
    try {
      const content = fs.readFileSync(logFile, 'utf-8');
      const allLines = content.split('\n');
      const lastLines = allLines.slice(-lines);
      console.log(`Last ${lines} lines:\n`);
      console.log(lastLines.join('\n'));
    } catch (readErr: any) {
      console.error('Failed to read logs:', readErr.message);
    }
  }
}
