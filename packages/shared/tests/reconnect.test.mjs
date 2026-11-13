// エージェント再接続根治サイクル（2026-11-14）: `reconnect.ts` の単体テスト。
//
// 自宅PC（fwjg2507-FMVD34003）が pong タイムアウト切断後、DNS エラーの再接続を約13回
// 繰り返した末に3日間沈黙した事故の根治で新設。`computeReconnectDelay()` は maxAttempts
// 撤廃（無期限リトライ）後も attempt が無限に増えても Infinity/NaN にならないことを保証する。

import test from 'node:test';
import assert from 'node:assert/strict';
import { computeReconnectDelay, CONNECT_TIMEOUT_MS, CONNECT_WATCHDOG_MS } from '../dist/reconnect.js';

const BASE = { baseDelay: 2000, maxDelay: 30000, jitterRange: 1000 };

test('attempt=1,2,3,4 は 2s/4s/8s/16s（jitter=0）', () => {
  assert.equal(computeReconnectDelay({ ...BASE, attempt: 1, random: 0 }), 2000);
  assert.equal(computeReconnectDelay({ ...BASE, attempt: 2, random: 0 }), 4000);
  assert.equal(computeReconnectDelay({ ...BASE, attempt: 3, random: 0 }), 8000);
  assert.equal(computeReconnectDelay({ ...BASE, attempt: 4, random: 0 }), 16000);
});

test('attempt=5 以降は maxDelay(30s) で clamp される', () => {
  assert.equal(computeReconnectDelay({ ...BASE, attempt: 5, random: 0 }), 30000);
  assert.equal(computeReconnectDelay({ ...BASE, attempt: 6, random: 0 }), 30000);
  assert.equal(computeReconnectDelay({ ...BASE, attempt: 100, random: 0 }), 30000);
});

test('jitter は [0, jitterRange) の範囲で加算される', () => {
  assert.equal(computeReconnectDelay({ ...BASE, attempt: 1, random: 0 }), 2000);
  assert.equal(computeReconnectDelay({ ...BASE, attempt: 1, random: 0.999 }), 2000 + 0.999 * 1000);
});

test('maxAttempts 撤廃後、attempt が非常に大きくても Infinity/NaN にならない（無期限リトライの安全性）', () => {
  const delay = computeReconnectDelay({ ...BASE, attempt: 1000, random: 0.5 });
  assert.ok(Number.isFinite(delay), `delay が有限でない: ${delay}`);
  assert.ok(delay <= BASE.maxDelay + BASE.jitterRange, `delay が maxDelay+jitter を超えている: ${delay}`);
  assert.ok(delay >= BASE.maxDelay, `delay が maxDelay 未満: ${delay}`);
});

test('attempt<=0 は exponent 0 として clamp される（baseDelay 相当）', () => {
  assert.equal(computeReconnectDelay({ ...BASE, attempt: 0, random: 0 }), 2000);
  assert.equal(computeReconnectDelay({ ...BASE, attempt: -5, random: 0 }), 2000);
});

test('CONNECT_WATCHDOG_MS は CONNECT_TIMEOUT_MS より後に発火する（handshakeTimeout が先に効くべき）', () => {
  assert.ok(
    CONNECT_WATCHDOG_MS > CONNECT_TIMEOUT_MS,
    `監視タイマーが handshakeTimeout より早いか同時に発火してしまう: watchdog=${CONNECT_WATCHDOG_MS}, timeout=${CONNECT_TIMEOUT_MS}`,
  );
});
