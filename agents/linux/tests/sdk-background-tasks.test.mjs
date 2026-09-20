// bg-task: バックグラウンド Agent 稼働中／resume 直後の空 result を終端と誤認しない判定
// （sdk-background-tasks.ts）の単体テスト。外部 import ゼロの純粋関数をコンパイル済み dist から
// 直接 import する（sdk-stop-reason.test.mjs と同じ流儀）。
// agents/macos/tests/sdk-background-tasks.test.mjs と byte-for-byte 同一。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_BG_TASK_IDLE_MS,
  DEFAULT_BG_TASK_MAX_DEFERRALS,
  resolveBackgroundTaskConfig,
  createBackgroundTaskState,
  observeBackgroundTaskEvent,
  decideResultDeferral,
} from '../dist/services/sdk-background-tasks.js';

const cfg = resolveBackgroundTaskConfig({});
const okResult = (over = {}) => ({ isError: false, numTurns: 2, resultText: 'done', fullOutputLength: 4, ...over });

// ============================================================
// A. resolveBackgroundTaskConfig
// ============================================================

test('A1: env 未設定 → 既定値', () => {
  assert.deepEqual(resolveBackgroundTaskConfig({}), {
    idleTimeoutMs: DEFAULT_BG_TASK_IDLE_MS,
    maxDeferrals: DEFAULT_BG_TASK_MAX_DEFERRALS,
  });
  assert.equal(DEFAULT_BG_TASK_IDLE_MS, 10 * 60 * 1000);
  assert.equal(DEFAULT_BG_TASK_MAX_DEFERRALS, 20);
});

test('A2: env で上書きできる。不正値（0以下・非数値・空文字）は既定値へフォールバック', () => {
  assert.equal(resolveBackgroundTaskConfig({ DEVRELAY_SDK_BG_TASK_IDLE_MS: '5000' }).idleTimeoutMs, 5000);
  assert.equal(resolveBackgroundTaskConfig({ DEVRELAY_SDK_BG_TASK_MAX_DEFERRALS: '3.9' }).maxDeferrals, 3);
  assert.equal(resolveBackgroundTaskConfig({ DEVRELAY_SDK_BG_TASK_IDLE_MS: '0' }).idleTimeoutMs, DEFAULT_BG_TASK_IDLE_MS);
  assert.equal(resolveBackgroundTaskConfig({ DEVRELAY_SDK_BG_TASK_IDLE_MS: '-1' }).idleTimeoutMs, DEFAULT_BG_TASK_IDLE_MS);
  assert.equal(resolveBackgroundTaskConfig({ DEVRELAY_SDK_BG_TASK_IDLE_MS: 'abc' }).idleTimeoutMs, DEFAULT_BG_TASK_IDLE_MS);
  assert.equal(resolveBackgroundTaskConfig({ DEVRELAY_SDK_BG_TASK_MAX_DEFERRALS: '' }).maxDeferrals, DEFAULT_BG_TASK_MAX_DEFERRALS);
});

// ============================================================
// B. observeBackgroundTaskEvent — 集合の追跡
// ============================================================

test('B1: task_started で追加、task_notification で削除（status は問わない）', () => {
  const st = createBackgroundTaskState();
  assert.equal(observeBackgroundTaskEvent(st, { type: 'system', subtype: 'task_started', task_id: 't1' }), true);
  assert.equal(observeBackgroundTaskEvent(st, { type: 'system', subtype: 'task_started', task_id: 't1' }), false, '重複追加は変化なし');
  assert.deepEqual(Array.from(st.pending), ['t1']);
  assert.equal(observeBackgroundTaskEvent(st, { type: 'system', subtype: 'task_notification', task_id: 't1', status: 'stopped' }), true);
  assert.equal(st.pending.size, 0);
  assert.equal(observeBackgroundTaskEvent(st, { type: 'system', subtype: 'task_notification', task_id: 'unknown', status: 'completed' }), false, '未知 id の通知は無視');
});

test('B2: background_tasks_changed は REPLACE セマンティクス。ambient は活動とみなさない', () => {
  const st = createBackgroundTaskState();
  observeBackgroundTaskEvent(st, { type: 'system', subtype: 'task_started', task_id: 'stale' });
  const changed = observeBackgroundTaskEvent(st, {
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: [
      { task_id: 'a', task_type: 'local_agent', description: 'x' },
      { task_id: 'w', task_type: 'watcher', description: 'y', ambient: true },
      { task_id: '', task_type: 'bogus', description: '' },
      null,
    ],
  });
  assert.equal(changed, true);
  assert.deepEqual(Array.from(st.pending).sort(), ['a'], 'stale は消え、ambient と不正要素は入らない');
  assert.equal(observeBackgroundTaskEvent(st, { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'a' }] }), false, '同一集合は変化なし');
  assert.equal(observeBackgroundTaskEvent(st, { type: 'system', subtype: 'background_tasks_changed', tasks: [] }), true);
  assert.equal(st.pending.size, 0);
});

test('B3: system 以外・不正な形のメッセージは無視し例外を投げない', () => {
  const st = createBackgroundTaskState();
  assert.equal(observeBackgroundTaskEvent(st, { type: 'assistant' }), false);
  assert.equal(observeBackgroundTaskEvent(st, { type: 'system', subtype: 'task_started' }), false, 'task_id 無し');
  assert.equal(observeBackgroundTaskEvent(st, { type: 'system', subtype: 'task_started', task_id: 42 }), false);
  assert.equal(observeBackgroundTaskEvent(st, { type: 'system', subtype: 'background_tasks_changed', tasks: 'nope' }), false);
  assert.equal(observeBackgroundTaskEvent(st, { type: 'system', subtype: 'task_progress', task_id: 'p' }), false, 'progress は集合に影響しない');
  assert.equal(observeBackgroundTaskEvent(st, null), false);
  assert.equal(st.pending.size, 0);
});

// ============================================================
// C. decideResultDeferral — 終端判定
// ============================================================

test('C1: バックグラウンドタスク無し・本文ありの通常 result は終端（延期しない）', () => {
  const st = createBackgroundTaskState();
  const d = decideResultDeferral(st, okResult(), cfg);
  assert.equal(d.defer, false);
  assert.equal(d.reason, undefined);
  assert.equal(st.deferrals, 0);
});

test('C2: 生きているバックグラウンドタスクがあれば延期（reason=backgroundTasks）。通知後の result は終端', () => {
  const st = createBackgroundTaskState();
  observeBackgroundTaskEvent(st, { type: 'system', subtype: 'task_started', task_id: 'ex1' });
  observeBackgroundTaskEvent(st, { type: 'system', subtype: 'task_started', task_id: 'ex2' });
  // モデルが「完了を待っています」で end_turn した result_index=0
  const d1 = decideResultDeferral(st, okResult({ resultText: 'Explore 2 体の完了を待っています', fullOutputLength: 20 }), cfg);
  assert.equal(d1.defer, true);
  assert.equal(d1.reason, 'backgroundTasks');
  assert.deepEqual(d1.pendingTaskIds.sort(), ['ex1', 'ex2']);
  assert.equal(st.deferrals, 1);
  observeBackgroundTaskEvent(st, { type: 'system', subtype: 'task_notification', task_id: 'ex1', status: 'completed' });
  const d2 = decideResultDeferral(st, okResult(), cfg);
  assert.equal(d2.defer, true, '1 体残っていればまだ延期');
  observeBackgroundTaskEvent(st, { type: 'system', subtype: 'task_notification', task_id: 'ex2', status: 'completed' });
  const d3 = decideResultDeferral(st, okResult(), cfg);
  assert.equal(d3.defer, false, '全部終わったら終端');
  assert.deepEqual(d3.pendingTaskIds, []);
});

test('C3: resume 直後の空 result（num_turns=0・本文なし）は 1 ターンに 1 回だけ延期（reason=emptyResult）', () => {
  const st = createBackgroundTaskState();
  const empty = { isError: false, numTurns: 0, resultText: '', fullOutputLength: 0 };
  const d1 = decideResultDeferral(st, empty, cfg);
  assert.equal(d1.defer, true);
  assert.equal(d1.reason, 'emptyResult');
  assert.equal(st.emptyResultSkipped, true);
  const d2 = decideResultDeferral(st, empty, cfg);
  assert.equal(d2.defer, false, '2 回目の空 result は終端（従来どおり (No response from AI) へ）');
});

test('C4: 空 result でも本文が既にストリーム済み／num_turns>0／result が undefined ではない場合は延期しない', () => {
  assert.equal(decideResultDeferral(createBackgroundTaskState(), { isError: false, numTurns: 0, resultText: '', fullOutputLength: 5 }, cfg).defer, false);
  assert.equal(decideResultDeferral(createBackgroundTaskState(), { isError: false, numTurns: 1, resultText: '', fullOutputLength: 0 }, cfg).defer, false);
  assert.equal(decideResultDeferral(createBackgroundTaskState(), { isError: false, numTurns: 0, resultText: 'x', fullOutputLength: 0 }, cfg).defer, false);
  // 旧 SDK（num_turns 無し）の空 result は従来どおり終端
  assert.equal(decideResultDeferral(createBackgroundTaskState(), { isError: false, numTurns: undefined, resultText: undefined, fullOutputLength: 0 }, cfg).defer, false);
});

test('C5: is_error の result はタスクが残っていても延期しない（既存のエラー経路へ）', () => {
  const st = createBackgroundTaskState();
  observeBackgroundTaskEvent(st, { type: 'system', subtype: 'task_started', task_id: 't' });
  const d = decideResultDeferral(st, okResult({ isError: true }), cfg);
  assert.equal(d.defer, false);
  assert.deepEqual(d.pendingTaskIds, ['t'], 'ログ用の pending は返す');
  assert.equal(st.deferrals, 0);
});

test('C6: 延期回数が上限に達したら延期しない（安全弁）', () => {
  const st = createBackgroundTaskState();
  observeBackgroundTaskEvent(st, { type: 'system', subtype: 'task_started', task_id: 't' });
  const small = { ...cfg, maxDeferrals: 2 };
  assert.equal(decideResultDeferral(st, okResult(), small).defer, true);
  assert.equal(decideResultDeferral(st, okResult(), small).defer, true);
  assert.equal(st.deferrals, 2);
  assert.equal(decideResultDeferral(st, okResult(), small).defer, false, '3 回目は終端扱い');
  assert.equal(st.deferrals, 2, '上限到達後はカウントしない');
});

test('C7: 実測シーケンス（2026-09-20）: 起動→完了待ち result→resume 空 result→本物の result', () => {
  // ターン 1: background Agent 2 体起動 → 「待っています」で result(idx0)
  const turn1 = createBackgroundTaskState();
  observeBackgroundTaskEvent(turn1, { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'a38b' }] });
  observeBackgroundTaskEvent(turn1, { type: 'system', subtype: 'task_started', task_id: 'a38b' });
  observeBackgroundTaskEvent(turn1, { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'a38b' }, { task_id: 'aa96' }] });
  observeBackgroundTaskEvent(turn1, { type: 'system', subtype: 'task_started', task_id: 'aa96' });
  assert.equal(decideResultDeferral(turn1, okResult({ resultText: '待っています', fullOutputLength: 495 }), cfg).defer, true);
  // ターン 2（従来どおり SDK が殺されていた場合の resume）: 合成通知 → 空 result → 本物の result
  const turn2 = createBackgroundTaskState();
  observeBackgroundTaskEvent(turn2, { type: 'system', subtype: 'task_notification', task_id: 'a38b', status: 'stopped', reason: 'worker_restart' });
  const d1 = decideResultDeferral(turn2, { isError: false, numTurns: 0, resultText: '', fullOutputLength: 0 }, cfg);
  assert.equal(d1.defer, true);
  assert.equal(d1.reason, 'emptyResult');
  const d2 = decideResultDeferral(turn2, okResult({ resultText: 'いいえ、落ちていません', fullOutputLength: 11 }), cfg);
  assert.equal(d2.defer, false);
});
