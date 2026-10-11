// 高辻ナレッジ サイクル4: apps/web/src/lib/knowledge-answer-rules.ts の単体テスト。
// 外部 import ゼロの純関数をコンパイル済み dist-test から直接 import する
// （knowledge-search-rules.test.mjs と同じ流儀）。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  tokenizeAnswerMarkdown,
  reduceAnswerStream,
  IDLE_ANSWER_STATE,
  startingAnswerState,
  DISABLED_ANSWER_STATE,
  parseAnswerToggleValue,
  serializeAnswerToggleValue,
  ANSWER_TOGGLE_DEFAULT,
  isKnowledgeAnswerDisabledError,
  isKnowledgeAnswerKeyMissingError,
  KNOWLEDGE_ANSWER_DISABLED_MESSAGE,
  KNOWLEDGE_ANSWER_KEY_MISSING_MESSAGE,
  buildAnswerRequestFilters,
} from '../dist-test/lib/knowledge-answer-rules.js';

describe('tokenizeAnswerMarkdown', () => {
  test('見出し（#〜######）を認識する', () => {
    const blocks = tokenizeAnswerMarkdown('## 見出し');
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].kind, 'heading');
    assert.equal(blocks[0].level, 2);
    assert.deepEqual(blocks[0].segments, [{ kind: 'text', text: '見出し' }]);
  });

  test('箇条書き（- / *）を認識する', () => {
    const blocks = tokenizeAnswerMarkdown('- 項目1\n* 項目2');
    assert.equal(blocks[0].kind, 'bullet');
    assert.equal(blocks[1].kind, 'bullet');
  });

  test('空行は blank', () => {
    const blocks = tokenizeAnswerMarkdown('text1\n\ntext2');
    assert.equal(blocks.length, 3);
    assert.equal(blocks[1].kind, 'blank');
  });

  test('それ以外は段落として扱う', () => {
    const blocks = tokenizeAnswerMarkdown('普通の文章');
    assert.equal(blocks[0].kind, 'paragraph');
  });

  test('インラインコード `code` を認識する', () => {
    const blocks = tokenizeAnswerMarkdown('これは `code` です');
    const segs = blocks[0].segments;
    assert.ok(segs.some((s) => s.kind === 'code' && s.text === 'code'));
  });

  test('太字 **bold** を認識する', () => {
    const blocks = tokenizeAnswerMarkdown('これは **重要** です');
    const segs = blocks[0].segments;
    assert.ok(segs.some((s) => s.kind === 'bold' && s.text === '重要'));
  });

  test('[n] を citation セグメントとして認識する', () => {
    const blocks = tokenizeAnswerMarkdown('Nim に変更された[2]');
    const segs = blocks[0].segments;
    const citation = segs.find((s) => s.kind === 'citation');
    assert.ok(citation);
    assert.equal(citation.rank, 2);
    assert.equal(citation.raw, '[2]');
  });

  test('生 HTML タグはテキストとしてそのまま残る（解釈・除去しない）', () => {
    const blocks = tokenizeAnswerMarkdown('<script>alert(1)</script>');
    const segs = blocks[0].segments;
    assert.equal(segs.length, 1);
    assert.equal(segs[0].kind, 'text');
    assert.equal(segs[0].text, '<script>alert(1)</script>');
  });

  test('text/citation セグメントを連結すると元の行に戻る（citation は raw、他は text を使う。code/bold は装飾マーカー自体を消費する設計のため対象外）', () => {
    const line = 'a [3] b [10] c';
    const blocks = tokenizeAnswerMarkdown(line);
    const joined = blocks[0].segments.map((s) => (s.kind === 'citation' ? s.raw : s.text)).join('');
    assert.equal(joined, line);
  });

  test('空文字列は 1 件の blank ブロック', () => {
    const blocks = tokenizeAnswerMarkdown('');
    assert.deepEqual(blocks, [{ kind: 'blank' }]);
  });
});

describe('reduceAnswerStream', () => {
  const doneData = {
    answer: '確定した回答[1]',
    sources: [{ rank: 1, sourceType: 'turn', sessionId: 's1', aiMessageId: 'm1', title: 't', projectName: 'p', ownerName: 'o', occurredAt: '2026-01-01', level: 0, compartment: null }],
    model: 'gpt-4o-mini',
    provider: 'openai',
    usage: { input: 100, output: 50 },
    context: { items: 1, omitted: 0, chars: 10 },
    elapsedMs: 1234,
    audited: true,
  };

  test('delta は answerId 一致時のみ text を連結する', () => {
    let state = startingAnswerState('a1');
    state = reduceAnswerStream(state, { type: 'delta', answerId: 'a1', text: 'Hello' });
    assert.equal(state.status, 'streaming');
    assert.equal(state.text, 'Hello');
    state = reduceAnswerStream(state, { type: 'delta', answerId: 'a1', text: ' World' });
    assert.equal(state.text, 'Hello World');
  });

  test('answerId 不一致の delta は無視される', () => {
    const state = startingAnswerState('a1');
    const next = reduceAnswerStream(state, { type: 'delta', answerId: 'a2', text: 'ignored' });
    assert.equal(next, state);
  });

  test('done で確定版に置き換わる', () => {
    let state = startingAnswerState('a1');
    state = reduceAnswerStream(state, { type: 'delta', answerId: 'a1', text: '途中経過' });
    state = reduceAnswerStream(state, { type: 'done', answerId: 'a1', data: doneData });
    assert.equal(state.status, 'done');
    assert.equal(state.text, doneData.answer);
    assert.deepEqual(state.sources, doneData.sources);
    assert.equal(state.model, 'gpt-4o-mini');
    assert.equal(state.audited, true);
  });

  test('done 後に届く delta は無視される（確定後は上書きしない）', () => {
    let state = startingAnswerState('a1');
    state = reduceAnswerStream(state, { type: 'done', answerId: 'a1', data: doneData });
    const next = reduceAnswerStream(state, { type: 'delta', answerId: 'a1', text: 'late' });
    assert.equal(next, state);
  });

  test('error で errorMessage が設定される', () => {
    let state = startingAnswerState('a1');
    state = reduceAnswerStream(state, { type: 'error', answerId: 'a1', message: 'timeout' });
    assert.equal(state.status, 'error');
    assert.equal(state.errorMessage, 'timeout');
  });

  test('answerId 不一致の done/error も無視される', () => {
    const state = startingAnswerState('a1');
    assert.equal(reduceAnswerStream(state, { type: 'done', answerId: 'a2', data: doneData }), state);
    assert.equal(reduceAnswerStream(state, { type: 'error', answerId: 'a2', message: 'x' }), state);
  });

  test('IDLE_ANSWER_STATE は answerId=null のため、どの delta/done/error も無視する', () => {
    const next = reduceAnswerStream(IDLE_ANSWER_STATE, { type: 'delta', answerId: 'a1', text: 'x' });
    assert.equal(next, IDLE_ANSWER_STATE);
  });
});

describe('トグルの既定値ロジック', () => {
  test('既定は ON', () => {
    assert.equal(ANSWER_TOGGLE_DEFAULT, true);
  });
  test("'1' → true, '0' → false", () => {
    assert.equal(parseAnswerToggleValue('1'), true);
    assert.equal(parseAnswerToggleValue('0'), false);
  });
  test('null・未指定・不正値は既定値（ON）にフォールバック', () => {
    assert.equal(parseAnswerToggleValue(null), true);
    assert.equal(parseAnswerToggleValue(undefined), true);
    assert.equal(parseAnswerToggleValue('garbage'), true);
  });
  test('serialize は往復する', () => {
    assert.equal(parseAnswerToggleValue(serializeAnswerToggleValue(true)), true);
    assert.equal(parseAnswerToggleValue(serializeAnswerToggleValue(false)), false);
  });
});

describe('エラー文言判定', () => {
  test('isKnowledgeAnswerDisabledError は完全一致のみ true', () => {
    assert.equal(isKnowledgeAnswerDisabledError(KNOWLEDGE_ANSWER_DISABLED_MESSAGE), true);
    assert.equal(isKnowledgeAnswerDisabledError('other'), false);
    assert.equal(isKnowledgeAnswerDisabledError(null), false);
  });
  test('isKnowledgeAnswerKeyMissingError は完全一致のみ true', () => {
    assert.equal(isKnowledgeAnswerKeyMissingError(KNOWLEDGE_ANSWER_KEY_MISSING_MESSAGE), true);
    assert.equal(isKnowledgeAnswerKeyMissingError('other'), false);
  });
});

describe('DISABLED_ANSWER_STATE', () => {
  test('status が disabled で初期化されている', () => {
    assert.equal(DISABLED_ANSWER_STATE.status, 'disabled');
    assert.equal(DISABLED_ANSWER_STATE.answerId, null);
  });
});

describe('buildAnswerRequestFilters', () => {
  test('query は除外し、maxLevel/limit は数値化する', () => {
    const filters = buildAnswerRequestFilters([
      ['query', 'hello'],
      ['scope', 'mine'],
      ['maxLevel', '3'],
      ['limit', '20'],
    ]);
    assert.deepEqual(filters, { scope: 'mine', maxLevel: 3, limit: 20 });
  });

  test('空配列なら空オブジェクト', () => {
    assert.deepEqual(buildAnswerRequestFilters([]), {});
  });

  test('未知のキーは無視する', () => {
    assert.deepEqual(buildAnswerRequestFilters([['unknown', 'x']]), {});
  });
});
