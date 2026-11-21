// TISA 系列（会社リポジトリ独自）の DB 変更（apps/server/db/changes/tisa/）の書き忘れ防止ガード。
//
// 本家の tests/db-changes.test.mjs（サイクルM1）と同じ自己チェックを TISA 系列にかける。
// 本家のテストは変更しない（本家とのマージで衝突させないため）。運用は doc/db-changes-tisa.md。
//   1. 純関数（db-change-tisa.ts の diffWithTisaChanges）の単体ケース
//   2. tisa/INDEX.tsv とファイルの突合（番号の一意性・昇順、TISA<4桁> と no の一致）
//   3. 各 SQL ファイル末尾の INSERT INTO "DbChange" が自分のファイル名・番号と一致
//   4. 冪等性 lint・誤爆ガード・禁止キーワード・ヘッダ必須項目
//   5. 追跡漏れ検知（git ls-files ∪ staged）
//   6. SCHEMA.sha256 の 2 列目は本家の最大番号のまま（TISA のファイル名を書くと本家テストが落ちる）

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { parseChangeIndex } from '../dist/services/db-change-rules.js';
import { diffWithTisaChanges, isTisaChangeName } from '../dist/services/db-change-tisa.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(serverRoot, '../..');
const changesDir = path.join(serverRoot, 'db', 'changes');
const tisaDir = path.join(changesDir, 'tisa');

// ============================================================
// 1. 純関数
// ============================================================

describe('diffWithTisaChanges', () => {
  const upstream = parseChangeIndex([
    '0001\t2026-03-29\t-\t0001_a.sql\tA\t-',
    '0002\t2026-04-01\t-\t0002_b.sql\tB\t-',
  ].join('\n'));
  const tisa = parseChangeIndex([
    '0001\t2026-10-31\t-\tTISA0001_x.sql\tX\t-',
    '0002\t2026-11-19\t-\tTISA0002_y.sql\tY\t-',
  ].join('\n'));

  test('本家と TISA の同じ番号（0001）は重複扱いにならない', () => {
    const diff = diffWithTisaChanges(upstream, tisa, ['0001_a.sql', '0002_b.sql', 'TISA0001_x.sql', 'TISA0002_y.sql']);
    assert.deepEqual(diff, { pending: [], dbAhead: [], duplicateNumbers: [] });
  });

  test('台帳の TISA 行は本家側の「索引に無い」に入らない', () => {
    const diff = diffWithTisaChanges(upstream, [], ['0001_a.sql', '0002_b.sql']);
    assert.deepEqual(diff.dbAhead, []);
    const diff2 = diffWithTisaChanges(upstream, tisa, ['0001_a.sql', '0002_b.sql', 'TISA0001_x.sql', 'TISA0002_y.sql', 'TISA0009_ghost.sql']);
    assert.deepEqual(diff2.dbAhead, ['tisa/TISA0009_ghost.sql']);
  });

  test('未適用は本家 → TISA の順で、TISA は tisa/ 付きのパスになる', () => {
    const diff = diffWithTisaChanges(upstream, tisa, ['0001_a.sql', 'TISA0001_x.sql']);
    assert.deepEqual(diff.pending.map((r) => r.file), ['0002_b.sql', 'tisa/TISA0002_y.sql']);
  });

  test('TISA の索引が空（本家だけの環境）なら本家の判定と同じ', () => {
    const diff = diffWithTisaChanges(upstream, [], ['0001_a.sql']);
    assert.deepEqual(diff.pending.map((r) => r.file), ['0002_b.sql']);
  });

  test('isTisaChangeName', () => {
    assert.equal(isTisaChangeName('TISA0001_x.sql'), true);
    assert.equal(isTisaChangeName('0001_a.sql'), false);
  });
});

// ============================================================
// 2〜6. tisa/ の静的検査
// ============================================================

const tisaRows = parseChangeIndex(readFileSync(path.join(tisaDir, 'INDEX.tsv'), 'utf8'));
const tisaSqlFiles = readdirSync(tisaDir).filter((f) => /^TISA\d{4}_.*\.sql$/.test(f)).sort();

describe('tisa/INDEX.tsv とファイルの突合', () => {
  test('データ行がある', () => {
    assert.ok(tisaRows.length > 0);
  });

  test('no は一意かつ昇順', () => {
    const nos = tisaRows.map((r) => r.no);
    assert.deepEqual(nos, [...nos].sort((a, b) => a - b));
    assert.equal(new Set(nos).size, nos.length, '重複した no があります');
  });

  test('file 列（\'-\' 以外）の集合 = tisa/ 内の TISA<4桁>_*.sql の集合', () => {
    const indexFiles = tisaRows.map((r) => r.file).filter((f) => f !== '-').sort();
    assert.deepEqual(indexFiles, tisaSqlFiles);
  });

  test('各行の file は TISA<no 4桁>_ で始まる', () => {
    for (const row of tisaRows) {
      if (row.file === '-') continue;
      assert.ok(row.file.startsWith(`TISA${String(row.no).padStart(4, '0')}_`), `${row.file} の番号が no=${row.no} と不一致`);
    }
  });

  test('tisa/ に TISA 以外の SQL を置いていない（本家の NNNN_*.sql は親フォルダに置く）', () => {
    const others = readdirSync(tisaDir).filter((f) => f.endsWith('.sql') && !/^TISA\d{4}_/.test(f));
    assert.deepEqual(others, []);
  });
});

describe('tisa/ の各 SQL ファイルの自己整合・冪等性・ガード・ヘッダ', () => {
  for (const file of tisaSqlFiles) {
    const no = Number.parseInt(file.slice(4, 8), 10);
    const source = readFileSync(path.join(tisaDir, file), 'utf8');
    const codeOnly = source.replace(/--.*$/gm, '');

    describe(file, () => {
      test('末尾の INSERT INTO "DbChange" が自分のファイル名・番号と一致する', () => {
        const m = source.match(/INSERT INTO "DbChange" \("name", "no", "appliedBy"\)\s*\nVALUES \('([^']+)',\s*(\d+),/);
        assert.ok(m, 'INSERT INTO "DbChange" (...) VALUES (...) の形が見つからない');
        assert.equal(m[1], file);
        assert.equal(Number.parseInt(m[2], 10), no);
      });

      test('CREATE TABLE / ADD COLUMN / CREATE INDEX は全て IF NOT EXISTS 付き', () => {
        assert.ok(!/CREATE TABLE(?! IF NOT EXISTS)/.test(codeOnly), 'IF NOT EXISTS の無い CREATE TABLE がある');
        assert.ok(!/ADD COLUMN(?! IF NOT EXISTS)/.test(codeOnly), 'IF NOT EXISTS の無い ADD COLUMN がある');
        assert.ok(!/CREATE (UNIQUE )?INDEX(?! IF NOT EXISTS)/.test(codeOnly), 'IF NOT EXISTS の無い CREATE INDEX がある');
      });

      test('backfill（UPDATE/DELETE FROM）を持たない（必要になったら本家と同じ _existed ガードを使い、このテストを本家同様に拡張する）', () => {
        assert.ok(!(/\bUPDATE\s+"/.test(codeOnly) || /\bDELETE\s+FROM\b/i.test(codeOnly)));
      });

      test('台帳作成と 3 段の誤爆ガードがある', () => {
        assert.match(source, /CREATE TABLE IF NOT EXISTS "DbChange"/);
        assert.match(source, /to_regclass\('public\."Machine"'\)/);
        assert.match(source, /usesuper/);
        assert.match(source, /pg_tables/);
      });

      test('禁止キーワード（OWNER TO / SET ROLE / CREATE EXTENSION / sudo）を含まない', () => {
        assert.ok(!/OWNER TO/i.test(source));
        assert.ok(!/\bSET ROLE\b/i.test(source));
        assert.ok(!/CREATE EXTENSION/i.test(source));
        assert.ok(!/\bsudo\b/i.test(source));
      });

      // PL/pgSQL の RAISE は format が単一の文字列リテラル必須（|| 連結は構文エラー）。
      // 2026-11-21、本家側 zz2_mark_baseline_applied.sql の本番適用時にこれで発覚した実例があるため、
      // TISA 系列にも同じガードを置く（本家テストの変更ではないのでマージ衝突にはならない）。
      test('RAISE の message が || で文字列連結されていない（PL/pgSQL の構文エラーになる）', () => {
        assert.ok(!/RAISE\s+(?:EXCEPTION|WARNING|NOTICE|INFO|LOG|DEBUG)\b[^;]*\|\|/.test(source));
      });

      test('ヘッダ必須項目が揃い、適用コマンドが tisa/ のパスを指している', () => {
        assert.match(source, /^-- TISA\d{4} \/ \d{4}-\d{2}-\d{2} \/ commit/m);
        assert.match(source, /サイクル: /);
        assert.match(source, /内容: /);
        assert.match(source, /注意: /);
        assert.match(source, /適用ロール: /);
        assert.ok(source.includes(`psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f apps/server/db/changes/tisa/${file}`));
      });
    });
  }
});

describe('tisa/ の全ファイルが追跡済み or stage 済みであること', () => {
  test('tisa/INDEX.tsv・README.md・全 TISA*.sql が git ls-files ∪ staged に含まれる', () => {
    const tracked = execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' }).split('\n');
    const staged = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], { cwd: repoRoot, encoding: 'utf8' }).split('\n');
    const all = new Set([...tracked, ...staged].filter(Boolean));
    const missing = ['INDEX.tsv', 'README.md', ...tisaSqlFiles]
      .map((f) => `apps/server/db/changes/tisa/${f}`)
      .filter((p) => !all.has(p));
    assert.deepEqual(missing, [], 'git add し忘れのファイルがあります');
  });
});

describe('SCHEMA.sha256 と TISA 系列', () => {
  test('2 列目は TISA のファイル名ではない（本家の最大番号のファイル名のまま）', () => {
    const [, file] = readFileSync(path.join(changesDir, 'SCHEMA.sha256'), 'utf8').trim().split(' ');
    assert.ok(!isTisaChangeName(file), 'SCHEMA.sha256 の 2 列目に TISA のファイル名を書かない（1 列目の指紋だけ更新する）');
  });
});
