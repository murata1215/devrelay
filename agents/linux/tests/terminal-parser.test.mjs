// 端末インタフェースモード（Terminal Mode）用パーサ（terminal-parser.ts）の単体テスト。
// 2026-09 に Claude Code の trust folder ダイアログが「番号なし・順序反転」レイアウトへ
// 変更され、無応答ハングが発生した実障害（20260909_113428_terminal-*.log）の回帰テストを含む。
//
// 他の純粋関数テストと同じ流儀で、コンパイル済み dist から直接 import する。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectStartupChoicePrompt,
  extractChoicePrompt,
  detectTrustPrompt,
  detectPromptReady,
} from '../dist/services/terminal-parser.js';

// --- 2026-09 新レイアウト（番号なし・順序反転、実障害ログの実文面） ---

const NEW_LAYOUT_SCREEN = [
  'Accessing workspace:',
  'C:\\Users\\fwjg2\\AndroidStudioProjects\\TestClock',
  '',
  "Quick safety check: Is this a project you created or one you trust? (Like your own code,",
  "a well-known open source project, or work from your team). If not, take a moment to review",
  "what's in this folder first.",
  "Claude Code'll be able to read, edit, and execute files here.",
  'Security guide',
  '❯ No, exit',
  '  Yes, I trust this folder',
  'Enter to confirm · Esc to cancel',
].join('\n');

test('detectStartupChoicePrompt: 新レイアウト（番号なしカーソルリスト）を検出する', () => {
  assert.equal(detectStartupChoicePrompt(NEW_LAYOUT_SCREEN), true);
});

test('extractChoicePrompt: 新レイアウトから2択・cursorIndex=0(No, exit)を抽出する', () => {
  const meta = extractChoicePrompt(NEW_LAYOUT_SCREEN);
  assert.ok(meta, 'meta should not be null');
  assert.deepEqual(meta.options, ['No, exit', 'Yes, I trust this folder']);
  assert.equal(meta.cursorIndex, 0, 'カーソルは No, exit（既定選択）に乗っている');
});

test('extractChoicePrompt: 新レイアウトの options に "Security guide" / 指示行を含めない', () => {
  const meta = extractChoicePrompt(NEW_LAYOUT_SCREEN);
  assert.ok(meta);
  for (const opt of meta.options) {
    assert.doesNotMatch(opt, /Security guide/);
    assert.doesNotMatch(opt, /Enter to confirm/);
  }
});

// --- 旧レイアウト（番号付き・Yes が先頭）の回帰防止 ---

const OLD_LAYOUT_SCREEN = [
  'Quick safety check: Is this a project you created or one you trust?',
  "Claude Code'll be able to read, edit, and execute files here.",
  '❯ 1. Yes, I trust this folder',
  '  2. No, exit',
  'Enter to confirm · Esc to cancel',
].join('\n');

test('detectStartupChoicePrompt: 旧レイアウト（番号付き）も引き続き検出する', () => {
  assert.equal(detectStartupChoicePrompt(OLD_LAYOUT_SCREEN), true);
});

test('extractChoicePrompt: 旧レイアウトから2択・cursorIndex=0(Yes)を抽出する（回帰防止）', () => {
  const meta = extractChoicePrompt(OLD_LAYOUT_SCREEN);
  assert.ok(meta);
  assert.deepEqual(meta.options, ['Yes, I trust this folder', 'No, exit']);
  assert.equal(meta.cursorIndex, 0);
});

// --- bypass permissions プロンプト（1. No, exit / 2. Yes, I accept 相当、逆順） ---

const BYPASS_LAYOUT_SCREEN = [
  'Bypass Permissions mode is not recommended.',
  '❯ 1. No, exit',
  '  2. Yes, I accept',
  'Enter to confirm · Esc to cancel',
].join('\n');

test('extractChoicePrompt: bypass permissions プロンプトから "Yes, I accept" の位置を特定できる', () => {
  const meta = extractChoicePrompt(BYPASS_LAYOUT_SCREEN);
  assert.ok(meta);
  const acceptIdx = meta.options.findIndex(o => /yes.*accept/i.test(o));
  assert.equal(acceptIdx, 1);
  assert.equal(meta.cursorIndex, 0);
});

// --- AskUserQuestion 形式（インデント説明文 + separator + Chat about this）の回帰防止（#228/#232） ---

const ASK_USER_QUESTION_SCREEN = [
  '依頼の意図を確認させてください',
  '❯ 1. 再ビルドしてexe生成',
  '       既存のelectron-builder設定で...',
  '  2. ビルドの仕組みを整備',
  '       ビルド手順書・npmスクリプト...',
  '  3. Type something.',
  '─────────────────',
  '  4. Chat about this',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
].join('\n');

test('extractChoicePrompt: AskUserQuestion 形式（説明文+separator）から4択を抽出する（回帰防止）', () => {
  const meta = extractChoicePrompt(ASK_USER_QUESTION_SCREEN);
  assert.ok(meta);
  assert.equal(meta.options.length, 4);
  assert.equal(meta.options[0], '再ビルドしてexe生成');
  assert.equal(meta.options[3], 'Chat about this');
  assert.equal(meta.cursorIndex, 0);
});

// --- 誤検出防止: 通常入力プロンプト（instruction行なし）は選択肢プロンプトと誤認しない ---

test('detectStartupChoicePrompt: 通常入力プロンプト（❯ Try "..."）は検出しない', () => {
  const normalPrompt = [
    '│ ❯ Try "add a dark mode toggle"',
    '╰──────────────────────────────',
  ].join('\n');
  assert.equal(detectStartupChoicePrompt(normalPrompt), false);
});

test('detectPromptReady: 通常入力プロンプトは true', () => {
  const normalPrompt = [
    '│ ❯ Try "add a dark mode toggle"',
    '╰──────────────────────────────',
  ].join('\n');
  assert.equal(detectPromptReady(normalPrompt), true);
});

// --- スクロールバックに過去の選択肢が残っていても最下部（最新）を採用する（#232 回帰防止） ---

test('extractChoicePrompt: スクロールバックの古い番号付きリストより最下部の現プロンプトを優先する', () => {
  const withScrollback = [
    '❯ 1. Old Option A',
    '  2. Old Option B',
    '  3. Old Option C',
    '  4. Old Option D',
    '',
    'Quick safety check: Is this a project you created or one you trust?',
    '❯ 1. Yes, I trust this folder',
    '  2. No, exit',
    'Enter to confirm · Esc to cancel',
  ].join('\n');
  const meta = extractChoicePrompt(withScrollback);
  assert.ok(meta);
  assert.deepEqual(meta.options, ['Yes, I trust this folder', 'No, exit']);
});

// --- detectTrustPrompt: レイアウト非依存の安全網（タイムアウト診断用） ---

test('detectTrustPrompt: 新レイアウトのテキストにも一致する（呼び出し元は起動タイムアウト診断のみ）', () => {
  assert.equal(detectTrustPrompt(NEW_LAYOUT_SCREEN), true);
});

test('detectTrustPrompt: 旧レイアウトのテキストにも一致する', () => {
  assert.equal(detectTrustPrompt(OLD_LAYOUT_SCREEN), true);
});

test('detectTrustPrompt: trust folder に無関係な画面では false', () => {
  assert.equal(detectTrustPrompt('│ ❯ Try "add a dark mode toggle"\n╰──'), false);
});
