// Claude 認証状態の source 優先度判定テスト（BUG A 最小修正、#326 Phase2）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideClaudeAuthUpdate } from '../dist/services/claude-auth-precedence.js';

test('runtime の ok:false は採用され、切れた通知が出る', () => {
  const result = decideClaudeAuthUpdate({ previousOk: true, reportedOk: false, source: 'runtime' });
  assert.equal(result.nextOk, false);
  assert.equal(result.notifyExpired, true);
  assert.equal(result.notifyRecovered, false);
});

test('runtime の ok:true は false を解除し、復旧通知が出る', () => {
  const result = decideClaudeAuthUpdate({ previousOk: false, reportedOk: true, source: 'runtime' });
  assert.equal(result.nextOk, true);
  assert.equal(result.notifyRecovered, true);
});

test('BUG A 回帰テスト: poll の ok:true は previousOk:false を解除しない', () => {
  const result = decideClaudeAuthUpdate({ previousOk: false, reportedOk: true, source: 'poll' });
  assert.equal(result.nextOk, false, 'poll の弱い ok:true で runtime/login の false を上書きしてはいけない');
  assert.equal(result.notifyExpired, false);
  assert.equal(result.notifyRecovered, false);
});

test('poll の ok:false は採用される（資格情報なしは強い根拠）', () => {
  const result = decideClaudeAuthUpdate({ previousOk: true, reportedOk: false, source: 'poll' });
  assert.equal(result.nextOk, false);
  assert.equal(result.notifyExpired, true);
});

test('poll の ok:true は previousOk が true/null のときは無害に採用される', () => {
  const fromTrue = decideClaudeAuthUpdate({ previousOk: true, reportedOk: true, source: 'poll' });
  assert.equal(fromTrue.nextOk, true);
  assert.equal(fromTrue.notifyRecovered, false);

  const fromNull = decideClaudeAuthUpdate({ previousOk: null, reportedOk: true, source: 'poll' });
  assert.equal(fromNull.nextOk, true);
  assert.equal(fromNull.notifyRecovered, false, '初回観測は通知しない');
});

test('login の ok:true は false を解除する', () => {
  const result = decideClaudeAuthUpdate({ previousOk: false, reportedOk: true, source: 'login' });
  assert.equal(result.nextOk, true);
  assert.equal(result.notifyRecovered, true);
});

test('source未指定（旧 Agent）は従来どおり常に採用される（fail-open）', () => {
  const toFalse = decideClaudeAuthUpdate({ previousOk: true, reportedOk: false, source: undefined });
  assert.equal(toFalse.nextOk, false);
  assert.equal(toFalse.notifyExpired, true);

  const toTrue = decideClaudeAuthUpdate({ previousOk: false, reportedOk: true, source: undefined });
  assert.equal(toTrue.nextOk, true);
  assert.equal(toTrue.notifyRecovered, true);
});

test('初回観測（previousOk:null）は通知しない', () => {
  const result = decideClaudeAuthUpdate({ previousOk: null, reportedOk: false, source: 'runtime' });
  assert.equal(result.nextOk, false);
  assert.equal(result.notifyExpired, false);
  assert.equal(result.notifyRecovered, false);
});

test('同値遷移（true→true, false→false）は通知しない', () => {
  const sameTrue = decideClaudeAuthUpdate({ previousOk: true, reportedOk: true, source: 'runtime' });
  assert.equal(sameTrue.notifyExpired, false);
  assert.equal(sameTrue.notifyRecovered, false);

  const sameFalse = decideClaudeAuthUpdate({ previousOk: false, reportedOk: false, source: 'runtime' });
  assert.equal(sameFalse.notifyExpired, false);
  assert.equal(sameFalse.notifyRecovered, false);
});
