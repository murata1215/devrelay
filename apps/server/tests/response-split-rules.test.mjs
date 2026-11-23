// AI 回答契約サイクル（2026-11-23）: AI 応答を「人間向け本文」と「詳細」に分ける
// 純関数（response-split-rules.ts）の単体テスト。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitAiResponse,
  hasDetailSection,
  joinWithoutLink,
  DETAIL_BOUNDARY_MARKER,
} from '../dist/services/response-split-rules.js';

test('境界行が無ければ全文が summary、detail は null', () => {
  const r = splitAiResponse('結論です。\n次の手順をお願いします。');
  assert.equal(r.summary, '結論です。\n次の手順をお願いします。');
  assert.equal(r.detail, null);
  assert.equal(hasDetailSection(r), false);
});

test('境界行で summary/detail に分かれる', () => {
  const raw = `結論です。\n${DETAIL_BOUNDARY_MARKER}\n調査過程の詳細です。`;
  const r = splitAiResponse(raw);
  assert.equal(r.summary, '結論です。');
  assert.equal(r.detail, '調査過程の詳細です。');
  assert.equal(hasDetailSection(r), true);
});

test('境界行の前後の空白は許容する', () => {
  const raw = `結論です。\n  ${DETAIL_BOUNDARY_MARKER}  \n詳細です。`;
  const r = splitAiResponse(raw);
  assert.equal(r.summary, '結論です。');
  assert.equal(r.detail, '詳細です。');
});

test('境界行が複数ある場合は最初の1つだけを使う（2つ目以降は detail の一部）', () => {
  const raw = `本文\n${DETAIL_BOUNDARY_MARKER}\n詳細A\n${DETAIL_BOUNDARY_MARKER}\n詳細B`;
  const r = splitAiResponse(raw);
  assert.equal(r.summary, '本文');
  assert.ok(r.detail.includes('詳細A'));
  assert.ok(r.detail.includes(DETAIL_BOUNDARY_MARKER));
  assert.ok(r.detail.includes('詳細B'));
});

test('コードフェンス内の境界行は分割対象にしない（例示をそのまま書いても誤爆しない）', () => {
  const raw = [
    '記法の例です。',
    '```',
    DETAIL_BOUNDARY_MARKER,
    '```',
    '以上です。',
  ].join('\n');
  const r = splitAiResponse(raw);
  assert.equal(r.detail, null);
  assert.ok(r.summary.includes(DETAIL_BOUNDARY_MARKER));
});

test('境界後が空白のみなら detail は null（分割なしと同じ扱い）', () => {
  const raw = `結論です。\n${DETAIL_BOUNDARY_MARKER}\n   \n`;
  const r = splitAiResponse(raw);
  assert.equal(r.summary, '結論です。');
  assert.equal(r.detail, null);
});

test('進捗ノイズ行（🔧使用中/📊 Rate Limit）は summary からも detail からも除去される', () => {
  const raw = [
    '📊 Rate Limit: 5h: 10%',
    '🔧 Bashを使用中...',
    '結論です。',
    DETAIL_BOUNDARY_MARKER,
    '🔧 Editを使用中...',
    '詳細です。',
  ].join('\n');
  const r = splitAiResponse(raw);
  assert.equal(r.summary, '結論です。');
  assert.equal(r.detail, '詳細です。');
});

test('非文字列入力は summary 空文字・detail null', () => {
  const r = splitAiResponse(undefined);
  assert.equal(r.summary, '');
  assert.equal(r.detail, null);
});

test('joinWithoutLink: detail が無ければ summary のみ', () => {
  assert.equal(joinWithoutLink({ summary: 'A', detail: null }), 'A');
});
test('joinWithoutLink: detail があれば summary+detail を連結する', () => {
  assert.equal(joinWithoutLink({ summary: 'A', detail: 'B' }), 'A\n\nB');
});
test('joinWithoutLink: summary が空なら detail のみ', () => {
  assert.equal(joinWithoutLink({ summary: '', detail: 'B' }), 'B');
});
