// AI 回答契約サイクル（2026-11-23 第3版）: AI が境界行を書かなかった場合の要約フォールバック
// 純関数（reply-summary-rules.ts）の単体テスト。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isReplySummaryEnabled,
  clampSummaryMinChars,
  resolveSummaryMinChars,
  shouldSummarize,
  normalizeSummary,
  buildReplySummaryUserPrompt,
  REPLY_SUMMARY_SYSTEM_PROMPT,
  DEFAULT_SUMMARY_MIN_CHARS,
} from '../dist/services/reply-summary-rules.js';

test('isReplySummaryEnabled: 既定（未設定）は true', () => {
  assert.equal(isReplySummaryEnabled(undefined), true);
});
test("isReplySummaryEnabled: '0' のときだけ false", () => {
  assert.equal(isReplySummaryEnabled('0'), false);
  assert.equal(isReplySummaryEnabled('1'), true);
});

test('clampSummaryMinChars: 範囲内はそのまま', () => {
  assert.equal(clampSummaryMinChars(800), 800);
  assert.equal(clampSummaryMinChars(100), 100);
  assert.equal(clampSummaryMinChars(20000), 20000);
});
test('clampSummaryMinChars: 範囲外・不正値は既定値 or クランプ', () => {
  assert.equal(clampSummaryMinChars(0), DEFAULT_SUMMARY_MIN_CHARS);
  assert.equal(clampSummaryMinChars(-5), DEFAULT_SUMMARY_MIN_CHARS);
  assert.equal(clampSummaryMinChars(NaN), DEFAULT_SUMMARY_MIN_CHARS);
  assert.equal(clampSummaryMinChars(50), 100);
  assert.equal(clampSummaryMinChars(999999), 20000);
});

test('resolveSummaryMinChars: 未設定・不正値は既定 100', () => {
  assert.equal(resolveSummaryMinChars(undefined), 100);
  assert.equal(resolveSummaryMinChars('abc'), 100);
  assert.equal(resolveSummaryMinChars('0'), 100);
});
test('resolveSummaryMinChars: 設定値を使う', () => {
  assert.equal(resolveSummaryMinChars('500'), 500);
  assert.equal(resolveSummaryMinChars('50'), 100); // クランプ
});

test('shouldSummarize: 下限未満は false', () => {
  assert.equal(shouldSummarize({ length: 99, minChars: 100 }), false);
});
test('shouldSummarize: 下限以上は true', () => {
  assert.equal(shouldSummarize({ length: 100, minChars: 100 }), true);
  assert.equal(shouldSummarize({ length: 5000, minChars: 100 }), true);
});

test('normalizeSummary: 非文字列は null', () => {
  assert.equal(normalizeSummary(undefined, '元の文章'), null);
  assert.equal(normalizeSummary(null, '元の文章'), null);
});
test('normalizeSummary: 空白のみは null', () => {
  assert.equal(normalizeSummary('   ', '元の文章'), null);
});
test('normalizeSummary: 元の文より短くなっていなければ null（要約になっていない）', () => {
  const original = 'あ'.repeat(1000);
  assert.equal(normalizeSummary('い'.repeat(1000), original), null);
  assert.equal(normalizeSummary('い'.repeat(1200), original), null);
});
test('normalizeSummary: 元より短い要約は trim して返す', () => {
  const original = 'あ'.repeat(1000);
  assert.equal(normalizeSummary('  要約結果  ', original), '要約結果');
});

test('buildReplySummaryUserPrompt: 本文を含む', () => {
  const prompt = buildReplySummaryUserPrompt('テスト本文');
  assert.ok(prompt.includes('テスト本文'));
});

test('REPLY_SUMMARY_SYSTEM_PROMPT: 人間が実行する手順を省略しない旨が書かれている', () => {
  assert.ok(REPLY_SUMMARY_SYSTEM_PROMPT.includes('省略も要約もせず'));
});
test('REPLY_SUMMARY_SYSTEM_PROMPT: 表は使わない旨が書かれている（Discord/Telegram で崩れるため）', () => {
  assert.ok(REPLY_SUMMARY_SYSTEM_PROMPT.includes('表は使わない'));
});
