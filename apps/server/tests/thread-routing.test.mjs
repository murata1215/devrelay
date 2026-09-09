import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  threadSortKey,
  sortThreadsDesc,
  decideConnectTarget,
  resolveChatSessionId,
  buildSessionInfoPayload,
  resolvePreferredThreadId,
} from '../dist/services/thread-routing.js';

const mkThread = (id, { status = 'active', startedAt, lastActiveAt = null } = {}) => ({
  id,
  status,
  startedAt: new Date(startedAt),
  lastActiveAt: lastActiveAt ? new Date(lastActiveAt) : null,
});

describe('threadSortKey', () => {
  test('lastActiveAt があればそれを使う', () => {
    const t = mkThread('a', { startedAt: '2026-01-01T00:00:00Z', lastActiveAt: '2026-01-02T00:00:00Z' });
    assert.equal(threadSortKey(t).toISOString(), '2026-01-02T00:00:00.000Z');
  });

  test('lastActiveAt が null なら startedAt にフォールバック', () => {
    const t = mkThread('a', { startedAt: '2026-01-01T00:00:00Z' });
    assert.equal(threadSortKey(t).toISOString(), '2026-01-01T00:00:00.000Z');
  });
});

describe('sortThreadsDesc', () => {
  test('新しい順（降順）にソートする', () => {
    const a = mkThread('a', { startedAt: '2026-01-01T00:00:00Z' });
    const b = mkThread('b', { startedAt: '2026-01-03T00:00:00Z' });
    const c = mkThread('c', { startedAt: '2026-01-02T00:00:00Z' });
    const sorted = sortThreadsDesc([a, b, c]);
    assert.deepEqual(sorted.map((t) => t.id), ['b', 'c', 'a']);
  });

  test('lastActiveAt 全 NULL でも startedAt で正しくソートされる', () => {
    const a = mkThread('a', { startedAt: '2026-01-01T00:00:00Z' });
    const b = mkThread('b', { startedAt: '2026-01-05T00:00:00Z' });
    const sorted = sortThreadsDesc([a, b]);
    assert.deepEqual(sorted.map((t) => t.id), ['b', 'a']);
  });

  test('非破壊（元配列を変更しない）', () => {
    const a = mkThread('a', { startedAt: '2026-01-01T00:00:00Z' });
    const b = mkThread('b', { startedAt: '2026-01-03T00:00:00Z' });
    const original = [a, b];
    sortThreadsDesc(original);
    assert.deepEqual(original.map((t) => t.id), ['a', 'b']);
  });
});

describe('decideConnectTarget（//connect 互換）', () => {
  test('候補0件なら新規作成', () => {
    const result = decideConnectTarget({ candidates: [] });
    assert.deepEqual(result, { action: 'createNew' });
  });

  test('複数 active で lastActiveAt が最新のものを再利用', () => {
    const older = mkThread('older', { startedAt: '2026-01-01T00:00:00Z', lastActiveAt: '2026-01-02T00:00:00Z' });
    const newer = mkThread('newer', { startedAt: '2026-01-01T00:00:00Z', lastActiveAt: '2026-01-05T00:00:00Z' });
    const result = decideConnectTarget({ candidates: [older, newer] });
    assert.equal(result.action, 'reuse');
    assert.equal(result.thread.id, 'newer');
  });

  test('lastActiveAt 全 NULL なら startedAt が最新のものを再利用', () => {
    const older = mkThread('older', { startedAt: '2026-01-01T00:00:00Z' });
    const newer = mkThread('newer', { startedAt: '2026-01-05T00:00:00Z' });
    const result = decideConnectTarget({ candidates: [older, newer] });
    assert.equal(result.action, 'reuse');
    assert.equal(result.thread.id, 'newer');
  });

  test('explicitSessionId が候補内にあれば最優先で再利用', () => {
    const older = mkThread('older', { startedAt: '2026-01-01T00:00:00Z' });
    const newer = mkThread('newer', { startedAt: '2026-01-05T00:00:00Z' });
    const result = decideConnectTarget({ candidates: [older, newer], explicitSessionId: 'older' });
    assert.equal(result.action, 'reuse');
    assert.equal(result.thread.id, 'older');
  });

  test('explicitSessionId が候補内に無ければ通常のソート結果にフォールバック', () => {
    const older = mkThread('older', { startedAt: '2026-01-01T00:00:00Z' });
    const newer = mkThread('newer', { startedAt: '2026-01-05T00:00:00Z' });
    const result = decideConnectTarget({ candidates: [older, newer], explicitSessionId: 'not-exist' });
    assert.equal(result.action, 'reuse');
    assert.equal(result.thread.id, 'newer');
  });
});

describe('resolvePreferredThreadId（サイクル4: //connect の直前スレッド優先）', () => {
  test('explicitSessionId があれば最優先', () => {
    const result = resolvePreferredThreadId({ explicitSessionId: 'explicit', contextSessionId: 'ctx' });
    assert.equal(result, 'explicit');
  });

  test('explicitSessionId が無ければ contextSessionId を使う', () => {
    const result = resolvePreferredThreadId({ explicitSessionId: null, contextSessionId: 'ctx' });
    assert.equal(result, 'ctx');
  });

  test('explicitSessionId が undefined でも contextSessionId にフォールバック', () => {
    const result = resolvePreferredThreadId({ contextSessionId: 'ctx' });
    assert.equal(result, 'ctx');
  });

  test('両方無ければ null', () => {
    const result = resolvePreferredThreadId({ explicitSessionId: null, contextSessionId: null });
    assert.equal(result, null);
  });

  test('空白のみの explicitSessionId は「指定なし」として扱い contextSessionId にフォールバック', () => {
    const result = resolvePreferredThreadId({ explicitSessionId: '   ', contextSessionId: 'ctx' });
    assert.equal(result, 'ctx');
  });

  test('空白のみの contextSessionId は null 扱い（両方空白なら null）', () => {
    const result = resolvePreferredThreadId({ explicitSessionId: '  ', contextSessionId: '  ' });
    assert.equal(result, null);
  });
});

describe('decideConnectTarget × resolvePreferredThreadId（//connect の統合ケース、サイクル4）', () => {
  test('直前 Session あり（候補に含まれる）→ そのスレッドへ接続', () => {
    const prev = mkThread('prev', { startedAt: '2026-01-01T00:00:00Z' });
    const latest = mkThread('latest', { startedAt: '2026-01-05T00:00:00Z' });
    const preferred = resolvePreferredThreadId({ contextSessionId: 'prev' });
    const result = decideConnectTarget({ candidates: [prev, latest], explicitSessionId: preferred });
    assert.equal(result.action, 'reuse');
    assert.equal(result.thread.id, 'prev');
  });

  test('直前 Session なし（新規タブ）→ 最新 active スレッドへ接続', () => {
    const older = mkThread('older', { startedAt: '2026-01-01T00:00:00Z' });
    const latest = mkThread('latest', { startedAt: '2026-01-05T00:00:00Z' });
    const preferred = resolvePreferredThreadId({ contextSessionId: null });
    const result = decideConnectTarget({ candidates: [older, latest], explicitSessionId: preferred });
    assert.equal(result.action, 'reuse');
    assert.equal(result.thread.id, 'latest');
  });

  test('直前 Session が候補に無い（別プロジェクトのセッション等）→ 最新 active にフォールバック（誤配送しない）', () => {
    const older = mkThread('older', { startedAt: '2026-01-01T00:00:00Z' });
    const latest = mkThread('latest', { startedAt: '2026-01-05T00:00:00Z' });
    const preferred = resolvePreferredThreadId({ contextSessionId: 'other-project-session' });
    const result = decideConnectTarget({ candidates: [older, latest], explicitSessionId: preferred });
    assert.equal(result.action, 'reuse');
    assert.equal(result.thread.id, 'latest');
  });
});

describe('resolveChatSessionId（S1〜S8 誤配送回帰）', () => {
  test('contextSessionId が null で複数候補ある場合は null を返す（旧実装は最初の1件を誤って返していた）', () => {
    const result = resolveChatSessionId({ contextSessionId: null, fallbackCandidates: ['B', 'C'] });
    assert.equal(result, null);
  });

  test('contextSessionId があれば常にそれを最優先で返す', () => {
    const result = resolveChatSessionId({ contextSessionId: 'A', fallbackCandidates: ['B', 'C'] });
    assert.equal(result, 'A');
  });

  test('contextSessionId が無く候補がちょうど1件なら後方互換でそれを返す', () => {
    const result = resolveChatSessionId({ contextSessionId: null, fallbackCandidates: ['B'] });
    assert.equal(result, 'B');
  });

  test('contextSessionId が無く候補も0件なら null', () => {
    const result = resolveChatSessionId({ contextSessionId: null, fallbackCandidates: [] });
    assert.equal(result, null);
  });

  test('contextSessionId が undefined でも同様に扱う', () => {
    const result = resolveChatSessionId({ contextSessionId: undefined, fallbackCandidates: ['B', 'C'] });
    assert.equal(result, null);
  });
});

describe('buildSessionInfoPayload（後方互換）', () => {
  test('title/agentScopeId が null の場合、現行実装と deep-equal（キー自体を含まない）', () => {
    const payload = buildSessionInfoPayload({
      projectId: 'proj1',
      sessionId: 'sess1',
      title: null,
      agentScopeId: null,
    });
    assert.deepEqual(payload, { projectId: 'proj1', sessionId: 'sess1' });
    assert.deepEqual(Object.keys(payload).sort(), ['projectId', 'sessionId']);
  });

  test('title/agentScopeId 未指定でも同様', () => {
    const payload = buildSessionInfoPayload({ projectId: 'proj1', sessionId: 'sess1' });
    assert.deepEqual(payload, { projectId: 'proj1', sessionId: 'sess1' });
  });

  test('title/agentScopeId がある場合は含める', () => {
    const payload = buildSessionInfoPayload({
      projectId: 'proj1',
      sessionId: 'sess1',
      title: 'My Thread',
      agentScopeId: 'sess1',
    });
    assert.deepEqual(payload, {
      projectId: 'proj1',
      sessionId: 'sess1',
      title: 'My Thread',
      agentScopeId: 'sess1',
    });
  });
});
