// #372: 会話履歴の圧縮ユーティリティ（history-compaction.ts）の単体テスト。
// 外部 import ゼロの純粋関数をコンパイル済み dist から直接 import する
// （sdk-loop-guard.test.mjs / running-code-stale.test.mjs と同じ流儀）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MAX_PLAN_MESSAGES,
  DEFAULT_MIN_SUBSTANTIVE_CHARS,
  MEMORY_INDEX_WARN_BYTES,
  isProgressMarkerLine,
  stripProgressMarkers,
  selectPlanMessages,
  claudeProjectSlug,
  claudeMemoryIndexPath,
  shouldWarnMemoryIndex,
} from '../dist/services/history-compaction.js';
import { tChat } from '@devrelay/shared';

/** テスト用: 実質的な assistant メッセージ（しきい値超え）を作る */
const bigText = (marker = 'plan') => marker + 'あ'.repeat(DEFAULT_MIN_SUBSTANTIVE_CHARS);

// ============================================================
// A. isProgressMarkerLine / stripProgressMarkers
// ============================================================

test('A1: ja / en の進捗マーカー行を検出する', () => {
  assert.equal(isProgressMarkerLine('🔧 Bashを使用中...'), true);
  assert.equal(isProgressMarkerLine('🔧 Using Bash...'), true);
  assert.equal(isProgressMarkerLine('  🔧 ToolSearchを使用中...  '), true);
  assert.equal(isProgressMarkerLine('🔧 mcp__claude_ai_devrelay__get_planを使用中...'), true);
});

test('A2: 通常の文・空行は進捗マーカーと見なさない', () => {
  assert.equal(isProgressMarkerLine(''), false);
  assert.equal(isProgressMarkerLine('   '), false);
  assert.equal(isProgressMarkerLine('実装が完了しました。'), false);
  // 🔧 で始まっても「使用中...」で終わらない通常文は残す
  assert.equal(isProgressMarkerLine('🔧 このツールの設計方針について説明します'), false);
  assert.equal(isProgressMarkerLine('🔧 Bashを使用中'), false);
});

test('A3: i18n 追従ガード — progress.usingTool の実出力にマッチすること', () => {
  // packages/shared/src/i18n.ts の progress.usingTool が変わったらここで落ちる
  for (const lang of ['ja', 'en']) {
    const line = tChat(lang, 'progress.usingTool', { tool: 'Bash' });
    assert.equal(isProgressMarkerLine(line), true, `lang=${lang} line=${line}`);
  }
});

test('A4: 進捗マーカーを除去し、連続空行を 1 行に畳む', () => {
  const input = [
    '🔧 ToolSearchを使用中...',
    '',
    '🔧 Readを使用中...',
    '',
    '調査の結果、原因は X でした。',
    '',
    '',
    '🔧 Editを使用中...',
    '',
    '修正しました。',
    '',
  ].join('\n');
  assert.equal(stripProgressMarkers(input), '調査の結果、原因は X でした。\n\n修正しました。');
});

test('A5: 全文が進捗マーカーなら空文字を返す', () => {
  assert.equal(stripProgressMarkers('🔧 Bashを使用中...\n\n🔧 Using Read...\n'), '');
});

test('A6: 不正入力でも例外を投げない', () => {
  assert.equal(stripProgressMarkers(''), '');
  assert.equal(stripProgressMarkers(undefined), '');
  assert.equal(stripProgressMarkers(null), '');
  assert.equal(isProgressMarkerLine(undefined), false);
});

// ============================================================
// B. selectPlanMessages
// ============================================================

test('B1: 直前の exec 以降で切る（それより前のサイクルは含めない）', () => {
  const history = [
    { role: 'user', content: '2 サイクル前の依頼' },
    { role: 'assistant', content: bigText('2 サイクル前のプラン') },
    { role: 'exec', content: '--- EXEC ---' },
    { role: 'user', content: '実装して' },
    { role: 'assistant', content: bigText('前サイクルの実装報告') },
    { role: 'user', content: '今回の依頼' },
    { role: 'assistant', content: bigText('今回のプラン') },
    { role: 'exec', content: '--- EXEC ---' },
  ];
  const got = selectPlanMessages(history, 7);
  // 直前の exec（index 2）以降だけ = 4 件。2 サイクル前は落ちる。
  // 「前サイクルの実装報告」は直前 exec のターンそのものなので残す（何をやった直後かの文脈）。
  assert.equal(got.length, 4);
  assert.ok(got.every(h => !h.content.startsWith('2 サイクル前')), '2 サイクル前が混入している');
  assert.ok(got[0].content.startsWith('実装して'));
  assert.ok(got[1].content.startsWith('前サイクルの実装報告'));
  assert.ok(got[3].content.startsWith('今回のプラン'));
});

test('B2: e 連打で無内容ターンだけが挟まった場合は 1 つ前の exec まで遡る', () => {
  // 実際に 2026-09-07 に起きた形（exec → Ready のみ → exec → Ready のみ → exec）
  const ready = 'Ready — the tool set is loaded. What would you like me to do next?';
  const history = [
    { role: 'user', content: '組織にAIデフォルトを作りたい。プラン立てて' },
    { role: 'assistant', content: bigText('承認済みプラン本体') },
    { role: 'exec', content: '--- EXEC ---' },
    { role: 'user', content: 'プランに従って実装を開始してください。' },
    { role: 'assistant', content: `🔧 ToolSearchを使用中...\n${ready}` },
    { role: 'exec', content: '--- EXEC ---' },
    { role: 'user', content: 'プランに従って実装を開始してください。' },
    { role: 'assistant', content: `🔧 ToolSearchを使用中...\n${ready}` },
    { role: 'exec', content: '--- EXEC ---' },
  ];
  const got = selectPlanMessages(history, 8);
  // プラン本体が残っていること（これが落ちると exec が「Ready」だけで終わる）
  assert.ok(got.some(h => h.content.startsWith('承認済みプラン本体')), JSON.stringify(got.map(h => h.content.slice(0, 20))));
});

test('B3: exec マーカーが 1 つも無ければ履歴の先頭から（上限件数まで）', () => {
  const history = [
    { role: 'user', content: 'a' },
    { role: 'assistant', content: bigText('b') },
    { role: 'exec', content: '--- EXEC ---' },
  ];
  const got = selectPlanMessages(history, 2);
  assert.deepEqual(got.map(h => h.role), ['user', 'assistant']);
});

test('B4: 上限件数を超えたら直近側を残す', () => {
  const history = [];
  for (let i = 0; i < 30; i++) history.push({ role: 'user', content: `m${i}` });
  history.push({ role: 'exec', content: '--- EXEC ---' });
  const got = selectPlanMessages(history, 30);
  assert.equal(got.length, DEFAULT_MAX_PLAN_MESSAGES);
  assert.equal(got[got.length - 1].content, 'm29');
});

test('B5: 遡っても上限件数に達したらそこで打ち切る（無限遡上しない）', () => {
  // 実質的な assistant が一切無い履歴（exec が大量に並ぶ）
  const history = [];
  for (let i = 0; i < 20; i++) {
    history.push({ role: 'exec', content: '--- EXEC ---' });
    history.push({ role: 'user', content: `u${i}` });
    history.push({ role: 'assistant', content: 'ok' });
  }
  history.push({ role: 'exec', content: '--- EXEC ---' });
  const got = selectPlanMessages(history, history.length - 1);
  assert.ok(got.length <= DEFAULT_MAX_PLAN_MESSAGES);
});

test('B6: exec マーカーは結果に含めない / 異常入力は空配列', () => {
  const history = [
    { role: 'user', content: 'a' },
    { role: 'exec', content: '--- EXEC ---' },
    { role: 'user', content: 'b' },
    { role: 'exec', content: '--- EXEC ---' },
  ];
  // exec マーカー自体は結果に含めない。実質的な assistant が 1 件も無いので
  // 遡りフォールバックが働き、履歴の先頭まで広がる（従来挙動と同じ安全側）。
  assert.deepEqual(selectPlanMessages(history, 3).map(h => h.role), ['user', 'user']);
  assert.ok(selectPlanMessages(history, 3).every(h => h.role !== 'exec'));
  assert.deepEqual(selectPlanMessages(history, -1), []);
  assert.deepEqual(selectPlanMessages([], 0), []);
  assert.deepEqual(selectPlanMessages(history, 3, { maxPlanMessages: 0 }), []);
});

// ============================================================
// C. Claude 自動メモリ索引のパス解決 / 警告判定
// ============================================================

test('C1: この機体の実ディレクトリ名と一致すること', () => {
  // 実在する ~/.claude/projects/ 配下のディレクトリ名（2026-09-07 実測）
  assert.equal(claudeProjectSlug('/opt/devrelay'), '-opt-devrelay');
  assert.equal(claudeProjectSlug('/opt/devrelay/doc'), '-opt-devrelay-doc');
  assert.equal(
    claudeProjectSlug('/home/devrelay/testflight/mimamori-server'),
    '-home-devrelay-testflight-mimamori-server'
  );
  assert.equal(
    claudeProjectSlug('/tmp/claude-1001/-home-devrelay/7600c084-54db-41bc-8414-0b8f4cbc2ba8/scratchpad'),
    '-tmp-claude-1001--home-devrelay-7600c084-54db-41bc-8414-0b8f4cbc2ba8-scratchpad'
  );
});

test('C2: MEMORY.md の絶対パスを組み立てる（末尾スラッシュを吸収）', () => {
  assert.equal(
    claudeMemoryIndexPath('/home/devrelay/.claude', '/opt/devrelay'),
    '/home/devrelay/.claude/projects/-opt-devrelay/memory/MEMORY.md'
  );
  assert.equal(
    claudeMemoryIndexPath('/home/devrelay/.claude/', '/opt/devrelay'),
    '/home/devrelay/.claude/projects/-opt-devrelay/memory/MEMORY.md'
  );
});

test('C3: しきい値超過かつ未警告のときだけ true', () => {
  assert.equal(shouldWarnMemoryIndex(MEMORY_INDEX_WARN_BYTES + 1, false), true);
  assert.equal(shouldWarnMemoryIndex(MEMORY_INDEX_WARN_BYTES, false), false);
  assert.equal(shouldWarnMemoryIndex(330079, true), false); // 警告済みなら再送しない
  assert.equal(shouldWarnMemoryIndex(0, false), false);
  assert.equal(shouldWarnMemoryIndex(NaN, false), false);
});
