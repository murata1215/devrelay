/**
 * Windows Agent 用ログ出力モジュール
 *
 * electron-log を使用して、コンソールとファイル両方にログを出力する。
 * ログファイルは %APPDATA%\devrelay\logs\agent.log に保存される。
 *
 * 使い方:
 *   import log from './logger.js';
 *   log.info('メッセージ');
 *   log.error('エラー', error);
 */
import log from 'electron-log';
import path from 'path';
import fs from 'fs';

/**
 * ログディレクトリのパスを取得
 * @returns ログディレクトリのフルパス
 */
function getLogDir(): string {
  return path.join(process.env.APPDATA || '', 'devrelay', 'logs');
}

/**
 * ログディレクトリを作成（存在しない場合）
 */
function ensureLogDir(): void {
  const logDir = getLogDir();
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
}

// ログディレクトリを作成
ensureLogDir();

// ログファイルの保存先を設定
log.transports.file.resolvePathFn = () => path.join(getLogDir(), 'agent.log');

// ログローテーション設定（1MB でローテーション）
log.transports.file.maxSize = 1024 * 1024;

// ログフォーマット設定
log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}] [{level}] {text}';
log.transports.console.format = '[{h}:{i}:{s}] [{level}] {text}';

// デフォルトのログレベル
log.transports.file.level = 'info';
log.transports.console.level = 'info';

/**
 * ログレベルを設定
 * config.yaml の logLevel 設定に対応
 *
 * @param level - ログレベル ('error' | 'warn' | 'info' | 'verbose' | 'debug' | 'silly')
 */
export function setLogLevel(level: string): void {
  const validLevels = ['error', 'warn', 'info', 'verbose', 'debug', 'silly'];
  if (validLevels.includes(level)) {
    log.transports.file.level = level as any;
    log.transports.console.level = level as any;
    log.info(`Log level set to: ${level}`);
  } else {
    log.warn(`Invalid log level: ${level}, using 'info'`);
  }
}

/**
 * ログファイルのパスを取得
 * @returns ログファイルのフルパス
 */
export function getLogFilePath(): string {
  return path.join(getLogDir(), 'agent.log');
}

// デフォルトエクスポート
export default log;
