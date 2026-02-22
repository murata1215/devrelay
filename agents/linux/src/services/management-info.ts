/**
 * Agent 管理コマンド情報生成モジュール
 *
 * Agent の OS・インストール方式を検出し、WebUI に表示する管理コマンド一覧を生成する。
 * 生成された情報は agent:connect 時にサーバーへ送信され、DB に保存される。
 */
import { existsSync } from 'fs';
import { execSync } from 'child_process';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { getConfigDir, getBinDir } from './config.js';
import type { ManagementInfo, ManagementCommand } from '@devrelay/shared';

/** 現在のファイルから dist/index.js への相対パスを解決 */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Agent の環境を検出し、管理コマンド情報を生成する
 *
 * 検出ロジック:
 *   Linux:
 *     1. systemd ユーザーサービスが有効 → systemd パス
 *     2. それ以外 → nohup パス
 *   Windows:
 *     1. Startup フォルダに VBS ランチャーが存在 → windows-startup パス
 *     2. それ以外 → manual パス
 *
 * @returns ManagementInfo オブジェクト（OS・インストール方式・管理コマンド一覧）
 */
export function generateManagementInfo(): ManagementInfo {
  if (process.platform === 'win32') {
    return generateWindowsInfo();
  }
  return generateLinuxInfo();
}

/**
 * Linux 環境の管理コマンドを生成
 * 検出順: systemd → PM2 → nohup（フォールバック）
 */
function generateLinuxInfo(): ManagementInfo {
  const configDir = getConfigDir();
  const logFile = path.join(configDir, 'logs', 'agent.log');

  // 1. systemd ユーザーサービスが有効か確認
  let isSystemd = false;
  try {
    const result = execSync('systemctl --user is-enabled devrelay-agent 2>/dev/null', {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    isSystemd = result === 'enabled';
  } catch {
    // systemctl が存在しない or サービス未登録
  }

  if (isSystemd) {
    return {
      os: 'linux',
      installType: 'systemd',
      commands: [
        { type: 'logs', label: 'ログ', command: 'journalctl --user -u devrelay-agent -f' },
        { type: 'status', label: 'ステータス', command: 'systemctl --user status devrelay-agent' },
        { type: 'restart', label: '再起動', command: 'systemctl --user restart devrelay-agent' },
        { type: 'stop', label: '停止', command: 'systemctl --user stop devrelay-agent' },
      ],
    };
  }

  // 2. PM2 で起動されているか確認
  // PM2 はプロセス起動時に pm_id 環境変数をセットする
  const pm2Name = process.env.pm_id !== undefined ? getPm2ProcessName() : null;

  if (pm2Name) {
    return {
      os: 'linux',
      installType: 'pm2',
      commands: [
        { type: 'logs', label: 'ログ', command: `pm2 logs ${pm2Name}` },
        { type: 'status', label: 'ステータス', command: 'pm2 status' },
        { type: 'restart', label: '再起動', command: `pm2 restart ${pm2Name}` },
        { type: 'stop', label: '停止', command: `pm2 stop ${pm2Name}` },
      ],
    };
  }

  // 3. nohup フォールバック: Node.js の絶対パスと Agent エントリポイントを取得
  const nodePath = process.execPath;
  // dist/services/management-info.js → dist/index.js
  const agentIndex = path.resolve(__dirname, '..', 'index.js');

  const commands: ManagementCommand[] = [
    { type: 'logs', label: 'ログ', command: `tail -f ${logFile}` },
    { type: 'stop', label: '停止', command: 'pgrep -u $(whoami) -f "\\.devrelay.*index\\.js" | xargs kill' },
    {
      type: 'restart',
      label: '再起動',
      command: `cd ${path.dirname(agentIndex)} && nohup ${nodePath} ${agentIndex} < /dev/null > ${logFile} 2>&1 &`,
    },
    { type: 'crontab', label: 'crontab 確認', command: 'crontab -l | grep devrelay' },
  ];

  return {
    os: 'linux',
    installType: 'nohup',
    commands,
  };
}

/**
 * PM2 のプロセス名を取得する
 * 環境変数 name（PM2 がセット）を使用し、なければ pm_id で代替
 */
function getPm2ProcessName(): string {
  // PM2 は起動時に name 環境変数をセットする
  return process.env.name || `${process.env.pm_id}`;
}

/**
 * Windows 環境の管理コマンドを生成
 * Startup フォルダの VBS ランチャー有無で自動起動解除コマンドの表示を制御
 */
function generateWindowsInfo(): ManagementInfo {
  const configDir = getConfigDir();
  const logFile = path.join(configDir, 'logs', 'agent.log');
  const vbsPath = path.join(getBinDir(), 'start-agent.vbs');

  // Windows Startup フォルダのパス
  const startupDir = path.join(
    process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup',
  );
  const startupVbs = path.join(startupDir, 'DevRelay Agent.vbs');

  const commands: ManagementCommand[] = [
    { type: 'logs', label: 'ログ', command: `Get-Content "${logFile}" -Tail 50` },
    {
      type: 'stop',
      label: '停止',
      command: "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*devrelay*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }",
    },
    { type: 'restart', label: '起動', command: `wscript.exe "${vbsPath}"` },
  ];

  // 自動起動の VBS ランチャーが存在する場合のみ解除コマンドを追加
  if (existsSync(startupVbs)) {
    commands.push({
      type: 'auto-start-disable',
      label: '自動起動解除',
      command: `Remove-Item "${startupVbs}"`,
    });
  }

  return {
    os: 'win32',
    installType: 'windows-startup',
    commands,
  };
}
