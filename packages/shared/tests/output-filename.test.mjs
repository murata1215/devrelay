// packages/shared/src/text.ts の outputFileBaseName() のテスト（コンパイル済み dist を直接 import、node:test）
// 2026-11-22: .devrelay-output のサブフォルダ再帰収集に伴い filename が `/` 区切りの相対パスを
// 持つようになったため、下流（Discord/Telegram添付名・dev-report画像src・ZIPエントリ名・
// WebUIのdownload属性）で basename 化するために追加。

import test from 'node:test';
import assert from 'node:assert/strict';
import { outputFileBaseName } from '../dist/text.js';

test('単純なファイル名はそのまま返る', () => {
  assert.equal(outputFileBaseName('report.pdf'), 'report.pdf');
});

test('相対パスの最後のセグメントだけを返す', () => {
  assert.equal(outputFileBaseName('sub/deep/best.mp4'), 'best.mp4');
  assert.equal(outputFileBaseName('a/b/c.txt'), 'c.txt');
});

test('空文字は "file" を返す', () => {
  assert.equal(outputFileBaseName(''), 'file');
});

test('末尾が / で終わる（ファイル名部分が空）場合も "file" を返す', () => {
  assert.equal(outputFileBaseName('sub/'), 'file');
});

test('先頭が / の絶対パス風でも最後のセグメントを返す', () => {
  assert.equal(outputFileBaseName('/etc/passwd'), 'passwd');
});
