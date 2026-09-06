// #368 Phase 2a サブサイクルA: git-guard-core.ts の単体テスト。
// 外部 import ゼロの純関数（agents/linux/src/services/git-guard-core.ts）を
// コンパイル済み dist から直接 import する（devin-file-watch.test.mjs と同じ流儀）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePorcelainZ,
  isGuardExcludedPath,
  isSafeRelativePath,
  diffAgainstBaseline,
  classifyRestoreAction,
} from '../dist/services/git-guard-core.js';

// --- parsePorcelainZ ---

test('parsePorcelainZ: 空文字列は空配列', () => {
  assert.deepEqual(parsePorcelainZ(''), []);
});

test('parsePorcelainZ: 通常の1レコード（末尾NULあり）', () => {
  const raw = ' M src/index.ts\0';
  const entries = parsePorcelainZ(raw);
  assert.deepEqual(entries, [{ x: ' ', y: 'M', path: 'src/index.ts', origPath: null }]);
});

test('parsePorcelainZ: 通常の1レコード（末尾NULなし）', () => {
  const raw = ' M src/index.ts';
  const entries = parsePorcelainZ(raw);
  assert.deepEqual(entries, [{ x: ' ', y: 'M', path: 'src/index.ts', origPath: null }]);
});

test('parsePorcelainZ: リネーム（R）は新パス→旧パスの2トークンを消費する（実測仕様）', () => {
  const raw = 'R  renamed.txt\0tracked.txt\0?? untracked.txt\0';
  const entries = parsePorcelainZ(raw);
  assert.deepEqual(entries, [
    { x: 'R', y: ' ', path: 'renamed.txt', origPath: 'tracked.txt' },
    { x: '?', y: '?', path: 'untracked.txt', origPath: null },
  ]);
});

test('parsePorcelainZ: コピー（C）も同様に2トークンを消費する', () => {
  const raw = 'C  copied.txt\0original.txt\0';
  const entries = parsePorcelainZ(raw);
  assert.deepEqual(entries, [{ x: 'C', y: ' ', path: 'copied.txt', origPath: 'original.txt' }]);
});

test('parsePorcelainZ: 未追跡（??）はorigPathがnullのまま1トークン', () => {
  const raw = '?? new-file.txt\0';
  const entries = parsePorcelainZ(raw);
  assert.deepEqual(entries, [{ x: '?', y: '?', path: 'new-file.txt', origPath: null }]);
});

test('parsePorcelainZ: 無視対象（!!）も1トークン', () => {
  const raw = '!! dist/build.js\0';
  const entries = parsePorcelainZ(raw);
  assert.deepEqual(entries, [{ x: '!', y: '!', path: 'dist/build.js', origPath: null }]);
});

test('parsePorcelainZ: 複数レコード混在（通常+リネーム+未追跡）', () => {
  const raw = ' M a.txt\0R  new-b.txt\0old-b.txt\0?? c.txt\0';
  const entries = parsePorcelainZ(raw);
  assert.equal(entries.length, 3);
  assert.deepEqual(entries[0], { x: ' ', y: 'M', path: 'a.txt', origPath: null });
  assert.deepEqual(entries[1], { x: 'R', y: ' ', path: 'new-b.txt', origPath: 'old-b.txt' });
  assert.deepEqual(entries[2], { x: '?', y: '?', path: 'c.txt', origPath: null });
});

test('parsePorcelainZ: リネームの次トークンが空文字なら消費せず1トークン扱い（防御的）', () => {
  const raw = 'R  odd.txt\0\0';
  const entries = parsePorcelainZ(raw);
  assert.deepEqual(entries, [{ x: 'R', y: ' ', path: 'odd.txt', origPath: null }]);
});

test('parsePorcelainZ: 3文字未満の不正トークンは無視する', () => {
  const raw = 'M\0 M valid.txt\0';
  const entries = parsePorcelainZ(raw);
  assert.deepEqual(entries, [{ x: ' ', y: 'M', path: 'valid.txt', origPath: null }]);
});

test('parsePorcelainZ: 空の末尾トークンは無視する', () => {
  const raw = ' M a.txt\0 M b.txt\0';
  const entries = parsePorcelainZ(raw);
  assert.equal(entries.length, 2);
});

// --- isGuardExcludedPath ---

test('isGuardExcludedPath: .git配下は除外', () => {
  assert.equal(isGuardExcludedPath('.git/index'), true);
});

test('isGuardExcludedPath: .devrelay配下は除外', () => {
  assert.equal(isGuardExcludedPath('.devrelay/reverted/x.txt'), true);
});

test('isGuardExcludedPath: .devrelay-output配下は除外（成果物保護）', () => {
  assert.equal(isGuardExcludedPath('.devrelay-output/result.md'), true);
});

test('isGuardExcludedPath: 通常のソースファイルは除外されない', () => {
  assert.equal(isGuardExcludedPath('src/services/foo.ts'), false);
});

test('isGuardExcludedPath: Windowsパス区切りも正しく判定される', () => {
  assert.equal(isGuardExcludedPath('.git\\index'), true);
  assert.equal(isGuardExcludedPath('.devrelay-output\\result.md'), true);
});

test('isGuardExcludedPath: 空文字はfalse（例外を投げない）', () => {
  assert.equal(isGuardExcludedPath(''), false);
});

// --- isSafeRelativePath ---

test('isSafeRelativePath: 通常の相対パスは安全', () => {
  assert.equal(isSafeRelativePath('src/index.ts'), true);
});

test('isSafeRelativePath: ".."を含むパスは拒否', () => {
  assert.equal(isSafeRelativePath('../etc/passwd'), false);
  assert.equal(isSafeRelativePath('src/../../etc/passwd'), false);
});

test('isSafeRelativePath: 絶対パス（/始まり）は拒否', () => {
  assert.equal(isSafeRelativePath('/etc/passwd'), false);
});

test('isSafeRelativePath: Windows絶対パス（C:/...）は拒否', () => {
  assert.equal(isSafeRelativePath('C:/Windows/system32'), false);
  assert.equal(isSafeRelativePath('C:'), false);
});

test('isSafeRelativePath: NULバイトを含むパスは拒否', () => {
  assert.equal(isSafeRelativePath('foo\0bar'), false);
});

test('isSafeRelativePath: Windows区切りの安全なパスは許可', () => {
  assert.equal(isSafeRelativePath('src\\index.ts'), true);
});

test('isSafeRelativePath: 空文字は拒否', () => {
  assert.equal(isSafeRelativePath(''), false);
});

// --- diffAgainstBaseline ---

test('diffAgainstBaseline: 既存dirtyで同じステータスなら差分に含めない', () => {
  const before = [{ x: ' ', y: 'M', path: 'a.txt', origPath: null }];
  const after = [{ x: ' ', y: 'M', path: 'a.txt', origPath: null }];
  assert.deepEqual(diffAgainstBaseline(before, after), []);
});

test('diffAgainstBaseline: 同じパスでもステータスが変わっていれば差分に含める', () => {
  const before = [{ x: ' ', y: 'M', path: 'a.txt', origPath: null }];
  const after = [{ x: 'M', y: ' ', path: 'a.txt', origPath: null }];
  const diff = diffAgainstBaseline(before, after);
  assert.equal(diff.length, 1);
  assert.equal(diff[0].path, 'a.txt');
});

test('diffAgainstBaseline: beforeに無い新規パスは差分に含める', () => {
  const before = [];
  const after = [{ x: '?', y: '?', path: 'new.txt', origPath: null }];
  const diff = diffAgainstBaseline(before, after);
  assert.equal(diff.length, 1);
  assert.equal(diff[0].path, 'new.txt');
});

test('diffAgainstBaseline: 両方空なら差分なし', () => {
  assert.deepEqual(diffAgainstBaseline([], []), []);
});

// --- classifyRestoreAction ---

test('classifyRestoreAction: 未追跡（??）はquarantine', () => {
  assert.equal(classifyRestoreAction({ x: '?', y: '?', path: 'x.txt', origPath: null }), 'quarantine');
});

test('classifyRestoreAction: 無視対象（!!）はskip', () => {
  assert.equal(classifyRestoreAction({ x: '!', y: '!', path: 'x.txt', origPath: null }), 'skip');
});

test('classifyRestoreAction: 追跡済みの変更はcheckout', () => {
  assert.equal(classifyRestoreAction({ x: ' ', y: 'M', path: 'x.txt', origPath: null }), 'checkout');
});

test('classifyRestoreAction: 追跡済みの追加もcheckout', () => {
  assert.equal(classifyRestoreAction({ x: 'A', y: ' ', path: 'x.txt', origPath: null }), 'checkout');
});

test('classifyRestoreAction: リネームもcheckout', () => {
  assert.equal(classifyRestoreAction({ x: 'R', y: ' ', path: 'new.txt', origPath: 'old.txt' }), 'checkout');
});
