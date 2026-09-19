// raw-completion（ゲーム席用の素の completion API）の Agent 側モード定義の単体テスト。
// 外部 import ゼロの純粋関数（agents/linux/src/services/raw-completion-mode.ts）を
// コンパイル済み dist から直接 import する（session-scope.test.mjs と同じ流儀）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RAW_MAX_TURNS,
  RAW_DISALLOWED_TOOLS,
  composeRawPrompt,
  buildRawSdkOverrides,
  isRawToolDenied,
  buildRawDenyMessage,
  resolveRawCompletionResult,
} from '../dist/services/raw-completion-mode.js';
import * as rawCompletionMode from '../dist/services/raw-completion-mode.js';

// ---- 定数 ----

test('RAW_MAX_TURNS: 1 ではなく 2（off-by-one 対策）', () => {
  assert.equal(RAW_MAX_TURNS, 2);
});

test('RAW_DISALLOWED_TOOLS: 主要な編集・実行系ツールを含む', () => {
  for (const tool of ['Bash', 'Read', 'Write', 'Edit', 'WebFetch', 'Task', 'AskUserQuestion', 'ExitPlanMode']) {
    assert.ok(RAW_DISALLOWED_TOOLS.includes(tool), `${tool} が含まれていない`);
  }
});

// ---- composeRawPrompt ----

test('composeRawPrompt: 恒等関数（DevRelay の前置きを一切付けない契約）', () => {
  assert.equal(composeRawPrompt('自分の役割は？'), '自分の役割は？');
  assert.equal(composeRawPrompt(''), '');
  const multiline = 'line1\nline2\n---\nline3';
  assert.equal(composeRawPrompt(multiline), multiline);
});

// ---- buildRawSdkOverrides ----

test('buildRawSdkOverrides: systemPrompt を完全置換する', () => {
  const overrides = buildRawSdkOverrides('あなたは談合カードのプレイヤーP05である');
  assert.equal(overrides.systemPrompt, 'あなたは談合カードのプレイヤーP05である');
});

test('buildRawSdkOverrides: tools/settingSources を空配列にする（D1 第1層・第4層前提）', () => {
  const overrides = buildRawSdkOverrides('sys');
  assert.deepEqual(overrides.tools, []);
  assert.deepEqual(overrides.settingSources, []);
});

test('buildRawSdkOverrides: disallowedTools は RAW_DISALLOWED_TOOLS そのもの（D1 第2層）', () => {
  const overrides = buildRawSdkOverrides('sys');
  assert.equal(overrides.disallowedTools, RAW_DISALLOWED_TOOLS);
});

test('buildRawSdkOverrides: permissionMode は default 固定（Phase 1.2: plan は SDK が plan-mode reminder を注入するため不可）', () => {
  const overrides = buildRawSdkOverrides('sys');
  assert.equal(overrides.permissionMode, 'default');
  assert.notEqual(overrides.permissionMode, 'plan'); // 回帰防止: 'plan' へ戻すと Phase 1.2 の不具合が再発する
});

test('buildRawSdkOverrides: mcpServers は空オブジェクト + strictMcpConfig true（MCP 経由の再導入を塞ぐ）', () => {
  const overrides = buildRawSdkOverrides('sys');
  assert.deepEqual(overrides.mcpServers, {});
  assert.equal(overrides.strictMcpConfig, true);
});

test('buildRawSdkOverrides: maxTurns は RAW_MAX_TURNS と一致する', () => {
  const overrides = buildRawSdkOverrides('sys');
  assert.equal(overrides.maxTurns, RAW_MAX_TURNS);
});

// ---- isRawToolDenied / buildRawDenyMessage ----

test('isRawToolDenied: 常に true（D1 第3層・無条件 deny）', () => {
  assert.equal(isRawToolDenied(), true);
});

test('buildRawDenyMessage: ツール名を含む拒否メッセージを返す', () => {
  const msg = buildRawDenyMessage('Bash');
  assert.match(msg, /Bash/);
  assert.match(msg, /denied/);
});

// ---- resolveRawCompletionResult（本文の配線。Phase 1.1 空レスポンス根治の核心） ----

test('resolveRawCompletionResult: 連結済み本文（rawOutput）が最終コールバックの空文字より優先される（空レスポンス根治の核心）', () => {
  const result = resolveRawCompletionResult({
    rawOutput: 'こんにちは、P05です。',
    completionText: '',
    completionSeen: true,
    stopReason: 'success',
  });
  assert.equal(result.ok, true);
  assert.equal(result.text, 'こんにちは、P05です。');
});

test('resolveRawCompletionResult: rawOutput が空文字でも success なら ok:true・text は空文字（例外を投げない）', () => {
  const result = resolveRawCompletionResult({
    rawOutput: '',
    completionText: '(No response from AI)',
    completionSeen: true,
    stopReason: 'success',
  });
  assert.equal(result.ok, true);
  assert.equal(result.text, '');
});

test('resolveRawCompletionResult: 最終コールバックの (No response from AI) を本文として採用しない', () => {
  const result = resolveRawCompletionResult({
    rawOutput: '実際の回答テキスト',
    completionText: '(No response from AI)',
    completionSeen: true,
    stopReason: 'success',
  });
  assert.equal(result.text, '実際の回答テキスト');
  assert.notEqual(result.text, '(No response from AI)');
});

test('resolveRawCompletionResult: stopReason 未指定（rawOutput あり＝自然終了フォールバック）は success に正規化する', () => {
  const result = resolveRawCompletionResult({
    rawOutput: '応答本文',
    completionText: '',
    completionSeen: true,
    stopReason: undefined,
  });
  assert.equal(result.ok, true);
  assert.equal(result.stopReason, 'success');
});

// ---- stopReason / エラー伝播 ----

test('resolveRawCompletionResult: stopReason=max_turns は ok:true のまま部分出力と stopReason を返す（切り詰めを隠さない）', () => {
  const result = resolveRawCompletionResult({
    rawOutput: '途中まで書いた応答',
    completionText: '',
    completionSeen: true,
    stopReason: 'max_turns',
  });
  assert.equal(result.ok, true);
  assert.equal(result.text, '途中まで書いた応答');
  assert.equal(result.stopReason, 'max_turns');
});

test('resolveRawCompletionResult: stopReason=error は ok:false・errorMessage に本文を載せる', () => {
  const result = resolveRawCompletionResult({
    rawOutput: 'エラー時の部分出力',
    completionText: '',
    completionSeen: true,
    stopReason: 'error',
  });
  assert.equal(result.ok, false);
  assert.equal(result.stopReason, 'error');
  assert.equal(result.errorMessage, 'エラー時の部分出力');
});

test('resolveRawCompletionResult: rawOutput 未設定（エラー分岐の早期 return）は完了テキストを errorMessage へ回し text は空にする', () => {
  const result = resolveRawCompletionResult({
    rawOutput: undefined,
    completionText: '⚠️ プロンプトが長すぎます。',
    completionSeen: true,
    stopReason: undefined,
  });
  assert.equal(result.ok, false);
  assert.equal(result.text, '');
  assert.equal(result.errorMessage, '⚠️ プロンプトが長すぎます。');
});

test('resolveRawCompletionResult: rawOutput 未設定 + stopReason 未指定は error として扱う（無言の success にしない）', () => {
  const result = resolveRawCompletionResult({
    rawOutput: undefined,
    completionText: 'なんらかのエラー文言',
    completionSeen: true,
    stopReason: undefined,
  });
  assert.equal(result.ok, false);
  assert.equal(result.stopReason, 'error');
});

test('resolveRawCompletionResult: rawOutput 未設定 + stopReason=aborted（loop-guard）は aborted を保ったまま ok:false', () => {
  const result = resolveRawCompletionResult({
    rawOutput: undefined,
    completionText: 'ループガードにより打ち切りました',
    completionSeen: true,
    stopReason: 'aborted',
  });
  assert.equal(result.ok, false);
  assert.equal(result.stopReason, 'aborted');
});

test('resolveRawCompletionResult: 完了シグナル自体が来なければ ok:false・errorMessage を明示する', () => {
  const result = resolveRawCompletionResult({
    rawOutput: undefined,
    completionText: '',
    completionSeen: false,
    stopReason: undefined,
  });
  assert.equal(result.ok, false);
  assert.equal(result.stopReason, 'error');
  assert.match(result.errorMessage, /completion signal/);
});

test('resolveRawCompletionResult: 完了テキストが空白のみなら既定のエラー文言にフォールバックする', () => {
  const result = resolveRawCompletionResult({
    rawOutput: undefined,
    completionText: '   ',
    completionSeen: true,
    stopReason: undefined,
  });
  assert.equal(result.ok, false);
  assert.match(result.errorMessage, /without output/);
});

// ---- deniedTools ----

test('resolveRawCompletionResult: deniedTools は重複を除去し入力順を保つ', () => {
  const result = resolveRawCompletionResult({
    rawOutput: 'ok',
    completionText: '',
    completionSeen: true,
    stopReason: 'success',
    deniedTools: ['Bash', 'Read', 'Bash', 'Write', 'Read'],
  });
  assert.deepEqual(result.deniedTools, ['Bash', 'Read', 'Write']);
});

test('resolveRawCompletionResult: deniedTools 未指定なら空配列を返す（undefined を返さない）', () => {
  const result = resolveRawCompletionResult({
    rawOutput: 'ok',
    completionText: '',
    completionSeen: true,
    stopReason: 'success',
  });
  assert.deepEqual(result.deniedTools, []);
});

test('resolveRawCompletionResult: 入力の deniedTools 配列と戻り値の配列が同一参照でない（呼び出し元の破壊を防ぐ）', () => {
  const input = ['Bash'];
  const result = resolveRawCompletionResult({
    rawOutput: 'ok',
    completionText: '',
    completionSeen: true,
    stopReason: 'success',
    deniedTools: input,
  });
  assert.notEqual(result.deniedTools, input);
});

// ---- mapRawUsage の削除確認（要件3の end state を表明: 死コードの復活防止） ----

test('mapRawUsage: 削除済み（raw-completion-mode.js から export されていない）', () => {
  assert.equal(rawCompletionMode.mapRawUsage, undefined);
});
