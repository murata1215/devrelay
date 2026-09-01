// #350: resolveSystemClaude() が使う OS 別 lookup コマンド/フォールバック候補パスの単体テスト。
// 外部 import ゼロの純粋関数（agents/linux/src/services/claude-locator.ts）を
// コンパイル済み dist から直接 import する（cli-failure.test.mjs と同じ流儀）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildClaudeLookupCommand, claudeFallbackCandidates } from '../dist/services/claude-locator.js';

// ---- buildClaudeLookupCommand ----

test('buildClaudeLookupCommand: win32 は where claude', () => {
  assert.equal(buildClaudeLookupCommand('win32'), 'where claude');
});

test('buildClaudeLookupCommand: linux は command -v claude', () => {
  assert.equal(buildClaudeLookupCommand('linux'), 'command -v claude');
});

test('buildClaudeLookupCommand: darwin は command -v claude', () => {
  assert.equal(buildClaudeLookupCommand('darwin'), 'command -v claude');
});

test('buildClaudeLookupCommand: 未知の platform も command -v claude（POSIX 側にフォールバック）', () => {
  assert.equal(buildClaudeLookupCommand('freebsd'), 'command -v claude');
});

// ---- claudeFallbackCandidates ----

test('claudeFallbackCandidates: win32 は Windows パス3件を home から組み立てる', () => {
  const candidates = claudeFallbackCandidates('win32', 'C:\\Users\\c-shiraki');
  assert.deepEqual(candidates, [
    'C:\\Users\\c-shiraki\\AppData\\Roaming\\npm\\claude.cmd',
    'C:\\Users\\c-shiraki\\AppData\\Local\\Programs\\claude\\claude.exe',
    'C:\\Users\\c-shiraki\\.local\\bin\\claude.cmd',
  ]);
});

test('claudeFallbackCandidates: linux は従来どおり4件のPOSIXパス', () => {
  const candidates = claudeFallbackCandidates('linux', '/home/devrelay');
  assert.deepEqual(candidates, [
    '/home/devrelay/.local/bin/claude',
    '/home/devrelay/.claude/local/claude',
    '/usr/local/bin/claude',
    '/usr/bin/claude',
  ]);
});

test('claudeFallbackCandidates: darwin も POSIX 候補と同じ組み立て方', () => {
  const candidates = claudeFallbackCandidates('darwin', '/Users/keisukemurata');
  assert.deepEqual(candidates, [
    '/Users/keisukemurata/.local/bin/claude',
    '/Users/keisukemurata/.claude/local/claude',
    '/usr/local/bin/claude',
    '/usr/bin/claude',
  ]);
});

test('claudeFallbackCandidates: 返り値は常に配列（空にはならない、静的候補のため）', () => {
  assert.ok(Array.isArray(claudeFallbackCandidates('win32', 'C:\\Users\\x')));
  assert.ok(claudeFallbackCandidates('win32', 'C:\\Users\\x').length > 0);
});
