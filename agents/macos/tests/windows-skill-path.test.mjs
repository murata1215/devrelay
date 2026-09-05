// #364 1-C: windows-skill-path.ts の純関数テスト（linux/macos byte-for-byte 同一）。
// toWslPath()/toGitBashPath() は外部 import ゼロの純関数のため、コンパイル済み dist を直接 import する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toWslPath, toGitBashPath } from '../dist/services/windows-skill-path.js';

test('toWslPath: 基本形（バックスラッシュ区切り）', () => {
  assert.equal(
    toWslPath('C:\\Users\\lfuser\\.claude\\skills'),
    '/mnt/c/Users/lfuser/.claude/skills',
  );
});

test('toWslPath: 大文字ドライブレター', () => {
  assert.equal(toWslPath('C:\\Users\\x'), '/mnt/c/Users/x');
});

test('toWslPath: 小文字ドライブレター', () => {
  assert.equal(toWslPath('d:\\work\\proj'), '/mnt/d/work/proj');
});

test('toWslPath: スラッシュ区切り（既に一部 POSIX 風）', () => {
  assert.equal(toWslPath('C:/Users/lfuser/.claude/skills'), '/mnt/c/Users/lfuser/.claude/skills');
});

test('toWslPath: バックスラッシュ・スラッシュ混在', () => {
  assert.equal(toWslPath('C:\\Users/lfuser\\.claude/skills'), '/mnt/c/Users/lfuser/.claude/skills');
});

test('toWslPath: 末尾スラッシュあり', () => {
  assert.equal(toWslPath('C:\\Users\\lfuser\\'), '/mnt/c/Users/lfuser/');
});

test('toWslPath: UNC パスは null', () => {
  assert.equal(toWslPath('\\\\server\\share\\path'), null);
});

test('toWslPath: 既に POSIX 形の入力は null', () => {
  assert.equal(toWslPath('/mnt/c/Users/lfuser'), null);
  assert.equal(toWslPath('/c/Users/lfuser'), null);
});

test('toWslPath: ドライブレターが2文字以上は null', () => {
  assert.equal(toWslPath('CC:\\Users'), null);
});

test('toWslPath: 空文字列・非文字列は null', () => {
  assert.equal(toWslPath(''), null);
  // @ts-expect-error 実行時の防御的チェックを確認するため意図的に型を無視する
  assert.equal(toWslPath(undefined), null);
  // @ts-expect-error 同上
  assert.equal(toWslPath(null), null);
});

test('toWslPath: ルート直下（残り部分が空）', () => {
  assert.equal(toWslPath('C:\\'), '/mnt/c/');
  assert.equal(toWslPath('C:/'), '/mnt/c/');
});

test('toGitBashPath: 基本形（バックスラッシュ区切り）', () => {
  assert.equal(
    toGitBashPath('C:\\Users\\lfuser\\.claude\\skills'),
    '/c/Users/lfuser/.claude/skills',
  );
});

test('toGitBashPath: 大文字ドライブレター', () => {
  assert.equal(toGitBashPath('C:\\Users\\x'), '/c/Users/x');
});

test('toGitBashPath: 小文字ドライブレター', () => {
  assert.equal(toGitBashPath('d:\\work\\proj'), '/d/work/proj');
});

test('toGitBashPath: スラッシュ区切り', () => {
  assert.equal(toGitBashPath('C:/Users/lfuser/.claude/skills'), '/c/Users/lfuser/.claude/skills');
});

test('toGitBashPath: バックスラッシュ・スラッシュ混在', () => {
  assert.equal(toGitBashPath('C:\\Users/lfuser\\.claude/skills'), '/c/Users/lfuser/.claude/skills');
});

test('toGitBashPath: 末尾スラッシュあり', () => {
  assert.equal(toGitBashPath('C:\\Users\\lfuser\\'), '/c/Users/lfuser/');
});

test('toGitBashPath: UNC パスは null', () => {
  assert.equal(toGitBashPath('\\\\server\\share\\path'), null);
});

test('toGitBashPath: 既に POSIX 形の入力は null', () => {
  assert.equal(toGitBashPath('/mnt/c/Users/lfuser'), null);
  assert.equal(toGitBashPath('/c/Users/lfuser'), null);
});

test('toGitBashPath: ドライブレターが2文字以上は null', () => {
  assert.equal(toGitBashPath('CC:\\Users'), null);
});

test('toGitBashPath: 空文字列・非文字列は null', () => {
  assert.equal(toGitBashPath(''), null);
  // @ts-expect-error 実行時の防御的チェックを確認するため意図的に型を無視する
  assert.equal(toGitBashPath(undefined), null);
  // @ts-expect-error 同上
  assert.equal(toGitBashPath(null), null);
});

test('toGitBashPath: ルート直下（残り部分が空）', () => {
  assert.equal(toGitBashPath('C:\\'), '/c/');
  assert.equal(toGitBashPath('C:/'), '/c/');
});

test('例外を投げない（不正入力でも throw しない）', () => {
  assert.doesNotThrow(() => toWslPath('not a windows path'));
  assert.doesNotThrow(() => toGitBashPath('not a windows path'));
  assert.equal(toWslPath('not a windows path'), null);
  assert.equal(toGitBashPath('not a windows path'), null);
});
