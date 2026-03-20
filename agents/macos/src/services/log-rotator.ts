/**
 * Agent ログローテーター
 * - agent.log を日付別にローテーション（agent_YYYYMMDD.log）
 * - 7日超の古いログを自動削除
 * - 起動時 + 24時間ごとにチェック
 *
 * copyTruncate 方式: nohup の stdout リダイレクトと互換
 * （ファイルディスクリプタを壊さずにローテーション可能）
 */
import fs from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';
import path from 'path';
import { getLogDir } from './config.js';

/** ログ保持日数 */
const RETENTION_DAYS = 7;
/** ローテーションチェック間隔（24時間） */
const ROTATION_INTERVAL = 24 * 60 * 60 * 1000;

const LOG_DIR = getLogDir();
const AGENT_LOG = path.join(LOG_DIR, 'agent.log');

/** YYYYMMDD 形式の日付文字列を返す */
function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

/**
 * agent.log をローテーション（copyTruncate 方式）
 * 最終更新が今日でなければ agent_YYYYMMDD.log にコピーし、agent.log を truncate する
 */
async function rotateIfNeeded(): Promise<void> {
  try {
    if (!existsSync(AGENT_LOG)) return;

    const stat = await fs.stat(AGENT_LOG);
    if (stat.size === 0) return;

    // 最終更新日が今日ならスキップ（まだローテーション不要）
    const lastModified = stat.mtime;
    const today = new Date();
    if (
      lastModified.getFullYear() === today.getFullYear() &&
      lastModified.getMonth() === today.getMonth() &&
      lastModified.getDate() === today.getDate()
    ) {
      return;
    }

    // copyTruncate: コピー → truncate（fd を壊さない）
    const dateStr = formatDate(lastModified);
    const rotatedFile = path.join(LOG_DIR, `agent_${dateStr}.log`);

    // 同名ファイルが既にある場合は追記（同日に複数回起動した場合）
    if (existsSync(rotatedFile)) {
      const content = await fs.readFile(AGENT_LOG, 'utf-8');
      await fs.appendFile(rotatedFile, content);
    } else {
      await fs.copyFile(AGENT_LOG, rotatedFile);
    }

    // agent.log を truncate（サイズ 0 にする。fd はそのまま）
    await fs.truncate(AGENT_LOG, 0);
    console.log(`📋 Agent log rotated: agent_${dateStr}.log`);
  } catch (err) {
    console.error('Failed to rotate agent log:', err);
  }
}

/**
 * 7日超の古いログファイルを削除する
 */
async function cleanOldLogs(): Promise<void> {
  try {
    const files = await fs.readdir(LOG_DIR);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
    const cutoffStr = formatDate(cutoff);

    for (const file of files) {
      // agent_YYYYMMDD.log パターンにマッチするファイルのみ対象
      const match = file.match(/^agent_(\d{8})\.log$/);
      if (!match) continue;

      const fileDate = match[1];
      if (fileDate < cutoffStr) {
        await fs.unlink(path.join(LOG_DIR, file));
        console.log(`🗑️ Old log deleted: ${file}`);
      }
    }
  } catch (err) {
    console.error('Failed to clean old logs:', err);
  }
}

/**
 * ログローテーションをセットアップ（Agent 起動時に呼び出し）
 * - 即座にローテーション + クリーンアップを実行
 * - 24時間ごとに定期チェックを設定
 */
export async function setupLogRotation(): Promise<void> {
  // ログディレクトリを確保
  mkdirSync(LOG_DIR, { recursive: true });

  // 起動時にローテーション + 古いログ削除
  await rotateIfNeeded();
  await cleanOldLogs();

  // 24時間ごとに定期チェック
  setInterval(async () => {
    await rotateIfNeeded();
    await cleanOldLogs();
  }, ROTATION_INTERVAL);
}
