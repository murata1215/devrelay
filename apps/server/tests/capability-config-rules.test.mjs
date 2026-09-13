// 外部 import ゼロの純粋関数（apps/server/src/services/capability-config-rules.ts）を
// コンパイル済み dist から直接 import する（auto-update-reconcile.test.mjs と同じ流儀）。
// サイクルP1: Capability 配布基盤

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCapabilityConfigInput, decideSweepAction } from '../dist/services/capability-config-rules.js';

test('null は valid: true, config: null（機能OFF）', () => {
  const result = validateCapabilityConfigInput(null);
  assert.deepEqual(result, { valid: true, config: null });
});

test('undefined は valid: true, config: null（機能OFF）', () => {
  const result = validateCapabilityConfigInput(undefined);
  assert.deepEqual(result, { valid: true, config: null });
});

test('配列は invalid', () => {
  const result = validateCapabilityConfigInput([]);
  assert.equal(result.valid, false);
});

test('文字列は invalid', () => {
  const result = validateCapabilityConfigInput('foo');
  assert.equal(result.valid, false);
});

test('providers/items 省略は空オブジェクト/空配列として valid', () => {
  const result = validateCapabilityConfigInput({});
  assert.deepEqual(result, { valid: true, config: { providers: {}, items: [] } });
});

test('正しい形の providers + items は valid でそのまま通る', () => {
  const input = {
    providers: { claude: { marketplaceName: 'devrelay', marketplaceSource: 'murata1215/devrelay-plugins' } },
    items: [{ provider: 'claude', kind: 'plugin', id: 'unity@devrelay' }],
  };
  const result = validateCapabilityConfigInput(input);
  assert.deepEqual(result, { valid: true, config: input });
});

test('providers.claude.marketplaceName が空文字なら invalid', () => {
  const result = validateCapabilityConfigInput({
    providers: { claude: { marketplaceName: '', marketplaceSource: 'x' } },
  });
  assert.equal(result.valid, false);
});

test('providers.claude.marketplaceSource が欠落なら invalid', () => {
  const result = validateCapabilityConfigInput({
    providers: { claude: { marketplaceName: 'devrelay' } },
  });
  assert.equal(result.valid, false);
});

test('items[i].provider が数値なら invalid', () => {
  const result = validateCapabilityConfigInput({ items: [{ provider: 1, kind: 'plugin', id: 'x' }] });
  assert.equal(result.valid, false);
});

test('items[i].kind が欠落なら invalid', () => {
  const result = validateCapabilityConfigInput({ items: [{ provider: 'claude', id: 'x' }] });
  assert.equal(result.valid, false);
});

test('items[i].id が空文字なら invalid', () => {
  const result = validateCapabilityConfigInput({ items: [{ provider: 'claude', kind: 'plugin', id: '' }] });
  assert.equal(result.valid, false);
});

test('items が配列でないなら invalid', () => {
  const result = validateCapabilityConfigInput({ items: 'not-array' });
  assert.equal(result.valid, false);
});

test('decideSweepAction: capabilityConfig が null なら skip', () => {
  const decision = decideSweepAction({ capabilityConfig: null, busy: false });
  assert.deepEqual(decision, { action: 'skip', reason: 'capabilityConfig not set' });
});

test('decideSweepAction: capabilityConfig が undefined なら skip', () => {
  const decision = decideSweepAction({ capabilityConfig: undefined, busy: false });
  assert.equal(decision.action, 'skip');
});

test('decideSweepAction: busy なら skip', () => {
  const decision = decideSweepAction({ capabilityConfig: { providers: {}, items: [] }, busy: true });
  assert.deepEqual(decision, { action: 'skip', reason: 'busy' });
});

test('decideSweepAction: capabilityConfig あり + busy でなければ sync', () => {
  const decision = decideSweepAction({ capabilityConfig: { providers: {}, items: [] }, busy: false });
  assert.deepEqual(decision, { action: 'sync', reason: 'ok' });
});

// ---- P1.1 回帰テスト: Web が「marketplace のみ・plugin 空」で送る payload が NULL 化しないことの保証 ----

test('P1.1回帰: Web の marketplace-only payload（items:[]）は valid:true で config が null にならない', () => {
  const input = {
    providers: { claude: { marketplaceName: 'devrelay', marketplaceSource: 'murata1215/devrelay-plugins' } },
    items: [],
  };
  const result = validateCapabilityConfigInput(input);
  assert.deepEqual(result, { valid: true, config: input });
  assert.notEqual(result.config, null);
});

test('P1.1回帰: decideSweepAction は items:[] の capabilityConfig でも busy でなければ sync（既に受容済みの挙動の明文化）', () => {
  const decision = decideSweepAction({
    capabilityConfig: { providers: { claude: { marketplaceName: 'devrelay', marketplaceSource: 'src' } }, items: [] },
    busy: false,
  });
  assert.deepEqual(decision, { action: 'sync', reason: 'ok' });
});
