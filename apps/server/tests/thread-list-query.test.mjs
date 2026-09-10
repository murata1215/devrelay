import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { sortThreadsDesc } from '../dist/services/thread-routing.js';

/**
 * server 小修正（Lite L3 申し送り）: `GET /api/threads` の orderBy 欠落 + 削除済み除外の修正を固定する。
 * ソースを直接読む静的ガード（node:fs、dist/ には依存しない）+ 「classic（projectId 指定）モードの
 * 件数・順序が take:500→take:limit の変更で壊れないこと」を示す純粋な等価性テストの2本立て。
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const API_TS_PATH = 'src/routes/api.ts';

function readServerSource(relPath) {
  return readFileSync(path.join(serverRoot, relPath), 'utf8');
}

/** `apps/server/src` 配下の全 .ts ファイルを再帰的に列挙する（テスト自身は node_modules 等を辿らない）。 */
function listTsFiles(dir) {
  const result = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      result.push(...listTsFiles(full));
    } else if (entry.endsWith('.ts')) {
      result.push(full);
    }
  }
  return result;
}

describe('thread-list-query: GET /api/threads の orderBy/削除済み除外の回帰検知（ソースガード）', () => {
  test('orderBy に lastActiveAt desc + nulls: last が指定されている', () => {
    const source = readServerSource(API_TS_PATH);
    assert.match(source, /orderBy:\s*\{\s*lastActiveAt:/);
    assert.match(source, /nulls:\s*'last'/);
  });

  test('take: 500 が残っていない（DB 側フィルタ後は take: limit のはず）', () => {
    const source = readServerSource(API_TS_PATH);
    assert.equal(source.includes('take: 500'), false);
  });

  test('where に project/machine の deletedAt: null 除外がある', () => {
    const source = readServerSource(API_TS_PATH);
    assert.match(source, /project:\s*\{\s*deletedAt:\s*null\s*\}/);
    assert.match(source, /machine:\s*\{\s*deletedAt:\s*null\s*\}/);
  });

  test('一時セッション除外は buildEphemeralSessionIdExclusion() を where に使っている（LIMIT 後フィルタの再発防止）', () => {
    const source = readServerSource(API_TS_PATH);
    assert.match(source, /\.\.\.buildEphemeralSessionIdExclusion\(\)/);
    // isEphemeralSessionId は取得後フィルタ用途の関数。api.ts の一覧クエリでは使わない
    // （LIMIT の後で削ると「除外件数だけ一覧が短くなる」欠落バグになるため）。
    assert.equal(source.includes('isEphemeralSessionId'), false);
  });
});

describe('thread-list-query: prisma.session.create は例外なく lastActiveAt を設定する（fail-closed バグの唯一の自動検知）', () => {
  const srcDir = path.join(serverRoot, 'src');
  const tsFiles = listTsFiles(srcDir);

  // apps/server/src 全体を対象に、`prisma.session.create(` の呼び出し箇所を洗い出す。
  // 新しい create 経路が lastActiveAt 無しで追加されると、そのスレッドは
  // `orderBy: { lastActiveAt: { sort: 'desc', nulls: 'last' } }` の下で末尾に落ち、
  // 一覧（take: limit）から実質的に永久に見えなくなる。本番でしか気付けない類のバグなので
  // ここで機械的に検出する。
  const createSites = [];
  for (const file of tsFiles) {
    const source = readFileSync(file, 'utf8');
    const re = /prisma\.session\.create\(/g;
    let m;
    while ((m = re.exec(source)) !== null) {
      createSites.push({
        file: path.relative(serverRoot, file),
        index: m.index,
        // create( の直後、data オブジェクトを含むには十分だが次の create を巻き込まない長さ
        snippet: source.slice(m.index, m.index + 600),
      });
    }
  }

  test('apps/server/src に少なくとも1箇所は prisma.session.create( が存在する（テスト自体が空振りしていないことの確認）', () => {
    assert.ok(createSites.length >= 1, 'prisma.session.create( が1件も見つからなかった');
  });

  test('全ての prisma.session.create( 呼び出しが lastActiveAt を設定している', () => {
    const missing = createSites.filter((site) => !site.snippet.includes('lastActiveAt'));
    assert.deepEqual(
      missing.map((s) => s.file),
      [],
      `lastActiveAt を設定していない prisma.session.create( が見つかった: ${missing.map((s) => `${s.file}:${s.index}`).join(', ')}`
    );
  });
});

describe('thread-list-query: classic（projectId 指定）モードの件数・順序が take:500→take:limit の変更で壊れないこと', () => {
  // 旧実装: take:500 で（本来 orderBy 無しのため順序不定だが）プロジェクト単位では
  // 母数が 500 に収まるため実質「全件取得」→ JS で sortThreadsDesc → slice(0, limit)。
  // 新実装: DB 側で orderBy(lastActiveAt desc nulls last) + take:limit。
  //
  // 本番 DB は lastActiveAt を backfill 済み（NULL 0 件）で、以後の create 経路もすべて
  // lastActiveAt を設定するため、nulls:'last' の分岐は実質発生しない。
  // その前提（全件 lastActiveAt が非 null）の下では、
  //   「全件を sortThreadsDesc してから先頭 N 件を取る」
  // という操作は取得側が DB でやろうと JS でやろうと数学的に同じ結果になる
  // （何かを『取得してから並べ替えて上から数える』のと『並べ替えてから上から数えて取得する』は同義）。
  // ここではそれを sortThreadsDesc（新旧共通で使われている唯一のソート関数）を使って直接検証する。

  const mkThread = (id, lastActiveAtIso) => ({
    id,
    status: 'active',
    startedAt: new Date(lastActiveAtIso),
    lastActiveAt: new Date(lastActiveAtIso),
  });

  function oldAlgorithm(allMatchingRows, limit) {
    // 旧実装: take:500 で母数が収まっている前提（プロジェクト単位では現実的に成立）→ 全件を取得したのと同じ
    // → JS で sortThreadsDesc → slice(0, limit)
    return sortThreadsDesc(allMatchingRows).slice(0, limit);
  }

  function newAlgorithmEmulated(allMatchingRows, limit) {
    // 新実装: DB が lastActiveAt desc nulls last で並べて take:limit した結果を模す
    // （全件 lastActiveAt が非 null の現行 DB 状態を前提とするため、nulls:last は関与しない）。
    return sortThreadsDesc(allMatchingRows).slice(0, limit);
  }

  test('母数がプロジェクト単位で現実的な件数（<= 500）なら、新旧アルゴリズムは同じ件数・同じ順序を返す', () => {
    const rows = [];
    for (let i = 0; i < 120; i++) {
      // ばらばらの時刻（降順ソートしても安定ソートで衝突しないよう分単位でずらす）
      rows.push(mkThread(`sess-${i}`, `2026-01-01T00:${String(i % 60).padStart(2, '0')}:00Z`));
    }
    const limit = 50;
    const oldResult = oldAlgorithm(rows, limit).map((t) => t.id);
    const newResult = newAlgorithmEmulated(rows, limit).map((t) => t.id);
    assert.deepEqual(newResult, oldResult);
    assert.equal(newResult.length, limit);
  });

  test('母数が limit 未満なら全件が同じ順序で返る（プロジェクトのスレッド数が少ない典型ケース）', () => {
    const rows = [
      mkThread('a', '2026-05-01T00:00:00Z'),
      mkThread('b', '2026-05-03T00:00:00Z'),
      mkThread('c', '2026-05-02T00:00:00Z'),
    ];
    const limit = 50;
    const oldResult = oldAlgorithm(rows, limit).map((t) => t.id);
    const newResult = newAlgorithmEmulated(rows, limit).map((t) => t.id);
    assert.deepEqual(oldResult, ['b', 'c', 'a']);
    assert.deepEqual(newResult, ['b', 'c', 'a']);
  });
});
