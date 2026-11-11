// サイクルC3a-1（クロス ask のセッション継続: リセット導線）: `decideCrossAskResetRequested()` と
// `decideCrossAskSessionPlan()` の `resetRequested` 入力の単体テスト。
// 外部 import ゼロの純粋関数をコンパイル済み dist から直接 import する
// （既存 cross-ask-resume-rules.test.mjs と同じ流儀）。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCrossAskScopeIdBase,
  parseCrossAskScopeGeneration,
  decideCrossAskSessionPlan,
  decideCrossAskResetRequested,
} from '../dist/services/cross-ask-resume-rules.js';

function basePlanInput(overrides = {}) {
  return {
    resumeEnabled: true,
    isolationEnabled: true,
    isCrossUser: true,
    agentSupportsResume: true,
    readOnlyEnforced: true,
    isolationStatePolicy: 'isolated',
    scopeIdBase: buildCrossAskScopeIdBase('a'.repeat(64)),
    latestGeneration: null,
    currentGenerationTurns: 0,
    lastTurnAgeMs: null,
    ttlMs: 14 * 24 * 60 * 60 * 1000,
    maxTurns: 40,
    resetRequested: false,
    ...overrides,
  };
}

describe('decideCrossAskResetRequested: 純粋な時刻比較', () => {
  test('resetAtMs が null → 常に false（リセット行が無い）', () => {
    assert.equal(decideCrossAskResetRequested(null, null), false);
    assert.equal(decideCrossAskResetRequested(null, 1000), false);
  });

  test('resetAtMs があり lastTurnAtMs が null（新規ペア）→ true', () => {
    assert.equal(decideCrossAskResetRequested(1000, null), true);
  });

  test('resetAtMs > lastTurnAtMs（リセットが最後のターンより後）→ true', () => {
    assert.equal(decideCrossAskResetRequested(2000, 1000), true);
  });

  test('resetAtMs <= lastTurnAtMs（リセットが最後のターンより前、または同時）→ false', () => {
    assert.equal(decideCrossAskResetRequested(1000, 2000), false);
    assert.equal(decideCrossAskResetRequested(1000, 1000), false);
  });
});

describe('decideCrossAskSessionPlan: resetRequested=true は必ず resumableFresh（resumable に落ちない）', () => {
  test('既存世代があり TTL/上限とも未超過でも resetRequested=true なら世代 +1 される', () => {
    const plan = decideCrossAskSessionPlan(basePlanInput({
      latestGeneration: 3, currentGenerationTurns: 5, lastTurnAgeMs: 1000, resetRequested: true,
    }));
    assert.equal(plan.mode, 'resumableFresh');
    assert.equal(plan.statePolicy, 'resumable-scoped');
    assert.equal(plan.includeContextPrefix, true);
    assert.equal(parseCrossAskScopeGeneration(plan.agentScopeId, basePlanInput().scopeIdBase), 4);
  });

  test('新規ペア（latestGeneration=null）+ resetRequested=true でも世代は 1（巻き戻らない）', () => {
    const plan = decideCrossAskSessionPlan(basePlanInput({ latestGeneration: null, resetRequested: true }));
    assert.equal(plan.mode, 'resumableFresh');
    assert.equal(parseCrossAskScopeGeneration(plan.agentScopeId, basePlanInput().scopeIdBase), 1);
  });

  test('resetRequested=true は statePolicy を isolated に退行させない（resumable-scoped のまま）', () => {
    for (const overrides of [
      { latestGeneration: 1, currentGenerationTurns: 0 },
      { latestGeneration: 10, currentGenerationTurns: 39 },
      { latestGeneration: null },
    ]) {
      const plan = decideCrossAskSessionPlan(basePlanInput({ ...overrides, resetRequested: true }));
      assert.equal(plan.statePolicy, 'resumable-scoped');
      assert.notEqual(plan.mode, 'resumable');
    }
  });

  test('【回帰ガード】resetRequested=false（既定）では C2 時点と完全同一（既存 resumable 判定が崩れない）', () => {
    const plan = decideCrossAskSessionPlan(basePlanInput({
      latestGeneration: 3, currentGenerationTurns: 5, lastTurnAgeMs: 1000, resetRequested: false,
    }));
    assert.equal(plan.mode, 'resumable');
    assert.equal(plan.includeContextPrefix, false);
  });

  test('resumeEnabled=false のときは resetRequested=true でも contextPrefix/featureOff（上位ゲートが先）', () => {
    const plan = decideCrossAskSessionPlan(basePlanInput({ resumeEnabled: false, resetRequested: true }));
    assert.equal(plan.mode, 'contextPrefix');
    assert.equal(plan.reason, 'featureOff');
  });

  test('readOnlyEnforced=false のときは resetRequested=true でも resumable-scoped にならない（安全ゲートが先）', () => {
    const plan = decideCrossAskSessionPlan(basePlanInput({ readOnlyEnforced: false, resetRequested: true }));
    assert.equal(plan.mode, 'contextPrefix');
    assert.notEqual(plan.statePolicy, 'resumable-scoped');
  });
});
