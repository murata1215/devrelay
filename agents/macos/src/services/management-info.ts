/**
 * Agent 管理コマンド情報生成モジュール（macOS 版）
 *
 * Agent の OS・インストール方式を検出し、WebUI に表示する管理コマンド一覧を生成する。
 * 生成された情報は agent:connect 時にサーバーへ送信され、DB に保存される。
 *
 * macOS では launchd (LaunchAgent) → PM2 → nohup の順で検出する。
 */
import { existsSync } from 'fs';
import { execSync } from 'child_process';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { getConfigDir } from './config.js';
import type { ManagementInfo, ManagementCommand } from '@devrelay/shared';

/** 現在のファイルから dist/index.js への相対パスを解決 */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** LaunchAgent の plist パス */
const PLIST_LABEL = 'io.devrelay.agent';
const PLIST_PATH = path.join(os.homedir(), 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`);

/**
 * Agent の環境を検出し、管理コマンド情報を生成する
 *
 * 検出ロジック（macOS 版）:
 *   1. LaunchAgent (plist) が存在 → launchd パス
 *   2. PM2 で起動されている → pm2 パス
 *   3. それ以外 → nohup フォールバック
 *
 * @returns ManagementInfo オブジェクト（OS・インストール方式・管理コマンド一覧）
 */
export function generateManagementInfo(): ManagementInfo {
  return generateDarwinInfo();
}

/**
 * macOS (Darwin) 環境の管理コマンドを生成
 * 検出順: launchd → PM2 → nohup（フォールバック）
 */
function generateDarwinInfo(): ManagementInfo {
  const configDir = getConfigDir();
  const logFile = path.join(configDir, 'logs', 'agent.log');

  // 1. LaunchAgent (plist) が存在するか確認
  if (existsSync(PLIST_PATH)) {
    return {
      os: 'darwin',
      installType: 'launchd',
      commands: [
        { type: 'logs', label: 'ログ', command: `tail -f ${logFile}` },
        { type: 'status', label: 'ステータス', command: `launchctl list ${PLIST_LABEL}` },
        { type: 'restart', label: '再起動', command: `launchctl kickstart -k gui/$(id -u)/${PLIST_LABEL}` },
        { type: 'stop', label: '停止', command: `launchctl kill SIGTERM gui/$(id -u)/${PLIST_LABEL}` },
      ],
    };
  }

  // 2. PM2 で起動されているか確認
  // PM2 はプロセス起動時に pm_id 環境変数をセットする
  const pm2Name = process.env.pm_id !== undefined ? getPm2ProcessName() : null;

  if (pm2Name) {
    return {
      os: 'darwin',
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
    // pgrep を2パターンで実行: 絶対パス(.devrelay含む) + 相対パス(node index.js) の両方を検出
    { type: 'stop', label: '停止', command: '{ pgrep -f "\\.devrelay.*index\\.js"; pgrep -fx "node index\\.js"; } 2>/dev/null | sort -u | grep -v "^$$\\$" | xargs kill' },
    {
      type: 'restart',
      label: '再起動',
      // 旧プロセスを停止してから新プロセスを起動
      // NODE_BIN フォールバック: process.execPath が存在しない場合は PATH 上の node を使用
      // grep -v "^$$\$": 自身の PID を除外（bash -c 経由で実行時の自殺防止）
      command: `NODE_BIN="${nodePath}"; [ ! -x "$NODE_BIN" ] && NODE_BIN=node; { pgrep -f "\\.devrelay.*index\\.js"; pgrep -fx "node index\\.js"; } 2>/dev/null | sort -u | grep -v "^$$\\$" | xargs kill 2>/dev/null || true; sleep 1; cd ${path.dirname(agentIndex)} && nohup "$NODE_BIN" ${agentIndex} < /dev/null >> ${logFile} 2>&1 &`,
    },
    { type: 'crontab', label: 'crontab 確認', command: 'crontab -l | grep devrelay' },
  ];

  return {
    os: 'darwin',
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
