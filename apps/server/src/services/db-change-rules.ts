/**
 * サイクルM1: DB 変更履歴（`apps/server/db/changes/`）の判定ロジック（純粋関数のみ）。
 *
 * import 文ゼロ。`bot-supervisor-rules.ts` / `chat-context-rules.ts` と同じ流儀で、
 * prisma / node:fs を芋づるでロードしないよう、I/O を行う `db-change-index.ts` から
 * 意図的に分離している（こちらは `tests/db-changes.test.mjs` から `dist/` 経由で直接検証する）。
 */

/** `INDEX.tsv` の 1 行（`#` コメント・空行を除いた実データ行）。 */
export interface DbChangeIndexRow {
  no: number;
  date: string;
  commit: string;
  /** SQL ファイル名。`-` = DDL 不要（schema.prisma のコメント等のみの変更） */
  file: string;
  summary: string;
  ref: string;
}

/** `diffDbChanges()` の結果。 */
export interface DbChangeDiffResult {
  /** 索引にあるが台帳に無い変更（file !== '-' のみが対象。これが「適用が必要」の本体） */
  pending: DbChangeIndexRow[];
  /** 台帳にあるが索引に無いファイル名（コードを巻き戻した・索引行の削除等の異常検知用） */
  dbAhead: string[];
  /** 索引内で重複している番号（会社リポとの merge で両者が同じ番号を採ったときに起こり得る） */
  duplicateNumbers: number[];
}

/**
 * `INDEX.tsv` をパースする。
 * `#` 始まりの行・空行は無視する。各データ行は TAB 区切りで
 * `no\tdate\tcommit\tfile\tsummary\tref` の 6 列。CRLF 由来の末尾 `\r` は無視する。
 */
export function parseChangeIndex(text: string): DbChangeIndexRow[] {
  const rows: DbChangeIndexRow[] = [];
  const lines = text.split('\n');
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (line.trim() === '' || line.startsWith('#')) continue;
    const cols = line.split('\t');
    if (cols.length !== 6) {
      throw new Error(`INDEX.tsv の行の列数が 6 ではありません（${cols.length} 列): ${line}`);
    }
    const [noRaw, date, commit, file, summary, ref] = cols;
    // no は 0032 のようにゼロ埋め4桁で書く運用（ファイル名の NNNN と揃える）ため、
    // String(no) との文字列一致ではなく「数字のみで構成されているか」で検証する。
    if (!/^\d+$/.test(noRaw.trim())) {
      throw new Error(`INDEX.tsv の no 列が整数ではありません: "${noRaw}"`);
    }
    const no = Number.parseInt(noRaw, 10);
    rows.push({ no, date, commit, file, summary, ref });
  }
  return rows;
}

/**
 * 索引の内容と、DB 台帳（`DbChange.name` の一覧）を突合する。
 * `appliedNames` は `prisma.dbChange.findMany()` 等で取得したファイル名の配列。
 */
export function diffDbChanges(
  indexRows: readonly DbChangeIndexRow[],
  appliedNames: readonly string[],
): DbChangeDiffResult {
  const appliedSet = new Set(appliedNames);
  const fileSet = new Set(indexRows.map((r) => r.file).filter((f) => f !== '-'));

  const pending = indexRows.filter((r) => r.file !== '-' && !appliedSet.has(r.file));
  const dbAhead = [...appliedSet].filter((name) => !fileSet.has(name));

  const noCounts = new Map<number, number>();
  for (const r of indexRows) {
    noCounts.set(r.no, (noCounts.get(r.no) ?? 0) + 1);
  }
  const duplicateNumbers = [...noCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([no]) => no)
    .sort((a, b) => a - b);

  return {
    pending: [...pending].sort((a, b) => a.no - b.no),
    dbAhead: dbAhead.sort(),
    duplicateNumbers,
  };
}

/**
 * `diffDbChanges()` の結果を、起動時警告・`db:status` の両方で使う表示行に変換する。
 * 何も問題が無ければ空配列を返す（= 呼び出し側は何も出力しない）。
 */
export function formatPendingWarning(diff: DbChangeDiffResult): string[] {
  const lines: string[] = [];

  if (diff.pending.length > 0) {
    lines.push(`未適用の DB 変更が ${diff.pending.length} 件あります`);
    for (const row of diff.pending) {
      lines.push(`  ${String(row.no).padStart(4, '0')}  ${row.date}  ${row.file}   ${row.summary}`);
    }
  }
  if (diff.dbAhead.length > 0) {
    lines.push(`DB 台帳にあるが索引に無いファイル名が ${diff.dbAhead.length} 件あります（コードの巻き戻り・索引行の削除の可能性）:`);
    for (const name of diff.dbAhead) {
      lines.push(`  ${name}`);
    }
  }
  if (diff.duplicateNumbers.length > 0) {
    lines.push(`索引内で番号が重複しています（会社リポとの同期で起こり得ます）: ${diff.duplicateNumbers.join(', ')}`);
  }

  return lines;
}

/** `warnOnPendingDbChanges()` / `fetchAppliedDbChanges()` が失敗した理由の分類。 */
export type DbChangeHealthState = 'ok' | 'no-ledger' | 'permission-denied' | 'connection-failed' | 'unknown-error';

/**
 * DB アクセスの失敗を 3 状態（台帳なし / 権限不足 / 接続不能）+ 不明に分類する。
 *
 * Prisma は生成クライアント経由のテーブル不在を `P2021`、生 SQL 経由の失敗を `P2010`
 * （実際の PostgreSQL SQLSTATE は `error.meta.code` に入る）で返す。接続不能は `P1001`/`P1017`。
 * 正確な code を拾えない呼び出し経路（将来の変更）に備え、メッセージ文字列の照合もフォールバックに持つ。
 */
export function classifyDbChangeError(err: unknown): DbChangeHealthState {
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string } | undefined)?.code;
  const metaCode = (err as { meta?: { code?: string } } | undefined)?.meta?.code;

  if (code === 'P1001' || code === 'P1017' || /ECONNREFUSED|ETIMEDOUT|getaddrinfo/i.test(message)) {
    return 'connection-failed';
  }
  if (code === 'P2021' || metaCode === '42P01' || /42P01/.test(message) || /relation .* does not exist/i.test(message)) {
    return 'no-ledger';
  }
  if (metaCode === '42501' || /42501/.test(message) || /permission denied/i.test(message)) {
    return 'permission-denied';
  }
  return 'unknown-error';
}

/** `DEVRELAY_DB_CHANGE_WARN` の既定値解決（既定 ON。`0` で起動時検査自体を行わない）。 */
export function isDbChangeWarnEnabled(raw: string | undefined): boolean {
  return raw !== '0';
}
