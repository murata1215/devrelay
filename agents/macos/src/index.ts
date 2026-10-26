import { loadConfig, detectAndUpdateAiTools } from './services/config.js';
import { getBinDir } from './services/config.js';
import { connectToServer } from './services/connection.js';
import { loadProjects, autoDiscoverProjects } from './services/projects.js';
import { logClaudeExecutableStatus } from './services/ai-runner.js';
import { prependBinDir } from './services/node-bin-path.js';
import { execSync } from 'child_process';
import { existsSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';

/**
 * Agent 自身を起動している node（`process.execPath`）の bin ディレクトリを PATH に前置する。
 *
 * 2026-10-26 `spawn codex ENOENT` 障害の根治: nvm 等でグローバルインストールした AI CLI
 * （codex 等）はその node バージョン専用の bin にしか存在しない。launchd 起動や `u`
 * 自己更新後の nohup 再起動で PATH が最小構成になっても、Agent を実行している node の bin を
 * 入れておけば同じ環境に入れた CLI は常に見える（詳細は `node-bin-path.ts` の JSDoc 参照）。
 * `loadConfig()` / `detectAndUpdateAiTools()` より前に呼ぶ必要がある。
 */
function augmentPathWithExecDir() {
  const sep = process.platform === 'win32' ? ';' : ':';
  process.env.PATH = prependBinDir(process.env.PATH, dirname(process.execPath), sep, existsSync);
}

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

async function main() {
  console.log(`
┌─────────────────────────────────────────────────┐
│  DevRelay Agent                                │
└─────────────────────────────────────────────────┘
  `);

  // Agent 自身を起動している node の bin を PATH に前置（codex 等 nvm グローバル CLI の検出・spawn 対策）
  augmentPathWithExecDir();

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
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n👋 Shutting down...');
  process.exit(0);
});

main().catch(console.error);
