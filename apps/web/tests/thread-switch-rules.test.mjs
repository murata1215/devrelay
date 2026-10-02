// スレッド切替時に前スレッドの「処理中...」進捗表示が残るバグ（2026-09-30）の回帰防止テスト。
// buildThreadSwitchPatch() が返すパッチに progress: null / completed: false が
// 必ず含まれることを固定する（これが無いと Tab.progress にスレッド跨ぎの残骸が残る）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildThreadSwitchPatch } from '../dist-test/lib/thread-switch-rules.js';

test('buildThreadSwitchPatch: progress を必ず null にクリアする（本バグの回帰防止の核）', () => {
  const patch = buildThreadSwitchPatch('session-new', 'タイトル');
  assert.equal(patch.progress, null);
});

test('buildThreadSwitchPatch: completed を必ず false にクリアする', () => {
  const patch = buildThreadSwitchPatch('session-new', 'タイトル');
  assert.equal(patch.completed, false);
});

test('buildThreadSwitchPatch: cancel を必ず null にクリアする（停止ボタン状態の引き継ぎ防止、2026-09-30）', () => {
  const patch = buildThreadSwitchPatch('session-new', 'タイトル');
  assert.equal(patch.cancel, null);
});

test('buildThreadSwitchPatch: messages を空配列にリセットする', () => {
  const patch = buildThreadSwitchPatch('session-new', null);
  assert.deepEqual(patch.messages, []);
});

test('buildThreadSwitchPatch: historyLoaded / hasMoreHistory を false にリセットする', () => {
  const patch = buildThreadSwitchPatch('session-new', null);
  assert.equal(patch.historyLoaded, false);
  assert.equal(patch.hasMoreHistory, false);
});

test('buildThreadSwitchPatch: sessionId / title は渡した値をそのまま反映する', () => {
  const patch = buildThreadSwitchPatch('session-abc', 'My Thread');
  assert.equal(patch.sessionId, 'session-abc');
  assert.equal(patch.title, 'My Thread');
});

test('buildThreadSwitchPatch: title は null を許容する（無題スレッド）', () => {
  const patch = buildThreadSwitchPatch('session-abc', null);
  assert.equal(patch.title, null);
});
