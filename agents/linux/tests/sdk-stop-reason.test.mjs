// #377: SDK maxTurns 打ち切りの可視化（sdk-stop-reason.ts）の単体テスト。
// 外部 import ゼロの純粋関数（agents/linux/src/services/sdk-stop-reason.ts）を
// コンパイル済み dist から直接 import する（sdk-loop-guard.test.mjs と同じ流儀）。
// agents/macos/tests/sdk-stop-reason.test.mjs と byte-for-byte 同一。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SDK_MAX_TURNS,
  resolveSdkMaxTurns,
  mapResultSubtypeToStopReason,
} from '../dist/services/sdk-stop-reason.js';

// ============================================================
// A. mapResultSubtypeToStopReason — 既知 subtype
// ============================================================

test('A1: subtype=success, is_error=false → success', () => {
  const r = mapResultSubtypeToStopReason('success', false);
  assert.equal(r.stopReason, 'success');
  assert.equal(r.unknownSubtype, false);
});

test('A2: subtype=success, is_error=true → error（success でも is_error が優先される）', () => {
  const r = mapResultSubtypeToStopReason('success', true);
  assert.equal(r.stopReason, 'error');
  assert.equal(r.unknownSubtype, false);
});

test('A3: subtype=error_max_turns → max_turns（is_error の値に関わらず）', () => {
  assert.equal(mapResultSubtypeToStopReason('error_max_turns', true).stopReason, 'max_turns');
  assert.equal(mapResultSubtypeToStopReason('error_max_turns', false).stopReason, 'max_turns');
});

test('A4: subtype=error_during_execution → error', () => {
  const r = mapResultSubtypeToStopReason('error_during_execution', true);
  assert.equal(r.stopReason, 'error');
  assert.equal(r.unknownSubtype, false);
});

test('A5: subtype=error_max_budget_usd → error', () => {
  const r = mapResultSubtypeToStopReason('error_max_budget_usd', true);
  assert.equal(r.stopReason, 'error');
  assert.equal(r.unknownSubtype, false);
});

test('A6: subtype=error_max_structured_output_retries → error', () => {
  const r = mapResultSubtypeToStopReason('error_max_structured_output_retries', true);
  assert.equal(r.stopReason, 'error');
  assert.equal(r.unknownSubtype, false);
});

// ============================================================
// B. mapResultSubtypeToStopReason — 未知 subtype / undefined（フェイルセーフ）
// ============================================================

test('B1: 未知の subtype 文字列は is_error に従いフェイルセーフ判定し unknownSubtype=true', () => {
  const r1 = mapResultSubtypeToStopReason('some_future_subtype', true);
  assert.equal(r1.stopReason, 'error');
  assert.equal(r1.unknownSubtype, true);

  const r2 = mapResultSubtypeToStopReason('some_future_subtype', false);
  assert.equal(r2.stopReason, 'success');
  assert.equal(r2.unknownSubtype, true);
});

test('B2: subtype=undefined は is_error に従いフェイルセーフ判定し unknownSubtype=true', () => {
  const r1 = mapResultSubtypeToStopReason(undefined, true);
  assert.equal(r1.stopReason, 'error');
  assert.equal(r1.unknownSubtype, true);

  const r2 = mapResultSubtypeToStopReason(undefined, false);
  assert.equal(r2.stopReason, 'success');
  assert.equal(r2.unknownSubtype, true);
});

// ============================================================
// C. resolveSdkMaxTurns
// ============================================================

test('C1: env 未指定時は既定値 400 を返す', () => {
  assert.equal(DEFAULT_SDK_MAX_TURNS, 400);
  assert.equal(resolveSdkMaxTurns({}), 400);
});

test('C2: DEVRELAY_SDK_MAX_TURNS で上書きできる', () => {
  assert.equal(resolveSdkMaxTurns({ DEVRELAY_SDK_MAX_TURNS: '200' }), 200);
  assert.equal(resolveSdkMaxTurns({ DEVRELAY_SDK_MAX_TURNS: '1000' }), 1000);
});

test('C3: 不正値（0・負数・非数値・空文字）は既定値にフォールバックする', () => {
  assert.equal(resolveSdkMaxTurns({ DEVRELAY_SDK_MAX_TURNS: '0' }), DEFAULT_SDK_MAX_TURNS);
  assert.equal(resolveSdkMaxTurns({ DEVRELAY_SDK_MAX_TURNS: '-5' }), DEFAULT_SDK_MAX_TURNS);
  assert.equal(resolveSdkMaxTurns({ DEVRELAY_SDK_MAX_TURNS: 'abc' }), DEFAULT_SDK_MAX_TURNS);
  assert.equal(resolveSdkMaxTurns({ DEVRELAY_SDK_MAX_TURNS: '' }), DEFAULT_SDK_MAX_TURNS);
});

test('C4: 小数値は切り捨てる', () => {
  assert.equal(resolveSdkMaxTurns({ DEVRELAY_SDK_MAX_TURNS: '150.7' }), 150);
});

// ============================================================
// D. 不変条件
// ============================================================

test('D1: mapResultSubtypeToStopReason / resolveSdkMaxTurns はいかなる入力でも例外を投げない', () => {
  assert.doesNotThrow(() => mapResultSubtypeToStopReason(undefined, undefined));
  assert.doesNotThrow(() => mapResultSubtypeToStopReason('', false));
  assert.doesNotThrow(() => resolveSdkMaxTurns({}));
  assert.doesNotThrow(() => resolveSdkMaxTurns({ DEVRELAY_SDK_MAX_TURNS: undefined }));
});
