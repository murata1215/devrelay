// 今サイクル: Devin 等の子プロセス停止（process-tree-kill.ts）の単体テスト。
// 外部 import ゼロの純粋関数（agents/linux/src/services/process-tree-kill.ts）を
// コンパイル済み dist から直接 import する（running-code-stale.test.mjs と同じ流儀）。
// agents/macos/tests/process-tree-kill.test.mjs / agents/windows/tests/process-tree-kill.test.mjs
// と byte-for-byte 同一。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildKillPlan,
  resolveKillTimings,
  shouldEmitHeartbeat,
  DEFAULT_EXIT_FLUSH_GRACE_MS,
  DEFAULT_SYNTHETIC_CLOSE_GRACE_MS,
  DEFAULT_KILL_FORCE_DELAY_MS,
  DEFAULT_KILL_GIVEUP_DELAY_MS,
} from '../dist/services/process-tree-kill.js';

// ---- buildKillPlan ----

test('buildKillPlan: posix (linux) term → command:null, SIGTERM', () => {
  const plan = buildKillPlan({ platform: 'linux', pid: 1234, stage: 'term' });
  assert.equal(plan.command, null);
  assert.equal(plan.fallbackSignal, 'SIGTERM');
});

test('buildKillPlan: posix (linux) force → command:null, SIGKILL', () => {
  const plan = buildKillPlan({ platform: 'linux', pid: 1234, stage: 'force' });
  assert.equal(plan.command, null);
  assert.equal(plan.fallbackSignal, 'SIGKILL');
});

test('buildKillPlan: darwin は posix 扱い（command:null）', () => {
  const plan = buildKillPlan({ platform: 'darwin', pid: 1234, stage: 'term' });
  assert.equal(plan.command, null);
});

test('buildKillPlan: 未知の platform は posix 扱い（fail-open、taskkill を組み立てない）', () => {
  const plan = buildKillPlan({ platform: 'aix', pid: 1234, stage: 'term' });
  assert.equal(plan.command, null);
});

test('buildKillPlan: win32 term/pid 1234 → taskkill /PID 1234 /T（/F なし）', () => {
  const plan = buildKillPlan({ platform: 'win32', pid: 1234, stage: 'term' });
  assert.deepEqual(plan.command, { file: 'taskkill', args: ['/PID', '1234', '/T'] });
  assert.equal(plan.fallbackSignal, 'SIGTERM');
});

test('buildKillPlan: win32 force/pid 1234 → taskkill /PID 1234 /T /F', () => {
  const plan = buildKillPlan({ platform: 'win32', pid: 1234, stage: 'force' });
  assert.deepEqual(plan.command, { file: 'taskkill', args: ['/PID', '1234', '/T', '/F'] });
  assert.equal(plan.fallbackSignal, 'SIGKILL');
});

test('buildKillPlan: 順序不変条件（H2）— win32 で有効 pid なら term/force とも command は非null', () => {
  const term = buildKillPlan({ platform: 'win32', pid: 5678, stage: 'term' });
  const force = buildKillPlan({ platform: 'win32', pid: 5678, stage: 'force' });
  assert.notEqual(term.command, null);
  assert.notEqual(force.command, null);
});

test('buildKillPlan: win32 + pid:null → command:null（fail-open）', () => {
  const plan = buildKillPlan({ platform: 'win32', pid: null, stage: 'term' });
  assert.equal(plan.command, null);
});

test('buildKillPlan: win32 + pid:undefined → command:null（fail-open）', () => {
  const plan = buildKillPlan({ platform: 'win32', pid: undefined, stage: 'term' });
  assert.equal(plan.command, null);
});

test('buildKillPlan: win32 + pid:0 → command:null（fail-open）', () => {
  const plan = buildKillPlan({ platform: 'win32', pid: 0, stage: 'term' });
  assert.equal(plan.command, null);
});

test('buildKillPlan: win32 + pid:-1 → command:null（fail-open）', () => {
  const plan = buildKillPlan({ platform: 'win32', pid: -1, stage: 'term' });
  assert.equal(plan.command, null);
});

test('buildKillPlan: win32 + pid:1.5（非整数） → command:null（fail-open）', () => {
  const plan = buildKillPlan({ platform: 'win32', pid: 1.5, stage: 'term' });
  assert.equal(plan.command, null);
});

test('buildKillPlan: win32 + pid:NaN → command:null（fail-open）', () => {
  const plan = buildKillPlan({ platform: 'win32', pid: NaN, stage: 'term' });
  assert.equal(plan.command, null);
});

test('buildKillPlan: 大きい pid はロケール区切りなしで文字列化される + 呼び出し毎に別配列インスタンス', () => {
  const a = buildKillPlan({ platform: 'win32', pid: 1234567, stage: 'term' });
  const b = buildKillPlan({ platform: 'win32', pid: 1234567, stage: 'term' });
  assert.deepEqual(a.command.args, ['/PID', '1234567', '/T']);
  assert.notEqual(a.command.args, b.command.args);
});

// ---- resolveKillTimings ----

test('resolveKillTimings: env が空 → 全て既定値', () => {
  const t = resolveKillTimings({});
  assert.deepEqual(t, {
    exitFlushGraceMs: DEFAULT_EXIT_FLUSH_GRACE_MS,
    syntheticCloseGraceMs: DEFAULT_SYNTHETIC_CLOSE_GRACE_MS,
    forceDelayMs: DEFAULT_KILL_FORCE_DELAY_MS,
    giveUpDelayMs: DEFAULT_KILL_GIVEUP_DELAY_MS,
  });
});

test('resolveKillTimings: 4つとも有効な値で上書きされる', () => {
  const t = resolveKillTimings({
    DEVRELAY_EXIT_FLUSH_GRACE_MS: '1000',
    DEVRELAY_SYNTHETIC_CLOSE_GRACE_MS: '2000',
    DEVRELAY_KILL_FORCE_DELAY_MS: '3000',
    DEVRELAY_KILL_GIVEUP_DELAY_MS: '4000',
  });
  assert.deepEqual(t, {
    exitFlushGraceMs: 1000,
    syntheticCloseGraceMs: 2000,
    forceDelayMs: 3000,
    giveUpDelayMs: 4000,
  });
});

test('resolveKillTimings: 非数値文字列は既定値へフォールバック', () => {
  const t = resolveKillTimings({ DEVRELAY_EXIT_FLUSH_GRACE_MS: 'abc' });
  assert.equal(t.exitFlushGraceMs, DEFAULT_EXIT_FLUSH_GRACE_MS);
});

test('resolveKillTimings: 空文字は既定値へフォールバック', () => {
  const t = resolveKillTimings({ DEVRELAY_EXIT_FLUSH_GRACE_MS: '' });
  assert.equal(t.exitFlushGraceMs, DEFAULT_EXIT_FLUSH_GRACE_MS);
});

test('resolveKillTimings: "0" は既定値へフォールバック（0 だと即座エスカレーションになるため）', () => {
  const t = resolveKillTimings({ DEVRELAY_KILL_FORCE_DELAY_MS: '0' });
  assert.equal(t.forceDelayMs, DEFAULT_KILL_FORCE_DELAY_MS);
});

test('resolveKillTimings: 負の値は既定値へフォールバック', () => {
  const t = resolveKillTimings({ DEVRELAY_KILL_GIVEUP_DELAY_MS: '-5000' });
  assert.equal(t.giveUpDelayMs, DEFAULT_KILL_GIVEUP_DELAY_MS);
});

test('resolveKillTimings: Infinity は既定値へフォールバック', () => {
  const t = resolveKillTimings({ DEVRELAY_SYNTHETIC_CLOSE_GRACE_MS: 'Infinity' });
  assert.equal(t.syntheticCloseGraceMs, DEFAULT_SYNTHETIC_CLOSE_GRACE_MS);
});

test('resolveKillTimings: 1つだけ有効・残り不正でも例外を投げず混在で解決する', () => {
  const t = resolveKillTimings({
    DEVRELAY_EXIT_FLUSH_GRACE_MS: '9999',
    DEVRELAY_SYNTHETIC_CLOSE_GRACE_MS: 'abc',
    DEVRELAY_KILL_FORCE_DELAY_MS: '-1',
    DEVRELAY_KILL_GIVEUP_DELAY_MS: undefined,
  });
  assert.equal(t.exitFlushGraceMs, 9999);
  assert.equal(t.syntheticCloseGraceMs, DEFAULT_SYNTHETIC_CLOSE_GRACE_MS);
  assert.equal(t.forceDelayMs, DEFAULT_KILL_FORCE_DELAY_MS);
  assert.equal(t.giveUpDelayMs, DEFAULT_KILL_GIVEUP_DELAY_MS);
});

// ---- shouldEmitHeartbeat ----

test('shouldEmitHeartbeat: 全て false → true（通常時はハートビートを出す）', () => {
  assert.equal(
    shouldEmitHeartbeat({ killRequested: false, turnEnded: false, processExited: false }),
    true
  );
});

test('shouldEmitHeartbeat: killRequested:true → false', () => {
  assert.equal(
    shouldEmitHeartbeat({ killRequested: true, turnEnded: false, processExited: false }),
    false
  );
});

test('shouldEmitHeartbeat: turnEnded:true → false', () => {
  assert.equal(
    shouldEmitHeartbeat({ killRequested: false, turnEnded: true, processExited: false }),
    false
  );
});

test('shouldEmitHeartbeat: processExited:true → false', () => {
  assert.equal(
    shouldEmitHeartbeat({ killRequested: false, turnEnded: false, processExited: true }),
    false
  );
});

test('shouldEmitHeartbeat: 複数 true → false', () => {
  assert.equal(
    shouldEmitHeartbeat({ killRequested: true, turnEnded: true, processExited: true }),
    false
  );
});
