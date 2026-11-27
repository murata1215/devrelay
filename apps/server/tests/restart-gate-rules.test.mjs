// 再起動耐性サイクル（2026-11-25）: apps/server/src/services/restart-gate-rules.ts の単体テスト。
// 外部 import ゼロの純粋関数をコンパイル済み dist から直接 import する
// （update-busy-rules.test.mjs と同じ流儀）。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isRestartGateEnabled } from '../dist/services/restart-gate-rules.js';

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
