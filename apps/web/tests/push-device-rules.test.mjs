// FCM プッシュ通知の端末一覧（apps/web/src/lib/push-device-rules.ts）の単体テスト。
// 外部 import ゼロの純粋関数をコンパイル済み dist-test から直接 import する（clearance-rules.test.mjs と同じ流儀）。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveHealthBadge,
  derivePushDeviceStatus,
  formatRelativeTime,
  sortDevices,
} from '../dist-test/lib/push-device-rules.js';

const NOW = '2026-10-23T00:00:00.000Z';

function device(overrides = {}) {
  return {
    tokenPrefix: 'abcdefghijkl…(152)',
    platform: 'ios',
    registeredAt: '2026-10-01T00:00:00.000Z',
    lastRegisteredAt: '2026-10-01T00:00:00.000Z',
    lastSuccessAt: null,
    lastFailureAt: null,
    lastErrorCode: null,
    consecutiveFailures: 0,
    deviceLabel: null,
    ...overrides,
  };
}

describe('deriveHealthBadge', () => {
  test('noDevice は error', () => {
    assert.equal(deriveHealthBadge('noDevice').tone, 'error');
  });
  test('neverSucceeded は error', () => {
    assert.equal(deriveHealthBadge('neverSucceeded').tone, 'error');
  });
  test('failing は error', () => {
    assert.equal(deriveHealthBadge('failing').tone, 'error');
  });
  test('stale は warn', () => {
    assert.equal(deriveHealthBadge('stale').tone, 'warn');
  });
  test('healthy は ok', () => {
    assert.equal(deriveHealthBadge('healthy').tone, 'ok');
  });
  test('各ステータスに空でないラベルが付く', () => {
    for (const status of ['noDevice', 'neverSucceeded', 'failing', 'stale', 'healthy']) {
      assert.ok(deriveHealthBadge(status).label.length > 0);
    }
  });
});

describe('derivePushDeviceStatus', () => {
  test('一度も成功していない端末は error', () => {
    assert.equal(derivePushDeviceStatus(device()), 'error');
  });
  test('成功歴があり連続失敗が無ければ ok', () => {
    assert.equal(derivePushDeviceStatus(device({ lastSuccessAt: NOW })), 'ok');
  });
  test('成功歴があっても連続失敗があれば warn', () => {
    assert.equal(derivePushDeviceStatus(device({ lastSuccessAt: NOW, consecutiveFailures: 2 })), 'warn');
  });
});

describe('formatRelativeTime', () => {
  test('null は null を返す', () => {
    assert.equal(formatRelativeTime(null, NOW), null);
  });
  test('1分未満は「たった今」', () => {
    assert.equal(formatRelativeTime('2026-10-22T23:59:30.000Z', NOW), 'たった今');
  });
  test('分単位（1時間未満）', () => {
    assert.equal(formatRelativeTime('2026-10-22T23:55:00.000Z', NOW), '5分前');
  });
  test('時間単位（1日未満）', () => {
    assert.equal(formatRelativeTime('2026-10-22T21:00:00.000Z', NOW), '3時間前');
  });
  test('日単位', () => {
    assert.equal(formatRelativeTime('2026-10-20T00:00:00.000Z', NOW), '3日前');
  });
  test('未来時刻は「たった今」に丸める（クロックスキュー対策）', () => {
    assert.equal(formatRelativeTime('2026-10-23T01:00:00.000Z', NOW), 'たった今');
  });
  test('不正な値は null', () => {
    assert.equal(formatRelativeTime('not-a-date', NOW), null);
  });
});

describe('sortDevices', () => {
  test('lastSuccessAt の新しい順に並ぶ', () => {
    const a = device({ tokenPrefix: 'a', lastSuccessAt: '2026-10-20T00:00:00.000Z' });
    const b = device({ tokenPrefix: 'b', lastSuccessAt: '2026-10-22T00:00:00.000Z' });
    const sorted = sortDevices([a, b]);
    assert.equal(sorted[0].tokenPrefix, 'b');
    assert.equal(sorted[1].tokenPrefix, 'a');
  });
  test('lastSuccessAt が無い端末は lastRegisteredAt で比較され、成功歴がある端末より後ろになる', () => {
    const noSuccess = device({ tokenPrefix: 'a', lastRegisteredAt: '2026-10-22T00:00:00.000Z' });
    const withSuccess = device({ tokenPrefix: 'b', lastSuccessAt: '2026-10-01T00:00:00.000Z', lastRegisteredAt: '2026-10-01T00:00:00.000Z' });
    const sorted = sortDevices([noSuccess, withSuccess]);
    assert.equal(sorted[0].tokenPrefix, 'a'); // lastRegisteredAt 2026-10-22 > lastSuccessAt 2026-10-01
  });
  test('元の配列を破壊しない', () => {
    const list = [device({ tokenPrefix: 'a' }), device({ tokenPrefix: 'b' })];
    const copy = [...list];
    sortDevices(list);
    assert.deepEqual(list, copy);
  });
});
