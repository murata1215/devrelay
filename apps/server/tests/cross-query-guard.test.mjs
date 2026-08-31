// 外部 import ゼロの純粋関数（apps/server/src/services/cross-query-guard.ts）を
// コンパイル済み dist から直接 import する（既存 approval-prompt.test.mjs と同じ流儀）。
// #348: クロスプロジェクト連携（ask-member / teamexec-member）の「入口の防御」

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeProjectPath,
  pickInflightCrossSession,
  decideCrossTarget,
  buildCrossTargetRejectionMessage,
  ASK_INFLIGHT_WINDOW_MS,
} from '../dist/services/cross-query-guard.js';

// ---- normalizeProjectPath ----

test('normalizeProjectPath: 末尾スラッシュを除去する', () => {
  assert.equal(normalizeProjectPath('/home/foo/bar/'), '/home/foo/bar');
});

test('normalizeProjectPath: ルート "/" 自身は除去しない', () => {
  assert.equal(normalizeProjectPath('/'), '/');
});

test('normalizeProjectPath: バックスラッシュを / に統一する', () => {
  assert.equal(normalizeProjectPath('C:\\Users\\foo\\bar'), 'c:/users/foo/bar');
});

test('normalizeProjectPath: Windows パスは大文字小文字を無視する（小文字化）', () => {
  assert.equal(normalizeProjectPath('C:/Users/Foo/Bar'), 'c:/users/foo/bar');
});

test('normalizeProjectPath: POSIX パスは大文字小文字を区別する（小文字化しない）', () => {
  assert.equal(normalizeProjectPath('/Home/Foo/Bar'), '/Home/Foo/Bar');
});

test('normalizeProjectPath: 前後の空白を除去する', () => {
  assert.equal(normalizeProjectPath('  /home/foo  '), '/home/foo');
});

test('normalizeProjectPath: null / undefined / 空文字は空文字を返す', () => {
  assert.equal(normalizeProjectPath(null), '');
  assert.equal(normalizeProjectPath(undefined), '');
  assert.equal(normalizeProjectPath(''), '');
  assert.equal(normalizeProjectPath('   '), '');
});

// ---- pickInflightCrossSession ----

test('pickInflightCrossSession: 窓内のセッションを返す', () => {
  const now = 1_000_000;
  const rows = [{ id: 'a', startedAt: new Date(now - 1000) }];
  const result = pickInflightCrossSession(rows, now, 60_000);
  assert.equal(result?.id, 'a');
});

test('pickInflightCrossSession: 窓外のセッションは除外する', () => {
  const now = 1_000_000;
  const rows = [{ id: 'a', startedAt: new Date(now - 120_000) }];
  const result = pickInflightCrossSession(rows, now, 60_000);
  assert.equal(result, null);
});

test('pickInflightCrossSession: mode ごとに異なる窓を渡せる（呼び出し側が windowMs を選ぶ）', () => {
  const now = 1_000_000;
  const rows = [{ id: 'a', startedAt: new Date(now - 20 * 60 * 1000) }];
  // ask 用の窓（15分）では窓外
  assert.equal(pickInflightCrossSession(rows, now, ASK_INFLIGHT_WINDOW_MS), null);
  // teamexec 用の窓（65分相当）では窓内
  const teamexecWindowMs = 65 * 60 * 1000;
  assert.equal(pickInflightCrossSession(rows, now, teamexecWindowMs)?.id, 'a');
});

test('pickInflightCrossSession: 複数件が窓内にある場合は最新（startedAt 最大）を返す', () => {
  const now = 1_000_000;
  const rows = [
    { id: 'old', startedAt: new Date(now - 5000) },
    { id: 'new', startedAt: new Date(now - 1000) },
    { id: 'mid', startedAt: new Date(now - 3000) },
  ];
  const result = pickInflightCrossSession(rows, now, 60_000);
  assert.equal(result?.id, 'new');
});

test('pickInflightCrossSession: 空配列は null を返す', () => {
  assert.equal(pickInflightCrossSession([], 1_000_000, 60_000), null);
});

// ---- decideCrossTarget ----

test('decideCrossTarget: 同一マシン・同一パス → 400 selfTarget', () => {
  const decision = decideCrossTarget({
    mode: 'ask',
    callerMachineId: 'm1',
    targetMachineId: 'm1',
    callerProjectPath: '/home/foo/pixblog',
    targetProjectPath: '/home/foo/pixblog/',
    inflightSessionId: null,
  });
  assert.deepEqual(decision, { allowed: false, status: 400, reason: 'selfTarget' });
});

test('decideCrossTarget: 同一マシン・別パス → allow + verifiedDifferent', () => {
  const decision = decideCrossTarget({
    mode: 'ask',
    callerMachineId: 'm1',
    targetMachineId: 'm1',
    callerProjectPath: '/home/foo/pixblog',
    targetProjectPath: '/home/foo/pixdraft',
    inflightSessionId: null,
  });
  assert.deepEqual(decision, { allowed: true, selfCheck: 'verifiedDifferent' });
});

test('decideCrossTarget: callerProjectPath 未指定（旧 Agent） → allow + unverified（fail-open）', () => {
  const decision = decideCrossTarget({
    mode: 'ask',
    callerMachineId: 'm1',
    targetMachineId: 'm1',
    callerProjectPath: null,
    targetProjectPath: '/home/foo/pixblog',
    inflightSessionId: null,
  });
  assert.deepEqual(decision, { allowed: true, selfCheck: 'unverified' });
});

test('decideCrossTarget: 別マシン → allow + verifiedDifferent（callerProjectPath 未指定でも確定）', () => {
  const decision = decideCrossTarget({
    mode: 'ask',
    callerMachineId: 'm1',
    targetMachineId: 'm2',
    callerProjectPath: null,
    targetProjectPath: '/home/foo/pixblog',
    inflightSessionId: null,
  });
  assert.deepEqual(decision, { allowed: true, selfCheck: 'verifiedDifferent' });
});

test('decideCrossTarget: inflightSessionId あり → 429 targetBusy', () => {
  const decision = decideCrossTarget({
    mode: 'ask',
    callerMachineId: 'm1',
    targetMachineId: 'm2',
    callerProjectPath: null,
    targetProjectPath: '/home/foo/pixblog',
    inflightSessionId: 'crossquery_abc',
  });
  assert.deepEqual(decision, { allowed: false, status: 429, reason: 'targetBusy', inflightSessionId: 'crossquery_abc' });
});

test('decideCrossTarget: 400 と 429 が同時に成立するとき 400 が勝つ（判定順の固定）', () => {
  const decision = decideCrossTarget({
    mode: 'ask',
    callerMachineId: 'm1',
    targetMachineId: 'm1',
    callerProjectPath: '/home/foo/pixblog',
    targetProjectPath: '/home/foo/pixblog',
    inflightSessionId: 'crossquery_xyz',
  });
  assert.deepEqual(decision, { allowed: false, status: 400, reason: 'selfTarget' });
});

test('decideCrossTarget: teamexec でも同じ判定ロジックが働く（selfTarget）', () => {
  const decision = decideCrossTarget({
    mode: 'teamexec',
    callerMachineId: 'm1',
    targetMachineId: 'm1',
    callerProjectPath: '/home/foo/pixblog',
    targetProjectPath: '/home/foo/pixblog',
    inflightSessionId: null,
  });
  assert.deepEqual(decision, { allowed: false, status: 400, reason: 'selfTarget' });
});

test('decideCrossTarget: teamexec でも同じ判定ロジックが働く（targetBusy）', () => {
  const decision = decideCrossTarget({
    mode: 'teamexec',
    callerMachineId: 'm1',
    targetMachineId: 'm2',
    callerProjectPath: null,
    targetProjectPath: '/home/foo/pixblog',
    inflightSessionId: 'teamexec_abc',
  });
  assert.deepEqual(decision, { allowed: false, status: 429, reason: 'targetBusy', inflightSessionId: 'teamexec_abc' });
});

// ---- buildCrossTargetRejectionMessage ----

test('buildCrossTargetRejectionMessage: selfTarget は noRetryNote と宛先名を含む', () => {
  const decision = { allowed: false, status: 400, reason: 'selfTarget' };
  const msg = buildCrossTargetRejectionMessage(decision, {
    mode: 'ask',
    targetProjectName: 'pixblog',
    noRetryNote: '__NO_RETRY__',
  });
  assert.match(msg, /pixblog/);
  assert.match(msg, /__NO_RETRY__/);
});

test('buildCrossTargetRejectionMessage: targetBusy は noRetryNote と宛先名を含む', () => {
  const decision = { allowed: false, status: 429, reason: 'targetBusy', inflightSessionId: 'crossquery_abc' };
  const msg = buildCrossTargetRejectionMessage(decision, {
    mode: 'teamexec',
    targetProjectName: 'pixdraft',
    noRetryNote: '__NO_RETRY__',
  });
  assert.match(msg, /pixdraft/);
  assert.match(msg, /__NO_RETRY__/);
});

test('buildCrossTargetRejectionMessage: allowed=true を渡すと例外を投げる', () => {
  assert.throws(() => {
    buildCrossTargetRejectionMessage({ allowed: true, selfCheck: 'unverified' }, {
      mode: 'ask',
      targetProjectName: 'pixblog',
      noRetryNote: '__NO_RETRY__',
    });
  });
});
