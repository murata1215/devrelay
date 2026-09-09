// スレッド管理 cycle2: thread-clear-guard.ts（decideClearDispatch）の単体テスト。
// 「既定スレッドは capability 不問で常に許可」「scoped スレッドは capability 申告済みの
// agent にのみ許可（未申告は fail-closed）」を検証する。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { decideClearDispatch } from '../dist/services/thread-clear-guard.js';

describe('decideClearDispatch', () => {
  test('① stored=null かつ capability なし → 許可・outbound は undefined', () => {
    const result = decideClearDispatch({
      storedAgentScopeId: null,
      agentSupportsScopedClear: false,
    });
    assert.deepEqual(result, { allowed: true, outboundAgentScopeId: undefined });
  });

  test('② stored=null かつ capability あり → 許可・outbound は undefined（既定スレッドは scope を載せない）', () => {
    const result = decideClearDispatch({
      storedAgentScopeId: null,
      agentSupportsScopedClear: true,
    });
    assert.deepEqual(result, { allowed: true, outboundAgentScopeId: undefined });
  });

  test('③ stored="s1" かつ capability なし → fail-closed で拒否', () => {
    const result = decideClearDispatch({
      storedAgentScopeId: 's1',
      agentSupportsScopedClear: false,
    });
    assert.deepEqual(result, { allowed: false, reason: 'agent-capability-missing' });
  });

  test('④ stored="s1" かつ capability あり → 許可・outbound は "s1"', () => {
    const result = decideClearDispatch({
      storedAgentScopeId: 's1',
      agentSupportsScopedClear: true,
    });
    assert.deepEqual(result, { allowed: true, outboundAgentScopeId: 's1' });
  });

  test('⑤ stored=undefined（stored=null と同様、既定スレッド扱い）は capability 不問で許可', () => {
    const withoutCap = decideClearDispatch({
      storedAgentScopeId: undefined,
      agentSupportsScopedClear: false,
    });
    assert.deepEqual(withoutCap, { allowed: true, outboundAgentScopeId: undefined });

    const withCap = decideClearDispatch({
      storedAgentScopeId: undefined,
      agentSupportsScopedClear: true,
    });
    assert.deepEqual(withCap, { allowed: true, outboundAgentScopeId: undefined });
  });
});
