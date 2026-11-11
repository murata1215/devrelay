/**
 * サイクルM1 — DB 変更履歴（`apps/server/db/changes/`）の未適用を確認する読み取り専用 CLI。
 *
 * 実行方法: `pnpm --filter @devrelay/server db:status`
 * （`package.json` の `db:status` スクリプトが `node dist/scripts/db-status.js` を実行。
 * ビルド済み dist から動かすため、事前に `pnpm build` が必要）
 *
 * 本スクリプトは DB に対して SELECT のみ行う。DDL の適用・台帳への INSERT は一切行わない
 * （適用は人間が `psql` で行う。手順は `doc/db-changes.md` 参照）。
 *
 * オプション:
 *   --strict  未適用（または dbAhead・重複番号）が 1 件でもあれば終了コード 1 を返す（CI 用）
 *
 * `knowledge-backfill.ts` と異なり `dotenv/config` を明示 import する（2026-11-08 判明の罠:
 * pm2 の `devrelay-server` と異なり `pnpm --filter` 実行時は cwd=`apps/server` のため、
 * このファイルが `apps/server/.env` を自力で読む必要がある）。
 */

import 'dotenv/config';
import { prisma } from '../db/client.js';
import { computeDbChangeStatus, DB_CHANGES_DIR } from '../services/db-change-index.js';
import { formatPendingWarning } from '../services/db-change-rules.js';

function log(msg: string): void {
  console.log(msg);
}

async function main(): Promise<void> {
  const strict = process.argv.includes('--strict');

  log(`DB 変更履歴: ${DB_CHANGES_DIR}（索引 INDEX.tsv）`);

  const dbUrl = process.env.DATABASE_URL ?? '';
  const connLabel = dbUrl.replace(/:\/\/[^@]*@/, '://***@'); // パスワードを隠す
  log(`接続: ${connLabel || '(DATABASE_URL 未設定)'}`);

  const { state, diff } = await computeDbChangeStatus();

  if (state === 'no-ledger') {
    log('台帳 "DbChange": 存在しません（全件を未適用として扱います）');
    log('→ DB が既に最新なら: zz1_verify.sql で突合 → MISSING が 0 行なら zz2_mark_baseline_applied.sql');
    log('→ DB が古いなら: 0001 から番号順に psql で流す');
    log('→ 新規 DB の構築はこのフォルダの担当外（README.md / doc/db-changes.md 参照）');
    if (strict) process.exitCode = 1;
    return;
  }
  if (state === 'permission-denied') {
    log('⚠️  "DbChange" を読めません（権限不足）。所有者ずれの可能性があります（current_user を確認してください）。');
    if (strict) process.exitCode = 1;
    return;
  }
  if (state === 'connection-failed') {
    log('⚠️  DB に接続できませんでした。DATABASE_URL を確認してください。');
    if (strict) process.exitCode = 1;
    return;
  }
  if (state === 'unknown-error' || !diff) {
    log('⚠️  DB 変更履歴の検査に失敗しました（原因不明）。');
    if (strict) process.exitCode = 1;
    return;
  }

  const appliedCount = await prisma.dbChange.count();
  log(`台帳 "DbChange": あり（記録 ${appliedCount} 件）`);

  const lines = formatPendingWarning(diff);
  if (lines.length === 0) {
    log('未適用: なし ✅');
    return;
  }

  log('');
  for (const line of lines) log(line);

  if (diff.pending.length > 0) {
    log('');
    log('番号の小さい順に 1 つずつ流してください:');
    for (const row of diff.pending) {
      log(`  psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f apps/server/db/changes/${row.file}`);
    }
  }

  if (strict) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error('❌', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
