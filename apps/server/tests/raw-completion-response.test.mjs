// raw-completion（ゲーム席用の素の completion API）の HTTP レスポンス組み立ての単体テスト。
// 外部 import ゼロの純粋関数（apps/server/src/services/raw-completion-response.ts）を
// コンパイル済み dist から直接 import する（raw-completion-guard.test.mjs と同じ流儀）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  summarizeRawUsage,
  resolveRawModel,
  buildRawCompletionResponse,
} from '../dist/services/raw-completion-response.js';

// ---- summarizeRawUsage ----

test('summarizeRawUsage: SDK 実キーを4キーへ写像する', () => {
  const result = summarizeRawUsage({
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 5,
    },
  });
  assert.deepEqual(result, { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 });
});

test('summarizeRawUsage: usageData 未指定は全キー0埋め', () => {
  assert.deepEqual(summarizeRawUsage(undefined), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test('summarizeRawUsage: usageData が null でも0埋め', () => {
  assert.deepEqual(summarizeRawUsage(null), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test('summarizeRawUsage: usage フィールド自体が欠落していても0埋め', () => {
  assert.deepEqual(summarizeRawUsage({}), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test('summarizeRawUsage: 非数値・NaN・負値は0埋め（キーは落とさない）', () => {
  const result = summarizeRawUsage({
    usage: {
      input_tokens: 'abc',
      output_tokens: NaN,
      cache_read_input_tokens: -5,
      cache_creation_input_tokens: undefined,
    },
  });
  assert.deepEqual(result, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test('summarizeRawUsage: 小数は切り捨てる', () => {
  const result = summarizeRawUsage({ usage: { input_tokens: 10.9 } });
  assert.equal(result.input, 10);
});

test('summarizeRawUsage: 例外を投げない（壊れた形の usageData でも）', () => {
  assert.doesNotThrow(() => summarizeRawUsage({ usage: null }));
});

// ---- resolveRawModel ----

test('resolveRawModel: usageData.model を最優先する', () => {
  const model = resolveRawModel({ model: 'claude-opus-5', modelUsage: { 'claude-fable-5-1': {} } }, 'claude-fable-5-1');
  assert.equal(model, 'claude-opus-5');
});

test('resolveRawModel: model 欠落時は modelUsage の先頭キーを使う', () => {
  const model = resolveRawModel({ modelUsage: { 'claude-fable-5-1': {}, 'claude-opus-5': {} } }, 'claude-opus-5');
  assert.equal(model, 'claude-fable-5-1');
});

test('resolveRawModel: usageData に何も無ければリクエスト指定のモデルを使う', () => {
  const model = resolveRawModel({}, 'claude-opus-5');
  assert.equal(model, 'claude-opus-5');
});

test('resolveRawModel: 全て無ければ undefined', () => {
  assert.equal(resolveRawModel(undefined, undefined), undefined);
  assert.equal(resolveRawModel({}, ''), undefined);
});

// ---- buildRawCompletionResponse ----

function baseInput(overrides = {}) {
  return {
    result: { ok: true, text: 'こんにちは', stopReason: 'success', deniedTools: [], ...overrides },
    sessionId: 'raw_abc123',
    requestedModel: 'claude-opus-5',
    latencyMs: 1234,
  };
}

test('buildRawCompletionResponse: 成功時は全キーを持つ', () => {
  const body = buildRawCompletionResponse(baseInput());
  assert.equal(body.text, 'こんにちは');
  assert.equal(body.output, 'こんにちは');
  assert.equal(body.stopReason, 'success');
  assert.equal(body.sessionId, 'raw_abc123');
  assert.deepEqual(body.usage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(body.error, undefined);
  assert.deepEqual(body.deniedTools, []);
  assert.equal(typeof body.latencyMs, 'number');
  assert.equal(typeof body.agentDurationMs, 'number');
});

test('buildRawCompletionResponse: sessionId は raw_ で始まる（渡された値をそのまま使う）', () => {
  const body = buildRawCompletionResponse(baseInput({ }));
  assert.match(body.sessionId, /^raw_/);
});

test('buildRawCompletionResponse: text 欠落（旧 Agent）でも text は空文字・error は必須', () => {
  const body = buildRawCompletionResponse(baseInput({ text: undefined, output: '古いAgentの応答' }));
  assert.equal(body.text, '');
  assert.equal(body.output, '');
  assert.match(body.error, /outdated agent/);
});

test('buildRawCompletionResponse: usage は常に4キーを持つ（usageData 未指定でも）', () => {
  const body = buildRawCompletionResponse(baseInput({ usageData: undefined }));
  assert.deepEqual(Object.keys(body.usage).sort(), ['cacheRead', 'cacheWrite', 'input', 'output']);
});

test('buildRawCompletionResponse: ok:false では error が必須で text は空文字', () => {
  const body = buildRawCompletionResponse(baseInput({ ok: false, text: undefined, errorMessage: '失敗しました', stopReason: 'error' }));
  assert.equal(body.text, '');
  assert.equal(body.error, '失敗しました');
  assert.equal(body.stopReason, 'error');
});

test('buildRawCompletionResponse: ok:false + errorMessage 未設定でも既定の error 文言を返す', () => {
  const body = buildRawCompletionResponse(baseInput({ ok: false, text: undefined, errorMessage: undefined, stopReason: undefined }));
  assert.match(body.error, /raw-completion failed/);
  assert.equal(body.stopReason, 'error');
});

test('buildRawCompletionResponse: stopReason 未指定は ok:true なら success に正規化', () => {
  const body = buildRawCompletionResponse(baseInput({ stopReason: undefined }));
  assert.equal(body.stopReason, 'success');
});

test('buildRawCompletionResponse: stopReason=max_turns は切り詰めを隠さずそのまま保持する', () => {
  const body = buildRawCompletionResponse(baseInput({ stopReason: 'max_turns', text: '途中まで' }));
  assert.equal(body.stopReason, 'max_turns');
  assert.equal(body.text, '途中まで');
  assert.equal(body.error, undefined);
});

test('buildRawCompletionResponse: deniedTools は常に配列（重複除去済み）', () => {
  const body = buildRawCompletionResponse(baseInput({ deniedTools: ['Bash', 'Read', 'Bash'] }));
  assert.deepEqual(body.deniedTools, ['Bash', 'Read']);
});

test('buildRawCompletionResponse: deniedTools 未指定なら空配列', () => {
  const body = buildRawCompletionResponse(baseInput({ deniedTools: undefined }));
  assert.deepEqual(body.deniedTools, []);
});

test('buildRawCompletionResponse: model はリクエスト指定へフォールバックする', () => {
  const body = buildRawCompletionResponse(baseInput({ usageData: undefined }));
  assert.equal(body.model, 'claude-opus-5');
});

test('buildRawCompletionResponse: model は usageData.model を優先する', () => {
  const body = buildRawCompletionResponse(baseInput({ usageData: { model: 'claude-fable-5-1' } }));
  assert.equal(body.model, 'claude-fable-5-1');
});

test('buildRawCompletionResponse: 空文字の text（success）は旧 Agent 扱いにしない', () => {
  const body = buildRawCompletionResponse(baseInput({ text: '' }));
  assert.equal(body.text, '');
  assert.equal(body.error, undefined);
});

test('buildRawCompletionResponse: agentDurationMs が非数値でも0を返す（例外を投げない）', () => {
  const body = buildRawCompletionResponse(baseInput({ agentDurationMs: 'abc' }));
  assert.equal(body.agentDurationMs, 0);
});

test('buildRawCompletionResponse: 例外を一切投げない（壊れた入力でも）', () => {
  assert.doesNotThrow(() => buildRawCompletionResponse({
    result: { ok: true },
    sessionId: 'raw_x',
    latencyMs: 0,
  }));
});
