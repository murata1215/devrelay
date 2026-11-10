// サイクルG（クロス ask の既存バグ修正）: cross-ask-isolation-rules.ts の単体テスト。
// 外部 import ゼロの純粋関数をコンパイル済み dist から直接 import する
// （既存 cross-query-guard.test.mjs / cross-team-guard.test.mjs と同じ流儀）。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideCrossAskIsolation,
  buildCrossAskIsolationDenialMessage,
  buildCrossAskIsolationDenyLog,
} from '../dist/services/cross-ask-isolation-rules.js';

function baseInput(overrides = {}) {
  return {
    isCrossUser: true,
    isolationEnabled: true,
    agentHasIsolationCapability: true,
    readOnlyEnforced: true,
    ...overrides,
  };
}

describe('decideCrossAskIsolation: 同一ユーザー ask は常に無条件で許可（statePolicy 無し）', () => {
  test('isCrossUser=false なら他のフラグに関わらず allowed=true, statePolicy=null', () => {
    for (const overrides of [
      {},
      { isolationEnabled: false },
      { agentHasIsolationCapability: false },
      { readOnlyEnforced: false },
      { isolationEnabled: false, agentHasIsolationCapability: false, readOnlyEnforced: false },
    ]) {
      const decision = decideCrossAskIsolation(baseInput({ isCrossUser: false, ...overrides }));
      assert.deepEqual(decision, { allowed: true, statePolicy: null });
    }
  });
});

describe('decideCrossAskIsolation: キルスイッチ OFF は常に許可（旧挙動）', () => {
  test('isolationEnabled=false なら capability/readOnlyEnforced に関わらず allowed=true, statePolicy=null', () => {
    for (const overrides of [
      {},
      { agentHasIsolationCapability: false },
      { readOnlyEnforced: false },
      { agentHasIsolationCapability: false, readOnlyEnforced: false },
    ]) {
      const decision = decideCrossAskIsolation(baseInput({ isolationEnabled: false, ...overrides }));
      assert.deepEqual(decision, { allowed: true, statePolicy: null });
    }
  });
});

describe('decideCrossAskIsolation: クロスユーザー + キルスイッチ ON のときだけ 2 点を検証する', () => {
  test('全条件 OK なら allowed=true, statePolicy=isolated', () => {
    const decision = decideCrossAskIsolation(baseInput());
    assert.deepEqual(decision, { allowed: true, statePolicy: 'isolated' });
  });

  test('capability 未申告なら agent_outdated で拒否（readOnlyEnforced の値に関わらず capability を先に見る）', () => {
    assert.deepEqual(
      decideCrossAskIsolation(baseInput({ agentHasIsolationCapability: false })),
      { allowed: false, reason: 'agent_outdated' },
    );
    assert.deepEqual(
      decideCrossAskIsolation(baseInput({ agentHasIsolationCapability: false, readOnlyEnforced: false })),
      { allowed: false, reason: 'agent_outdated' },
    );
  });

  test('capability はあるが readOnlyEnforced=false（devin/gemini/claude+terminalMode）なら ai_unsafe で拒否', () => {
    assert.deepEqual(
      decideCrossAskIsolation(baseInput({ readOnlyEnforced: false })),
      { allowed: false, reason: 'ai_unsafe' },
    );
  });
});

describe('buildCrossAskIsolationDenialMessage', () => {
  test('agent_outdated は Agent 更新を促す文言', () => {
    const message = buildCrossAskIsolationDenialMessage({ allowed: false, reason: 'agent_outdated' }, 'my-project');
    assert.match(message, /Agent/);
    assert.match(message, /my-project/);
  });

  test('ai_unsafe は AI の読み取り専用を保証できない旨の文言', () => {
    const message = buildCrossAskIsolationDenialMessage({ allowed: false, reason: 'ai_unsafe' }, 'my-project');
    assert.match(message, /読み取り専用/);
    assert.match(message, /my-project/);
  });

  test('allowed=true の decision を渡すと誤用として throw する', () => {
    assert.throws(() => buildCrossAskIsolationDenialMessage({ allowed: true, statePolicy: null }, 'my-project'));
  });
});

describe('buildCrossAskIsolationDenyLog', () => {
  test('requesterUserId と targetProjectName と reason を含む 1 行を返す', () => {
    const log = buildCrossAskIsolationDenyLog({ requesterUserId: 'user-a', targetProjectName: 'proj-b', reason: 'ai_unsafe' });
    assert.match(log, /user-a/);
    assert.match(log, /proj-b/);
    assert.match(log, /ai_unsafe/);
  });
});
