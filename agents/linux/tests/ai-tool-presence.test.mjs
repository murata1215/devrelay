// Devin 専用端末で `a 1` しないと devin が選ばれない問題の対策（ai-tool-presence.ts）の単体テスト。
// 外部 import ゼロの純関数をコンパイル済み dist から直接 import する（devin-locator.test.mjs と同じ流儀）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aiToolFallbackCandidates,
  isPathLikeCommand,
  filterPresentAiTools,
  pickReplacementDefaultAiTool,
} from '../dist/services/ai-tool-presence.js';

// ---- filterPresentAiTools ----

test('filterPresentAiTools: claude エントリはあるが実体なし + devin 実在 → [devin]', () => {
  const present = new Set(['devin']);
  assert.deepEqual(filterPresentAiTools(['claude', 'devin'], (t) => present.has(t)), ['devin']);
});

test('filterPresentAiTools: 両方実在なら順序を保ったまま全部', () => {
  assert.deepEqual(filterPresentAiTools(['claude', 'gemini', 'devin'], () => true), ['claude', 'gemini', 'devin']);
});

test('filterPresentAiTools: 1 つも実在しなければ config のまま（後方互換）', () => {
  assert.deepEqual(filterPresentAiTools(['claude'], () => false), ['claude']);
});

test('filterPresentAiTools: 空配列は空配列', () => {
  assert.deepEqual(filterPresentAiTools([], () => true), []);
});

// ---- pickReplacementDefaultAiTool ----

test('pickReplacementDefaultAiTool: default=claude が実在せず devin 実在 → devin', () => {
  assert.equal(pickReplacementDefaultAiTool('claude', ['devin']), 'devin');
});

test('pickReplacementDefaultAiTool: default が実在するなら差し替えない', () => {
  assert.equal(pickReplacementDefaultAiTool('gemini', ['claude', 'gemini']), null);
});

test('pickReplacementDefaultAiTool: 実在ツールが無ければ差し替えない', () => {
  assert.equal(pickReplacementDefaultAiTool('claude', []), null);
});

test('pickReplacementDefaultAiTool: 優先順 claude > devin > gemini > codex > aider', () => {
  assert.equal(pickReplacementDefaultAiTool('aider', ['gemini', 'devin']), 'devin');
  assert.equal(pickReplacementDefaultAiTool(undefined, ['codex', 'gemini']), 'gemini');
});

// ---- isPathLikeCommand ----

test('isPathLikeCommand: コマンド名のみは false、パスは true', () => {
  assert.equal(isPathLikeCommand('devin'), false);
  assert.equal(isPathLikeCommand('/opt/devin/bin/devin'), true);
  assert.equal(isPathLikeCommand('C:\\tools\\devin.exe'), true);
});

// ---- aiToolFallbackCandidates ----

test('aiToolFallbackCandidates: darwin は /opt/homebrew/bin も見る', () => {
  assert.ok(aiToolFallbackCandidates('devin', 'devin', 'darwin', '/Users/u').includes('/opt/homebrew/bin/devin'));
  assert.ok(aiToolFallbackCandidates('gemini', 'gemini', 'darwin', '/Users/u').includes('/opt/homebrew/bin/gemini'));
});

test('aiToolFallbackCandidates: devin(linux) は ~/.local/bin/devin を含む', () => {
  assert.ok(aiToolFallbackCandidates('devin', 'devin', 'linux', '/home/u').includes('/home/u/.local/bin/devin'));
});

test('aiToolFallbackCandidates: claude(linux) は claude-locator の候補', () => {
  assert.ok(aiToolFallbackCandidates('claude', 'claude', 'linux', '/home/u').includes('/home/u/.claude/local/claude'));
});

test('aiToolFallbackCandidates: その他ツールは ~/.local/bin / npm グローバル', () => {
  assert.deepEqual(aiToolFallbackCandidates('gemini', 'gemini', 'linux', '/home/u'), ['/home/u/.local/bin/gemini', '/usr/local/bin/gemini']);
  assert.ok(aiToolFallbackCandidates('gemini', 'gemini', 'win32', 'C:\\Users\\u').includes('C:\\Users\\u\\AppData\\Roaming\\npm\\gemini.cmd'));
});

// ---- aiToolFallbackCandidates: execDir（2026-10-26 `spawn codex ENOENT` 障害の根治） ----

test('aiToolFallbackCandidates: execDir 省略時は従来どおり（後方互換）', () => {
  assert.deepEqual(
    aiToolFallbackCandidates('codex', 'codex', 'linux', '/home/u'),
    ['/home/u/.local/bin/codex', '/usr/local/bin/codex'],
  );
});

test('aiToolFallbackCandidates: execDir 指定時は候補の先頭に入る（codex, linux）', () => {
  assert.deepEqual(
    aiToolFallbackCandidates('codex', 'codex', 'linux', '/home/u', '/home/u/.nvm/versions/node/v20.20.0/bin'),
    ['/home/u/.nvm/versions/node/v20.20.0/bin/codex', '/home/u/.local/bin/codex', '/usr/local/bin/codex'],
  );
});

test('aiToolFallbackCandidates: execDir は claude/devin の分岐でも先頭に入る', () => {
  assert.equal(
    aiToolFallbackCandidates('claude', 'claude', 'linux', '/home/u', '/exec/bin')[0],
    '/exec/bin/claude',
  );
  assert.equal(
    aiToolFallbackCandidates('devin', 'devin', 'linux', '/home/u', '/exec/bin')[0],
    '/exec/bin/devin',
  );
});

test('aiToolFallbackCandidates: execDir は win32 では .cmd 拡張子になる', () => {
  assert.equal(
    aiToolFallbackCandidates('codex', 'codex', 'win32', 'C:\\Users\\u', 'C:\\nvm\\v20')[0],
    'C:\\nvm\\v20\\codex.cmd',
  );
});
