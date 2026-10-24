// 外部 import ゼロの純粋関数（apps/server/src/services/agent-update-decision.ts）を
// コンパイル済み dist から直接 import する（cross-query-guard.test.mjs と同じ流儀）。
// #350: stale dist デッドロック（git は最新だが実行中コードが古い）からの復帰経路

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideUpdateAction, decideUpdateFlow } from '../dist/services/agent-update-decision.js';

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

// 2026-10-24: `u force` 一発化（decideUpdateFlow）。素の u の 2段階確認は不変で、
// force 時だけ確認を待たず即実行（execute）に倒す。
test('decideUpdateFlow: action=upToDate は force の有無に関わらず常に upToDate', () => {
  assert.equal(decideUpdateFlow({ action: 'upToDate', force: false }), 'upToDate');
  assert.equal(decideUpdateFlow({ action: 'upToDate', force: true }), 'upToDate');
});

test('decideUpdateFlow: action=update, force=false は confirm（従来の2段階確認）', () => {
  assert.equal(decideUpdateFlow({ action: 'update', force: false }), 'confirm');
});

test('decideUpdateFlow: action=update, force=true は execute（1回で実行）', () => {
  assert.equal(decideUpdateFlow({ action: 'update', force: true }), 'execute');
});

test('decideUpdateFlow: action=rebuild, force=false は confirm', () => {
  assert.equal(decideUpdateFlow({ action: 'rebuild', force: false }), 'confirm');
});

test('decideUpdateFlow: action=rebuild, force=true は execute', () => {
  assert.equal(decideUpdateFlow({ action: 'rebuild', force: true }), 'execute');
});
