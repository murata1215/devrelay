// 外部 import ゼロの純粋関数（apps/server/src/services/auto-update-reconcile.ts）を
// コンパイル済み dist から直接 import する（agent-update-decision.test.mjs と同じ流儀）。
// #351: 一度 timeout に落ちた lastAutoUpdateStatus が二度と自己回復しない問題の回帰テスト
// （DESKTOP-1JR1NLL/c-shiraki, 2026-09-01 で実際に発生: 成功の証拠が揃っているのに
// lastAutoUpdateStatus が timeout:... のまま残り、autoUpdateAttempts もリセットされなかった）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideReconcileOutcome } from '../dist/services/auto-update-reconcile.js';

const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.parse('2026-09-01T20:36:00Z');
const PENDING_TIMEOUT_MS = 2 * HOUR_MS;

const base = {
  localCommit: 'ae1fbba1234567890',
  lastAttemptCommit: null,
  status: null,
  runningCodeStale: undefined,
  lastAttemptAt: null,
  nowMs: NOW,
  pendingTimeoutMs: PENDING_TIMEOUT_MS,
};

test('lastAttemptCommit が null なら none（判定材料なし）', () => {
  const outcome = decideReconcileOutcome({ ...base, lastAttemptCommit: null });
  assert.deepEqual(outcome, { action: 'none' });
});

test('commit 一致 + stale=false + status=pending → success', () => {
  const outcome = decideReconcileOutcome({
    ...base,
    lastAttemptCommit: base.localCommit,
    status: 'pending',
    runningCodeStale: false,
  });
  assert.deepEqual(outcome, { action: 'success' });
});

test('【回帰テスト】commit 一致 + stale=false + status=timeout:... → success（#351 本題）', () => {
  const outcome = decideReconcileOutcome({
    ...base,
    lastAttemptCommit: base.localCommit,
    status: 'timeout:running code is stale (rebuild did not take effect)',
    runningCodeStale: false,
  });
  assert.deepEqual(outcome, { action: 'success' });
});

test('commit 一致 + stale=undefined（旧 Agent）+ status=pending → success:unverified', () => {
  const outcome = decideReconcileOutcome({
    ...base,
    lastAttemptCommit: base.localCommit,
    status: 'pending',
    runningCodeStale: undefined,
  });
  assert.deepEqual(outcome, { action: 'success:unverified' });
});

test('commit 一致 + stale=undefined（旧 Agent）+ status=timeout:... → none（fail-safe、根拠なく success に書き換えない）', () => {
  const outcome = decideReconcileOutcome({
    ...base,
    lastAttemptCommit: base.localCommit,
    status: 'timeout:commit unchanged',
    runningCodeStale: undefined,
  });
  assert.deepEqual(outcome, { action: 'none' });
});

test('commit 一致 + stale=true + status=pending + 2h 未満 → none（まだ様子見）', () => {
  const outcome = decideReconcileOutcome({
    ...base,
    lastAttemptCommit: base.localCommit,
    status: 'pending',
    runningCodeStale: true,
    lastAttemptAt: new Date(NOW - 30 * 60 * 1000), // 30分前
  });
  assert.deepEqual(outcome, { action: 'none' });
});

test('commit 一致 + stale=true + status=pending + 2h 超過 → timeout', () => {
  const outcome = decideReconcileOutcome({
    ...base,
    lastAttemptCommit: base.localCommit,
    status: 'pending',
    runningCodeStale: true,
    lastAttemptAt: new Date(NOW - 3 * HOUR_MS), // 3時間前
  });
  assert.deepEqual(outcome, {
    action: 'timeout',
    detail: 'running code is stale (rebuild did not take effect)',
  });
});

test('status が pending 以外 + stale=true → none（既に決着済み、timeout を二重に記録しない）', () => {
  const outcome = decideReconcileOutcome({
    ...base,
    lastAttemptCommit: base.localCommit,
    status: 'failed:stale-dist',
    runningCodeStale: true,
    lastAttemptAt: new Date(NOW - 3 * HOUR_MS),
  });
  assert.deepEqual(outcome, { action: 'none' });
});

test('commit 不一致 + stale=false + status=pending + 2h 超過 → timeout（commit unchanged 扱い）', () => {
  const outcome = decideReconcileOutcome({
    ...base,
    lastAttemptCommit: 'differentcommit0000',
    status: 'pending',
    runningCodeStale: false,
    lastAttemptAt: new Date(NOW - 3 * HOUR_MS),
  });
  assert.deepEqual(outcome, { action: 'timeout', detail: 'commit unchanged' });
});
