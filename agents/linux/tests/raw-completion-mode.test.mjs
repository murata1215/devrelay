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
  mapRawUsage,
} from '../dist/services/raw-completion-mode.js';

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

test('buildRawSdkOverrides: permissionMode は plan 固定（D1 第4層）', () => {
  const overrides = buildRawSdkOverrides('sys');
  assert.equal(overrides.permissionMode, 'plan');
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

// ---- mapRawUsage ----

test('mapRawUsage: usage/modelUsage/durationMs をそのまま写像する', () => {
  const usage = { input_tokens: 10, output_tokens: 20 };
  const modelUsage = { 'claude-sonnet-4-5': { contextWindow: 200000 } };
  const result = mapRawUsage({ usage, modelUsage, durationMs: 1234 });
  assert.equal(result.usage, usage);
  assert.equal(result.modelUsage, modelUsage);
  assert.equal(result.durationMs, 1234);
});

test('mapRawUsage: model は modelUsage の先頭キーから導出する', () => {
  const result = mapRawUsage({ modelUsage: { 'claude-opus-4-1': {} } });
  assert.equal(result.model, 'claude-opus-4-1');
});

test('mapRawUsage: modelUsage が無ければ model は undefined', () => {
  const result = mapRawUsage({ usage: { input_tokens: 1 } });
  assert.equal(result.model, undefined);
});

test('mapRawUsage: 入力が空でも例外を投げない', () => {
  assert.doesNotThrow(() => mapRawUsage({}));
  const result = mapRawUsage({});
  assert.equal(result.usage, undefined);
  assert.equal(result.modelUsage, undefined);
  assert.equal(result.durationMs, undefined);
  assert.equal(result.model, undefined);
});
