// #337: 進捗タイムアウト（5分無出力タイムアウトの誤検知対策）の判定ロジックの単体テスト。
// 外部 import ゼロの純粋関数（apps/server/src/services/progress-timeout.ts）を
// コンパイル済み dist から直接 import する（human-text-fence.test.mjs と同じ流儀）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideProgressTimeoutAction } from '../dist/services/progress-timeout.js';

const HARD_TIMEOUT_MS = 60 * 60 * 1000; // 60分

test('decideProgressTimeoutAction: マシンが online なら extend（agentAlive）', () => {
  const result = decideProgressTimeoutAction({
    elapsedSinceStartMs: 5 * 60 * 1000,
    hardTimeoutMs: HARD_TIMEOUT_MS,
    machineStatus: 'online',
  });
  assert.equal(result.action, 'extend');
  assert.equal(result.reason, 'agentAlive');
});

test('decideProgressTimeoutAction: マシンが offline なら finalize（machineOffline）', () => {
  const result = decideProgressTimeoutAction({
    elapsedSinceStartMs: 5 * 60 * 1000,
    hardTimeoutMs: HARD_TIMEOUT_MS,
    machineStatus: 'offline',
  });
  assert.equal(result.action, 'finalize');
  assert.equal(result.reason, 'machineOffline');
});

test('decideProgressTimeoutAction: マシンの状態が不明（null）なら finalize（machineUnknown、fail-safe）', () => {
  const result = decideProgressTimeoutAction({
    elapsedSinceStartMs: 5 * 60 * 1000,
    hardTimeoutMs: HARD_TIMEOUT_MS,
    machineStatus: null,
  });
  assert.equal(result.action, 'finalize');
  assert.equal(result.reason, 'machineUnknown');
});

test('decideProgressTimeoutAction: ハードタイムアウト超過は online でも finalize（hardTimeout、暴走の安全網）', () => {
  const result = decideProgressTimeoutAction({
    elapsedSinceStartMs: HARD_TIMEOUT_MS + 1,
    hardTimeoutMs: HARD_TIMEOUT_MS,
    machineStatus: 'online',
  });
  assert.equal(result.action, 'finalize');
  assert.equal(result.reason, 'hardTimeout');
});

test('decideProgressTimeoutAction: 境界値（ちょうど hardTimeoutMs）は finalize（>= 判定）', () => {
  const result = decideProgressTimeoutAction({
    elapsedSinceStartMs: HARD_TIMEOUT_MS,
    hardTimeoutMs: HARD_TIMEOUT_MS,
    machineStatus: 'online',
  });
  assert.equal(result.action, 'finalize');
  assert.equal(result.reason, 'hardTimeout');
});

test('decideProgressTimeoutAction: 境界値未満（hardTimeoutMs - 1）は online なら extend', () => {
  const result = decideProgressTimeoutAction({
    elapsedSinceStartMs: HARD_TIMEOUT_MS - 1,
    hardTimeoutMs: HARD_TIMEOUT_MS,
    machineStatus: 'online',
  });
  assert.equal(result.action, 'extend');
  assert.equal(result.reason, 'agentAlive');
});
