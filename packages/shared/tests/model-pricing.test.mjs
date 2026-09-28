// Devin 料金可視化サイクル: model-pricing.ts の単体テスト
// （コンパイル済み dist を直接 import、node:test。model-catalog.test.mjs と同じ流儀）。
//
// 二重管理防止テスト（AI_MODEL_CATALOG.devin の description ⇔ DEVIN_MODEL_PRICING の数値一致）
// + DB 実測15種のモデル ID 正規化 + Claude 実データによるコスト計算式の校正を含む。

import test from 'node:test';
import assert from 'node:assert/strict';
import { AI_MODEL_CATALOG } from '../dist/constants.js';
import {
  DEVIN_MODEL_PRICING,
  normalizeDevinModelId,
  resolveDevinModelPrice,
  estimateCostUsd,
  resolveMessageCost,
} from '../dist/model-pricing.js';

// --- 二重管理防止: description の $a/$b/$c per MTok 表記と DEVIN_MODEL_PRICING の数値一致 ---

test('AI_MODEL_CATALOG.devin の description 内の単価表記が DEVIN_MODEL_PRICING と一致する', () => {
  const priced = AI_MODEL_CATALOG.devin.filter((m) => /\$[\d.]+\/\$[\d.]+\/\$[\d.]+\s*per MTok/.test(m.description));
  assert.ok(priced.length > 0, 'per MTok 表記のモデルが1件も見つからない（正規表現が壊れている可能性）');
  for (const m of priced) {
    const match = m.description.match(/\$([\d.]+)\/\$([\d.]+)\/\$([\d.]+)\s*per MTok/);
    const [, inStr, cacheReadStr, outStr] = match;
    const expected = { input: Number(inStr), cacheRead: Number(cacheReadStr), output: Number(outStr) };
    const actual = DEVIN_MODEL_PRICING[m.id];
    assert.ok(actual, `${m.id}: description に単価表記があるのに DEVIN_MODEL_PRICING に無い（追加漏れ）`);
    assert.equal(actual.input, expected.input, `${m.id}: input 単価が description と不一致`);
    assert.equal(actual.cacheRead, expected.cacheRead, `${m.id}: cacheRead 単価が description と不一致`);
    assert.equal(actual.output, expected.output, `${m.id}: output 単価が description と不一致`);
  }
});

test('「無料」を含む description のモデルは DEVIN_MODEL_PRICING で free:true かつ全額0', () => {
  const freeModels = AI_MODEL_CATALOG.devin.filter((m) => m.description.includes('無料'));
  assert.ok(freeModels.length > 0, '無料モデルが1件も見つからない（swe-2 が想定）');
  for (const m of freeModels) {
    const price = DEVIN_MODEL_PRICING[m.id];
    assert.ok(price, `${m.id}: 無料と明記されているのに DEVIN_MODEL_PRICING に無い`);
    assert.equal(price.free, true, `${m.id}: free フラグが立っていない`);
    assert.equal(price.input, 0);
    assert.equal(price.cacheRead, 0);
    assert.equal(price.output, 0);
  }
});

test('claude-opus-5.5 の -fast 版単価（description に併記）が別エントリとして存在する', () => {
  const fastPrice = DEVIN_MODEL_PRICING['claude-opus-5.5-fast'];
  assert.ok(fastPrice, 'claude-opus-5.5-fast が DEVIN_MODEL_PRICING に無い');
  assert.equal(fastPrice.input, 8);
  assert.equal(fastPrice.output, 40);
});

// --- normalizeDevinModelId: DB 実測15種の正規化 ---

test('normalizeDevinModelId: DB 実測キーを正しく正規化する', () => {
  const cases = [
    ['swe-1-7-medium', 'swe-1.7'],
    ['claude-sonnet-5-medium', 'claude-sonnet-5'],
    ['claude-opus-4-6[1m]', 'claude-opus-4.6'],
    ['claude-opus-5', 'claude-opus-5'],
    ['kimi-k2-7', 'kimi-k2.7'],
    ['claude-opus-5-medium', 'claude-opus-5'],
    ['swe-2-high', 'swe-2'],
    ['gpt-5-6-luna-medium', 'gpt-5.6-luna'],
    ['gpt-6-sol-medium', 'gpt-6-sol'],
    ['claude-opus-4-6', 'claude-opus-4.6'],
    ['gpt-5-6-sol-low', 'gpt-5.6-sol'],
    ['gpt-6-luna-high', 'gpt-6-luna'],
    ['swe-1-7-lightning', 'swe-1.7'],
    ['MODEL_PRIVATE_11', 'MODEL_PRIVATE_11'],
  ];
  for (const [raw, expectedId] of cases) {
    const { id } = normalizeDevinModelId(raw);
    assert.equal(id, expectedId, `normalizeDevinModelId(${raw}) → ${id}、期待値 ${expectedId}`);
  }
});

test('normalizeDevinModelId: [1m] サフィックスで longContext フラグが立つ', () => {
  const { longContext } = normalizeDevinModelId('claude-opus-4-6[1m]');
  assert.equal(longContext, true);
});

test('normalizeDevinModelId: -fast サフィックスで fast フラグが立つ', () => {
  const { id, fast } = normalizeDevinModelId('claude-opus-5-5-fast');
  assert.equal(fast, true);
  assert.equal(id, 'claude-opus-5.5');
});

// --- resolveDevinModelPrice: 単価解決（未知モデルへの fallback 禁止） ---

test('resolveDevinModelPrice: カタログに無いモデルは undefined（fallback しない）', () => {
  assert.equal(resolveDevinModelPrice('kimi-k2-7'), undefined);
  assert.equal(resolveDevinModelPrice('swe-1-7-medium'), undefined);
  assert.equal(resolveDevinModelPrice('MODEL_PRIVATE_11'), undefined);
  assert.equal(resolveDevinModelPrice(null), undefined);
  assert.equal(resolveDevinModelPrice(undefined), undefined);
});

test('resolveDevinModelPrice: カタログに一致するモデルは単価を返す', () => {
  assert.deepEqual(resolveDevinModelPrice('claude-sonnet-5-medium'), { input: 2, cacheRead: 0.2, output: 10 });
  assert.equal(resolveDevinModelPrice('swe-2-high').free, true);
});

test('resolveDevinModelPrice: -fast は専用単価が無ければ非fast単価を流用しない', () => {
  // gpt-6-sol には -fast 専用単価が無いため undefined を返すべき（過小評価防止）
  assert.equal(resolveDevinModelPrice('gpt-6-sol-fast'), undefined);
  // claude-opus-5.5 は -fast 専用単価がある
  assert.deepEqual(resolveDevinModelPrice('claude-opus-5-5-fast'), { input: 8, cacheRead: 0.4, output: 40 });
});

// --- estimateCostUsd ---

test('estimateCostUsd: free モデルは常に0', () => {
  const usd = estimateCostUsd({ input: 999, cacheRead: 999, output: 999, free: true }, {
    inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheCreationTokens: 1_000_000,
  });
  assert.equal(usd, 0);
});

test('estimateCostUsd: トークン数×単価（cache-write は入力単価×1.25）', () => {
  const price = { input: 2, cacheRead: 0.2, output: 10 };
  const usd = estimateCostUsd(price, {
    inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheCreationTokens: 1_000_000,
  });
  // 2 + 10 + 0.2 + (2*1.25) = 14.7
  assert.ok(Math.abs(usd - 14.7) < 1e-9, `usd=${usd}`);
});

// --- resolveMessageCost: 優先順位（sdk > estimate > unknown） ---

test('resolveMessageCost: modelUsage[model].costUSD があれば source:sdk を最優先で返す', () => {
  // 実 DB から採取した Claude 実データ（料金可視化サイクル調査時の実測フィクスチャ）。
  // costUSD=1.5069985 は in/cacheRead/out の3項合計 $0.129 + cache-write $1.378
  // （220,462 トークン × $6.25/MTok ≒ 入力単価 $5 × 1.25）で説明できることを確認済み。
  const usageData = {
    model: 'claude-opus-4-6[1m]',
    usage: {
      input_tokens: 4, output_tokens: 152,
      cache_read_input_tokens: 250582, cache_creation_input_tokens: 220462,
    },
    modelUsage: {
      'claude-opus-4-6[1m]': { costUSD: 1.5069985, inputTokens: 4, outputTokens: 152 },
    },
  };
  const result = resolveMessageCost(usageData);
  assert.equal(result.source, 'sdk');
  assert.equal(result.usd, 1.5069985);
  assert.equal(result.model, 'claude-opus-4-6[1m]');
});

test('resolveMessageCost: usageData.tool==="devin" かつ単価判明なら source:estimate', () => {
  const usageData = {
    model: 'claude-sonnet-5-medium',
    tool: 'devin',
    usage: { input_tokens: 40820, output_tokens: 1097, cache_read_input_tokens: 24885, cache_creation_input_tokens: 0 },
  };
  const result = resolveMessageCost(usageData);
  assert.equal(result.source, 'estimate');
  assert.ok(result.usd > 0);
});

test('resolveMessageCost: usageData.tool が devin でも単価不明モデルなら unknown（$0にしない）', () => {
  const usageData = {
    model: 'kimi-k2-7',
    tool: 'devin',
    usage: { input_tokens: 40820, output_tokens: 1097, cache_read_input_tokens: 24885, cache_creation_input_tokens: 0 },
  };
  const result = resolveMessageCost(usageData);
  assert.equal(result.source, 'unknown');
  assert.equal(result.usd, null);
});

test('resolveMessageCost: usageData.tool が無い旧 Devin データは costUSD が無ければ unknown（Session.aiTool は信用しない）', () => {
  // 事実B対策の回帰テスト: Session.aiTool='devin' のセッションに Claude 時代の行が
  // 混入していても、usageData.tool が無ければ Devin 単価表を勝手に適用してはいけない。
  const usageData = {
    model: 'claude-sonnet-5', // tool フィールド無し（Agent 更新前の旧データを模す）
    usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  };
  const result = resolveMessageCost(usageData);
  assert.equal(result.source, 'unknown');
  assert.equal(result.usd, null);
});

test('resolveMessageCost: usageData が無ければ unknown', () => {
  assert.deepEqual(resolveMessageCost(null), { usd: null, source: 'unknown', model: null });
  assert.deepEqual(resolveMessageCost(undefined), { usd: null, source: 'unknown', model: null });
});

test('resolveMessageCost: durationMs のみ（usage 無し）の devin データは unknown', () => {
  const usageData = { tool: 'devin', durationMs: 1234 };
  const result = resolveMessageCost(usageData);
  assert.equal(result.source, 'unknown');
  assert.equal(result.usd, null);
});
