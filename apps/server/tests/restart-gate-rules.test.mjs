// 再起動耐性サイクル（2026-11-25）: apps/server/src/services/restart-gate-rules.ts の単体テスト。
// 外部 import ゼロの純粋関数をコンパイル済み dist から直接 import する
// （update-busy-rules.test.mjs と同じ流儀）。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isRestartGateEnabled, resolveRestartIdleCooldownMs } from '../dist/services/restart-gate-rules.js';

describe('isRestartGateEnabled', () => {
  test('未設定（undefined）は有効（既定 ON）', () => {
    assert.equal(isRestartGateEnabled(undefined), true);
  });
  test(`'1' は有効`, () => {
    assert.equal(isRestartGateEnabled('1'), true);
  });
  test(`'0' のときだけ無効`, () => {
    assert.equal(isRestartGateEnabled('0'), false);
  });
  test('その他の文字列は有効扱い（"0" 以外は fail-safe で ON）', () => {
    assert.equal(isRestartGateEnabled('nope'), true);
  });
});

// 追補（2026-11-28）: 冷却期間の実機既定値は 10000ms（ユーザー指定「10秒で」）。
describe('resolveRestartIdleCooldownMs', () => {
  test('未設定（undefined）は既定 10000ms', () => {
    assert.equal(resolveRestartIdleCooldownMs(undefined), 10_000);
  });
  test('数値文字列はそのまま使う', () => {
    assert.equal(resolveRestartIdleCooldownMs('5000'), 5_000);
  });
  test(`'0' は 0（この段の判定自体を行わない）`, () => {
    assert.equal(resolveRestartIdleCooldownMs('0'), 0);
  });
  test('負の値は 0 に clamp される', () => {
    assert.equal(resolveRestartIdleCooldownMs('-100'), 0);
  });
  test('上限（600000ms）を超える値は 600000 に clamp される', () => {
    assert.equal(resolveRestartIdleCooldownMs('99999999'), 600_000);
  });
  test('数値でない文字列は既定値にフォールバック', () => {
    assert.equal(resolveRestartIdleCooldownMs('abc'), 10_000);
  });
});
