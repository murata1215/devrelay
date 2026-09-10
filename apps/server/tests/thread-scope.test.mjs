import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  isEphemeralSessionId,
  decideNewSessionScopeId,
  resolveOutboundAgentScopeId,
  inheritScopeForReestablishedSession,
  buildEphemeralSessionIdExclusion,
} from '../dist/services/thread-scope.js';

describe('isEphemeralSessionId', () => {
  test('teamexec_ プレフィックスは一時セッション', () => {
    assert.equal(isEphemeralSessionId('teamexec_abc123'), true);
  });

  test('crossquery_ プレフィックスは一時セッション', () => {
    assert.equal(isEphemeralSessionId('crossquery_abc123'), true);
  });

  test('askdesc_ プレフィックスは一時セッション', () => {
    assert.equal(isEphemeralSessionId('askdesc_a1b2c3'), true);
  });

  test('通常の cuid は一時セッションではない', () => {
    assert.equal(isEphemeralSessionId('clx1234567890abcdef'), false);
  });

  test('null/undefined は false', () => {
    assert.equal(isEphemeralSessionId(null), false);
    assert.equal(isEphemeralSessionId(undefined), false);
  });

  test('空文字は false', () => {
    assert.equal(isEphemeralSessionId(''), false);
  });
});

describe('buildEphemeralSessionIdExclusion（一覧 where への展開）', () => {
  test('NOT { OR: [...] } の形で全プレフィックスを返す', () => {
    assert.deepEqual(buildEphemeralSessionIdExclusion(), {
      NOT: {
        OR: [
          { id: { startsWith: 'teamexec_' } },
          { id: { startsWith: 'crossquery_' } },
          { id: { startsWith: 'askdesc_' } },
        ],
      },
    });
  });

  // 単一情報源の担保: where 用フィルタと isEphemeralSessionId が同じ定数から派生していること。
  // 片方だけにプレフィックスを足す実装ミスをここで落とす。
  test('フィルタの各プレフィックスは isEphemeralSessionId でも true になる', () => {
    const prefixes = buildEphemeralSessionIdExclusion().NOT.OR.map((c) => c.id.startsWith);
    assert.ok(prefixes.length > 0);
    for (const prefix of prefixes) {
      assert.equal(isEphemeralSessionId(`${prefix}deadbeef`), true, prefix);
    }
    assert.equal(isEphemeralSessionId('clx1234567890abcdef'), false);
  });

  test('呼び出しごとに新しいオブジェクトを返す（共有ミュータブル状態を作らない）', () => {
    const a = buildEphemeralSessionIdExclusion();
    const b = buildEphemeralSessionIdExclusion();
    assert.notEqual(a, b);
    assert.notEqual(a.NOT, b.NOT);
    assert.notEqual(a.NOT.OR, b.NOT.OR);
  });
});

describe('decideNewSessionScopeId', () => {
  test('キルスイッチ OFF なら常に null（従来挙動）', () => {
    const result = decideNewSessionScopeId({
      newSessionId: 'newsess1',
      interactiveScopeEnabled: false,
    });
    assert.equal(result, null);
  });

  test('キルスイッチ ON なら新規セッション自身の id を返す', () => {
    const result = decideNewSessionScopeId({
      newSessionId: 'newsess1',
      interactiveScopeEnabled: true,
    });
    assert.equal(result, 'newsess1');
  });
});

describe('resolveOutboundAgentScopeId（バックフィル禁止の唯一の実装点）', () => {
  test('null は undefined になる（NULL を推測で埋めない）', () => {
    assert.equal(resolveOutboundAgentScopeId(null), undefined);
  });

  test('undefined も undefined のまま', () => {
    assert.equal(resolveOutboundAgentScopeId(undefined), undefined);
  });

  test('非 null 値はそのまま通す', () => {
    assert.equal(resolveOutboundAgentScopeId('sess123'), 'sess123');
  });

  test('空文字は空文字のまま通す（false-y だが null ではない）', () => {
    assert.equal(resolveOutboundAgentScopeId(''), '');
  });
});

describe('inheritScopeForReestablishedSession（agent 再起動時の継承）', () => {
  test('null（従来スレッド）は null のまま継承 — 新規採番しない', () => {
    const result = inheritScopeForReestablishedSession({ oldAgentScopeId: null });
    assert.equal(result, null);
  });

  test('非 null（scoped スレッド）はそのまま継承', () => {
    const result = inheritScopeForReestablishedSession({ oldAgentScopeId: 'oldsess1' });
    assert.equal(result, 'oldsess1');
  });
});
