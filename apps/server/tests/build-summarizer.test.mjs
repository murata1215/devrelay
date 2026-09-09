// 2026-09-09 サイクル: get_build_status.summary「不明」の根治対応（build-summarizer.ts）の単体テスト。
// build-summarizer.ts はマルチプロバイダー SDK（openai/@anthropic-ai/sdk/@google/generative-ai）と
// user-settings.js（→ Prisma Client）を import するが、いずれもモジュール読み込み時点では
// ネットワーク接続や DB 接続を行わない（PrismaClient はコンストラクタでは接続しない遅延接続、
// 各 AI SDK クライアントも summarizeWithXxx() 内でのみインスタンス化される）ため、
// buildUserMessage / normalizeSummary という純粋関数部分だけをコンパイル済み dist から
// 直接 import して DB 非接続で検証できる（content-truncate.test.mjs と同じ流儀）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildUserMessage,
  normalizeSummary,
  MAX_OUTPUT_LENGTH,
  OUTPUT_HEAD_LENGTH,
  OUTPUT_TAIL_LENGTH,
  MAX_SUMMARY_LENGTH,
} from '../dist/services/build-summarizer.js';

// ============================================================
// buildUserMessage: head+tail 切り詰め
// ============================================================

test('buildUserMessage: MAX_OUTPUT_LENGTH 以下ならそのまま（切り詰めマーカーなし）', () => {
  const output = '短い実行結果テキスト';
  const msg = buildUserMessage(output);
  assert.match(msg, /実行結果:\n短い実行結果テキスト$/);
  assert.equal(msg.includes('[...omitted...]'), false);
});

test('buildUserMessage: execPrompt があれば先頭に付与される', () => {
  const msg = buildUserMessage('結果本文', 'テストプロンプト');
  assert.match(msg, /^実行プロンプト: テストプロンプト\n\n実行結果:\n結果本文$/);
});

test('buildUserMessage: 進捗マーカー行が除去されてから長さ判定される', () => {
  // 進捗マーカーだけで MAX_OUTPUT_LENGTH を超えるが、除去後は短いため head+tail 分割は起きない
  const noise = '🔧 Editを使用中...\n'.repeat(1000); // 除去前は長いが除去後はゼロに近い
  const completion = '## 完了報告\ncommit hash: abc1234';
  const output = noise + completion;
  const msg = buildUserMessage(output);
  assert.equal(msg.includes('[...omitted...]'), false);
  assert.match(msg, /## 完了報告/);
  assert.match(msg, /commit hash: abc1234/);
  assert.equal(msg.includes('使用中'), false);
});

test('buildUserMessage: 除去後もなお長い場合は先頭 OUTPUT_HEAD_LENGTH + 末尾 OUTPUT_TAIL_LENGTH を [...omitted...] で連結する', () => {
  const head = 'H'.repeat(OUTPUT_HEAD_LENGTH + 500);
  const middle = 'M'.repeat(6000);
  const tailMarker = '## 完了報告\ncommit hash: deadbeef\n変更ファイル: a.ts, b.ts';
  const output = `${head}\n${middle}\n${tailMarker}`;
  assert.ok(output.length > MAX_OUTPUT_LENGTH, 'テスト前提: 入力が MAX_OUTPUT_LENGTH を超えていること');

  const msg = buildUserMessage(output);
  assert.match(msg, /\[\.\.\.omitted\.\.\.\]/);
  // 完了報告（末尾）が必ず残っていること — これが「不明」の真因への直接的な回帰テスト
  assert.match(msg, /## 完了報告/);
  assert.match(msg, /commit hash: deadbeef/);
  assert.match(msg, /変更ファイル: a\.ts, b\.ts/);
});

test('buildUserMessage: 実障害ログの再現（#849相当）— 進捗マーカー洪水の末尾にある完了報告が残る', () => {
  const noise = '🔧 ToolSearchを使用中...\n...\n🔧 Bashを使用中...\n...\n🔧 Editを使用中...\n...\n'.repeat(300);
  const completion = '## 完了報告\ncommit hash: abc1234\n変更ファイル: agent-manager.ts, tools.ts';
  const output = noise + completion;
  const msg = buildUserMessage(output);
  assert.match(msg, /## 完了報告/);
  assert.match(msg, /commit hash: abc1234/);
});

// ============================================================
// normalizeSummary: 長さ制限 + トリム + 「不明」検疫
// ============================================================

test('normalizeSummary: 空 / 空白のみ / null / undefined は null', () => {
  assert.equal(normalizeSummary(''), null);
  assert.equal(normalizeSummary('   '), null);
  assert.equal(normalizeSummary(null), null);
  assert.equal(normalizeSummary(undefined), null);
});

test('normalizeSummary: 通常の要約はトリムされてそのまま返る', () => {
  assert.equal(normalizeSummary('  agent-manager.ts に機能を追加  '), 'agent-manager.ts に機能を追加');
});

test('normalizeSummary: MAX_SUMMARY_LENGTH を超える場合は切り詰めて ... を付与', () => {
  const long = 'あ'.repeat(MAX_SUMMARY_LENGTH + 50);
  const result = normalizeSummary(long);
  assert.equal(result, 'あ'.repeat(MAX_SUMMARY_LENGTH) + '...');
});

test('normalizeSummary: 「不明」は検疫され null を返す', () => {
  assert.equal(normalizeSummary('不明'), null);
  assert.equal(normalizeSummary('  不明  '), null); // 前後空白があってもトリム後に一致
});

test('normalizeSummary: 「「不明」」（カギ括弧付き）も検疫される', () => {
  assert.equal(normalizeSummary('「不明」'), null);
});

test('normalizeSummary: 英語の unknown も大小無視で検疫される', () => {
  assert.equal(normalizeSummary('unknown'), null);
  assert.equal(normalizeSummary('Unknown'), null);
  assert.equal(normalizeSummary('UNKNOWN'), null);
});

test('normalizeSummary: 「不明」を含むが完全一致ではない文は検疫されない', () => {
  // 「不明な点があれば...」のような実質的な要約文まで誤って null 化しないことを確認
  const result = normalizeSummary('要件が不明瞭なため一部仮実装とした');
  assert.equal(result, '要件が不明瞭なため一部仮実装とした');
});
