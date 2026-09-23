// DevRelay Sites Phase 1-B: access-aggregator.ts の day bucket 集計ロジックの単体テスト。
// `applyLineToBuckets` / `computeStatsFromBuckets` は純粋関数として切り出されており、
// 実ファイル I/O・スケジューラを介さずにテストできる。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyLineToBuckets, computeStatsFromBuckets, syncCoverageWithObservedOldestDate, CARDINALITY_LIMIT } from '../dist/services/sites/access-aggregator.js';

const HOST = 'dangou-card-viewer.devrelay.io';
const SECRET = 'test-secret';

function line({ host = HOST, method = 'GET', path = '/', query = null, status = 200, ts, userAgent = 'Mozilla/5.0', referer = null, remoteIp = '203.0.113.5' }) {
  return { ts, host, method, path, query, status, userAgent, referer, remoteIp };
}

function fullCoverage(measuredSince, coveredDays) {
  return {
    requestedDays: 30,
    oldestCoveredDate: measuredSince,
    coveredDays,
    complete: coveredDays >= 30,
    truncated: coveredDays < 30,
    truncatedReason: coveredDays < 30 ? 'log_retention' : null,
    measuredSince,
    timeZone: 'Asia/Tokyo',
  };
}

test('30 日 coverage 不足時に完全値と誤認させない（補外しない・欠測は null）', () => {
  const buckets = new Map();
  // 直近 5 日分だけデータがある（measuredSince = today-4）
  const today = '2026-09-22';
  const days = ['2026-09-18', '2026-09-19', '2026-09-20', '2026-09-21', '2026-09-22'];
  for (const d of days) {
    applyLineToBuckets(buckets, line({ path: '/', ts: `${d}T10:00:00.000Z` }), SECRET);
  }
  const coverage = fullCoverage('2026-09-18', 5);
  const stats = computeStatsFromBuckets(buckets.get(HOST), HOST, today, coverage, SECRET);

  assert.equal(stats.coverage.complete, false);
  assert.equal(stats.coverage.coveredDays, 5);
  assert.equal(stats.coverage.truncatedReason, 'log_retention');
  // measuredSince より前（today-5 以前）は 0 ではなく null（欠測）
  const beforeMeasured = stats.last30d.daily.find((d) => d.date === '2026-09-17');
  assert.equal(beforeMeasured.count, null);
  // measuredSince 以降は実データ（0 も含めて数値）
  const measuredDay = stats.last30d.daily.find((d) => d.date === '2026-09-18');
  assert.equal(measuredDay.count, 1);
  // last30d.pv は「実際に読めた日」の合計のみ（補外・推定をしていない = 単純合計と一致）
  const expectedSum = days.length; // 各日 1 PV
  assert.equal(stats.last30d.pv, expectedSum);
});

test('日跨ぎ UU が日毎に独立して数えられる（同一 IP でも日が変われば別カウント）', () => {
  // B2-0 修正3（JST bucket 化）: toDateKey は Asia/Tokyo（UTC+9）基準なので、
  // JST の日跨ぎ（UTC 15:00:00）を跨ぐ ts を使う（UTC 深夜 0 時は JST では日中で日を跨がない）。
  const buckets = new Map();
  const ip = '203.0.113.9';
  applyLineToBuckets(buckets, line({ path: '/', ts: '2026-09-21T14:59:00.000Z', remoteIp: ip }), SECRET);
  applyLineToBuckets(buckets, line({ path: '/', ts: '2026-09-21T15:01:00.000Z', remoteIp: ip }), SECRET);

  const hostBuckets = buckets.get(HOST);
  assert.equal(hostBuckets.get('2026-09-21').uu.size, 1);
  assert.equal(hostBuckets.get('2026-09-22').uu.size, 1);
  // 別日なのでハッシュも異なる（同一値が両日に重複して入っていない）
  const hash21 = [...hostBuckets.get('2026-09-21').uu][0];
  const hash22 = [...hostBuckets.get('2026-09-22').uu][0];
  assert.notEqual(hash21, hash22);

  const coverage = fullCoverage('2026-09-21', 2);
  const statsToday = computeStatsFromBuckets(hostBuckets, HOST, '2026-09-22', coverage, SECRET);
  assert.equal(statsToday.today.uu, 1);
});

test('カーディナリティ上限で (other) に畳まれ detailTruncated: true になる', () => {
  const buckets = new Map();
  const today = '2026-09-22';
  // CARDINALITY_LIMIT + 少数、distinct path を投入する
  const extra = 10;
  for (let i = 0; i < CARDINALITY_LIMIT + extra; i++) {
    applyLineToBuckets(buckets, line({ path: `/p/${i}`, ts: `${today}T00:00:00.000Z` }), SECRET);
  }
  const coverage = fullCoverage(today, 1);
  const stats = computeStatsFromBuckets(buckets.get(HOST), HOST, today, coverage, SECRET);

  assert.equal(stats.detailTruncated, true);
  const other = stats.topPaths.find((e) => e.key === '(other)');
  // '(other)' 自体は上位 N（TOP_N_RETURNED）に必ずしも入らない可能性があるため、
  // 直接 bucket 側で確認する（集計自体が畳まれていること）。
  const hostBuckets = buckets.get(HOST);
  const pathsMap = hostBuckets.get(today).paths;
  assert.ok(pathsMap.has('(other)'));
  assert.equal(pathsMap.get('(other)'), extra);
  assert.equal(pathsMap.size, CARDINALITY_LIMIT + 1); // 個別キー上限件数 + '(other)' 1 件
  void other;
});

test('bot / DevRelay 自身のヘルスチェックは PV に計上されない', () => {
  const buckets = new Map();
  const today = '2026-09-22';
  applyLineToBuckets(buckets, line({ path: '/', ts: `${today}T00:00:00.000Z`, userAgent: 'Googlebot/2.1' }), SECRET);
  applyLineToBuckets(buckets, line({ path: '/', ts: `${today}T00:00:01.000Z`, userAgent: 'DevRelay-Sites/1.0' }), SECRET);
  applyLineToBuckets(buckets, line({ path: '/', ts: `${today}T00:00:02.000Z`, userAgent: 'Mozilla/5.0' }), SECRET);

  const coverage = fullCoverage(today, 1);
  const stats = computeStatsFromBuckets(buckets.get(HOST), HOST, today, coverage, SECRET);
  assert.equal(stats.today.pv, 1, 'bot 1 件・ヘルスチェック 1 件（完全除外）・通常 1 件 → PV は 1 のみ');
});

test('uuSecret が null の場合、UU は null（PV は継続する）', () => {
  const buckets = new Map();
  const today = '2026-09-22';
  applyLineToBuckets(buckets, line({ path: '/', ts: `${today}T00:00:00.000Z` }), null);
  const coverage = fullCoverage(today, 1);
  const stats = computeStatsFromBuckets(buckets.get(HOST), HOST, today, coverage, null);
  assert.equal(stats.today.uu, null);
  assert.equal(stats.today.pv, 1);
});

test('excludedByRules: dangou-card-viewer は true、他 host は false', () => {
  const buckets = new Map();
  const today = '2026-09-22';
  applyLineToBuckets(buckets, line({ path: '/', ts: `${today}T00:00:00.000Z` }), SECRET);
  const coverage = fullCoverage(today, 1);
  const stats = computeStatsFromBuckets(buckets.get(HOST), HOST, today, coverage, SECRET);
  assert.equal(stats.excludedByRules, true);

  const other = 'chrome-bookmark.devrelay.io';
  applyLineToBuckets(buckets, line({ host: other, path: '/', ts: `${today}T00:00:00.000Z` }), SECRET);
  const statsOther = computeStatsFromBuckets(buckets.get(other), other, today, coverage, SECRET);
  assert.equal(statsOther.excludedByRules, false);
});

// ---------------------------------------------------------------------------
// B2-0 修正2: 404 を PV に含めない（集計レベル）
// ---------------------------------------------------------------------------

test('404 非 PV（集計レベル）: GET /missing 404 は status4xx のみ加算され PV は 0', () => {
  const buckets = new Map();
  const today = '2026-09-22';
  applyLineToBuckets(buckets, line({ path: '/missing', status: 404, ts: `${today}T00:00:00.000Z` }), SECRET);

  const hostBuckets = buckets.get(HOST);
  const bucket = hostBuckets.get(today);
  assert.equal(bucket.status4xx, 1);
  assert.equal(bucket.pv, 0);
});

test('bot / API / 200 の内訳: bot は botCount+PV0、/api/* は 200 でも PV0、通常 200 は PV+1', () => {
  const buckets = new Map();
  const today = '2026-09-22';
  applyLineToBuckets(buckets, line({ path: '/', status: 200, ts: `${today}T00:00:00.000Z`, userAgent: 'Googlebot/2.1' }), SECRET);
  applyLineToBuckets(buckets, line({ path: '/api/games', status: 200, ts: `${today}T00:00:01.000Z` }), SECRET);
  applyLineToBuckets(buckets, line({ path: '/', status: 200, ts: `${today}T00:00:02.000Z` }), SECRET);

  const bucket = buckets.get(HOST).get(today);
  assert.equal(bucket.botCount, 1);
  assert.equal(bucket.pv, 1, 'bot 1 件（PV0）・API 1 件（PV0）・通常 1 件（PV+1) → PV は 1 のみ');
});

// ---------------------------------------------------------------------------
// B2-0 修正3: JST midnight 跨ぎで Today PV/UU が正しく分離される
// ---------------------------------------------------------------------------

test('JST midnight 跨ぎで Today PV/UU が正しく分離される（同一 IP でも別日として独立集計）', () => {
  const buckets = new Map();
  const ip = '203.0.113.42';
  // UTC 14:59:59（JST 23:59:59、まだ 09-22）と UTC 15:00:00（JST 0:00:00、09-23 に切り替わる）
  applyLineToBuckets(buckets, line({ path: '/', ts: '2026-09-22T14:59:59.000Z', remoteIp: ip }), SECRET);
  applyLineToBuckets(buckets, line({ path: '/', ts: '2026-09-22T15:00:00.000Z', remoteIp: ip }), SECRET);

  const hostBuckets = buckets.get(HOST);
  const bucketDay1 = hostBuckets.get('2026-09-22');
  const bucketDay2 = hostBuckets.get('2026-09-23');
  assert.ok(bucketDay1, 'JST 2026-09-22 の bucket が存在する');
  assert.ok(bucketDay2, 'JST 2026-09-23 の bucket が存在する');
  assert.equal(bucketDay1.pv, 1);
  assert.equal(bucketDay2.pv, 1);
  assert.equal(bucketDay1.uu.size, 1);
  assert.equal(bucketDay2.uu.size, 1);

  const coverage = fullCoverage('2026-09-22', 2);
  const statsToday = computeStatsFromBuckets(hostBuckets, HOST, '2026-09-23', coverage, SECRET);
  assert.equal(statsToday.today.pv, 1, '前日分（2026-09-22）が混ざらない');
});

// ---------------------------------------------------------------------------
// B2-0 修正1: measuredSince 追従（self-heal で初めて行が入った後の coverage 再計算）
// ---------------------------------------------------------------------------

test('measuredSince 追従: observedOldestDate の出現後、coverage が再計算され last30d.daily が全 null にならない', () => {
  const today = '2026-09-23';
  // self-heal 前: coverage.measuredSince は null のまま（B1 導入直後・access log 未生成の状態）
  const initialCoverage = {
    requestedDays: 30,
    oldestCoveredDate: null,
    coveredDays: 0,
    complete: false,
    truncated: false,
    truncatedReason: null,
    measuredSince: null,
    timeZone: 'Asia/Tokyo',
  };

  // observedOldestDate が null のままなら coverage は変化しない（同じ参照を返す）
  const unchanged = syncCoverageWithObservedOldestDate(initialCoverage, null, today);
  assert.equal(unchanged, initialCoverage);
  assert.equal(unchanged.measuredSince, null);

  // self-heal で今日分の行が入った（observedOldestDate = today）
  const synced = syncCoverageWithObservedOldestDate(initialCoverage, today, today);
  assert.equal(synced.measuredSince, today);
  assert.equal(synced.oldestCoveredDate, today);
  assert.equal(synced.coveredDays, 1);
  assert.equal(synced.complete, false, '30 日に満たないので complete は false のまま');

  // computeStatsFromBuckets が last30d.daily を全 null にしないことを確認
  const buckets = new Map();
  applyLineToBuckets(buckets, line({ path: '/', ts: `${today}T00:00:00.000Z` }), SECRET);
  const stats = computeStatsFromBuckets(buckets.get(HOST), HOST, today, synced, SECRET);
  const todayDaily = stats.last30d.daily.find((d) => d.date === today);
  assert.equal(todayDaily.count, 1, 'measuredSince 追従前なら null になっていたはずが、実データが入る');
  const allNull = stats.last30d.daily.every((d) => d.count === null);
  assert.equal(allNull, false, 'last30d.daily が全 null にならない');

  // observedOldestDate が既存 measuredSince と同じ場合は再計算せず同じ参照を返す（無駄な再計算をしない）
  const noChange = syncCoverageWithObservedOldestDate(synced, today, today);
  assert.equal(noChange, synced);

  // truncated / truncatedReason は保持される（gap 検出等の既存判定を壊さない）
  const truncatedCoverage = { ...initialCoverage, truncated: true, truncatedReason: 'gap_detected' };
  const syncedWithTruncation = syncCoverageWithObservedOldestDate(truncatedCoverage, today, today);
  assert.equal(syncedWithTruncation.truncated, true);
  assert.equal(syncedWithTruncation.truncatedReason, 'gap_detected');
  assert.equal(syncedWithTruncation.measuredSince, today);
});
