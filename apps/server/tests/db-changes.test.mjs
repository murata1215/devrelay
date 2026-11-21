// サイクルM1: DB 変更履歴の一元化（apps/server/db/changes/）の書き忘れ防止ガード。
//
// `knowledge-wiring.test.mjs`（prisma/bootstrap.sql を正規表現で検査する先例）と
// `tracked-imports.test.mjs`（git ls-files でリポジトリ全体を検査する先例）に倣い、
// 以下を1ファイルで検証する:
//   1. 純関数（db-change-rules.ts）の単体ケース
//   2. SCHEMA.sha256: schema.prisma の指紋 + INDEX.tsv 最大番号行のファイル名との一致
//      （schema.prisma を変えて変更ファイル・索引行を足し忘れると落ちる）
//   3. INDEX.tsv とファイルの突合（番号の一意性・昇順、NNNN と no の一致）
//   4. 各 SQL ファイル末尾の INSERT INTO "DbChange" が自分のファイル名・番号と一致
//   5. 冪等性 lint（IF NOT EXISTS・backfill のガード）
//   6. 誤爆ガード必須 + 禁止キーワード（OWNER TO / SET ROLE / CREATE EXTENSION / sudo）不在
//   7. ヘッダ必須項目
//   8. 追跡漏れ検知（git ls-files ∪ staged）
//   9. 禁止コマンドの封じ込め（package.json に db:push 等が無い・prisma/migrations/ 凍結）
//
// dist/ に依存するのは 1.（純関数）のみ。2〜9 は node:fs + git CLI のみで、ビルド不要。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  parseChangeIndex,
  diffDbChanges,
  formatPendingWarning,
  classifyDbChangeError,
  isDbChangeWarnEnabled,
} from '../dist/services/db-change-rules.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(serverRoot, '../..');
const changesDir = path.join(serverRoot, 'db', 'changes');

function readServerFile(relPath) {
  return readFileSync(path.join(serverRoot, relPath), 'utf8');
}

// ============================================================
// 1. 純関数の単体ケース
// ============================================================

describe('parseChangeIndex', () => {
  test('# コメント・空行を無視し、6列を正しくパースする', () => {
    const text = [
      '# comment',
      '',
      '#no\tdate\tcommit\tfile\tsummary\tref',
      '0001\t2026-03-29\t5da2879\t0001_x.sql\tsummary1\t-',
      '0002\t2026-04-01\t-\t-\tDDL 不要\t-',
    ].join('\n');
    const rows = parseChangeIndex(text);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], { no: 1, date: '2026-03-29', commit: '5da2879', file: '0001_x.sql', summary: 'summary1', ref: '-' });
    assert.equal(rows[1].file, '-');
  });

  test('CRLF の末尾 \\r を無視する', () => {
    const text = '0001\t2026-03-29\t-\t0001_x.sql\tsummary\t-\r\n';
    const rows = parseChangeIndex(text);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].ref, '-');
  });

  test('列数が6でない行は例外', () => {
    assert.throws(() => parseChangeIndex('0001\t2026-03-29\t-\t0001_x.sql\tsummary'), /列数/);
  });

  test('no 列が整数でない行は例外', () => {
    assert.throws(() => parseChangeIndex('abc\t2026-03-29\t-\t0001_x.sql\tsummary\t-'), /整数/);
  });
});

describe('diffDbChanges', () => {
  const rows = parseChangeIndex([
    '0001\t2026-03-29\t-\t0001_a.sql\tA\t-',
    '0002\t2026-04-01\t-\t-\tDDL不要\t-',
    '0003\t2026-04-02\t-\t0003_c.sql\tC\t-',
  ].join('\n'));

  test('未適用（file!==\'-\' かつ台帳未記録）だけが pending に入る', () => {
    const diff = diffDbChanges(rows, ['0001_a.sql']);
    assert.equal(diff.pending.length, 1);
    assert.equal(diff.pending[0].file, '0003_c.sql');
  });

  test('file=\'-\' の行は台帳に無くても pending にならない', () => {
    const diff = diffDbChanges(rows, ['0001_a.sql', '0003_c.sql']);
    assert.equal(diff.pending.length, 0);
  });

  test('台帳にあるが索引に無いファイルは dbAhead に入る', () => {
    const diff = diffDbChanges(rows, ['0001_a.sql', '0003_c.sql', '9999_ghost.sql']);
    assert.deepEqual(diff.dbAhead, ['9999_ghost.sql']);
  });

  test('番号が重複していれば duplicateNumbers に入る', () => {
    const dup = parseChangeIndex([
      '0001\t2026-03-29\t-\t0001_a.sql\tA\t-',
      '0001\t2026-04-01\t-\t0001_b.sql\tB\t-',
    ].join('\n'));
    const diff = diffDbChanges(dup, []);
    assert.deepEqual(diff.duplicateNumbers, [1]);
  });
});

describe('formatPendingWarning', () => {
  test('何も問題が無ければ空配列', () => {
    const diff = { pending: [], dbAhead: [], duplicateNumbers: [] };
    assert.deepEqual(formatPendingWarning(diff), []);
  });

  test('pending があれば件数と一覧が出る', () => {
    const diff = {
      pending: [{ no: 32, date: '2026-11-12', commit: '-', file: '0032_x.sql', summary: 'テスト', ref: '-' }],
      dbAhead: [],
      duplicateNumbers: [],
    };
    const lines = formatPendingWarning(diff);
    assert.ok(lines[0].includes('1 件'));
    assert.ok(lines.some((l) => l.includes('0032_x.sql')));
  });
});

describe('classifyDbChangeError', () => {
  test('P1001/P1017・ECONNREFUSED は connection-failed', () => {
    assert.equal(classifyDbChangeError({ code: 'P1001' }), 'connection-failed');
    assert.equal(classifyDbChangeError({ code: 'P1017' }), 'connection-failed');
    assert.equal(classifyDbChangeError(new Error('connect ECONNREFUSED 127.0.0.1:5432')), 'connection-failed');
  });

  test('P2021・42P01・relation does not exist は no-ledger', () => {
    assert.equal(classifyDbChangeError({ code: 'P2021' }), 'no-ledger');
    assert.equal(classifyDbChangeError(new Error('relation "DbChange" does not exist')), 'no-ledger');
    assert.equal(classifyDbChangeError({ meta: { code: '42P01' } }), 'no-ledger');
  });

  test('42501・permission denied は permission-denied', () => {
    assert.equal(classifyDbChangeError({ meta: { code: '42501' } }), 'permission-denied');
    assert.equal(classifyDbChangeError(new Error('permission denied for table DbChange')), 'permission-denied');
  });

  test('それ以外は unknown-error', () => {
    assert.equal(classifyDbChangeError(new Error('something else')), 'unknown-error');
  });
});

describe('isDbChangeWarnEnabled', () => {
  test('既定（未設定）は true', () => {
    assert.equal(isDbChangeWarnEnabled(undefined), true);
  });
  test("'0' のときだけ false", () => {
    assert.equal(isDbChangeWarnEnabled('0'), false);
    assert.equal(isDbChangeWarnEnabled('1'), true);
  });
});

// ============================================================
// 2〜9. apps/server/db/changes/ の静的検査（dist 不要）
// ============================================================

const indexText = readServerFile('db/changes/INDEX.tsv');
const indexRows = parseChangeIndex(indexText);
const schemaShaText = readServerFile('db/changes/SCHEMA.sha256').trim();
const changeSqlFiles = readdirSync(changesDir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();

describe('SCHEMA.sha256: schema.prisma の指紋照合（書き忘れ検知の本体）', () => {
  test('SCHEMA.sha256 は "<sha16>␣<ファイル名>" の1行形式', () => {
    assert.match(schemaShaText, /^[0-9a-f]{16} \S+$/);
  });

  test('第1フィールドが現在の schema.prisma の sha256 先頭16桁と一致する', () => {
    const schemaBuf = readFileSync(path.join(serverRoot, 'prisma', 'schema.prisma'));
    const actualSha16 = createHash('sha256').update(schemaBuf).digest('hex').slice(0, 16);
    const [expectedSha16] = schemaShaText.split(' ');
    assert.equal(
      expectedSha16,
      actualSha16,
      'schema.prisma を変更したら apps/server/db/changes/ に変更ファイル(or file=- の索引行)を追加し、' +
        'SCHEMA.sha256 を `sha256sum apps/server/prisma/schema.prisma | cut -c1-16` の値で更新してください',
    );
  });

  test('第2フィールドが INDEX.tsv の最大番号の行のファイル名と一致する', () => {
    assert.ok(indexRows.length > 0, 'INDEX.tsv にデータ行が無い');
    const maxRow = indexRows.reduce((a, b) => (b.no > a.no ? b : a));
    const [, expectedFile] = schemaShaText.split(' ');
    assert.equal(expectedFile, maxRow.file);
  });
});

describe('INDEX.tsv とファイルの突合', () => {
  test('no は一意かつ昇順', () => {
    const nos = indexRows.map((r) => r.no);
    const sorted = [...nos].sort((a, b) => a - b);
    assert.deepEqual(nos, sorted, 'INDEX.tsv の行は no 昇順で並んでいる必要があります');
    assert.equal(new Set(nos).size, nos.length, '重複した no があります');
  });

  test('file 列（\'-\' 以外）の集合 = ディレクトリ内の NNNN_*.sql ファイル集合', () => {
    const indexFiles = indexRows.map((r) => r.file).filter((f) => f !== '-').sort();
    assert.deepEqual(indexFiles, changeSqlFiles);
  });

  test('各行の file の NNNN プレフィクスが no と一致する', () => {
    for (const row of indexRows) {
      if (row.file === '-') continue;
      const prefix = row.file.slice(0, 4);
      assert.equal(prefix, String(row.no).padStart(4, '0'), `${row.file} の番号プレフィクスが no=${row.no} と不一致`);
    }
  });
});

describe('各 SQL ファイルの自己整合・冪等性・ガード・ヘッダ', () => {
  for (const file of changeSqlFiles) {
    const no = Number.parseInt(file.slice(0, 4), 10);
    const source = readFileSync(path.join(changesDir, file), 'utf8');
    // `--` 始まりの SQL コメント（行末まで）を取り除いたもの。冪等性・禁止キーワードの検査は
    // 実コードに対してのみ行う（ヘッダの説明文に「CREATE TABLE」等の語が出てくる誤検知を防ぐ）。
    const codeOnly = source.replace(/--.*$/gm, '');

    describe(file, () => {
      test('末尾の INSERT INTO "DbChange" が自分のファイル名・番号と一致する', () => {
        const m = source.match(/INSERT INTO "DbChange" \("name", "no", "appliedBy"\)\s*\nVALUES \('([^']+)',\s*(\d+),/);
        assert.ok(m, 'INSERT INTO "DbChange" (...) VALUES (...) の形が見つからない');
        assert.equal(m[1], file);
        assert.equal(Number.parseInt(m[2], 10), no);
      });

      // "_existed" ガード（IF NOT column_existed THEN ... END IF;）の内側は、SQL レベルの
      // IF NOT EXISTS の代わりに PL/pgSQL の分岐そのものが冪等性を保証する（0027 のパターン）。
      // そのため冪等性 lint はガードの外側だけに適用する。
      const outsideExistedGuard = codeOnly.replace(/IF NOT \w+_existed THEN[\s\S]*?END IF;/g, '');

      test('CREATE TABLE / ADD COLUMN / CREATE INDEX は全て IF NOT EXISTS 付き（column_existed ガード内は対象外）', () => {
        assert.ok(!/CREATE TABLE(?! IF NOT EXISTS)/.test(outsideExistedGuard), 'IF NOT EXISTS の無い CREATE TABLE がある');
        assert.ok(!/ADD COLUMN(?! IF NOT EXISTS)/.test(outsideExistedGuard), 'IF NOT EXISTS の無い ADD COLUMN がある');
        assert.ok(!/CREATE (UNIQUE )?INDEX(?! IF NOT EXISTS)/.test(outsideExistedGuard), 'IF NOT EXISTS の無い CREATE INDEX がある');
      });

      // backfill（実データを書き換える UPDATE/DELETE FROM）の検出。
      // "ON DELETE CASCADE/RESTRICT"（FK の参照動作）・"ON UPDATE CASCADE" は対象外にする
      // （これらは `\bUPDATE\b`/`\bDELETE\b` に単純一致するが backfill ではない）。
      const hasBackfillDml = /\bUPDATE\s+"/.test(codeOnly) || /\bDELETE\s+FROM\b/i.test(codeOnly);

      test('backfill（UPDATE/DELETE FROM）がある場合、ALTER 前の列存在チェックで「今回新規追加したときだけ」実行するガードを持つ（台帳の記録状態に依存せず、既存データを書き換えない）', () => {
        if (!hasBackfillDml) return; // backfill を持たないファイルは対象外

        assert.match(source, /information_schema\.columns/, 'backfill の前に列の存在チェック（information_schema.columns）が無い');
        assert.match(source, /IF NOT \w+_existed THEN/, '"_existed" 系フラグで分岐する IF NOT ガードが無い');

        // "_existed" ガードの外側に backfill の UPDATE/DELETE FROM が無いこと（= 必ずガードの内側にある。
        // 状態不明の DB で頭から全ファイルを流しても、既に列がある DB では書き換えが起きないことを
        // 構造的に保証する）
        assert.ok(
          !(/\bUPDATE\s+"/.test(outsideExistedGuard) || /\bDELETE\s+FROM\b/i.test(outsideExistedGuard)),
          'backfill の UPDATE/DELETE FROM が "_existed" ガードの外にある',
        );
      });

      test('ヘッダに台帳作成（CREATE TABLE IF NOT EXISTS "DbChange"）がある', () => {
        assert.match(source, /CREATE TABLE IF NOT EXISTS "DbChange"/);
      });

      test('3段の誤爆ガード（Machine存在 / usesuper / 所有者一致）がある', () => {
        assert.match(source, /to_regclass\('public\."Machine"'\)/);
        assert.match(source, /usesuper/);
        assert.match(source, /pg_tables/);
      });

      test('禁止キーワード（OWNER TO / SET ROLE / CREATE EXTENSION / sudo）を含まない', () => {
        assert.ok(!/OWNER TO/i.test(source), 'OWNER TO を含む');
        assert.ok(!/\bSET ROLE\b/i.test(source), 'SET ROLE を含む');
        assert.ok(!/CREATE EXTENSION/i.test(source), 'CREATE EXTENSION を含む（pgvector は bootstrap.sql の担当）');
        assert.ok(!/\bsudo\b/i.test(source), 'sudo を含む');
      });

      test('ヘッダ必須項目（日付・commit・サイクル・内容・注意・適用ロール・適用コマンド）が揃っている', () => {
        assert.match(source, /^-- \d{4} \/ \d{4}-\d{2}-\d{2} \/ commit/m);
        assert.match(source, /サイクル: /);
        assert.match(source, /内容: /);
        assert.match(source, /注意: /);
        assert.match(source, /適用ロール: /);
        assert.match(source, /適用: psql "\$DATABASE_URL"/);
      });

      test('psql -1（単一トランザクション）を前提にした適用コマンドが書かれている（-- no-single-transaction マーカーが無い限り）', () => {
        if (!/no-single-transaction/.test(source)) {
          assert.match(source, /psql "\$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f/);
        }
      });
    });
  }
});

// ============================================================
// 8. 追跡漏れ検知（git ls-files ∪ staged）
// ============================================================

function getTrackedOrStagedFiles() {
  const tracked = execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
  const staged = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);
  return new Set([...tracked, ...staged]);
}

describe('apps/server/db/changes/ の全ファイルが追跡済み or stage 済みであること', () => {
  test('INDEX.tsv・SCHEMA.sha256・README.md・zz1/zz2・全 NNNN_*.sql が git ls-files ∪ staged に含まれる', () => {
    const trackedOrStaged = getTrackedOrStagedFiles();
    const expected = [
      'INDEX.tsv', 'SCHEMA.sha256', 'README.md',
      'zz1_verify.sql', 'zz2_mark_baseline_applied.sql',
      ...changeSqlFiles,
    ].map((f) => `apps/server/db/changes/${f}`);
    const missing = expected.filter((p) => !trackedOrStaged.has(p));
    if (missing.length > 0) {
      assert.fail(`git add し忘れのファイルがあります（commit すると索引だけが届く恐れ）:\n${missing.map((m) => `  ${m}`).join('\n')}`);
    }
  });
});

// ============================================================
// zz1/zz2: baseline 系補助 SQL の安全性（サイクルM1b）
// ============================================================

describe('zz1_verify.sql は読み取り専用（DDL・DML を一切含まない）', () => {
  const source = readFileSync(path.join(changesDir, 'zz1_verify.sql'), 'utf8');
  const codeOnly = source.replace(/--.*$/gm, '');

  test('CREATE/ALTER/DROP/INSERT/UPDATE/DELETE FROM を含まない', () => {
    assert.ok(!/\b(CREATE|ALTER|DROP|INSERT)\b/i.test(codeOnly), 'DDL/INSERT を含んでいる');
    assert.ok(!/\bUPDATE\s+"/.test(codeOnly), 'UPDATE 文を含んでいる');
    assert.ok(!/\bDELETE\s+FROM\b/i.test(codeOnly), 'DELETE FROM 文を含んでいる');
  });
});

describe('zz2_mark_baseline_applied.sql は台帳への INSERT 以外の書き込みを行わない', () => {
  const source = readFileSync(path.join(changesDir, 'zz2_mark_baseline_applied.sql'), 'utf8');
  const codeOnly = source.replace(/--.*$/gm, '');

  test('3段の誤爆ガード + 突合ゲート + 台帳作成を持つ', () => {
    assert.match(source, /to_regclass\('public\."Machine"'\)/);
    assert.match(source, /usesuper/);
    assert.match(source, /pg_tables/);
    assert.match(source, /CREATE TABLE IF NOT EXISTS "DbChange"/);
  });

  test('UPDATE/DELETE FROM を含まない（INSERT ... ON CONFLICT DO NOTHING のみで既存データに触れない）', () => {
    assert.ok(!/\bUPDATE\s+"/.test(codeOnly), 'UPDATE 文を含んでいる');
    assert.ok(!/\bDELETE\s+FROM\b/i.test(codeOnly), 'DELETE FROM 文を含んでいる');
    assert.match(codeOnly, /ON CONFLICT \("name"\) DO NOTHING/);
  });

  test('CREATE TABLE は "DbChange" のみ（他テーブルを新設しない）', () => {
    const matches = [...codeOnly.matchAll(/CREATE TABLE IF NOT EXISTS "(\w+)"/g)].map((m) => m[1]);
    assert.deepEqual(matches, ['DbChange']);
  });
});

// ============================================================
// 9. 禁止コマンドの封じ込め（M1a スコープ: package.json + prisma/migrations/ 凍結）
// ============================================================

describe('禁止コマンドの封じ込め', () => {
  test('apps/server/package.json の scripts に db:push が無い', () => {
    const pkg = JSON.parse(readServerFile('package.json'));
    assert.ok(!('db:push' in pkg.scripts), 'db:push スクリプトが残っている（embedding 列を DROP する db push への入口になる）');
  });

  test('apps/server/package.json のどの script 値にも "migrate dev" / "migrate deploy" が無い', () => {
    const pkg = JSON.parse(readServerFile('package.json'));
    for (const [name, value] of Object.entries(pkg.scripts)) {
      assert.ok(!/migrate dev|migrate deploy/.test(value), `script "${name}" に migrate dev/deploy が含まれている`);
    }
  });

  test('apps/server/package.json に db:bootstrap:new-db-only と db:status がある', () => {
    const pkg = JSON.parse(readServerFile('package.json'));
    assert.ok('db:bootstrap:new-db-only' in pkg.scripts);
    assert.ok('db:status' in pkg.scripts);
  });

  test('CLAUDE.md / rules/devrelay.md の DB 手順が migrate dev を実行コマンドとして案内していない（サイクルM1c）', () => {
    const claudeMd = readFileSync(path.join(repoRoot, 'CLAUDE.md'), 'utf8');
    const rulesDevrelay = readFileSync(path.join(repoRoot, 'rules', 'devrelay.md'), 'utf8');
    for (const [name, text] of [['CLAUDE.md', claudeMd], ['rules/devrelay.md', rulesDevrelay]]) {
      assert.ok(!/npx prisma migrate (dev|deploy)/.test(text), `${name} が migrate dev/deploy を実行コマンドとして案内している`);
    }
  });

  test('apps/server/prisma/migrations/ は凍結済み（ディレクトリ数が20のまま）', () => {
    const entries = readdirSync(path.join(serverRoot, 'prisma', 'migrations'));
    const dirs = entries.filter((e) => statSync(path.join(serverRoot, 'prisma', 'migrations', e)).isDirectory());
    assert.equal(dirs.length, 20, 'prisma/migrations/ のディレクトリ数が変化している（新規変更は apps/server/db/changes/ に置くこと）');
  });
});
