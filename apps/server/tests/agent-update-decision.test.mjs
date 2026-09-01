// 外部 import ゼロの純粋関数（apps/server/src/services/agent-update-decision.ts）を
// コンパイル済み dist から直接 import する（cross-query-guard.test.mjs と同じ流儀）。
// #350: stale dist デッドロック（git は最新だが実行中コードが古い）からの復帰経路

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideUpdateAction } from '../dist/services/agent-update-decision.js';

test('hasUpdate=true なら常に update（runningCodeStale の値に関わらず）', () => {
  assert.equal(decideUpdateAction({ hasUpdate: true, runningCodeStale: true }), 'update');
  assert.equal(decideUpdateAction({ hasUpdate: true, runningCodeStale: false }), 'update');
  assert.equal(decideUpdateAction({ hasUpdate: true, runningCodeStale: undefined }), 'update');
});

test('hasUpdate=false かつ runningCodeStale=true なら rebuild（stale dist デッドロック）', () => {
  assert.equal(decideUpdateAction({ hasUpdate: false, runningCodeStale: true }), 'rebuild');
});

test('hasUpdate=false かつ runningCodeStale=false なら upToDate', () => {
  assert.equal(decideUpdateAction({ hasUpdate: false, runningCodeStale: false }), 'upToDate');
});

test('hasUpdate=false かつ runningCodeStale=undefined（旧 Agent）なら upToDate（fail-open、#302 と同じ）', () => {
  assert.equal(decideUpdateAction({ hasUpdate: false, runningCodeStale: undefined }), 'upToDate');
});

test('hasUpdate=false かつ runningCodeStale 未指定（キー自体無し）なら upToDate', () => {
  assert.equal(decideUpdateAction({ hasUpdate: false }), 'upToDate');
});

test('境界値: hasUpdate=false, runningCodeStale=true の判定は入力オブジェクトの余分なキーに影響されない', () => {
  const input = { hasUpdate: false, runningCodeStale: true, extra: 'ignored' };
  assert.equal(decideUpdateAction(input), 'rebuild');
});
