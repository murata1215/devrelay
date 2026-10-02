// 2026-09-30: WebUI 停止ボタンの操作状態遷移（apps/web/src/lib/cancel-request-rules.ts）の
// 単体テスト。外部 import ゼロの純粋関数をコンパイル済み dist-test から直接 import する
// （thread-switch-rules.test.mjs と同じ流儀）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveCancelPhase,
  decideCancelClick,
  CANCEL_CONFIRM_WINDOW_MS,
  CANCEL_REQUEST_TIMEOUT_MS,
} from '../dist-test/lib/cancel-request-rules.js';

const SID = 'session-abc';
const T0 = 1_000_000;

test('定数の不変条件: CONFIRM_WINDOW < REQUEST_TIMEOUT かつ REQUEST_TIMEOUT は kill ラダー合計(30s)より大きい', () => {
  assert.ok(CANCEL_CONFIRM_WINDOW_MS < CANCEL_REQUEST_TIMEOUT_MS);
  assert.ok(CANCEL_REQUEST_TIMEOUT_MS > 30_000);
});

test('resolveCancelPhase: state が null なら idle', () => {
  assert.equal(resolveCancelPhase({ state: null, sessionId: SID, nowMs: T0 }), 'idle');
});

test('resolveCancelPhase: sessionId が state と不一致なら idle（スレッド切替で必ず解除）', () => {
  const state = { phase: 'requested', sessionId: 'other-session', atMs: T0 };
  assert.equal(resolveCancelPhase({ state, sessionId: SID, nowMs: T0 + 1000 }), 'idle');
});

test('resolveCancelPhase: armed は猶予内なら confirm', () => {
  const state = { phase: 'armed', sessionId: SID, atMs: T0 };
  assert.equal(resolveCancelPhase({ state, sessionId: SID, nowMs: T0 + CANCEL_CONFIRM_WINDOW_MS - 1 }), 'confirm');
});

test('resolveCancelPhase: armed は猶予超過で idle に自動解除される（誤クリック救済）', () => {
  const state = { phase: 'armed', sessionId: SID, atMs: T0 };
  assert.equal(resolveCancelPhase({ state, sessionId: SID, nowMs: T0 + CANCEL_CONFIRM_WINDOW_MS }), 'idle');
});

test('resolveCancelPhase: requested は猶予内なら requesting', () => {
  const state = { phase: 'requested', sessionId: SID, atMs: T0 };
  assert.equal(resolveCancelPhase({ state, sessionId: SID, nowMs: T0 + CANCEL_REQUEST_TIMEOUT_MS - 1 }), 'requesting');
});

test('resolveCancelPhase: requested は猶予超過で stalled（正直に「止まっていない」と伝える）', () => {
  const state = { phase: 'requested', sessionId: SID, atMs: T0 };
  assert.equal(resolveCancelPhase({ state, sessionId: SID, nowMs: T0 + CANCEL_REQUEST_TIMEOUT_MS }), 'stalled');
});

test('decideCancelClick: 未接続なら送らない', () => {
  const result = decideCancelClick({ state: null, sessionId: SID, nowMs: T0, connected: false });
  assert.equal(result.send, false);
  assert.equal(result.reason, 'disconnected');
});

test('decideCancelClick: sessionId が無ければ送らない', () => {
  const result = decideCancelClick({ state: null, sessionId: null, nowMs: T0, connected: true });
  assert.equal(result.send, false);
  assert.equal(result.reason, 'noSession');
});

test('decideCancelClick: idle での1回目クリックは送らず armed になる', () => {
  const result = decideCancelClick({ state: null, sessionId: SID, nowMs: T0, connected: true });
  assert.equal(result.send, false);
  assert.equal(result.reason, 'armed');
  assert.deepEqual(result.next, { phase: 'armed', sessionId: SID, atMs: T0 });
});

test('decideCancelClick: armed を猶予内に再クリックすると送信して requested になる', () => {
  const state = { phase: 'armed', sessionId: SID, atMs: T0 };
  const nowMs = T0 + 1000;
  const result = decideCancelClick({ state, sessionId: SID, nowMs, connected: true });
  assert.equal(result.send, true);
  assert.equal(result.reason, 'fire');
  assert.deepEqual(result.next, { phase: 'requested', sessionId: SID, atMs: nowMs });
});

test('decideCancelClick: armed が猶予超過後のクリックは再武装のみで送らない（誤操作防止の核）', () => {
  const state = { phase: 'armed', sessionId: SID, atMs: T0 };
  const nowMs = T0 + CANCEL_CONFIRM_WINDOW_MS + 1;
  const result = decideCancelClick({ state, sessionId: SID, nowMs, connected: true });
  assert.equal(result.send, false);
  assert.equal(result.reason, 'armed');
  assert.deepEqual(result.next, { phase: 'armed', sessionId: SID, atMs: nowMs });
});

test('decideCancelClick: requesting 中のクリックは送らない（二重送信防止）', () => {
  const state = { phase: 'requested', sessionId: SID, atMs: T0 };
  const nowMs = T0 + 1000;
  const result = decideCancelClick({ state, sessionId: SID, nowMs, connected: true });
  assert.equal(result.send, false);
  assert.equal(result.reason, 'alreadyRequested');
  assert.deepEqual(result.next, state);
});

test('decideCancelClick: stalled 後のクリックは再試行として送信する', () => {
  const state = { phase: 'requested', sessionId: SID, atMs: T0 };
  const nowMs = T0 + CANCEL_REQUEST_TIMEOUT_MS + 1;
  const result = decideCancelClick({ state, sessionId: SID, nowMs, connected: true });
  assert.equal(result.send, true);
  assert.equal(result.reason, 'retry');
  assert.deepEqual(result.next, { phase: 'requested', sessionId: SID, atMs: nowMs });
});

test('decideCancelClick: 別スレッドの state が残っていても現スレッドでは idle 扱いで武装から始まる', () => {
  const state = { phase: 'requested', sessionId: 'other-session', atMs: T0 };
  const nowMs = T0 + 1000;
  const result = decideCancelClick({ state, sessionId: SID, nowMs, connected: true });
  assert.equal(result.send, false);
  assert.equal(result.reason, 'armed');
  assert.deepEqual(result.next, { phase: 'armed', sessionId: SID, atMs: nowMs });
});
