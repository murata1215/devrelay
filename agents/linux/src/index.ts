import { loadConfig, detectAndUpdateAiTools } from './services/config.js';
import { getBinDir } from './services/config.js';
import { connectToServer } from './services/connection.js';
import { loadProjects, autoDiscoverProjects } from './services/projects.js';
import { execSync } from 'child_process';
import { existsSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import os from 'os';

/**
 * devrelay-claude ラッパーを作成する（クロスプラットフォーム対応）
 *
 * Claude Code のプロセスを識別しやすくするため、ラッパーを作成する。
 * - Linux: シンボリックリンク（devrelay-claude -> claude）
 * - Windows: .cmd バッチファイル（管理者権限不要）
 */
function ensureDevrelaySymlinks() {
  const isWindows = process.platform === 'win32';
  const devrelayBinDir = getBinDir();
  const wrapperName = isWindows ? 'devrelay-claude.cmd' : 'devrelay-claude';
  const devrelayClaude = join(devrelayBinDir, wrapperName);

  try {
    // ディレクトリが存在しない場合は作成
    if (!existsSync(devrelayBinDir)) {
      mkdirSync(devrelayBinDir, { recursive: true });
    }

    // claude バイナリのパスを取得（Linux: which, Windows: where）
    const findCmd = isWindows ? 'where' : 'which';
    const claudePathRaw = execSync(`${findCmd} claude`, { encoding: 'utf-8' }).trim();
    // where コマンドは複数行を返す場合があるため、最初の行を使用
    const claudePath = claudePathRaw.split(/\r?\n/)[0];

    // 既存のラッパーがあれば削除
    if (existsSync(devrelayClaude)) {
      unlinkSync(devrelayClaude);
    }

    if (isWindows) {
      // Windows: .cmd バッチファイルを作成
      writeFileSync(devrelayClaude, `@echo off\r\n"${claudePath}" %*\r\n`);
    } else {
      // Linux: シンボリックリンクを作成
      symlinkSync(claudePath, devrelayClaude);
    }
    console.log(`🔗 Wrapper: ${wrapperName} -> ${claudePath}`);
  } catch (err) {
    console.warn(`⚠️ Could not create ${wrapperName}:`, (err as Error).message);
  }
}

/**
 * PID ファイルを書き込む（インストーラーからの既存プロセス停止用）
 * Windows: %APPDATA%\devrelay\agent.pid
 * Linux/Mac: ~/.devrelay/agent.pid
 */
function writePidFile() {
  const configDir = process.platform === 'win32'
    ? join(process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming'), 'devrelay')
    : join(os.homedir(), '.devrelay');
  const pidFile = join(configDir, 'agent.pid');
  try {
    writeFileSync(pidFile, String(process.pid));
  } catch {
    // PID ファイル書き込み失敗は致命的ではない
  }
}

/**
 * PID ファイルを削除する（シャットダウン時）
 */
function removePidFile() {
  const configDir = process.platform === 'win32'
    ? join(process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming'), 'devrelay')
    : join(os.homedir(), '.devrelay');
  const pidFile = join(configDir, 'agent.pid');
  try {
    unlinkSync(pidFile);
  } catch {
    // 既に削除済みの場合は無視
  }
}

async function main() {
  console.log(`
┌─────────────────────────────────────────────────┐
│  DevRelay Agent                                │
└─────────────────────────────────────────────────┘
  `);

  // PID ファイル書き込み（インストーラーからの停止用）
  writePidFile();

  // Load config
  const config = await loadConfig();

  if (!config.token) {
    console.error('❌ Token not configured. Run: devrelay setup');
    process.exit(1);
  }

  console.log(`📡 Machine: ${config.machineName}`);
  console.log(`🔗 Server: ${config.serverUrl}`);

  // AI ツール自動検出（PATH 上の CLI を検出して config.yaml に追加）
  await detectAndUpdateAiTools(config);

  // Ensure devrelay-claude wrapper exists
  ensureDevrelaySymlinks();

  // Auto-discover projects with CLAUDE.md
  for (const dir of config.projectsDirs) {
    await autoDiscoverProjects(dir);
  }

  // Load projects
  const projects = await loadProjects(config);
  console.log(`📁 Projects: ${projects.length}`);

  // Connect to server
  await connectToServer(config, projects);
}

// Handle shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down...');
  removePidFile();
  process.exit(0);
});

process.on('SIGTERM', () => {
  removePidFile();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n👋 Shutting down...');
  process.exit(0);
});

main().catch(console.error);
