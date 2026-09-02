import { loadConfig, detectAndUpdateAiTools } from './services/config.js';
import { getBinDir } from './services/config.js';
import { connectToServer } from './services/connection.js';
import { loadProjects, autoDiscoverProjects } from './services/projects.js';
import { logClaudeExecutableStatus, resolveSystemClaude } from './services/ai-runner.js';
import { existsSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import os from 'os';

/**
 * devrelay-claude ラッパーを作成する（クロスプラットフォーム対応）
 *
 * Claude Code のプロセスを識別しやすくするため、ラッパーを作成する。
 * - Linux: シンボリックリンク（devrelay-claude -> claude）
 * - Windows: .cmd バッチファイル（管理者権限不要）
 *
 * #354: claude 解決は `resolveSystemClaude()`（ai-runner.ts、#350 で OS 分岐・stderr 破棄済み）を
 * 再利用する。従来は `execSync('where'/'which' + ' claude')` を直書きしており、
 * PATH に無い場合の生 stderr が漏れる経路になっていた（`stdio` 指定はあったが、
 * catch 後に「見つからなかっただけ」と「本当の失敗」を区別できず、
 * claude 未インストールの端末（devin 専用機等）でも `⚠️ Could not create` という
 * 誤解を招く警告が出ていた）。
 */
function ensureDevrelaySymlinks() {
  const isWindows = process.platform === 'win32';
  const devrelayBinDir = getBinDir();
  const wrapperName = isWindows ? 'devrelay-claude.cmd' : 'devrelay-claude';
  const devrelayClaude = join(devrelayBinDir, wrapperName);

  // claude が見つからない場合は「正常な不在」として静かにスキップする（#325 の対象外：
  // これは「フォールバック」ではなく「対象が無いので何もしない」ケース）
  const claudePath = resolveSystemClaude();
  if (!claudePath) {
    console.log(`ℹ️ claude not found; skipping ${wrapperName} wrapper`);
    return;
  }

  try {
    // ディレクトリが存在しない場合は作成
    if (!existsSync(devrelayBinDir)) {
      mkdirSync(devrelayBinDir, { recursive: true });
    }

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
    // claude は見つかったのにラッパー作成自体が失敗した＝本当の異常（#325 静かなフォールバック禁止）
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

  // #287: SDK 内蔵 cli.js の状態を起動時にログ出力（欠落時はシステム claude フォールバックを通知）
  logClaudeExecutableStatus();

  // Auto-discover projects with CLAUDE.md
  // config.yaml の aiTools.default を新規プロジェクトの既定 AI として使う
  // （Devin 専用マシンで自動検出プロジェクトが claude 固定になる不具合を防ぐ）
  for (const dir of config.projectsDirs) {
    await autoDiscoverProjects(dir, 5, config.aiTools?.default || 'claude');
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
