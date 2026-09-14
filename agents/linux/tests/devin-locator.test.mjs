// サイクルP3-A: resolveSystemDevin() が使う OS 別 lookup コマンド/フォールバック候補パスの単体テスト。
// 外部 import ゼロの純粋関数（agents/linux/src/services/devin-locator.ts）を
// コンパイル済み dist から直接 import する（claude-locator.test.mjs と同じ流儀）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDevinLookupCommand, devinFallbackCandidates } from '../dist/services/devin-locator.js';

// ---- buildDevinLookupCommand ----

test('buildDevinLookupCommand: win32 は where devin', () => {
  assert.equal(buildDevinLookupCommand('win32'), 'where devin');
});

test('buildDevinLookupCommand: linux は command -v devin', () => {
  assert.equal(buildDevinLookupCommand('linux'), 'command -v devin');
});

test('buildDevinLookupCommand: darwin は command -v devin', () => {
  assert.equal(buildDevinLookupCommand('darwin'), 'command -v devin');
});

test('buildDevinLookupCommand: 未知の platform も command -v devin（POSIX 側にフォールバック）', () => {
  assert.equal(buildDevinLookupCommand('freebsd'), 'command -v devin');
});

// ---- devinFallbackCandidates ----

test('devinFallbackCandidates: win32 は Windows パス3件を home から組み立てる', () => {
  const candidates = devinFallbackCandidates('win32', 'C:\\Users\\c-shiraki');
  assert.deepEqual(candidates, [
    'C:\\Users\\c-shiraki\\AppData\\Roaming\\npm\\devin.cmd',
    'C:\\Users\\c-shiraki\\AppData\\Local\\Programs\\devin\\devin.exe',
    'C:\\Users\\c-shiraki\\.local\\bin\\devin.cmd',
  ]);
});

test('devinFallbackCandidates: linux は3件のPOSIXパス', () => {
  const candidates = devinFallbackCandidates('linux', '/home/devrelay');
  assert.deepEqual(candidates, [
    '/home/devrelay/.local/bin/devin',
    '/usr/local/bin/devin',
    '/usr/bin/devin',
  ]);
});

test('devinFallbackCandidates: darwin も POSIX 候補と同じ組み立て方', () => {
  const candidates = devinFallbackCandidates('darwin', '/Users/keisukemurata');
  assert.deepEqual(candidates, [
    '/Users/keisukemurata/.local/bin/devin',
    '/usr/local/bin/devin',
    '/usr/bin/devin',
  ]);
});

test('devinFallbackCandidates: 返り値は常に配列（空にはならない、静的候補のため）', () => {
  assert.ok(Array.isArray(devinFallbackCandidates('win32', 'C:\\Users\\x')));
  assert.ok(devinFallbackCandidates('win32', 'C:\\Users\\x').length > 0);
});
