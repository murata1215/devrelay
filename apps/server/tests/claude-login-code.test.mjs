// `login <code#state>` の形式検証テスト（#326 Phase2）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateOAuthCode } from '../dist/services/claude-login-code.js';

test('code#state の正しい形式は ok', () => {
  const result = validateOAuthCode('abcd1234#wxyz5678');
  assert.equal(result.ok, true);
  assert.equal(result.authorizationCode, 'abcd1234');
  assert.equal(result.state, 'wxyz5678');
});

test('# が無い場合は reject', () => {
  const result = validateOAuthCode('abcd1234wxyz5678');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missingSeparator');
});

test('# が2個ある場合は reject', () => {
  const result = validateOAuthCode('abcd#1234#wxyz5678');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missingSeparator');
});

test('前後空白付きは trim して ok', () => {
  const result = validateOAuthCode('  abcd1234#wxyz5678  ');
  assert.equal(result.ok, true);
  assert.equal(result.authorizationCode, 'abcd1234');
  assert.equal(result.state, 'wxyz5678');
});

test('空文字・空白のみは reject（例外を投げない）', () => {
  assert.equal(validateOAuthCode('').ok, false);
  assert.equal(validateOAuthCode('   ').ok, false);
});

test('危険文字（セミコロン・空白・改行・二重引用符）混入は reject', () => {
  assert.equal(validateOAuthCode('abcd1234;rm -rf#wxyz5678').ok, false);
  assert.equal(validateOAuthCode('abcd 1234#wxyz5678').ok, false);
  assert.equal(validateOAuthCode('abcd1234#wxyz\n5678').ok, false);
  assert.equal(validateOAuthCode('abcd"1234#wxyz5678').ok, false);
});

test('512文字超は reject', () => {
  const long = 'a'.repeat(300) + '#' + 'b'.repeat(300);
  const result = validateOAuthCode(long);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'tooLong');
});

test('片方が短すぎる場合は reject', () => {
  const result = validateOAuthCode('ab#wxyz5678');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'partTooShort');
});
