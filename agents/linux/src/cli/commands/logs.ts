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
    console.log('📜 No logs found.');
    console.log(`   Log file: ${logFile}`);
    return;
  }
  
  const lines = options.lines || '50';
  
  if (options.follow) {
    // Tail with follow
    console.log(`📜 Following logs (Ctrl+C to stop)...\n`);
    
    const tail = spawn('tail', ['-f', '-n', lines, logFile], {
      stdio: 'inherit'
    });
    
    tail.on('error', (err) => {
      console.error('Failed to read logs:', err.message);
    });
    
    // Handle Ctrl+C
    process.on('SIGINT', () => {
      tail.kill();
      process.exit(0);
    });
  } else {
    // Just show last N lines
    try {
      const output = execSync(`tail -n ${lines} "${logFile}"`, { encoding: 'utf-8' });
      console.log(`📜 Last ${lines} lines:\n`);
      console.log(output);
    } catch (err: any) {
      console.error('Failed to read logs:', err.message);
    }
  }
}
