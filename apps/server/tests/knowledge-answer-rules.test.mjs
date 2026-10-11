// 高辻ナレッジ サイクル4: apps/server/src/services/knowledge-answer-rules.ts の単体テスト。
// 外部 import ゼロの純関数をコンパイル済み dist から直接 import する
// （knowledge-access.test.mjs / raw-completion-guard.test.mjs と同じ流儀）。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  isKnowledgeAnswerEnabled,
  buildKnowledgeContext,
  buildKnowledgePrompt,
  buildEmptyContextAnswer,
  sanitizeCitations,
  normalizeQuestion,
  normalizeAnswerId,
  resolveAnswerKey,
  ANSWER_KEY_MISSING_MESSAGE,
  DEFAULT_ANSWER_MODEL,
  ANSWER_QUESTION_MAX_LENGTH,
  createAnswerGuardState,
  pruneAnswerGuardState,
  acquireAnswerSlot,
  releaseAnswerSlot,
  ANSWER_MINUTE_RATE_LIMIT,
  ANSWER_DAY_RATE_LIMIT,
  ANSWER_MINUTE_WINDOW_MS,
  ANSWER_DAY_WINDOW_MS,
  ANSWER_SLOT_STALE_MS,
  decideDelivery,
} from '../dist/services/knowledge-answer-rules.js';

function makeItem(overrides = {}) {
  return {
    rank: 1,
    sourceType: 'turn',
    sessionId: 'sess1',
    aiMessageId: 'msg1',
    title: 'タイトル',
    projectName: 'proj',
    ownerName: 'owner',
    occurredAt: '2026-10-01T00:00:00.000Z',
    level: 0,
    compartment: null,
    text: 'line1\nline2\nline3',
    ...overrides,
  };
}

describe('isKnowledgeAnswerEnabled', () => {
  test('既定 ON（undefined）', () => {
    assert.equal(isKnowledgeAnswerEnabled(undefined), true);
  });
  test("'0' のときのみ OFF", () => {
    assert.equal(isKnowledgeAnswerEnabled('0'), false);
  });
  test("'1' や他の文字列は ON", () => {
    assert.equal(isKnowledgeAnswerEnabled('1'), true);
    assert.equal(isKnowledgeAnswerEnabled('true'), true);
  });
});

describe('buildKnowledgeContext', () => {
  test('予算内なら全件そのまま、omitted=0', () => {
    const items = [makeItem({ rank: 1 }), makeItem({ rank: 2, aiMessageId: 'msg2' })];
    const result = buildKnowledgeContext(items, { perItemChars: 1500, totalChars: 18000 });
    assert.equal(result.items.length, 2);
    assert.equal(result.omitted, 0);
    assert.equal(result.chars, items[0].text.length + items[1].text.length);
  });

  test('1 件あたりの文字数上限を超えると行境界で打ち切る', () => {
    const longText = 'a'.repeat(100) + '\n' + 'b'.repeat(100);
    const items = [makeItem({ text: longText })];
    const result = buildKnowledgeContext(items, { perItemChars: 150, totalChars: 18000 });
    assert.equal(result.items.length, 1);
    // 150 文字でスライスすると改行より後ろで切れる（'a'*100 + '\n' + 'b'*49 の151文字分…
    // スライスは0-149番目=150文字、改行はindex100にあるのでそこまで切り詰められる）
    assert.equal(result.items[0].text, 'a'.repeat(100));
    assert.ok(result.items[0].text.length <= 150);
  });

  test('改行が無い場合はハードカットする', () => {
    const items = [makeItem({ text: 'x'.repeat(200) })];
    const result = buildKnowledgeContext(items, { perItemChars: 50, totalChars: 18000 });
    assert.equal(result.items[0].text.length, 50);
  });

  test('合計予算を超える分は末尾側が omitted になり、rank に欠番は生じない', () => {
    const items = [
      makeItem({ rank: 1, aiMessageId: 'm1', text: 'x'.repeat(10) }),
      makeItem({ rank: 2, aiMessageId: 'm2', text: 'y'.repeat(10) }),
      makeItem({ rank: 3, aiMessageId: 'm3', text: 'z'.repeat(10) }),
    ];
    const result = buildKnowledgeContext(items, { perItemChars: 10, totalChars: 15 });
    // 1件目10文字で消費、2件目は残り5文字→5文字に切り詰め、3件目は残り0→omitted
    assert.equal(result.items.length, 2);
    assert.equal(result.items[0].rank, 1);
    assert.equal(result.items[1].rank, 2);
    assert.equal(result.omitted, 1);
    assert.equal(result.chars, 15);
  });

  test('空配列なら items=[] omitted=0 chars=0', () => {
    const result = buildKnowledgeContext([], { perItemChars: 1500, totalChars: 18000 });
    assert.deepEqual(result, { items: [], omitted: 0, chars: 0 });
  });

  test('totalChars が 0 なら全件 omitted', () => {
    const items = [makeItem()];
    const result = buildKnowledgeContext(items, { perItemChars: 1500, totalChars: 0 });
    assert.equal(result.items.length, 0);
    assert.equal(result.omitted, 1);
  });
});

describe('buildKnowledgePrompt', () => {
  test('ja: 固定システムプロンプト + 抜粋付き user プロンプト', () => {
    const items = [makeItem({ rank: 1 }), makeItem({ rank: 2, aiMessageId: 'm2' })];
    const result = buildKnowledgePrompt({ language: 'ja', question: '経緯は？', items });
    assert.ok(result.system.includes('[n]'));
    assert.ok(result.user.includes('経緯は？'));
    assert.ok(result.user.includes('[1]'));
    assert.ok(result.user.includes('[2]'));
  });

  test('en: 英語の固定システムプロンプト', () => {
    const result = buildKnowledgePrompt({ language: 'en', question: 'why?', items: [makeItem()] });
    assert.ok(result.system.includes('ONLY'));
    assert.ok(result.user.includes('why?'));
  });

  test('items が空なら抜粋ブロックを付けない（question のみ）', () => {
    const result = buildKnowledgePrompt({ language: 'ja', question: '質問', items: [] });
    assert.equal(result.user, '質問');
  });
});

describe('buildEmptyContextAnswer', () => {
  test('ja', () => {
    assert.ok(buildEmptyContextAnswer('ja').includes('見つかりませんでした'));
  });
  test('en', () => {
    assert.ok(buildEmptyContextAnswer('en').toLowerCase().includes('not found'));
  });
});

describe('sanitizeCitations', () => {
  test('有効な [n] はそのまま残る', () => {
    const result = sanitizeCitations('Nim に変更された[1]', [1, 2]);
    assert.equal(result.answer, 'Nim に変更された[1]');
    assert.deepEqual(result.cited, [1]);
  });

  test('無効な [n] は除去される', () => {
    const result = sanitizeCitations('何か[5]を言った', [1, 2]);
    assert.equal(result.answer, '何かを言った');
    assert.deepEqual(result.cited, []);
  });

  test('[n][m] の連続はどちらも有効なら両方残る', () => {
    const result = sanitizeCitations('決定された[1][2]', [1, 2]);
    assert.equal(result.answer, '決定された[1][2]');
    assert.deepEqual(result.cited, [1, 2]);
  });

  test('同じ番号を複数回引用しても cited は重複しない（初出順）', () => {
    const result = sanitizeCitations('[2]最初の話[1]次の話[2]また2番目', [1, 2]);
    assert.deepEqual(result.cited, [2, 1]);
    assert.ok(result.answer.includes('[1]'));
    assert.equal(result.answer.match(/\[2\]/g).length, 2);
  });

  test('validRefs が空なら全ての [n] が除去される', () => {
    const result = sanitizeCitations('text[1]more[2]', []);
    assert.equal(result.answer, 'textmore');
    assert.deepEqual(result.cited, []);
  });

  test('[n] を含まない本文はそのまま', () => {
    const result = sanitizeCitations('見つかりませんでした。', [1]);
    assert.equal(result.answer, '見つかりませんでした。');
    assert.deepEqual(result.cited, []);
  });
});

describe('normalizeQuestion', () => {
  test('trim 後 1〜1000 文字は OK', () => {
    const result = normalizeQuestion('  質問文  ');
    assert.deepEqual(result, { ok: true, value: '質問文' });
  });
  test('空文字・空白のみは NG', () => {
    assert.equal(normalizeQuestion('').ok, false);
    assert.equal(normalizeQuestion('   ').ok, false);
  });
  test('非文字列は NG', () => {
    assert.equal(normalizeQuestion(undefined).ok, false);
    assert.equal(normalizeQuestion(123).ok, false);
  });
  test(`${ANSWER_QUESTION_MAX_LENGTH} 文字はOK、${ANSWER_QUESTION_MAX_LENGTH + 1} 文字はNG（境界値）`, () => {
    assert.equal(normalizeQuestion('a'.repeat(ANSWER_QUESTION_MAX_LENGTH)).ok, true);
    assert.equal(normalizeQuestion('a'.repeat(ANSWER_QUESTION_MAX_LENGTH + 1)).ok, false);
  });
});

describe('normalizeAnswerId', () => {
  test('妥当な ID はそのまま使う', () => {
    assert.equal(normalizeAnswerId('abc-123_XYZ', 'fallback'), 'abc-123_XYZ');
  });
  test('不正な文字を含む場合は fallback', () => {
    assert.equal(normalizeAnswerId('abc 123', 'fallback'), 'fallback');
    assert.equal(normalizeAnswerId('a/b', 'fallback'), 'fallback');
  });
  test('未指定・非文字列は fallback', () => {
    assert.equal(normalizeAnswerId(undefined, 'fallback'), 'fallback');
    assert.equal(normalizeAnswerId(42, 'fallback'), 'fallback');
  });
  test('101 文字は NG（100 文字上限）', () => {
    assert.equal(normalizeAnswerId('a'.repeat(101), 'fallback'), 'fallback');
    assert.equal(normalizeAnswerId('a'.repeat(100), 'fallback'), 'a'.repeat(100));
  });
});

describe('resolveAnswerKey（ユーザー承認の最終決定: DEVRELAY_ANSWER_API_KEY 専用・フォールバック無し）', () => {
  test('envAnswerKey 未設定ならエラー（個人キーにも OPENAI_API_KEY にもフォールバックしない）', () => {
    const result = resolveAnswerKey({ envAnswerKey: undefined, envModel: undefined });
    assert.deepEqual(result, { ok: false, error: ANSWER_KEY_MISSING_MESSAGE });
  });
  test('空文字もエラー扱い', () => {
    const result = resolveAnswerKey({ envAnswerKey: '', envModel: undefined });
    assert.equal(result.ok, false);
  });
  test('envAnswerKey があれば provider=openai 固定・既定モデル', () => {
    const result = resolveAnswerKey({ envAnswerKey: 'sk-xxx', envModel: undefined });
    assert.deepEqual(result, { ok: true, provider: 'openai', apiKey: 'sk-xxx', model: DEFAULT_ANSWER_MODEL });
  });
  test('envModel 指定時はそれを使う', () => {
    const result = resolveAnswerKey({ envAnswerKey: 'sk-xxx', envModel: 'gpt-4.1' });
    assert.equal(result.ok, true);
    assert.equal(result.model, 'gpt-4.1');
  });
});

describe('acquireAnswerSlot / releaseAnswerSlot（判定順: busy → 分レート → 日レート → 成功）', () => {
  test('初回は成功', () => {
    const state = createAnswerGuardState();
    const decision = acquireAnswerSlot(state, { userId: 'u1', answerId: 'a1', nowMs: 1000 });
    assert.deepEqual(decision, { ok: true });
  });

  test('同一ユーザーが生成中なら busy で拒否される', () => {
    const state = createAnswerGuardState();
    acquireAnswerSlot(state, { userId: 'u1', answerId: 'a1', nowMs: 1000 });
    const decision = acquireAnswerSlot(state, { userId: 'u1', answerId: 'a2', nowMs: 1001 });
    assert.deepEqual(decision, { ok: false, status: 429, reason: 'answerBusy' });
  });

  test('release 後は再度取得できる', () => {
    const state = createAnswerGuardState();
    acquireAnswerSlot(state, { userId: 'u1', answerId: 'a1', nowMs: 1000 });
    releaseAnswerSlot(state, 'u1');
    const decision = acquireAnswerSlot(state, { userId: 'u1', answerId: 'a2', nowMs: 1001 });
    assert.deepEqual(decision, { ok: true });
  });

  test(`1 分間に ${ANSWER_MINUTE_RATE_LIMIT} 回を超えると minuteRateLimited`, () => {
    const state = createAnswerGuardState();
    let now = 0;
    for (let i = 0; i < ANSWER_MINUTE_RATE_LIMIT; i++) {
      const d = acquireAnswerSlot(state, { userId: 'u1', answerId: `a${i}`, nowMs: now });
      assert.equal(d.ok, true);
      releaseAnswerSlot(state, 'u1');
      now += 1;
    }
    const decision = acquireAnswerSlot(state, { userId: 'u1', answerId: 'aN', nowMs: now });
    assert.equal(decision.ok, false);
    assert.equal(decision.reason, 'minuteRateLimited');
    assert.ok(decision.retryAfterSec >= 1);
  });

  test('窓外（1分経過後）になれば分レートはリセットされる', () => {
    const state = createAnswerGuardState();
    for (let i = 0; i < ANSWER_MINUTE_RATE_LIMIT; i++) {
      acquireAnswerSlot(state, { userId: 'u1', answerId: `a${i}`, nowMs: 0 });
      releaseAnswerSlot(state, 'u1');
    }
    const decision = acquireAnswerSlot(state, { userId: 'u1', answerId: 'aN', nowMs: ANSWER_MINUTE_WINDOW_MS + 1 });
    assert.deepEqual(decision, { ok: true });
  });

  test(`1 日に ${ANSWER_DAY_RATE_LIMIT} 回を超えると dailyRateLimited（分レートに余裕を持たせて検証）`, () => {
    const state = createAnswerGuardState();
    // 分レート上限に引っかからないよう、各ヒットを1分以上ずつ離す
    let now = 0;
    for (let i = 0; i < ANSWER_DAY_RATE_LIMIT; i++) {
      const d = acquireAnswerSlot(state, { userId: 'u1', answerId: `a${i}`, nowMs: now });
      assert.equal(d.ok, true, `iteration ${i} should succeed`);
      releaseAnswerSlot(state, 'u1');
      now += ANSWER_MINUTE_WINDOW_MS + 1;
    }
    const decision = acquireAnswerSlot(state, { userId: 'u1', answerId: 'aN', nowMs: now });
    assert.equal(decision.ok, false);
    assert.equal(decision.reason, 'dailyRateLimited');
  });

  test('異なるユーザーは互いに影響しない', () => {
    const state = createAnswerGuardState();
    acquireAnswerSlot(state, { userId: 'u1', answerId: 'a1', nowMs: 1000 });
    const decision = acquireAnswerSlot(state, { userId: 'u2', answerId: 'a2', nowMs: 1000 });
    assert.deepEqual(decision, { ok: true });
  });

  test('stale なスロットは pruneAnswerGuardState で掃除される', () => {
    const state = createAnswerGuardState();
    acquireAnswerSlot(state, { userId: 'u1', answerId: 'a1', nowMs: 0 });
    pruneAnswerGuardState(state, ANSWER_SLOT_STALE_MS + 1);
    assert.equal(state.slots.has('u1'), false);
  });
});

describe('decideDelivery', () => {
  test('stream=true かつ WS 接続中 → ws', () => {
    assert.equal(decideDelivery({ stream: true, wsConnected: true }), 'ws');
  });
  test('stream=true だが WS 未接続 → http', () => {
    assert.equal(decideDelivery({ stream: true, wsConnected: false }), 'http');
  });
  test('stream=false → http（WS 接続有無を問わない）', () => {
    assert.equal(decideDelivery({ stream: false, wsConnected: true }), 'http');
  });
});
