// 会話履歴レール（右レール第3タブ）: apps/server/src/services/thread-activity.ts の単体テスト。
// 外部 import ゼロの純関数をコンパイル済み dist から直接 import する
// （thread-list-filter.test.mjs / in-flight-turns.test.mjs と同じ流儀）。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isConversationRailEnabled, resolveRunning, RUNNING_DISPLAY_TTL_MS } from '../dist/services/thread-activity.js';

describe('isConversationRailEnabled', () => {
  test('未設定（undefined）は有効', () => {
    assert.equal(isConversationRailEnabled(undefined), true);
  });

  test("'0' は無効", () => {
    assert.equal(isConversationRailEnabled('0'), false);
  });

  test("'1' は有効", () => {
    assert.equal(isConversationRailEnabled('1'), true);
  });

  test("未知の値（'x' 等）は有効（'0' のときだけ無効という既存キルスイッチと同じ流儀）", () => {
    assert.equal(isConversationRailEnabled('x'), true);
  });
});

describe('resolveRunning', () => {
  test('enabled=false のときは常に undefined（他の引数に関わらず）', () => {
    assert.equal(resolveRunning({
      enabled: false,
      progressTracked: true,
      inFlightStartedAtMs: 0,
      nowMs: 1000,
    }), undefined);
  });

  test('progressTracked=true なら true（inFlightStartedAtMs が無くても）', () => {
    assert.equal(resolveRunning({
      enabled: true,
      progressTracked: true,
      inFlightStartedAtMs: undefined,
      nowMs: 1000,
    }), true);
  });

  test('inFlightStartedAtMs が直近（TTL 内）なら true', () => {
    assert.equal(resolveRunning({
      enabled: true,
      progressTracked: false,
      inFlightStartedAtMs: 1000,
      nowMs: 1000 + RUNNING_DISPLAY_TTL_MS - 1,
    }), true);
  });

  test('inFlightStartedAtMs が TTL ちょうどで超過扱い（false）', () => {
    assert.equal(resolveRunning({
      enabled: true,
      progressTracked: false,
      inFlightStartedAtMs: 1000,
      nowMs: 1000 + RUNNING_DISPLAY_TTL_MS,
    }), false);
  });

  test('inFlightStartedAtMs が TTL を大きく超過していれば false（6h 台帳の残骸で永久スピナーにならないことの固定）', () => {
    const sixHoursMs = 6 * 60 * 60 * 1000;
    assert.equal(resolveRunning({
      enabled: true,
      progressTracked: false,
      inFlightStartedAtMs: 0,
      nowMs: sixHoursMs - 1, // 台帳の TTL（6h）内ではあるが表示用 TTL（30分）は超過
    }), false);
  });

  test('progressTracked=false かつ inFlightStartedAtMs=undefined なら false', () => {
    assert.equal(resolveRunning({
      enabled: true,
      progressTracked: false,
      inFlightStartedAtMs: undefined,
      nowMs: 1000,
    }), false);
  });

  test('displayTtlMs を明示指定すると既定の RUNNING_DISPLAY_TTL_MS より優先される', () => {
    assert.equal(resolveRunning({
      enabled: true,
      progressTracked: false,
      inFlightStartedAtMs: 0,
      nowMs: 500,
      displayTtlMs: 1000,
    }), true); // 既定 TTL なら余裕だが、ここでは短い displayTtlMs=1000 が使われても 500 < 1000 なので true
  });

  test('displayTtlMs を明示指定した場合、その値で超過判定される', () => {
    assert.equal(resolveRunning({
      enabled: true,
      progressTracked: false,
      inFlightStartedAtMs: 0,
      nowMs: 1000,
      displayTtlMs: 1000,
    }), false); // ちょうど displayTtlMs で超過扱い
  });
});
