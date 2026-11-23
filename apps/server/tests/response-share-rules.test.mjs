// AI 回答契約サイクル（2026-11-23 改訂）: AI 応答の詳細ページ（公開共有リンク）の
// 純関数（response-share-rules.ts）の単体テスト。
// 外部 import ゼロの純粋関数をコンパイル済み dist から直接 import する（content-truncate.test.mjs と同じ流儀）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isResponseShareEnabled,
  clampShareTtlDays,
  resolveShareTtlDays,
  isPlausibleShareToken,
  isShareExpired,
  daysRemaining,
  buildShareSuffix,
  resolveShareBaseUrl,
  buildShareUrl,
  DEFAULT_SHARE_TTL_DAYS,
} from '../dist/services/response-share-rules.js';

// ============================================================
// キルスイッチ（既定 OFF。他の多数のキルスイッチと逆方向）
// ============================================================

test('isResponseShareEnabled: 既定（未設定）は false', () => {
  assert.equal(isResponseShareEnabled(undefined), false);
});
test("isResponseShareEnabled: '1' のときだけ true", () => {
  assert.equal(isResponseShareEnabled('1'), true);
  assert.equal(isResponseShareEnabled('0'), false);
  assert.equal(isResponseShareEnabled('true'), false);
});

// ============================================================
// TTL のクランプ・解決
// ============================================================

test('clampShareTtlDays: 範囲内はそのまま', () => {
  assert.equal(clampShareTtlDays(30), 30);
  assert.equal(clampShareTtlDays(1), 1);
  assert.equal(clampShareTtlDays(365), 365);
});
test('clampShareTtlDays: 範囲外・不正値は既定値 or クランプ', () => {
  assert.equal(clampShareTtlDays(0), DEFAULT_SHARE_TTL_DAYS);
  assert.equal(clampShareTtlDays(-5), DEFAULT_SHARE_TTL_DAYS);
  assert.equal(clampShareTtlDays(NaN), DEFAULT_SHARE_TTL_DAYS);
  assert.equal(clampShareTtlDays(1000), 365);
});

test('resolveShareTtlDays: ユーザー個人設定が最優先', () => {
  assert.equal(resolveShareTtlDays('3', '7'), 7);
});
test('resolveShareTtlDays: ユーザー未設定なら env（devrelay.io=3 等）', () => {
  assert.equal(resolveShareTtlDays('3', null), 3);
  assert.equal(resolveShareTtlDays('3', undefined), 3);
});
test('resolveShareTtlDays: どちらも未設定/不正なら既定 30 日', () => {
  assert.equal(resolveShareTtlDays(undefined, undefined), DEFAULT_SHARE_TTL_DAYS);
  assert.equal(resolveShareTtlDays('abc', 'xyz'), DEFAULT_SHARE_TTL_DAYS);
  assert.equal(resolveShareTtlDays('0', '0'), DEFAULT_SHARE_TTL_DAYS);
});

// ============================================================
// トークン形式・期限判定
// ============================================================

test('isPlausibleShareToken: base64url 32〜128文字のみ true', () => {
  assert.equal(isPlausibleShareToken('a'.repeat(32)), true);
  assert.equal(isPlausibleShareToken('a'.repeat(31)), false);
  assert.equal(isPlausibleShareToken('a'.repeat(129)), false);
  assert.equal(isPlausibleShareToken('has space'.padEnd(32, 'x')), false);
  assert.equal(isPlausibleShareToken(123), false);
  assert.equal(isPlausibleShareToken(undefined), false);
});

test('isShareExpired: expiresAt が無い（未発行）は期限切れ扱い', () => {
  assert.equal(isShareExpired(null), true);
  assert.equal(isShareExpired(undefined), true);
});
test('isShareExpired: 未来なら false、過去/現在なら true', () => {
  const now = new Date('2026-11-23T00:00:00Z');
  assert.equal(isShareExpired(new Date('2026-11-24T00:00:00Z'), now), false);
  assert.equal(isShareExpired(new Date('2026-11-22T00:00:00Z'), now), true);
  assert.equal(isShareExpired(now, now), true); // 同時刻は期限切れ扱い
});

test('daysRemaining: null/undefined は 0', () => {
  assert.equal(daysRemaining(null), 0);
  assert.equal(daysRemaining(undefined), 0);
});
test('daysRemaining: 期限切れ（過去・現在）は 0', () => {
  const now = new Date('2026-11-23T00:00:00Z');
  assert.equal(daysRemaining(new Date('2026-11-22T00:00:00Z'), now), 0);
  assert.equal(daysRemaining(now, now), 0);
});
test('daysRemaining: 未来は切り上げで残り日数を返す', () => {
  const now = new Date('2026-11-23T00:00:00Z');
  assert.equal(daysRemaining(new Date('2026-11-24T00:00:00Z'), now), 1);
  assert.equal(daysRemaining(new Date('2026-11-23T12:00:00Z'), now), 1); // 半日でも切り上げで1日
  assert.equal(daysRemaining(new Date('2026-11-26T00:00:00Z'), now), 3);
});

// ============================================================
// サフィックス組み立て（Discord/Telegram の案内行。プラットフォームの出し分けゲートは
// 撤廃済み＝「詳細があるかどうか」だけで発行を判断する。response-split.ts 参照）
// ============================================================

test('buildShareSuffix: discord は <url> で埋め込みカードを抑制する', () => {
  const s = buildShareSuffix('discord', 'https://app.devrelay.io/s/abc', 30);
  assert.match(s, /<https:\/\/app\.devrelay\.io\/s\/abc>/);
  assert.match(s, /30日間有効/);
});
test('buildShareSuffix: telegram は無装飾のまま貼る', () => {
  const s = buildShareSuffix('telegram', 'https://app.devrelay.io/s/abc', 3);
  assert.ok(s.includes('https://app.devrelay.io/s/abc'));
  assert.ok(!s.includes('<https://'));
  assert.match(s, /3日間有効/);
});
test('buildShareSuffix: markdown は [text](url) 形式（本文に埋め込んでも全クライアントで読める）', () => {
  const s = buildShareSuffix('markdown', 'https://app.devrelay.io/s/abc', 3);
  assert.match(s, /\[詳細を見る（3日間有効）\]\(https:\/\/app\.devrelay\.io\/s\/abc\)/);
});

// ============================================================
// ベース URL 解決
// ============================================================

test('resolveShareBaseUrl: PUBLIC_URL 未設定なら既定ドメイン（oauth.ts と同じ既定値）', () => {
  assert.equal(resolveShareBaseUrl({}), 'https://app.devrelay.io');
});
test('resolveShareBaseUrl: PUBLIC_URL の末尾スラッシュ・サブパスを吸収する', () => {
  assert.equal(resolveShareBaseUrl({ PUBLIC_URL: 'https://example.com/' }), 'https://example.com');
  assert.equal(resolveShareBaseUrl({ PUBLIC_URL: 'https://example.com/sub/' }), 'https://example.com/sub');
});
test('resolveShareBaseUrl: 壊れた URL は既定ドメインにフォールバック', () => {
  assert.equal(resolveShareBaseUrl({ PUBLIC_URL: 'not a url' }), 'https://app.devrelay.io');
});

test('buildShareUrl: <base>/s/<token> を組み立てる', () => {
  assert.equal(buildShareUrl('TOKEN123', { PUBLIC_URL: 'https://example.com' }), 'https://example.com/s/TOKEN123');
  assert.equal(buildShareUrl('TOKEN123', {}), 'https://app.devrelay.io/s/TOKEN123');
});
