/**
 * サイクルM1: DB 変更履歴の一元化（`apps/server/db/changes/`）— I/O ラッパ。
 *
 * 判定ロジック本体は `db-change-rules.ts`（外部 import ゼロの純関数）に分離してある。
 * このファイルは node:fs / prisma を読み込む側（`cross-team-authz.ts` が `cross-team-guard.ts`
 * を呼ぶのと同じ構成）。`index.ts`（起動時警告・/health）と `scripts/db-status.ts` の両方が
 * ここを経由することで、判定ロジックを 1 箇所に保つ。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prisma } from '../db/client.js';
import {
  parseChangeIndex,
  diffDbChanges,
  formatPendingWarning,
  classifyDbChangeError,
  isDbChangeWarnEnabled,
  type DbChangeDiffResult,
  type DbChangeHealthState,
} from './db-change-rules.js';

/** apps/server/db/changes/ の絶対パス。dist/services/ と src/services/ のどちらから実行しても
 *  同じ相対位置（../../db/changes）になるため cwd に依存しない。 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DB_CHANGES_DIR = path.resolve(__dirname, '../../db/changes');
export const DB_CHANGES_INDEX_PATH = path.join(DB_CHANGES_DIR, 'INDEX.tsv');

/** `apps/server/db/changes/INDEX.tsv` を読む。 */
export function loadChangeIndexText(): string {
  return readFileSync(DB_CHANGES_INDEX_PATH, 'utf8');
}

/** 台帳 "DbChange" に記録済みのファイル名一覧を取得する。テーブル未作成等は例外を投げる（呼び出し側で分類）。 */
export async function fetchAppliedDbChangeNames(): Promise<string[]> {
  const rows = await prisma.dbChange.findMany({ select: { name: true } });
  return rows.map((r) => r.name);
}

/** 起動時・db:status が共有する判定結果。 */
export interface DbChangeStatus {
  state: DbChangeHealthState;
  diff: DbChangeDiffResult | null;
}

/** 索引と台帳を突合し、状態（3 状態 + ok）と差分を返す。例外は投げない（呼び出し側の分岐が要らない）。 */
export async function computeDbChangeStatus(): Promise<DbChangeStatus> {
  let appliedNames: string[];
  try {
    appliedNames = await fetchAppliedDbChangeNames();
  } catch (err) {
    return { state: classifyDbChangeError(err), diff: null };
  }
  const indexRows = parseChangeIndex(loadChangeIndexText());
  const diff = diffDbChanges(indexRows, appliedNames);
  return { state: 'ok', diff };
}

/**
 * 起動時（`app.listen()` より前）に呼ぶ fail-open な警告。
 * 呼び出し元の `runStartupInitWithTimeout()` が 20 秒タイムアウト + 例外握りつぶしを
 * 既に備えているため、本関数自体は例外を投げない作りにする必要はないが、念のため try/catch する。
 */
export async function warnOnPendingDbChanges(): Promise<void> {
  if (!isDbChangeWarnEnabled(process.env.DEVRELAY_DB_CHANGE_WARN)) return;

  const { state, diff } = await computeDbChangeStatus();

  if (state === 'no-ledger') {
    console.warn('⚠️  DB 変更台帳 "DbChange" がありません（起動は続行します）。apps/server/db/changes/ の SQL が 1 件も適用記録されていない状態です。doc/db-changes.md を参照してください。');
    return;
  }
  if (state === 'permission-denied') {
    console.warn('⚠️  "DbChange" を読めません（権限不足）。所有者ずれの可能性があります（current_user を確認してください。起動は続行します）。');
    return;
  }
  if (state === 'connection-failed') {
    console.warn('⚠️  DB に接続できないため DB 変更履歴を検査できませんでした（起動は続行します）。');
    return;
  }
  if (state === 'unknown-error') {
    console.warn('⚠️  DB 変更履歴の検査に失敗しました（原因不明。起動は続行します）。');
    return;
  }
  if (!diff) return;

  const lines = formatPendingWarning(diff);
  if (lines.length === 0) return;

  console.warn('⚠️  ──────────────────────────────────────────────────────────');
  for (const line of lines) {
    console.warn(`⚠️  ${line}`);
  }
  console.warn('⚠️  Prisma Client が存在しない列を参照すると API が 500 になります。');
  console.warn('⚠️  確認: pnpm --filter @devrelay/server db:status / 手順: doc/db-changes.md');
  console.warn('⚠️  ──────────────────────────────────────────────────────────');
}
