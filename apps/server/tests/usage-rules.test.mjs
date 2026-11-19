// Usage（コスト集計）サイクル: services/usage-rules.ts の単体テスト（dist を直接 import）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isUsageEnabled,
  isPlausibleSignageToken,
  parseSignageInnerAxis,
  usageDisplayName,
  usageThreadTitle,
} from '../dist/services/usage-rules.js';

test('isUsageEnabled: 既定 ON、"0" のときだけ OFF', () => {
  assert.equal(isUsageEnabled(undefined), true);
  assert.equal(isUsageEnabled('1'), true);
  assert.equal(isUsageEnabled(''), true);
  assert.equal(isUsageEnabled('0'), false);
});

test('isPlausibleSignageToken: base64url 32 文字以上のみ', () => {
  assert.equal(isPlausibleSignageToken('a'.repeat(32)), true);
  assert.equal(isPlausibleSignageToken('Ab-_'.repeat(8)), true);
  assert.equal(isPlausibleSignageToken('short'), false);
  assert.equal(isPlausibleSignageToken("x' OR 1=1 --".padEnd(40, 'x')), false);
  assert.equal(isPlausibleSignageToken(undefined), false);
});

test('parseSignageInnerAxis: 既定は案件別', () => {
  assert.equal(parseSignageInnerAxis(undefined), 'case');
  assert.equal(parseSignageInnerAxis('user'), 'user');
  assert.equal(parseSignageInnerAxis('project'), 'project');
  assert.equal(parseSignageInnerAxis('group'), 'case');
});

test('usageDisplayName: 名前 → メールの @ より前 → id（メール全体は出さない）', () => {
  assert.equal(usageDisplayName({ id: 'u1', name: ' 村田 ', email: 'murata-k@example.jp' }), '村田');
  assert.equal(usageDisplayName({ id: 'u1', name: null, email: 'murata-k@example.jp' }), 'murata-k');
  assert.equal(usageDisplayName({ id: 'u1', name: null, email: null }), 'u1');
});

test('usageThreadTitle: タイトル優先、無ければ先頭発言 + 開始日（JST）', () => {
  const started = new Date('2026-11-03T16:00:00.000Z'); // JST 11/04 01:00
  assert.equal(usageThreadTitle('スレッド名a', 'x', started), 'スレッド名a');
  assert.equal(usageThreadTitle(null, '  ログ画面の\n不具合を直して ', started), 'ログ画面の 不具合を直して (11/04)');
  assert.equal(usageThreadTitle('', null, started), '(無題) 11/04');
  assert.ok(usageThreadTitle(null, 'あ'.repeat(50), started).includes('…'));
});
