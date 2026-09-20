// raw-completion（ゲーム席用の素の completion API）の cwd 中立化ロジックの単体テスト。
// 外部 import ゼロの純粋関数（`resolveRawCwdPath` / `isRawCwdStatAcceptable`）のみを対象にする。
// `ensureRawCwd()`（実 I/O）はここでは検証しない（統合的な確認は実機スモークで行う）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RAW_CWD_PRIMARY_PATH,
  resolveRawCwdPath,
  isRawCwdStatAcceptable,
} from '../dist/services/raw-cwd.js';

// ---- RAW_CWD_PRIMARY_PATH ----

test('RAW_CWD_PRIMARY_PATH: /tmp/seat 固定（devrelay・ユーザー名を含まない）', () => {
  assert.equal(RAW_CWD_PRIMARY_PATH, '/tmp/seat');
  assert.doesNotMatch(RAW_CWD_PRIMARY_PATH, /devrelay/i);
});

// ---- resolveRawCwdPath ----

test('resolveRawCwdPath: linux では RAW_CWD_PRIMARY_PATH を返す', () => {
  assert.equal(resolveRawCwdPath('linux', '/tmp'), RAW_CWD_PRIMARY_PATH);
});

test('resolveRawCwdPath: darwin でも RAW_CWD_PRIMARY_PATH を返す（POSIX 共通）', () => {
  assert.equal(resolveRawCwdPath('darwin', '/tmp'), RAW_CWD_PRIMARY_PATH);
});

test('resolveRawCwdPath: win32 では tmpdir 配下の seat を返す（D4 対象外だが型上の完全性のため）', () => {
  assert.equal(resolveRawCwdPath('win32', 'C:\\Users\\devrelay\\AppData\\Local\\Temp'), 'C:\\Users\\devrelay\\AppData\\Local\\Temp\\seat');
});

test('resolveRawCwdPath: tmpdir が空文字でも例外を投げない', () => {
  assert.doesNotThrow(() => resolveRawCwdPath('win32', ''));
});

// ---- isRawCwdStatAcceptable ----

function stat({ isDirectory = true, isSymbolicLink = false, uid = 1000 } = {}) {
  return {
    isDirectory: () => isDirectory,
    isSymbolicLink: () => isSymbolicLink,
    uid,
  };
}

test('isRawCwdStatAcceptable: ディレクトリ・非symlink・所有uid一致なら true', () => {
  assert.equal(isRawCwdStatAcceptable(stat({ uid: 1000 }), 1000), true);
});

test('isRawCwdStatAcceptable: ディレクトリでなければ false', () => {
  assert.equal(isRawCwdStatAcceptable(stat({ isDirectory: false, uid: 1000 }), 1000), false);
});

test('isRawCwdStatAcceptable: symlink なら false', () => {
  assert.equal(isRawCwdStatAcceptable(stat({ isSymbolicLink: true, uid: 1000 }), 1000), false);
});

test('isRawCwdStatAcceptable: 所有uidが自プロセスと異なれば false（他ユーザー所有の /tmp/seat を拒否）', () => {
  assert.equal(isRawCwdStatAcceptable(stat({ uid: 0 }), 1000), false);
});

test('isRawCwdStatAcceptable: 複数条件が同時に不合格でも例外を投げず false', () => {
  assert.equal(isRawCwdStatAcceptable(stat({ isDirectory: false, isSymbolicLink: true, uid: 0 }), 1000), false);
});
