// AI 回答契約サイクル（2026-11-23 改訂）: AI が「人間向け本文」と「詳細」を分けて書くための
// 契約をプロンプト先頭に前置する brief-reply-rules.ts の単体テスト。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isBriefReplyEnabled,
  shouldPrependBriefReplyLine,
  BRIEF_REPLY_PROMPT_LINE,
} from '../dist/services/brief-reply-rules.js';
import { DETAIL_BOUNDARY_MARKER } from '../dist/services/response-split-rules.js';

test('isBriefReplyEnabled: 既定（未設定）は true', () => {
  assert.equal(isBriefReplyEnabled(undefined), true);
});
test("isBriefReplyEnabled: '0' のときだけ false", () => {
  assert.equal(isBriefReplyEnabled('0'), false);
  assert.equal(isBriefReplyEnabled('1'), true);
});

test('shouldPrependBriefReplyLine: 通常ターンは true', () => {
  assert.equal(shouldPrependBriefReplyLine({}), true);
});
test('shouldPrependBriefReplyLine: terminalMode は false', () => {
  assert.equal(shouldPrependBriefReplyLine({ terminalMode: true }), false);
});
test('shouldPrependBriefReplyLine: statePolicy あり（クロスユーザー ask）は false', () => {
  assert.equal(shouldPrependBriefReplyLine({ hasStatePolicy: true }), false);
});
test('shouldPrependBriefReplyLine: handoverTurn は false', () => {
  assert.equal(shouldPrependBriefReplyLine({ handoverTurn: true }), false);
});

test('BRIEF_REPLY_PROMPT_LINE: 空でない文字列で、境界マーカーの記法を案内している', () => {
  assert.equal(typeof BRIEF_REPLY_PROMPT_LINE, 'string');
  assert.ok(BRIEF_REPLY_PROMPT_LINE.length > 0);
  assert.ok(BRIEF_REPLY_PROMPT_LINE.includes(DETAIL_BOUNDARY_MARKER), '境界マーカーの記法そのものを案内していること');
});

test('BRIEF_REPLY_PROMPT_LINE: 振り分け基準が行数・書式でないことを明示している', () => {
  // 「行数」「文字数」「字」のような長さ基準の指示語を含まないことを確認する
  // （過去の設計訂正: 当初「10行以内」等の上限を指示していたがユーザー指摘で撤回した）
  assert.ok(!/\d+\s*行以内/.test(BRIEF_REPLY_PROMPT_LINE), '行数での上限指示が残っていないこと');
  assert.ok(!/\d+\s*文字以内/.test(BRIEF_REPLY_PROMPT_LINE), '文字数での上限指示が残っていないこと');
});

test('BRIEF_REPLY_PROMPT_LINE: 人間が実行する手順を省略しないことを明示している', () => {
  assert.ok(BRIEF_REPLY_PROMPT_LINE.includes('省略しない'));
});

test('BRIEF_REPLY_PROMPT_LINE: 分割不要な場合はそのまま返してよいことを明示している', () => {
  assert.ok(BRIEF_REPLY_PROMPT_LINE.includes('そのまま返してください'));
});
