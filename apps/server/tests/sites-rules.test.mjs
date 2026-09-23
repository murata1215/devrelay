// DevRelay Sites Phase 1-B: sites-rules.ts の単体テスト。
// bot 判定 / page view 判定 / Referer・UTM 抽出 / UU ハッシュ（host 分離）/ window 判定を固定する。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isBotUserAgent,
  isOwnHealthCheck,
  isPageView,
  extractUtm,
  classifyReferer,
  hashUu,
  toDateKey,
  daysSince,
  isWithinWindow,
  OWN_HEALTH_CHECK_UA,
  SITES_TIME_ZONE,
} from '../dist/services/sites/sites-rules.js';

test('/ と /watch は PV（200）', () => {
  assert.equal(isPageView('GET', '/', 200), true);
  assert.equal(isPageView('GET', '/watch', 200), true);
});

test('UTM 付き / は PV かつ UTM 抽出できる', () => {
  assert.equal(isPageView('GET', '/', 200), true);
  const utm = extractUtm('utm_source=x&utm_medium=cpc&utm_campaign=launch');
  assert.deepEqual(utm, { source: 'x', medium: 'cpc', campaign: 'launch' });
});

test('UTM 抽出: ? 付き query, 部分欠落, null もハンドルする', () => {
  assert.deepEqual(extractUtm('?utm_source=x'), { source: 'x', medium: null, campaign: null });
  assert.deepEqual(extractUtm(null), { source: null, medium: null, campaign: null });
  assert.deepEqual(extractUtm(''), { source: null, medium: null, campaign: null });
});

test('/api/* /assets/* /favicon.ico /health は PV でない', () => {
  assert.equal(isPageView('GET', '/api/games', 200), false);
  assert.equal(isPageView('GET', '/assets/app.js', 200), false);
  assert.equal(isPageView('GET', '/favicon.ico', 200), false);
  assert.equal(isPageView('GET', '/health', 200), false);
});

test('POST は PV でない', () => {
  assert.equal(isPageView('POST', '/', 200), false);
});

// ---------------------------------------------------------------------------
// B2-0 修正2: isPageView に status を渡し、404 等を PV から除外する
// ---------------------------------------------------------------------------

test('isPageView: status を見て 404 非 PV を判定する（B2-0 修正2）', () => {
  assert.equal(isPageView('GET', '/missing', 404), false);
  assert.equal(isPageView('GET', '/', 200), true);
  assert.equal(isPageView('GET', '/watch', 200), true);
  assert.equal(isPageView('GET', '/', 304), true);
  assert.equal(isPageView('GET', '/api/games', 200), false);
  assert.equal(isPageView('POST', '/', 200), false);
  assert.equal(isPageView('GET', '/', 500), false);
});

test('bot UA / UA 空は bot 扱い', () => {
  assert.equal(isBotUserAgent(null), true);
  assert.equal(isBotUserAgent(''), true);
  assert.equal(isBotUserAgent('   '), true);
  assert.equal(isBotUserAgent('Googlebot/2.1'), true);
  assert.equal(isBotUserAgent('curl/8.4.0'), true);
  assert.equal(isBotUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0'), false);
});

test('DevRelay-Sites/1.0 は完全除外（isOwnHealthCheck）', () => {
  assert.equal(isOwnHealthCheck(OWN_HEALTH_CHECK_UA), true);
  assert.equal(isOwnHealthCheck('DevRelay-Sites/1.0'), true);
  assert.equal(isOwnHealthCheck('Mozilla/5.0'), false);
});

test('Referer は hostname 単位、自ホストは direct', () => {
  assert.equal(classifyReferer(null, 'dangou-card-viewer.devrelay.io'), 'direct');
  assert.equal(classifyReferer('not a url', 'dangou-card-viewer.devrelay.io'), 'direct');
  assert.equal(classifyReferer('https://dangou-card-viewer.devrelay.io/', 'dangou-card-viewer.devrelay.io'), 'direct');
  assert.equal(classifyReferer('https://x.com/status/1', 'dangou-card-viewer.devrelay.io'), 'x.com');
});

test('UU ハッシュ: host を含むため site 間で一致しない（global UU として合算不能）', () => {
  const a = hashUu('secret', '2026-09-22', 'siteA.devrelay.io', '203.0.113.5');
  const b = hashUu('secret', '2026-09-22', 'siteB.devrelay.io', '203.0.113.5');
  assert.notEqual(a, b);
  assert.equal(a.length, 16);
});

test('UU ハッシュ: 同一 secret/date/host/ip は決定的に同一ハッシュ', () => {
  const a = hashUu('secret', '2026-09-22', 'siteA.devrelay.io', '203.0.113.5');
  const b = hashUu('secret', '2026-09-22', 'siteA.devrelay.io', '203.0.113.5');
  assert.equal(a, b);
});

test('UU ハッシュ: date が違えば別ハッシュ（日跨ぎで独立集計できる）', () => {
  const a = hashUu('secret', '2026-09-22', 'siteA.devrelay.io', '203.0.113.5');
  const b = hashUu('secret', '2026-09-23', 'siteA.devrelay.io', '203.0.113.5');
  assert.notEqual(a, b);
});

test('toDateKey: ISO ts から YYYY-MM-DD を取り出す（JST 基準。UTC 10:00 = JST 19:00 なので同日）', () => {
  assert.equal(toDateKey('2026-09-22T10:00:00.000Z'), '2026-09-22');
});

// ---------------------------------------------------------------------------
// B2-0 修正3: toDateKey を Asia/Tokyo 基準にする
// ---------------------------------------------------------------------------

test('toDateKey: JST 日付境界（UTC 15:00 = JST 翌日 0:00）で日付が切り替わる', () => {
  assert.equal(toDateKey('2026-09-22T14:59:59.000Z'), '2026-09-22', 'JST 23:59:59 はまだ同日');
  assert.equal(toDateKey('2026-09-22T15:00:00.000Z'), '2026-09-23', 'JST 0:00:00 で翌日に切り替わる');
});

test('toDateKey: すでに YYYY-MM-DD 形式（10 文字）の入力はそのまま返す（date key の再正規化を壊さない）', () => {
  assert.equal(toDateKey('2026-09-22'), '2026-09-22');
});

test('toDateKey: パース不能な入力は従来の slice(0, 10) にフォールバックする', () => {
  assert.equal(toDateKey('not-a-date'), 'not-a-date'.slice(0, 10));
});

test('toDateKey: Intl.DateTimeFormat(Asia/Tokyo) の結果と複数 ts でクロスチェックする', () => {
  assert.equal(SITES_TIME_ZONE, 'Asia/Tokyo');
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: SITES_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
  const samples = [
    '2026-09-22T00:00:00.000Z',
    '2026-09-22T14:59:59.999Z',
    '2026-09-22T15:00:00.000Z',
    '2026-01-01T00:00:00.000Z',
    '2026-12-31T23:59:59.000Z',
    '2026-02-28T15:00:00.000Z', // JST 3/1 0:00 への月跨ぎ（2026 は非閏年）
  ];
  for (const ts of samples) {
    const expected = fmt.format(new Date(ts)); // en-CA は 'YYYY-MM-DD' 形式
    assert.equal(toDateKey(ts), expected, `ts=${ts}`);
  }
});

test('daysSince / isWithinWindow: window 判定', () => {
  assert.equal(daysSince('2026-09-22', '2026-09-22'), 0);
  assert.equal(daysSince('2026-08-24', '2026-09-22'), 29);
  assert.equal(isWithinWindow('2026-09-22', '2026-09-22', 30), true);
  assert.equal(isWithinWindow('2026-08-24', '2026-09-22', 30), true);
  assert.equal(isWithinWindow('2026-08-23', '2026-09-22', 30), false);
  assert.equal(isWithinWindow('2026-09-23', '2026-09-22', 30), false); // 未来日
});
