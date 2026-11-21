// サイクルC2（クロス ask のセッション継続: サーバー配線）: cross-ask-resume-rules.ts の単体テスト。
// 外部 import ゼロの純粋関数をコンパイル済み dist から直接 import する
// （既存 cross-ask-isolation-rules.test.mjs と同じ流儀）。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCrossAskScopeIdBase,
  buildCrossAskScopeId,
  parseCrossAskScopeGeneration,
  resolveCrossAskResumeTtlMs,
  resolveCrossAskResumeMaxTurns,
  decideCrossAskSessionPlan,
  buildCrossAskResumeLog,
  isValidCrossAskScopeId,
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
    ...overrides,
  };
}

describe('scope id の組み立て・解析', () => {
  test('buildCrossAskScopeIdBase は crossask- プレフィックス + digest 先頭32桁', () => {
    const digest = '0123456789abcdef0123456789abcdef0123456789abcdef'; // 48桁
    const base = buildCrossAskScopeIdBase(digest);
    assert.equal(base, `crossask-${digest.slice(0, 32)}`);
  });

  test('buildCrossAskScopeId ⇄ parseCrossAskScopeGeneration の往復', () => {
    const base = buildCrossAskScopeIdBase('f'.repeat(64));
    for (const gen of [1, 2, 10, 999]) {
      const scopeId = buildCrossAskScopeId(base, gen);
      assert.equal(parseCrossAskScopeGeneration(scopeId, base), gen);
    }
  });

  test('parseCrossAskScopeGeneration は base 不一致・不正形式で null', () => {
    const base = buildCrossAskScopeIdBase('1'.repeat(64));
    const otherBase = buildCrossAskScopeIdBase('2'.repeat(64));
    assert.equal(parseCrossAskScopeGeneration(buildCrossAskScopeId(otherBase, 1), base), null);
    assert.equal(parseCrossAskScopeGeneration(`${base}-gabc`, base), null);
    assert.equal(parseCrossAskScopeGeneration(`${base}-g0`, base), null); // 0 は無効（1始まり）
    assert.equal(parseCrossAskScopeGeneration('', base), null);
  });

  test('組み立てた scope id は常に AGENT_SCOPE_ID_PATTERN（^[A-Za-z0-9_-]{1,128}$）を満たす', () => {
    const base = buildCrossAskScopeIdBase('deadbeef'.repeat(8));
    for (const gen of [1, 2, 999]) {
      assert.ok(isValidCrossAskScopeId(buildCrossAskScopeId(base, gen)));
    }
  });

  test('scope id は既存の crossquery_（アンダースコア）ピンに一致しない', () => {
    const base = buildCrossAskScopeIdBase('b'.repeat(64));
    const scopeId = buildCrossAskScopeId(base, 1);
    assert.doesNotMatch(scopeId, /crossquery_/);
    assert.doesNotMatch(scopeId, /crossask_/); // ハイフンのみ、アンダースコアは使わない
  });
});

describe('env パーサ', () => {
  test('resolveCrossAskResumeTtlMs: 既定14日・0で無効・clamp 1〜365日', () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    assert.equal(resolveCrossAskResumeTtlMs(undefined), 14 * DAY_MS);
    assert.equal(resolveCrossAskResumeTtlMs('0'), 0);
    assert.equal(resolveCrossAskResumeTtlMs('7'), 7 * DAY_MS);
    assert.equal(resolveCrossAskResumeTtlMs('9999'), 365 * DAY_MS);
    assert.equal(resolveCrossAskResumeTtlMs('-5'), 14 * DAY_MS);
    assert.equal(resolveCrossAskResumeTtlMs('not-a-number'), 14 * DAY_MS);
  });

  test('resolveCrossAskResumeMaxTurns: 既定40・0で無効・clamp 2〜500', () => {
    assert.equal(resolveCrossAskResumeMaxTurns(undefined), 40);
    assert.equal(resolveCrossAskResumeMaxTurns('0'), 0);
    assert.equal(resolveCrossAskResumeMaxTurns('10'), 10);
    assert.equal(resolveCrossAskResumeMaxTurns('99999'), 500);
    assert.equal(resolveCrossAskResumeMaxTurns('1'), 2);
    assert.equal(resolveCrossAskResumeMaxTurns('bogus'), 40);
  });
});

describe('decideCrossAskSessionPlan: 非 resume に落ちる条件（理由付き）', () => {
  test('resumeEnabled=false → contextPrefix/featureOff（isolationStatePolicy をそのまま通す）', () => {
    const plan = decideCrossAskSessionPlan(basePlanInput({ resumeEnabled: false }));
    assert.deepEqual(plan, {
      mode: 'contextPrefix', agentScopeId: undefined, statePolicy: 'isolated',
      includeContextPrefix: true, reason: 'featureOff',
    });
  });

  test('isolationEnabled=false → contextPrefix/isolationOff（G のロールバックで resume も止まる）', () => {
    const plan = decideCrossAskSessionPlan(basePlanInput({ isolationEnabled: false, isolationStatePolicy: null }));
    assert.deepEqual(plan, {
      mode: 'contextPrefix', agentScopeId: undefined, statePolicy: undefined,
      includeContextPrefix: true, reason: 'isolationOff',
    });
  });

  test('isCrossUser=false → contextPrefix/notCrossUser', () => {
    const plan = decideCrossAskSessionPlan(basePlanInput({ isCrossUser: false, isolationStatePolicy: null }));
    assert.equal(plan.mode, 'contextPrefix');
    assert.equal(plan.reason, 'notCrossUser');
    assert.equal(plan.agentScopeId, undefined);
  });

  test('agentSupportsResume=false（capability 未申告の旧 Agent）→ contextPrefix/agentOutdated', () => {
    const plan = decideCrossAskSessionPlan(basePlanInput({ agentSupportsResume: false }));
    assert.equal(plan.mode, 'contextPrefix');
    assert.equal(plan.reason, 'agentOutdated');
  });

  test('readOnlyEnforced=false（devin/gemini/claude+terminalMode）→ contextPrefix/aiUnsafe', () => {
    const plan = decideCrossAskSessionPlan(basePlanInput({ readOnlyEnforced: false }));
    assert.equal(plan.mode, 'contextPrefix');
    assert.equal(plan.reason, 'aiUnsafe');
  });

  test('【回帰ガード】readOnlyEnforced=false では statePolicy が絶対に resumable-scoped にならない', () => {
    for (const overrides of [
      { readOnlyEnforced: false },
      { readOnlyEnforced: false, agentSupportsResume: false },
      { readOnlyEnforced: false, latestGeneration: 3, currentGenerationTurns: 1 },
    ]) {
      const plan = decideCrossAskSessionPlan(basePlanInput(overrides));
      assert.notEqual(plan.statePolicy, 'resumable-scoped');
    }
  });
});

describe('decideCrossAskSessionPlan: resume に昇格する条件', () => {
  test('新規ペア（latestGeneration=null）→ resumableFresh（世代1、前置 on）', () => {
    const plan = decideCrossAskSessionPlan(basePlanInput({ latestGeneration: null }));
    assert.equal(plan.mode, 'resumableFresh');
    assert.equal(plan.statePolicy, 'resumable-scoped');
    assert.equal(plan.includeContextPrefix, true);
    assert.equal(parseCrossAskScopeGeneration(plan.agentScopeId, basePlanInput().scopeIdBase), 1);
  });

  test('既存ペア・TTL/上限未超過 → resumable（前置 off、同一世代を継続）', () => {
    const plan = decideCrossAskSessionPlan(basePlanInput({
      latestGeneration: 3, currentGenerationTurns: 5, lastTurnAgeMs: 1000,
    }));
    assert.equal(plan.mode, 'resumable');
    assert.equal(plan.statePolicy, 'resumable-scoped');
    assert.equal(plan.includeContextPrefix, false);
    assert.equal(parseCrossAskScopeGeneration(plan.agentScopeId, basePlanInput().scopeIdBase), 3);
  });

  test('TTL 超過 → resumableFresh（世代 +1）', () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const plan = decideCrossAskSessionPlan(basePlanInput({
      latestGeneration: 2, currentGenerationTurns: 3, lastTurnAgeMs: 20 * DAY_MS, ttlMs: 14 * DAY_MS,
    }));
    assert.equal(plan.mode, 'resumableFresh');
    assert.equal(parseCrossAskScopeGeneration(plan.agentScopeId, basePlanInput().scopeIdBase), 3);
  });

  test('上限ターン超過 → resumableFresh（世代 +1）', () => {
    const plan = decideCrossAskSessionPlan(basePlanInput({
      latestGeneration: 5, currentGenerationTurns: 40, maxTurns: 40,
    }));
    assert.equal(plan.mode, 'resumableFresh');
    assert.equal(parseCrossAskScopeGeneration(plan.agentScopeId, basePlanInput().scopeIdBase), 6);
  });

  test('ttlMs=0（無効）なら lastTurnAgeMs がいくら大きくても TTL では昇格しない', () => {
    const plan = decideCrossAskSessionPlan(basePlanInput({
      latestGeneration: 1, currentGenerationTurns: 1, lastTurnAgeMs: 999 * 24 * 60 * 60 * 1000, ttlMs: 0,
    }));
    assert.equal(plan.mode, 'resumable');
  });

  test('maxTurns=0（無効）なら currentGenerationTurns がいくら大きくても上限では昇格しない', () => {
    const plan = decideCrossAskSessionPlan(basePlanInput({
      latestGeneration: 1, currentGenerationTurns: 9999, maxTurns: 0,
    }));
    assert.equal(plan.mode, 'resumable');
  });
});

describe('【不変条件】resumable のとき includeContextPrefix は必ず false（二重注入の禁止）', () => {
  test('resumable モードの全ケースで false', () => {
    const plan = decideCrossAskSessionPlan(basePlanInput({ latestGeneration: 1, currentGenerationTurns: 0 }));
    assert.equal(plan.mode, 'resumable');
    assert.equal(plan.includeContextPrefix, false);
  });
});

describe('【不変条件】DEVRELAY_CROSS_ASK_RESUME=OFF（resumeEnabled=false）のとき、G 時点と完全同一の statePolicy/agentScopeId になる', () => {
  test('isolationStatePolicy・その他の入力に関わらず statePolicy は isolationStatePolicy をそのまま通し、agentScopeId は常に undefined', () => {
    for (const isolationStatePolicy of ['isolated', null]) {
      for (const overrides of [
        {}, // 既定（capability あり・readOnly 強制可）
        { agentSupportsResume: false },
        { readOnlyEnforced: false },
        { latestGeneration: 5, currentGenerationTurns: 39 },
        { isCrossUser: false },
      ]) {
        const plan = decideCrossAskSessionPlan(basePlanInput({
          resumeEnabled: false, isolationStatePolicy, ...overrides,
        }));
        assert.equal(plan.mode, 'contextPrefix');
        assert.equal(plan.statePolicy, isolationStatePolicy ?? undefined);
        assert.equal(plan.agentScopeId, undefined);
        assert.equal(plan.includeContextPrefix, true);
      }
    }
  });
});

describe('buildCrossAskResumeLog', () => {
  test('resumable/resumableFresh は scope とモードを含む1行', () => {
    const plan = decideCrossAskSessionPlan(basePlanInput({ latestGeneration: null }));
    const log = buildCrossAskResumeLog(plan, 'pixblog');
    assert.match(log, /mode=resumableFresh/);
    assert.match(log, /pixblog/);
    assert.match(log, new RegExp(plan.agentScopeId));
  });

  test('contextPrefix は理由を含む1行', () => {
    const plan = decideCrossAskSessionPlan(basePlanInput({ resumeEnabled: false }));
    const log = buildCrossAskResumeLog(plan, 'pixblog');
    assert.match(log, /mode=contextPrefix/);
    assert.match(log, /reason=featureOff/);
  });
});
