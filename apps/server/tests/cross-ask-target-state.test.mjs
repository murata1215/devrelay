// サイクルC3a-1: cross-ask-target-state.ts の単体テスト（`GET /api/cross-team/ask-targets` の
// `memory` フィールド解決）。外部 import ゼロの純粋関数をコンパイル済み dist から直接 import する。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideCrossAskTargetMemoryState,
  countLatestGenerationTurns,
} from '../dist/services/cross-ask-target-state.js';
import { buildCrossAskScopeId, buildCrossAskScopeIdBase } from '../dist/services/cross-ask-resume-rules.js';

function baseState(overrides = {}) {
  return {
    isolationEnabled: true,
    resumeEnabled: true,
    agentHasIsolationCapability: true,
    agentHasResumeCapability: true,
    readOnlyEnforced: true,
    ...overrides,
  };
}

describe('decideCrossAskTargetMemoryState: askable（G の隔離判定と同じ結果）', () => {
  test('既定（全条件クリア）→ askable=true, remembers=true, reason 無し', () => {
    const state = decideCrossAskTargetMemoryState(baseState());
    assert.equal(state.askable, true);
    assert.equal(state.askDenyReason, undefined);
    assert.equal(state.remembers, true);
    assert.equal(state.reason, undefined);
  });

  test('isolationEnabled=false → askable=true（G 自体が無条件許可）、remembers=false/isolationOff', () => {
    const state = decideCrossAskTargetMemoryState(baseState({ isolationEnabled: false }));
    assert.equal(state.askable, true);
    assert.equal(state.askDenyReason, undefined);
    assert.equal(state.remembers, false);
    assert.equal(state.reason, 'isolationOff');
  });

  test('agentHasIsolationCapability=false（未更新 Agent）→ askable=false/agent_outdated', () => {
    const state = decideCrossAskTargetMemoryState(baseState({ agentHasIsolationCapability: false }));
    assert.equal(state.askable, false);
    assert.equal(state.askDenyReason, 'agent_outdated');
    assert.equal(state.remembers, false);
    assert.equal(state.reason, 'agentOutdated');
  });

  test('readOnlyEnforced=false（devin/gemini/claude+terminalMode）→ askable=false/ai_unsafe', () => {
    const state = decideCrossAskTargetMemoryState(baseState({ readOnlyEnforced: false }));
    assert.equal(state.askable, false);
    assert.equal(state.askDenyReason, 'ai_unsafe');
    assert.equal(state.remembers, false);
    assert.equal(state.reason, 'aiUnsafe');
  });
});

describe('decideCrossAskTargetMemoryState: remembers（C2 の resume 判定と同じ結果）', () => {
  test('resumeEnabled=false → askable=true（isolation は別軸）、remembers=false/featureOff', () => {
    const state = decideCrossAskTargetMemoryState(baseState({ resumeEnabled: false }));
    assert.equal(state.askable, true);
    assert.equal(state.remembers, false);
    assert.equal(state.reason, 'featureOff');
  });

  test('agentHasResumeCapability=false（isolation capability はあるが resume 未申告）→ remembers=false/agentOutdated', () => {
    const state = decideCrossAskTargetMemoryState(baseState({ agentHasResumeCapability: false }));
    assert.equal(state.askable, true);
    assert.equal(state.remembers, false);
    assert.equal(state.reason, 'agentOutdated');
  });

  test('真理値表: 4条件 × askable/remembers の全組み合わせで askDenyReason/reason が一貫する', () => {
    for (const isolationEnabled of [true, false]) {
      for (const resumeEnabled of [true, false]) {
        for (const agentHasIsolationCapability of [true, false]) {
          for (const agentHasResumeCapability of [true, false]) {
            for (const readOnlyEnforced of [true, false]) {
              const state = decideCrossAskTargetMemoryState({
                isolationEnabled, resumeEnabled, agentHasIsolationCapability, agentHasResumeCapability, readOnlyEnforced,
              });
              // askable=false は常に isolationEnabled=true のときのみ発生する。
              // また askable=false のとき runner.ts では resume 判定自体に到達しないため、
              // remembers は常に false に強制される（isolation の拒否理由がそのまま reason になる）。
              if (!state.askable) {
                assert.equal(isolationEnabled, true);
                assert.ok(state.askDenyReason === 'agent_outdated' || state.askDenyReason === 'ai_unsafe');
                assert.equal(state.remembers, false);
                assert.equal(state.reason, state.askDenyReason === 'agent_outdated' ? 'agentOutdated' : 'aiUnsafe');
              }
              // remembers=true は 5 条件すべてクリアのときだけ
              if (state.remembers) {
                assert.equal(resumeEnabled, true);
                assert.equal(isolationEnabled, true);
                assert.equal(agentHasResumeCapability, true);
                assert.equal(readOnlyEnforced, true);
              }
            }
          }
        }
      }
    }
  });
});

describe('countLatestGenerationTurns', () => {
  const base = buildCrossAskScopeIdBase('c'.repeat(64));

  test('Session 行が無い → latestGeneration=null, turns=0', () => {
    const stats = countLatestGenerationTurns([], base);
    assert.deepEqual(stats, { latestGeneration: null, turns: 0 });
  });

  test('同一世代の複数行 → その世代の件数を turns として返す', () => {
    const rows = [
      { agentScopeId: buildCrossAskScopeId(base, 2) },
      { agentScopeId: buildCrossAskScopeId(base, 2) },
      { agentScopeId: buildCrossAskScopeId(base, 2) },
    ];
    assert.deepEqual(countLatestGenerationTurns(rows, base), { latestGeneration: 2, turns: 3 });
  });

  test('複数世代が混在 → 最新世代（最大の世代番号）の件数だけを数える', () => {
    const rows = [
      { agentScopeId: buildCrossAskScopeId(base, 1) },
      { agentScopeId: buildCrossAskScopeId(base, 1) },
      { agentScopeId: buildCrossAskScopeId(base, 3) },
      { agentScopeId: buildCrossAskScopeId(base, 2) },
      { agentScopeId: buildCrossAskScopeId(base, 3) },
    ];
    assert.deepEqual(countLatestGenerationTurns(rows, base), { latestGeneration: 3, turns: 2 });
  });

  test('他の scope base・null・不正形式は無視する（base 突合で構造的に除外）', () => {
    const otherBase = buildCrossAskScopeIdBase('d'.repeat(64));
    const rows = [
      { agentScopeId: buildCrossAskScopeId(otherBase, 5) },
      { agentScopeId: null },
      { agentScopeId: 'not-a-scope-id' },
      { agentScopeId: buildCrossAskScopeId(base, 1) },
    ];
    assert.deepEqual(countLatestGenerationTurns(rows, base), { latestGeneration: 1, turns: 1 });
  });

  test('世代の並び順に関わらず最新世代が正しく解決される（走査順は findMany の既定順）', () => {
    const rows = [
      { agentScopeId: buildCrossAskScopeId(base, 5) },
      { agentScopeId: buildCrossAskScopeId(base, 1) },
      { agentScopeId: buildCrossAskScopeId(base, 9) },
      { agentScopeId: buildCrossAskScopeId(base, 9) },
    ];
    assert.deepEqual(countLatestGenerationTurns(rows, base), { latestGeneration: 9, turns: 2 });
  });
});
