// DevRelay Sites Phase 1-A の積み残し（Phase 1-B サイクルで穴埋め）:
// health-checker.ts の純粋関数 `classifyHealth` / `isSitesHealthEnabled` の単体テスト。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyHealth, isSitesHealthEnabled } from '../dist/services/sites/health-checker.js';

test('classifyHealth: エラーがあれば無条件で down', () => {
  assert.equal(classifyHealth(200, 'timeout'), 'down');
  assert.equal(classifyHealth(null, 'ECONNREFUSED'), 'down');
});

test('classifyHealth: status が null（エラーなし）は unknown', () => {
  assert.equal(classifyHealth(null, null), 'unknown');
});

test('classifyHealth: 2xx/3xx は up', () => {
  assert.equal(classifyHealth(200, null), 'up');
  assert.equal(classifyHealth(301, null), 'up');
  assert.equal(classifyHealth(399, null), 'up');
});

test('classifyHealth: 401/403 は認証があるだけで up 扱い', () => {
  assert.equal(classifyHealth(401, null), 'up');
  assert.equal(classifyHealth(403, null), 'up');
});

test('classifyHealth: 404 は degraded', () => {
  assert.equal(classifyHealth(404, null), 'degraded');
});

test('classifyHealth: 502/503/504 は down（upstream 不応答）', () => {
  assert.equal(classifyHealth(502, null), 'down');
  assert.equal(classifyHealth(503, null), 'down');
  assert.equal(classifyHealth(504, null), 'down');
});

test('classifyHealth: 500/501/505 等その他 5xx は degraded（down ではない）', () => {
  assert.equal(classifyHealth(500, null), 'degraded');
  assert.equal(classifyHealth(501, null), 'degraded');
  assert.equal(classifyHealth(505, null), 'degraded');
});

test('classifyHealth: 400 系（404 以外）は degraded', () => {
  assert.equal(classifyHealth(400, null), 'degraded');
  assert.equal(classifyHealth(429, null), 'degraded');
});

test('isSitesHealthEnabled: 既定 ON、"0" のときのみ無効', () => {
  assert.equal(isSitesHealthEnabled(undefined), true);
  assert.equal(isSitesHealthEnabled('1'), true);
  assert.equal(isSitesHealthEnabled(''), true);
  assert.equal(isSitesHealthEnabled('0'), false);
});
