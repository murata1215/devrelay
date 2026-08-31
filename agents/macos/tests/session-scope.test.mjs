// #348: セッションの一時性判定（session-scope.ts）の単体テスト。
// 外部 import ゼロの純粋関数をコンパイル済み dist から直接 import する（control-response.test.mjs と同じ流儀）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifySessionScope, isEphemeralSession, sessionScopeLabel } from '../dist/services/session-scope.js';

test('classifySessionScope: crossquery_ プレフィックスは crossQuery', () => {
  assert.equal(classifySessionScope('crossquery_abc123'), 'crossQuery');
});

test('classifySessionScope: teamexec_ プレフィックスは teamExec', () => {
  assert.equal(classifySessionScope('teamexec_abc123'), 'teamExec');
});

test('classifySessionScope: askdesc_ プレフィックスは askDesc', () => {
  assert.equal(classifySessionScope('askdesc_abc123'), 'askDesc');
});

test('classifySessionScope: それ以外は interactive', () => {
  assert.equal(classifySessionScope('cmthrit6d03ed1392nf83da8o'), 'interactive');
  assert.equal(classifySessionScope(''), 'interactive');
});

test('classifySessionScope: プレフィックスは前方一致のみ（途中に含まれるだけでは一致しない）', () => {
  assert.equal(classifySessionScope('somesession_crossquery_notreally'), 'interactive');
});

test('isEphemeralSession: crossQuery/teamExec/askDesc は true', () => {
  assert.equal(isEphemeralSession('crossquery_x'), true);
  assert.equal(isEphemeralSession('teamexec_x'), true);
  assert.equal(isEphemeralSession('askdesc_x'), true);
});

test('isEphemeralSession: interactive は false', () => {
  assert.equal(isEphemeralSession('normal-session-id'), false);
});

test('sessionScopeLabel: 全スコープが既存のログ表記と互換のラベルを返す', () => {
  assert.equal(sessionScopeLabel('crossQuery'), 'CROSS-QUERY');
  assert.equal(sessionScopeLabel('teamExec'), 'TEAM-EXEC');
  assert.equal(sessionScopeLabel('askDesc'), 'ASK-DESC');
  assert.equal(sessionScopeLabel('interactive'), 'INTERACTIVE');
});
