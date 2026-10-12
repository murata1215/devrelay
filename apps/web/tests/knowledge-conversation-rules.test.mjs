// 高辻ナレッジ サイクル4.5: apps/web/src/lib/knowledge-answer-rules.ts の会話継続ロジックの単体テスト。
// 外部 import ゼロの純関数をコンパイル済み dist-test から直接 import する
// （knowledge-answer-rules.test.mjs と同じ流儀）。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  IDLE_CONVERSATION,
  DISABLED_CONVERSATION,
  reduceConversation,
  buildFollowUpRequest,
  resolveCitationTarget,
} from '../dist-test/lib/knowledge-answer-rules.js';

function makeSource(ref, overrides = {}) {
  return {
    rank: ref,
    ref,
    sourceType: 'turn',
    sessionId: `sess${ref}`,
    aiMessageId: `msg${ref}`,
    projectId: 'proj1',
    title: `title${ref}`,
    projectName: 'proj',
    ownerName: 'owner',
    isOwn: true,
    occurredAt: '2026-10-01T00:00:00.000Z',
    level: 0,
    compartment: null,
    ...overrides,
  };
}

function makeDoneData(overrides = {}) {
  return {
    answer: 'answer text',
    sources: [],
    model: 'gpt-4o-mini',
    provider: 'openai',
    usage: { input: 10, output: 20 },
    context: { items: 1, omitted: 0, chars: 100 },
    elapsedMs: 1234,
    audited: false,
    ...overrides,
  };
}

describe('reduceConversation: idle/disabled 定数', () => {
  test('IDLE_CONVERSATION は空の会話', () => {
    assert.deepEqual(IDLE_CONVERSATION, { status: 'idle', turns: [], sources: [] });
  });
  test('DISABLED_CONVERSATION は disabled 状態', () => {
    assert.deepEqual(DISABLED_CONVERSATION, { status: 'disabled', turns: [], sources: [] });
  });
});

describe('reduceConversation: ask', () => {
  test('IDLE_CONVERSATION に ask すると 1 往復目が loading で積まれる', () => {
    const state = reduceConversation(IDLE_CONVERSATION, { type: 'ask', answerId: 'a1', question: '最初の質問' });
    assert.equal(state.status, 'loading');
    assert.equal(state.turns.length, 1);
    assert.equal(state.turns[0].question, '最初の質問');
    assert.equal(state.turns[0].answer.status, 'loading');
    assert.equal(state.turns[0].answer.answerId, 'a1');
    assert.deepEqual(state.sources, []);
  });

  test('既存の会話に ask すると新しい往復が末尾に積まれ、既存 turns/sources は維持される', () => {
    const afterFirst = reduceConversation(IDLE_CONVERSATION, { type: 'ask', answerId: 'a1', question: 'q1' });
    const afterDone = reduceConversation(afterFirst, {
      type: 'done',
      answerId: 'a1',
      data: makeDoneData({ answer: 'a1 answer', sources: [makeSource(1)] }),
    });
    const afterSecondAsk = reduceConversation(afterDone, { type: 'ask', answerId: 'a2', question: 'q2' });

    assert.equal(afterSecondAsk.turns.length, 2);
    assert.equal(afterSecondAsk.turns[0].question, 'q1');
    assert.equal(afterSecondAsk.turns[0].answer.status, 'done');
    assert.equal(afterSecondAsk.turns[1].question, 'q2');
    assert.equal(afterSecondAsk.turns[1].answer.status, 'loading');
    assert.deepEqual(afterSecondAsk.sources, [makeSource(1)]);
  });
});

describe('reduceConversation: delta/done/error は末尾ターンにのみ適用される', () => {
  test('delta は末尾ターンの answer.text に連結される', () => {
    const asked = reduceConversation(IDLE_CONVERSATION, { type: 'ask', answerId: 'a1', question: 'q' });
    const afterDelta = reduceConversation(asked, { type: 'delta', answerId: 'a1', text: 'He' });
    const afterDelta2 = reduceConversation(afterDelta, { type: 'delta', answerId: 'a1', text: 'llo' });
    assert.equal(afterDelta2.turns[0].answer.text, 'Hello');
    assert.equal(afterDelta2.status, 'streaming');
  });

  test('done で末尾ターンが確定し、sources が会話全体に統合される', () => {
    const asked = reduceConversation(IDLE_CONVERSATION, { type: 'ask', answerId: 'a1', question: 'q' });
    const done = reduceConversation(asked, {
      type: 'done',
      answerId: 'a1',
      data: makeDoneData({ answer: '確定した回答[1]', sources: [makeSource(1)] }),
    });
    assert.equal(done.status, 'done');
    assert.equal(done.turns[0].answer.status, 'done');
    assert.equal(done.turns[0].answer.text, '確定した回答[1]');
    assert.deepEqual(done.sources, [makeSource(1)]);
  });

  test('error で末尾ターンが error になる', () => {
    const asked = reduceConversation(IDLE_CONVERSATION, { type: 'ask', answerId: 'a1', question: 'q' });
    const errored = reduceConversation(asked, { type: 'error', answerId: 'a1', message: 'timeout' });
    assert.equal(errored.status, 'error');
    assert.equal(errored.turns[0].answer.errorMessage, 'timeout');
  });

  test('answerId 不一致の delta/done/error は無視される（state 参照そのまま）', () => {
    const asked = reduceConversation(IDLE_CONVERSATION, { type: 'ask', answerId: 'a1', question: 'q' });
    const ignoredDelta = reduceConversation(asked, { type: 'delta', answerId: 'stale', text: 'x' });
    const ignoredDone = reduceConversation(asked, { type: 'done', answerId: 'stale', data: makeDoneData() });
    const ignoredError = reduceConversation(asked, { type: 'error', answerId: 'stale', message: 'x' });
    assert.equal(ignoredDelta, asked);
    assert.equal(ignoredDone, asked);
    assert.equal(ignoredError, asked);
  });

  test('turns が空のときの delta/done/error は無視される（lastIndex<0 ガード）', () => {
    const result = reduceConversation(IDLE_CONVERSATION, { type: 'delta', answerId: 'a1', text: 'x' });
    assert.equal(result, IDLE_CONVERSATION);
  });

  test('確定済み（done/error）のターンに同じ answerId の delta が来ても上書きしない', () => {
    const asked = reduceConversation(IDLE_CONVERSATION, { type: 'ask', answerId: 'a1', question: 'q' });
    const done = reduceConversation(asked, { type: 'done', answerId: 'a1', data: makeDoneData({ answer: '確定' }) });
    const afterLateDelta = reduceConversation(done, { type: 'delta', answerId: 'a1', text: '追加分' });
    assert.equal(afterLateDelta, done);
  });
});

describe('reduceConversation: sources の ref 統合', () => {
  test('2 回目の done で新規 ref が追加され、既出 ref は上書きされる（ref 昇順で保持）', () => {
    const asked1 = reduceConversation(IDLE_CONVERSATION, { type: 'ask', answerId: 'a1', question: 'q1' });
    const done1 = reduceConversation(asked1, {
      type: 'done',
      answerId: 'a1',
      data: makeDoneData({ sources: [makeSource(2), makeSource(1)] }),
    });
    const asked2 = reduceConversation(done1, { type: 'ask', answerId: 'a2', question: 'q2' });
    const done2 = reduceConversation(asked2, {
      type: 'done',
      answerId: 'a2',
      data: makeDoneData({ sources: [makeSource(1, { title: '更新されたタイトル' }), makeSource(3)] }),
    });

    assert.deepEqual(done2.sources.map((s) => s.ref), [1, 2, 3]);
    assert.equal(done2.sources.find((s) => s.ref === 1).title, '更新されたタイトル');
  });
});

describe('reduceConversation: clear', () => {
  test('clear は IDLE_CONVERSATION に戻す', () => {
    const asked = reduceConversation(IDLE_CONVERSATION, { type: 'ask', answerId: 'a1', question: 'q' });
    const cleared = reduceConversation(asked, { type: 'clear' });
    assert.deepEqual(cleared, IDLE_CONVERSATION);
  });
});

describe('buildFollowUpRequest', () => {
  test('会話が空なら全て空', () => {
    const result = buildFollowUpRequest(IDLE_CONVERSATION, '質問');
    assert.deepEqual(result, { history: [], knownSources: [], previousQuestion: '' });
  });

  test('done な往復だけ history に入り、previousQuestion は最後の done の質問', () => {
    const asked1 = reduceConversation(IDLE_CONVERSATION, { type: 'ask', answerId: 'a1', question: '最初の質問' });
    const done1 = reduceConversation(asked1, {
      type: 'done',
      answerId: 'a1',
      data: makeDoneData({ answer: '最初の回答', sources: [makeSource(1)] }),
    });
    const asked2 = reduceConversation(done1, { type: 'ask', answerId: 'a2', question: '2 問目（進行中）' });

    const result = buildFollowUpRequest(asked2, '3 問目');
    assert.deepEqual(result.history, [{ question: '最初の質問', answer: '最初の回答' }]);
    assert.equal(result.previousQuestion, '最初の質問');
    assert.deepEqual(result.knownSources, [{ sourceType: 'turn', sourceId: 'msg1', sessionId: 'sess1', ref: 1 }]);
  });
});

describe('resolveCitationTarget', () => {
  const sources = [makeSource(1, { sessionId: 'sessA', aiMessageId: 'msgA' }), makeSource(2, { sessionId: 'sessB', aiMessageId: 'msgB' })];

  test('ref に対応するソースが無ければ null', () => {
    assert.equal(resolveCitationTarget(sources, [], 99), null);
  });

  test('カード一覧に同じ (sessionId, aiMessageId) があれば card を返す', () => {
    const cards = [{ sessionId: 'sessA', aiMessageId: 'msgA', occurredAt: '2026-10-01T00:00:00.000Z', rank: 5 }];
    const target = resolveCitationTarget(sources, cards, 1);
    assert.deepEqual(target, { kind: 'card', sessionId: 'sessA', aiMessageId: 'msgA', occurredAt: '2026-10-01T00:00:00.000Z', rank: 5 });
  });

  test('カード一覧に一致が無ければ viewer を返す（会話で新たに増えた根拠）', () => {
    const target = resolveCitationTarget(sources, [], 2);
    assert.deepEqual(target, { kind: 'viewer', sessionId: 'sessB', aiMessageId: 'msgB', occurredAt: '2026-10-01T00:00:00.000Z' });
  });
});
