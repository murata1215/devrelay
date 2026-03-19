/**
 * ツール承認履歴の JSONL ファイルログ
 * - ~/.devrelay/approvals/current.jsonl に追記
 * - Agent 起動時にローテーション（current → archive/approvals_YYYYMMDD_HHmmss.jsonl）
 */
import fs from 'fs/promises';
import { existsSync, mkdirSync, appendFileSync } from 'fs';
import path from 'path';
import { getConfigDir } from './config.js';

/** 承認ログディレクトリ */
const APPROVALS_DIR = path.join(getConfigDir(), 'approvals');
const ARCHIVE_DIR = path.join(APPROVALS_DIR, 'archive');
const CURRENT_FILE = path.join(APPROVALS_DIR, 'current.jsonl');

/** 承認ログのエントリ型 */
interface ApprovalLogEntry {
  timestamp: string;
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  status: string;
}

/**
 * Agent 起動時にローテーション（current.jsonl → archive/ にリネーム）
 * 既存の current.jsonl があれば archive/ に移動し、新しい空ファイルを作成
 */
export async function rotateApprovalLog(): Promise<void> {
  try {
    // ディレクトリを確保
    mkdirSync(APPROVALS_DIR, { recursive: true });
    mkdirSync(ARCHIVE_DIR, { recursive: true });

    // current.jsonl が存在する場合はアーカイブ
    if (existsSync(CURRENT_FILE)) {
      const stat = await fs.stat(CURRENT_FILE);
      if (stat.size > 0) {
        const now = new Date();
        const ts = now.toISOString().replace(/[-:T]/g, '').replace(/\.\d+Z/, '');
        const archiveName = `approvals_${ts}.jsonl`;
        const archivePath = path.join(ARCHIVE_DIR, archiveName);
        await fs.rename(CURRENT_FILE, archivePath);
        console.log(`📋 Approval log rotated: ${archiveName}`);
      }
    }
  } catch (err) {
    console.error('Failed to rotate approval log:', err);
  }
}

/**
 * 承認ログに1行追記する
 * fire-and-forget で呼ぶ想定（エラーは握りつぶす）
 */
export function appendApprovalLog(entry: ApprovalLogEntry): void {
  try {
    // ディレクトリが無ければ作成（初回 or ローテーション後）
    if (!existsSync(APPROVALS_DIR)) {
      mkdirSync(APPROVALS_DIR, { recursive: true });
    }
    const line = JSON.stringify(entry) + '\n';
    appendFileSync(CURRENT_FILE, line, 'utf-8');
  } catch (err) {
    console.error('Failed to append approval log:', err);
  }
}
