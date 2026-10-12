// 高辻ナレッジ サイクル4.5: 会話継続（追い質問）の純ロジック単体テスト。
// 外部 import ゼロの純関数をコンパイル済み dist から直接 import する
// （knowledge-answer-rules.test.mjs と同じ流儀）。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeHistory,
  ANSWER_HISTORY_MAX_TURNS,
  ANSWER_HISTORY_QUESTION_CHARS,
  ANSWER_HISTORY_ANSWER_CHARS,
  buildConversationSearchQuery,
  normalizeKnownSources,
  ANSWER_KNOWN_SOURCES_MAX,
  mergeConversationSources,
  extractCitedRefs,
  evictForBudget,
  buildKnowledgePrompt,
} from '../dist/services/knowledge-answer-rules.js';

function makeItem(overrides = {}) {
  return {
    rank: 1,
    sourceType: 'turn',
    sessionId: 'sess1',
    aiMessageId: 'msg1',
    projectId: 'proj1',
    title: 'タイトル',
    projectName: 'proj',
    ownerUserId: 'u1',
    ownerName: 'owner',
    isOwn: true,
    occurredAt: '2026-10-01T00:00:00.000Z',
    level: 0,
    compartment: null,
    text: 'line1\nline2\nline3',
    ...overrides,
  };
}

describe('normalizeHistory', () => {
  test('配列でなければ空配列', () => {
    assert.deepEqual(normalizeHistory(undefined), []);
    assert.deepEqual(normalizeHistory(null), []);
    assert.deepEqual(normalizeHistory('x'), []);
  });

  test('7 往復渡すと直近 6 往復だけ残る（古い方を捨てる）', () => {
    const raw = Array.from({ length: 7 }, (_, i) => ({ question: `q${i}`, answer: `a${i}` }));
    const result = normalizeHistory(raw);
    assert.equal(result.length, ANSWER_HISTORY_MAX_TURNS);
    assert.equal(result[0].question, 'q1');
    assert.equal(result[result.length - 1].question, 'q6');
  });

  test('各質問は 1000 文字で行境界打ち切り', () => {
    const longQuestion = 'a'.repeat(1200) + '\nmore text after a newline';
    const result = normalizeHistory([{ question: longQuestion, answer: 'ok' }]);
    assert.ok(result[0].question.length <= ANSWER_HISTORY_QUESTION_CHARS);
  });

  test('各回答は 1500 文字で行境界打ち切り', () => {
    const longAnswer = 'b'.repeat(1700) + '\nmore text after a newline';
    const result = normalizeHistory([{ question: 'q', answer: longAnswer }]);
    assert.ok(result[0].answer.length <= ANSWER_HISTORY_ANSWER_CHARS);
  });

  test('不正要素（文字列でない question/answer、空文字）は捨てる', () => {
    const raw = [
      { question: 'ok1', answer: 'ok1' },
      { question: 123, answer: 'bad' },
      { question: 'bad', answer: null },
      { question: '', answer: 'empty question' },
      { question: 'empty answer', answer: '' },
      null,
      'not an object',
      { question: 'ok2', answer: 'ok2' },
    ];
    const result = normalizeHistory(raw);
    assert.deepEqual(result.map((r) => r.question), ['ok1', 'ok2']);
  });

  test('trim 後に判定する（前後空白のみの質問は空扱いで捨てる）', () => {
    const result = normalizeHistory([{ question: '   ', answer: 'a' }]);
    assert.deepEqual(result, []);
  });
});

describe('buildConversationSearchQuery', () => {
  test('previousQuestion があれば連結する', () => {
    const q = buildConversationSearchQuery({ previousQuestion: '前の質問', question: '今の質問' });
    assert.equal(q, '前の質問 今の質問');
  });

  test('previousQuestion が無ければ question のみ', () => {
    const q = buildConversationSearchQuery({ question: '今の質問' });
    assert.equal(q, '今の質問');
  });

  test('previousQuestion が空文字・空白のみなら question のみ', () => {
    assert.equal(buildConversationSearchQuery({ previousQuestion: '', question: 'q' }), 'q');
    assert.equal(buildConversationSearchQuery({ previousQuestion: '   ', question: 'q' }), 'q');
  });

  test('500 文字で切る', () => {
    const q = buildConversationSearchQuery({ previousQuestion: 'x'.repeat(300), question: 'y'.repeat(300) });
    assert.equal(q.length, 500);
  });
});

describe('normalizeKnownSources', () => {
  test('配列でなければ空配列', () => {
    assert.deepEqual(normalizeKnownSources(undefined), []);
  });

  test('正しい形のものだけ残す', () => {
    const raw = [
      { sourceType: 'turn', sourceId: 's1', sessionId: 'sess1', ref: 1 },
      { sourceType: 'turn', sourceId: 's2', sessionId: 'sess2', ref: 'bad' },
      { sourceType: 'turn', sourceId: 123, sessionId: 'sess3', ref: 3 },
      { sourceType: 'turn', sourceId: 's4', sessionId: 'sess4', ref: 0 },
      { sourceType: 'turn', sourceId: 's5', sessionId: 'sess5', ref: -1 },
      null,
      { sourceType: 'turn', sourceId: 's6', sessionId: 'sess6', ref: 6 },
    ];
    const result = normalizeKnownSources(raw);
    assert.deepEqual(result.map((r) => r.sourceId), ['s1', 's6']);
  });

  test('sourceId 重複は先に出てきた方を残す', () => {
    const raw = [
      { sourceType: 'turn', sourceId: 'dup', sessionId: 'sessA', ref: 1 },
      { sourceType: 'turn', sourceId: 'dup', sessionId: 'sessB', ref: 2 },
    ];
    const result = normalizeKnownSources(raw);
    assert.equal(result.length, 1);
    assert.equal(result[0].sessionId, 'sessA');
  });

  test(`${ANSWER_KNOWN_SOURCES_MAX} 件を超える分は切る（安全弁）`, () => {
    const raw = Array.from({ length: ANSWER_KNOWN_SOURCES_MAX + 10 }, (_, i) => ({
      sourceType: 'turn',
      sourceId: `s${i}`,
      sessionId: `sess${i}`,
      ref: i + 1,
    }));
    const result = normalizeKnownSources(raw);
    assert.equal(result.length, ANSWER_KNOWN_SOURCES_MAX);
  });
});

describe('mergeConversationSources', () => {
  test('既知の番号を維持し、新ヒットは続き番号で追加する', () => {
    const result = mergeConversationSources({
      known: [{ sourceType: 'turn', sourceId: 'k1', sessionId: 'sessK1', ref: 1 }, { sourceType: 'turn', sourceId: 'k2', sessionId: 'sessK2', ref: 3 }],
      newHits: [{ sourceType: 'turn', sourceId: 'n1', sessionId: 'sessN1' }, { sourceType: 'turn', sourceId: 'n2', sessionId: 'sessN2' }],
      visibleSourceIds: ['k1', 'k2', 'n1', 'n2'],
    });
    assert.deepEqual(result.items.map((i) => [i.sourceId, i.ref, i.origin]), [
      ['k1', 1, 'known'],
      ['k2', 3, 'known'],
      ['n1', 4, 'new'],
      ['n2', 5, 'new'],
    ]);
    assert.equal(result.added, 2);
    assert.equal(result.droppedInvisible, 0);
  });

  test('既出の新ヒット（既知と同じ sourceId）は重複追加しない', () => {
    const result = mergeConversationSources({
      known: [{ sourceType: 'turn', sourceId: 'dup', sessionId: 'sess1', ref: 1 }],
      newHits: [{ sourceType: 'turn', sourceId: 'dup', sessionId: 'sess1' }, { sourceType: 'turn', sourceId: 'fresh', sessionId: 'sess2' }],
      visibleSourceIds: ['dup', 'fresh'],
    });
    assert.deepEqual(result.items.map((i) => i.sourceId), ['dup', 'fresh']);
    assert.equal(result.items.find((i) => i.sourceId === 'fresh').ref, 2);
    assert.equal(result.added, 1);
  });

  test('不可視の既知は落とされ、番号は欠番のまま再利用されない', () => {
    const result = mergeConversationSources({
      known: [{ sourceType: 'turn', sourceId: 'k1', sessionId: 'sess1', ref: 1 }, { sourceType: 'turn', sourceId: 'k2', sessionId: 'sess2', ref: 2 }],
      newHits: [{ sourceType: 'turn', sourceId: 'n1', sessionId: 'sess3' }],
      visibleSourceIds: ['k1', 'n1'], // k2 は不可視
    });
    assert.deepEqual(result.items.map((i) => [i.sourceId, i.ref]), [
      ['k1', 1],
      ['n1', 3], // k2(ref=2) が落ちても 2 を再利用しない
    ]);
    assert.equal(result.droppedInvisible, 1);
  });

  test('known が空なら新ヒットは 1 から連番', () => {
    const result = mergeConversationSources({
      known: [],
      newHits: [{ sourceType: 'turn', sourceId: 'n1', sessionId: 'sess1' }, { sourceType: 'turn', sourceId: 'n2', sessionId: 'sess2' }],
      visibleSourceIds: ['n1', 'n2'],
    });
    assert.deepEqual(result.items.map((i) => i.ref), [1, 2]);
  });
});

describe('extractCitedRefs', () => {
  test('複数回答から [n] を全て抽出する（重複は 1 つに）', () => {
    const refs = extractCitedRefs(['Nim に変更された[2]。理由は[3]。', 'それは[2]のときです。']);
    assert.deepEqual([...refs].sort((a, b) => a - b), [2, 3]);
  });

  test('引用が無ければ空集合', () => {
    assert.equal(extractCitedRefs(['citation なし']).size, 0);
    assert.equal(extractCitedRefs([]).size, 0);
  });
});

describe('evictForBudget', () => {
  test('予算内なら何も落とさない', () => {
    const entries = [
      { ref: 1, origin: 'known', chars: 100, cited: true },
      { ref: 2, origin: 'new', chars: 100, cited: false },
    ];
    const result = evictForBudget(entries, 1000);
    assert.deepEqual(result.keptRefs, [1, 2]);
    assert.deepEqual(result.droppedRefs, []);
  });

  test('優先順位: 未引用の既知 → 新ヒット下位 → 引用済み既知の順に落ちる', () => {
    const entries = [
      { ref: 1, origin: 'known', chars: 500, cited: true }, // 引用済み既知: 最後まで残る
      { ref: 2, origin: 'known', chars: 500, cited: false }, // 未引用既知: 最初に落ちる
      { ref: 3, origin: 'new', chars: 500, cited: false }, // 新ヒット上位
      { ref: 4, origin: 'new', chars: 500, cited: false }, // 新ヒット下位: ref が大きいので先に落ちる
    ];
    // 合計 2000。予算 1500 → 未引用既知(ref2, 500)を落とせば remaining=1500 で予算内に収まる
    const result1 = evictForBudget(entries, 1500);
    assert.deepEqual(result1.droppedRefs, [2]);

    // 予算 900 → 未引用既知(ref2, 500)だけでは remaining=1500 で予算超過のまま → 新ヒット下位から
    // 順に落ち続け、ref4(500)+ref3(500)を落として remaining=500 でやっと予算内に収まる
    const result2 = evictForBudget(entries, 900);
    assert.deepEqual(result2.droppedRefs.sort(), [2, 3, 4]);
    // 引用済み既知（ref1）は他の 3 件を落とせば予算内に収まるため残る
    assert.deepEqual(result2.keptRefs, [1]);

    // 予算 300 → 未引用既知(ref2)+新下位(ref4)+新上位(ref3) = 1500 落としても remaining=500 で
    // まだ超過 → 最後に引用済み既知(ref1)も落ちる
    const result3 = evictForBudget(entries, 300);
    assert.deepEqual(result3.droppedRefs.sort(), [1, 2, 3, 4]);
  });

  test('引用済みの既知は他に落とせるものが無い限り残る', () => {
    const entries = [{ ref: 1, origin: 'known', chars: 1000, cited: true }];
    const result = evictForBudget(entries, 2000);
    assert.deepEqual(result.keptRefs, [1]);
    assert.deepEqual(result.droppedRefs, []);
  });
});

describe('buildKnowledgePrompt: history 対応（サイクル4.5）', () => {
  test('history 省略時はサイクル4 とバイト一致（items 空: user === question）', () => {
    const result = buildKnowledgePrompt({ language: 'ja', question: '質問', items: [] });
    assert.equal(result.user, '質問');
    assert.ok(!result.system.includes('会話の続き'));
  });

  test('history 省略時はサイクル4 とバイト一致（items 有り: 既存の excerpts 構成）', () => {
    const items = [makeItem({ rank: 1 })];
    const result = buildKnowledgePrompt({ language: 'ja', question: '経緯は？', items });
    assert.ok(result.user.includes('経緯は？'));
    assert.ok(result.user.includes('[1]'));
    assert.ok(!result.system.includes('会話の続き'));
  });

  test('history 省略時の messages は [{role:user, content:user}] の 1 件', () => {
    const result = buildKnowledgePrompt({ language: 'ja', question: '質問', items: [] });
    assert.deepEqual(result.messages, [{ role: 'user', content: '質問' }]);
  });

  test('history 有りなら system に会話継続の段落が付く（ja）', () => {
    const history = [{ question: '前の質問', answer: '前の回答[1]' }];
    const result = buildKnowledgePrompt({ language: 'ja', question: '追い質問', items: [], history });
    assert.ok(result.system.includes('会話の続き'));
  });

  test('history 有りなら system に会話継続の段落が付く（en）', () => {
    const history = [{ question: 'prev q', answer: 'prev a[1]' }];
    const result = buildKnowledgePrompt({ language: 'en', question: 'follow up', items: [], history });
    assert.ok(result.system.toLowerCase().includes('continuation'));
  });

  test('messages は history の各往復を user/assistant で並べ、末尾に今回の user を積む', () => {
    const history = [
      { question: 'q1', answer: 'a1' },
      { question: 'q2', answer: 'a2' },
    ];
    const result = buildKnowledgePrompt({ language: 'ja', question: '今回の質問', items: [], history });
    assert.deepEqual(result.messages, [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: '今回の質問' },
    ]);
  });

  test('items が空でも history があれば system に段落が付く（早期 return の外で扱われている）', () => {
    const history = [{ question: 'q', answer: 'a' }];
    const result = buildKnowledgePrompt({ language: 'ja', question: '質問', items: [], history });
    assert.equal(result.user, '質問');
    assert.ok(result.system.includes('会話の続き'));
  });
});
