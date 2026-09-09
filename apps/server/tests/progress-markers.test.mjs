// 2026-09-09 サイクル: BuildLog summary「不明」調査に伴う進捗マーカー除去（progress-markers.ts）の単体テスト。
// 外部 import ゼロの純粋関数（apps/server/src/services/progress-markers.ts）を
// コンパイル済み dist から直接 import する（stop-reason.test.mjs と同じ流儀）。
// ロジックは agents/linux/src/services/history-compaction.ts の同名関数の写しであり、
// 挙動が一致することもここで確認する。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isProgressMarkerLine, stripProgressMarkers } from '../dist/services/progress-markers.js';

// ---- isProgressMarkerLine ----

test('isProgressMarkerLine: 日本語の進捗マーカー行を検出する', () => {
  assert.equal(isProgressMarkerLine('🔧 Editを使用中...'), true);
  assert.equal(isProgressMarkerLine('🔧 Bashを使用中...'), true);
});

test('isProgressMarkerLine: 英語の進捗マーカー行を検出する', () => {
  assert.equal(isProgressMarkerLine('🔧 Using Edit...'), true);
  assert.equal(isProgressMarkerLine('🔧 Using Bash...'), true);
});

test('isProgressMarkerLine: 前後の空白があってもマッチする（trim される）', () => {
  assert.equal(isProgressMarkerLine('  🔧 Editを使用中...  '), true);
});

test('isProgressMarkerLine: 通常のテキストは false', () => {
  assert.equal(isProgressMarkerLine('agent-manager.ts に BuildLog の AI 要約機能を追加。'), false);
  assert.equal(isProgressMarkerLine('## 完了報告'), false);
});

test('isProgressMarkerLine: 空行は false', () => {
  assert.equal(isProgressMarkerLine(''), false);
  assert.equal(isProgressMarkerLine('   '), false);
});

test('isProgressMarkerLine: 文字列以外は false（例外を投げない）', () => {
  assert.equal(isProgressMarkerLine(undefined), false);
  assert.equal(isProgressMarkerLine(null), false);
  assert.equal(isProgressMarkerLine(123), false);
});

test('isProgressMarkerLine: 🔧 で始まっても「使用中」でなければ false', () => {
  assert.equal(isProgressMarkerLine('🔧 ツールを修正しました'), false);
});

// ---- stripProgressMarkers ----

test('stripProgressMarkers: 進捗マーカー行を除去する', () => {
  const input = '🔧 Editを使用中...\n実装内容の説明\n🔧 Bashを使用中...\nテスト実行結果';
  const result = stripProgressMarkers(input);
  assert.equal(result.includes('使用中'), false);
  assert.equal(result.includes('実装内容の説明'), true);
  assert.equal(result.includes('テスト実行結果'), true);
});

test('stripProgressMarkers: マーカー行そのものは空行を残さず除去される（隣接行が直接連結される）', () => {
  // マーカー行は continue で読み飛ばされるだけで空行に置換されるわけではないため、
  // マーカー行同士が隣接している場合は間に空行は残らない
  // （agents/linux/src/services/history-compaction.ts の同名関数と挙動一致）
  const input = '本文1行目\n🔧 Editを使用中...\n🔧 Bashを使用中...\n本文2行目';
  const result = stripProgressMarkers(input);
  assert.equal(result, '本文1行目\n本文2行目');
});

test('stripProgressMarkers: 除去で生じた連続空行（マーカー行の前後に元々あった空行）を1行に畳む', () => {
  // agents/linux/tests/history-compaction.test.mjs A4 と同じ入力パターン
  // （マーカー行の前後に実際の空行があるケース）
  const input = [
    '🔧 ToolSearchを使用中...',
    '',
    '🔧 Readを使用中...',
    '',
    '調査の結果、原因は X でした。',
    '',
    '',
    '修正しました。',
  ].join('\n');
  const result = stripProgressMarkers(input);
  assert.equal(result, '調査の結果、原因は X でした。\n\n修正しました。');
});

test('stripProgressMarkers: 先頭の進捗マーカー除去後、先頭空行を残さない', () => {
  const input = '🔧 Editを使用中...\n本文';
  const result = stripProgressMarkers(input);
  assert.equal(result, '本文');
});

test('stripProgressMarkers: 末尾の進捗マーカー除去後、末尾空行を残さない', () => {
  const input = '本文\n🔧 Editを使用中...';
  const result = stripProgressMarkers(input);
  assert.equal(result, '本文');
});

test('stripProgressMarkers: 進捗マーカーのみの入力は空文字になる', () => {
  const input = '🔧 Editを使用中...\n🔧 Bashを使用中...\n🔧 Using Grep...';
  assert.equal(stripProgressMarkers(input), '');
});

test('stripProgressMarkers: 空文字入力は空文字を返す', () => {
  assert.equal(stripProgressMarkers(''), '');
});

test('stripProgressMarkers: 文字列以外は空文字を返す（例外を投げない）', () => {
  assert.equal(stripProgressMarkers(undefined), '');
  assert.equal(stripProgressMarkers(null), '');
});

test('stripProgressMarkers: 進捗マーカーが無い入力は変化しない', () => {
  const input = '実装内容の説明\n\n完了しました。';
  assert.equal(stripProgressMarkers(input), input);
});

test('stripProgressMarkers: 実障害ログの再現（#849 相当、末尾の完了報告が生き残る）', () => {
  const noise = '🔧 ToolSearchを使用中...\n...\n🔧 Bashを使用中...\n...\n🔧 Editを使用中...\n...\n'.repeat(200);
  const completion = '## 完了報告\ncommit hash: abc1234\n変更ファイル: agent-manager.ts, tools.ts';
  const input = noise + completion;
  const result = stripProgressMarkers(input);
  assert.equal(result.includes('## 完了報告'), true);
  assert.equal(result.includes('commit hash: abc1234'), true);
  // ノイズが除去されて全体としては元より大幅に短くなっている
  assert.ok(result.length < input.length);
});
