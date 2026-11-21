/**
 * TISA 系列（会社リポジトリ独自）の DB 変更を、本家の DB 変更履歴（サイクルM1）と並べて扱う純関数。
 *
 * 本家は `apps/server/db/changes/NNNN_*.sql` の 4 桁連番で管理している。会社側の変更に本家の連番を
 * 使うと、本家が同じ番号を採ったときにマージで衝突するため、会社側は別系列
 * `apps/server/db/changes/tisa/TISA<4桁>_*.sql`（索引は `tisa/INDEX.tsv`）で管理する。
 * 台帳 "DbChange" の主キーはファイル名なので、同じ台帳に記録しても本家の行とはぶつからない。
 *
 * 本家ファイル（db-change-index.ts / db-change-rules.ts）への変更を最小にするため、
 * 振り分けと結果の合成はこのファイルに置く（外部 import は db-change-rules.ts の型と関数のみ）。
 * 運用は `doc/db-changes-tisa.md` 参照。
 */

import { diffDbChanges, type DbChangeDiffResult, type DbChangeIndexRow } from './db-change-rules.js';

/** TISA 系列のファイル名の接頭辞（台帳の name もこれで始まる） */
export const TISA_CHANGE_PREFIX = 'TISA';

/** TISA 系列のフォルダ名（`apps/server/db/changes/` からの相対） */
export const TISA_CHANGES_SUBDIR = 'tisa';

/** 台帳の name が TISA 系列のものか */
export function isTisaChangeName(name: string): boolean {
  return name.startsWith(TISA_CHANGE_PREFIX);
}

/**
 * 本家の索引と TISA の索引を、台帳の記録（ファイル名の一覧）とそれぞれ突合して 1 つの結果にまとめる。
 * - 台帳の name は `TISA` で始まるかどうかで振り分ける（振り分けないと、もう片方で「索引に無い」と警告される）
 * - TISA 側の未適用・台帳だけにある行は、表示と適用コマンドがそのまま使えるよう `tisa/<ファイル名>` にする
 * - 未適用は本家 → TISA の順（各系列の中は番号順）
 */
export function diffWithTisaChanges(
  upstreamRows: readonly DbChangeIndexRow[],
  tisaRows: readonly DbChangeIndexRow[],
  appliedNames: readonly string[],
): DbChangeDiffResult {
  const upstream = diffDbChanges(upstreamRows, appliedNames.filter((n) => !isTisaChangeName(n)));
  const tisa = diffDbChanges(tisaRows, appliedNames.filter(isTisaChangeName));
  const withDir = (file: string) => `${TISA_CHANGES_SUBDIR}/${file}`;
  return {
    pending: [...upstream.pending, ...tisa.pending.map((r) => ({ ...r, file: withDir(r.file) }))],
    dbAhead: [...upstream.dbAhead, ...tisa.dbAhead.map(withDir)],
    duplicateNumbers: [...upstream.duplicateNumbers, ...tisa.duplicateNumbers],
  };
}
