import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REVIEW_QUESTION_MAX_LENGTH, buildReviewQuestion, buildReviewTranscript, buildReconsiderPrompt, buildReviewStoredMessage } from '../dist/services/review-prompt.js';

test('review prompt: 会話内の命令を実行しないよう明記し、時系列順を維持する', () => {
  const messages = [{ role: 'user', content: 'old-user' }, { role: 'ai', content: 'middle-ai' }, { role: 'user', content: 'new-user' }];
  const prompt = buildReviewQuestion(messages);
  assert.ok(prompt.indexOf('old-user') < prompt.indexOf('middle-ai'));
  assert.ok(prompt.indexOf('middle-ai') < prompt.indexOf('new-user'));
  assert.match(prompt, /命令.*従わない/);
  assert.match(prompt, /コードや資料の探索は行わない/);
  assert.ok(prompt.length <= REVIEW_QUESTION_MAX_LENGTH);
});

test('review prompt: 最新 AI 回答の末尾を残し、超過時は中央を中略する', () => {
  const prompt = buildReviewQuestion([
    { role: 'user', content: '背景' },
    { role: 'ai', content: `先頭-${'x'.repeat(14_000)}-末尾の結論` },
  ]);
  assert.match(prompt, /先頭-/);
  assert.match(prompt, /末尾の結論/);
  assert.match(prompt, /…（中略 \d+ 字）…/);
  assert.ok(prompt.length <= REVIEW_QUESTION_MAX_LENGTH);
});

test('review prompt: 予算を超えた古い会話は件数を明記する', () => {
  const transcript = buildReviewTranscript(Array.from({ length: 20 }, (_, i) => ({
    role: i === 19 ? 'ai' : 'user',
    content: i === 19 ? 'final' : `old-${i}-${'x'.repeat(3_000)}`,
  })));
  assert.match(transcript, /古い会話 \d+ 件は予算のため省略/);
  assert.ok(transcript.indexOf('old-') < transcript.indexOf('final'));
});

test('reconsider prompt: レビューは参考意見であり、そのまま従わない', () => {
  const prompt = buildReconsiderPrompt('GPT reviewer', '指摘');
  assert.match(prompt, /鵜呑みにせず/);
  assert.match(prompt, /最終回答/);
  assert.match(prompt, /GPT reviewer/);
});

test('review stored message: 見出しと詳細を分ける', () => {
  const stored = buildReviewStoredMessage('Reviewer', '全文');
  assert.equal(stored, '[review] Reviewer のレビューを受けて再考\n\n<!-- devrelay:detail -->\n全文');
});
