// packages/shared/src/redact.ts のテスト（コンパイル済み dist を直接 import、node:test）
import test from 'node:test';
import assert from 'node:assert/strict';
import { redactChatInput } from '../dist/redact.js';

test('login <code#state> はコード部分をマスクする', () => {
  assert.equal(redactChatInput('login abc#xyz'), 'login ***');
});

test('login 単独（引数なし）は無変更', () => {
  assert.equal(redactChatInput('login'), 'login');
});

test('login cancel は無変更', () => {
  assert.equal(redactChatInput('login cancel'), 'login cancel');
});

test('login を含まない通常の文は完全に無変更', () => {
  const text = 'こんにちは、進捗はどうですか？';
  assert.equal(redactChatInput(text), text);
});

test('大文字 LOGIN でもマスクされる（大文字小文字を区別しない）', () => {
  assert.equal(redactChatInput('LOGIN abc#xyz'), 'LOGIN ***');
});
