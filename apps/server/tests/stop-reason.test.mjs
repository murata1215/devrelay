// #377: SDK maxTurns 打ち切りの可視化（stop-reason.ts）の単体テスト。
// 外部 import ゼロの純粋関数（apps/server/src/services/stop-reason.ts）を
// コンパイル済み dist から直接 import する（cross-query-guard.test.mjs と同じ流儀）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STOP_REASON_SUCCESS,
  normalizeStopReason,
  isStopReasonTruncated,
  applyStopReasonMark,
} from '../dist/services/stop-reason.js';

// ---- normalizeStopReason ----

test('normalizeStopReason: undefined は success に正規化される（旧 Agent 互換）', () => {
  assert.equal(normalizeStopReason(undefined), STOP_REASON_SUCCESS);
});

test('normalizeStopReason: 空文字は success に正規化される', () => {
  assert.equal(normalizeStopReason(''), STOP_REASON_SUCCESS);
});

test('normalizeStopReason: 実値はそのまま通す', () => {
  assert.equal(normalizeStopReason('max_turns'), 'max_turns');
  assert.equal(normalizeStopReason('error'), 'error');
  assert.equal(normalizeStopReason('aborted'), 'aborted');
  assert.equal(normalizeStopReason('success'), 'success');
});

// ---- isStopReasonTruncated ----

test('isStopReasonTruncated: success は false', () => {
  assert.equal(isStopReasonTruncated('success'), false);
});

test('isStopReasonTruncated: success 以外は true', () => {
  assert.equal(isStopReasonTruncated('max_turns'), true);
  assert.equal(isStopReasonTruncated('error'), true);
  assert.equal(isStopReasonTruncated('aborted'), true);
  assert.equal(isStopReasonTruncated('some_future_value'), true);
});

// ---- applyStopReasonMark ----

test('applyStopReasonMark: mark が空文字ならテキストをそのまま返す（success 時にマークが付かない）', () => {
  assert.equal(applyStopReasonMark('Build completed', ''), 'Build completed');
});

test('applyStopReasonMark: mark ありなら先頭に付与する', () => {
  assert.equal(
    applyStopReasonMark('Build completed', '⚠️ 途中終了（max_turns）: '),
    '⚠️ 途中終了（max_turns）: Build completed'
  );
});

test('applyStopReasonMark: text が空文字でも mark だけを返す', () => {
  assert.equal(applyStopReasonMark('', '⚠️ mark: '), '⚠️ mark: ');
});
