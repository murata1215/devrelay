// 2026-10-02 実機事故（組織デフォルト Opus 5.5 設定済みの devin 機で swe-2 が使われた）対策。
// apps/server/src/services/ai-tool-availability.ts の純粋関数 pickAvailableAiTool() の単体テスト。
// コンパイル済み dist から直接 import する（org-ai-defaults.test.mjs 等と同じ流儀）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickAvailableAiTool } from '../dist/services/ai-tool-availability.js';

test('pickAvailableAiTool: available が空（旧 Agent・未接続）→ 差し替えない', () => {
  assert.equal(pickAvailableAiTool('claude', [], ['devin']), 'claude');
});

test('pickAvailableAiTool: requested が available に含まれる → そのまま尊重', () => {
  assert.equal(pickAvailableAiTool('claude', ['claude', 'devin'], ['devin']), 'claude');
});

test('pickAvailableAiTool: requested が不在、fallback の先頭が実在 → fallback 採用（実機事故の再現ケース）', () => {
  // Project.defaultAi='claude' だが Agent に Claude Code が無く devin のみ → devin へ差し替わる
  assert.equal(pickAvailableAiTool('claude', ['devin'], [undefined, 'devin']), 'devin');
});

test('pickAvailableAiTool: fallback を優先順位どおりに試す（1件目が不在なら2件目）', () => {
  assert.equal(pickAvailableAiTool('claude', ['codex', 'devin'], ['gemini', 'devin']), 'devin');
});

test('pickAvailableAiTool: fallback が null/undefined 混じりでもスキップして次を試す', () => {
  assert.equal(pickAvailableAiTool('claude', ['devin'], [null, undefined, 'devin']), 'devin');
});

test('pickAvailableAiTool: どの fallback も不在 → available の先頭を採用', () => {
  assert.equal(pickAvailableAiTool('claude', ['gemini', 'codex'], ['devin']), 'gemini');
});

test('pickAvailableAiTool: fallback 未指定（空配列）でもクラッシュせず available の先頭を採用', () => {
  assert.equal(pickAvailableAiTool('claude', ['gemini'], []), 'gemini');
});
