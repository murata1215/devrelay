// 再起動耐性サイクル（2026-11-25）: apps/server/src/services/restart-notice.ts の単体テスト。
// pure な env 解釈部分のみを検証する（broadcastRestartingNotice() 自体は WebSocket I/O を
// 持つため、ここでは呼ばない。auto-updater.test.mjs 同様、他モジュールを import するだけで
// DB 接続等の副作用は起きない前提は既存テストで確認済み）。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRestartNoticeWaitMs, isRestartNoticeEnabled } from '../dist/services/restart-notice.js';

describe('resolveRestartNoticeWaitMs', () => {
  test('未設定（undefined）は既定 800ms', () => {
    assert.equal(resolveRestartNoticeWaitMs(undefined), 800);
  });
  test('数値文字列はそのまま使う（範囲内）', () => {
    assert.equal(resolveRestartNoticeWaitMs('2000'), 2000);
  });
  test('NaN になる文字列は既定値にフォールバック', () => {
    assert.equal(resolveRestartNoticeWaitMs('abc'), 800);
  });
  test('下限（0）未満は 0 に clamp', () => {
    assert.equal(resolveRestartNoticeWaitMs('-100'), 0);
  });
  test('上限（5000）超過は 5000 に clamp', () => {
    assert.equal(resolveRestartNoticeWaitMs('99999'), 5000);
  });
});

describe('isRestartNoticeEnabled', () => {
  test('未設定（undefined）は有効（既定 ON）', () => {
    assert.equal(isRestartNoticeEnabled(undefined), true);
  });
  test(`'0' のときだけ無効`, () => {
    assert.equal(isRestartNoticeEnabled('0'), false);
  });
  test('その他の文字列は有効扱い', () => {
    assert.equal(isRestartNoticeEnabled('yes'), true);
  });
});
