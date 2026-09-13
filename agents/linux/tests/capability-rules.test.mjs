// サイクルP1: Capability 配布基盤の共通層ロジック（外部 import ゼロの純粋関数）を
// コンパイル済み dist から直接 import する（running-code-stale.test.mjs と同じ流儀）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aiToolToCapabilityProvider,
  triggerPriority,
  decideEnqueue,
  shouldAlwaysReport,
  mergeCapabilityResults,
  buildUnsupportedResult,
  buildPrelaunchCacheKey,
  decidePrelaunchAction,
  listConfiguredProviders,
  resolveReconcileTargets,
  hasReportableOutcome,
} from '../dist/services/capability-rules.js';

// ---- aiToolToCapabilityProvider ----

test('claude は provider claude に解決される', () => {
  assert.equal(aiToolToCapabilityProvider('claude'), 'claude');
});

test('未登録の AiTool は null（Capability 対象外）', () => {
  assert.equal(aiToolToCapabilityProvider('codex'), null);
  assert.equal(aiToolToCapabilityProvider('gemini'), null);
  assert.equal(aiToolToCapabilityProvider('devin'), null);
});

// ---- triggerPriority ----

test('trigger の優先度: manual > connect > config > idle > prelaunch', () => {
  assert.ok(triggerPriority('manual') > triggerPriority('connect'));
  assert.ok(triggerPriority('connect') > triggerPriority('config'));
  assert.ok(triggerPriority('config') > triggerPriority('idle'));
  assert.ok(triggerPriority('idle') > triggerPriority('prelaunch'));
});

test('未知の trigger は最低優先度扱い', () => {
  assert.equal(triggerPriority('unknown-trigger'), 0);
  assert.equal(triggerPriority('unknown-trigger'), triggerPriority('prelaunch'));
});

// ---- decideEnqueue ----

test('decideEnqueue: in-flight でなければ run-now', () => {
  const result = decideEnqueue({ inFlight: false, pendingTrigger: null }, 'idle');
  assert.deepEqual(result, { action: 'run-now' });
});

test('decideEnqueue: in-flight かつ pending 無しなら queue-pending', () => {
  const result = decideEnqueue({ inFlight: true, pendingTrigger: null }, 'idle');
  assert.deepEqual(result, { action: 'queue-pending', trigger: 'idle' });
});

test('decideEnqueue: pending より新規の方が優先度高ければ置き換え', () => {
  const result = decideEnqueue({ inFlight: true, pendingTrigger: 'idle' }, 'manual');
  assert.deepEqual(result, { action: 'queue-pending', trigger: 'manual' });
});

test('decideEnqueue: pending の方が優先度高ければ keep-pending', () => {
  const result = decideEnqueue({ inFlight: true, pendingTrigger: 'manual' }, 'idle');
  assert.deepEqual(result, { action: 'keep-pending' });
});

test('decideEnqueue: 同一優先度なら keep-pending（既存を保持）', () => {
  const result = decideEnqueue({ inFlight: true, pendingTrigger: 'config' }, 'config');
  assert.deepEqual(result, { action: 'keep-pending' });
});

// ---- shouldAlwaysReport ----

test('shouldAlwaysReport: manual は true', () => {
  assert.equal(shouldAlwaysReport('manual'), true);
});

test('shouldAlwaysReport: manual 以外は false', () => {
  assert.equal(shouldAlwaysReport('idle'), false);
  assert.equal(shouldAlwaysReport('config'), false);
  assert.equal(shouldAlwaysReport('connect'), false);
  assert.equal(shouldAlwaysReport('prelaunch'), false);
});

// ---- mergeCapabilityResults ----

const baseResult = (overrides = {}) => ({
  provider: 'claude',
  kind: 'plugin',
  runtimeVersion: null,
  installed: [],
  updated: [],
  present: [],
  failed: [],
  notAllowed: [],
  ...overrides,
});

test('mergeCapabilityResults: 単一要素はそのまま返る', () => {
  const input = [baseResult({ installed: ['unity@devrelay'] })];
  const result = mergeCapabilityResults(input);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].installed, ['unity@devrelay']);
});

test('mergeCapabilityResults: 同一 provider×kind は結合される', () => {
  const input = [
    baseResult({ installed: ['a@devrelay'] }),
    baseResult({ installed: ['b@devrelay'] }),
  ];
  const result = mergeCapabilityResults(input);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].installed.sort(), ['a@devrelay', 'b@devrelay']);
});

test('mergeCapabilityResults: 重複要素は除去される', () => {
  const input = [
    baseResult({ installed: ['a@devrelay'] }),
    baseResult({ installed: ['a@devrelay'] }),
  ];
  const result = mergeCapabilityResults(input);
  assert.deepEqual(result[0].installed, ['a@devrelay']);
});

test('mergeCapabilityResults: runtimeVersion は null でない値を優先する', () => {
  const input = [
    baseResult({ runtimeVersion: null }),
    baseResult({ runtimeVersion: '2.1.0' }),
  ];
  const result = mergeCapabilityResults(input);
  assert.equal(result[0].runtimeVersion, '2.1.0');
});

test('mergeCapabilityResults: provider×kind が異なれば別エントリのまま', () => {
  const input = [
    baseResult({ provider: 'claude', kind: 'plugin' }),
    baseResult({ provider: 'claude', kind: 'skill' }),
  ];
  const result = mergeCapabilityResults(input);
  assert.equal(result.length, 2);
});

test('mergeCapabilityResults: failed は id+reason の組で重複除去される', () => {
  const input = [
    baseResult({ failed: [{ id: 'x@devrelay', reason: 'blocked' }] }),
    baseResult({ failed: [{ id: 'x@devrelay', reason: 'blocked' }, { id: 'y@devrelay', reason: 'notAllowed' }] }),
  ];
  const result = mergeCapabilityResults(input);
  assert.equal(result[0].failed.length, 2);
});

test('mergeCapabilityResults: 空配列は空配列を返す', () => {
  assert.deepEqual(mergeCapabilityResults([]), []);
});

// ---- buildUnsupportedResult ----

test('buildUnsupportedResult: provider 自体が未知なら unsupported-provider', () => {
  const result = buildUnsupportedResult('codex', 'plugin', false);
  assert.equal(result.failed[0].reason, 'unsupported-provider');
  assert.equal(result.provider, 'codex');
  assert.equal(result.kind, 'plugin');
});

test('buildUnsupportedResult: provider は既知だが kind が無ければ unsupported-kind', () => {
  const result = buildUnsupportedResult('claude', 'mcp', true);
  assert.equal(result.failed[0].reason, 'unsupported-kind');
});

test('buildUnsupportedResult: 他のフィールドは空のまま', () => {
  const result = buildUnsupportedResult('claude', 'mcp', true);
  assert.deepEqual(result.installed, []);
  assert.deepEqual(result.updated, []);
  assert.deepEqual(result.present, []);
  assert.deepEqual(result.notAllowed, []);
  assert.equal(result.runtimeVersion, null);
});

// ---- buildPrelaunchCacheKey / decidePrelaunchAction ----

test('buildPrelaunchCacheKey: provider と projectPath を組み合わせる', () => {
  const key1 = buildPrelaunchCacheKey('claude', '/home/user/proj-a');
  const key2 = buildPrelaunchCacheKey('claude', '/home/user/proj-b');
  assert.notEqual(key1, key2);
});

test('decidePrelaunchAction: キャッシュが無ければ run', () => {
  const action = decidePrelaunchAction(null, 'claude\u0000/proj', 1000, 5000);
  assert.equal(action, 'run');
});

test('decidePrelaunchAction: キーが違えば run', () => {
  const cache = { key: 'claude\u0000/proj-a', cachedAtMs: 1000 };
  const action = decidePrelaunchAction(cache, 'claude\u0000/proj-b', 1500, 5000);
  assert.equal(action, 'run');
});

test('decidePrelaunchAction: 同一キー + TTL 内なら use-cache', () => {
  const cache = { key: 'claude\u0000/proj', cachedAtMs: 1000 };
  const action = decidePrelaunchAction(cache, 'claude\u0000/proj', 3000, 5000);
  assert.equal(action, 'use-cache');
});

test('decidePrelaunchAction: 同一キーでも TTL 超過なら run', () => {
  const cache = { key: 'claude\u0000/proj', cachedAtMs: 1000 };
  const action = decidePrelaunchAction(cache, 'claude\u0000/proj', 10000, 5000);
  assert.equal(action, 'run');
});

// ---- listConfiguredProviders（サイクルP1.2） ----

test('listConfiguredProviders: null/undefined は空配列', () => {
  assert.deepEqual(listConfiguredProviders(null), []);
  assert.deepEqual(listConfiguredProviders(undefined), []);
});

test('listConfiguredProviders: 空オブジェクトは空配列', () => {
  assert.deepEqual(listConfiguredProviders({}), []);
});

test('listConfiguredProviders: 値が非 null オブジェクトのキーだけを返す', () => {
  const result = listConfiguredProviders({ claude: { marketplaceName: 'devrelay', marketplaceSource: 'x/y' } });
  assert.deepEqual(result, ['claude']);
});

test('listConfiguredProviders: 値が null/配列/非オブジェクトのキーは無視する', () => {
  const result = listConfiguredProviders({ claude: { marketplaceName: 'a', marketplaceSource: 'b' }, codex: null, devin: 'x', gemini: [1, 2] });
  assert.deepEqual(result, ['claude']);
});

test('listConfiguredProviders: 複数 provider が設定されていれば全て返す', () => {
  const result = listConfiguredProviders({ claude: { a: 1 }, codex: { b: 2 } });
  assert.deepEqual(result.sort(), ['claude', 'codex']);
});

// ---- resolveReconcileTargets（サイクルP1.2の中核） ----

const item = (provider, kind, id) => ({ provider, kind, id });

test('resolveReconcileTargets: items 空 + providers.claude あり → registry 由来 1 件（items:[]・hasAdapter:true）', () => {
  const result = resolveReconcileTargets(['claude'], [], ['claude:plugin']);
  assert.deepEqual(result, [{ provider: 'claude', kind: 'plugin', items: [], hasAdapter: true }]);
});

test('resolveReconcileTargets: providers 未設定 + items 空 → 空配列（何も対象にならない）', () => {
  const result = resolveReconcileTargets([], [], ['claude:plugin']);
  assert.deepEqual(result, []);
});

test('回帰ガード: items 2件 + providers.claude あり → ターゲット1件に items 2件が保持される（items が [] に潰れない）', () => {
  const items = [item('claude', 'plugin', 'a'), item('claude', 'plugin', 'b')];
  const result = resolveReconcileTargets(['claude'], items, ['claude:plugin']);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].items, items);
  assert.equal(result[0].hasAdapter, true);
});

test('resolveReconcileTargets: providers 未設定でも items があれば items 由来のターゲットは作る', () => {
  const items = [item('claude', 'plugin', 'a')];
  const result = resolveReconcileTargets([], items, ['claude:plugin']);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].items, items);
});

test('resolveReconcileTargets: 未知 provider の item は hasAdapter:false（unsupported-provider 経路に流れる）', () => {
  const items = [item('codex', 'plugin', 'a')];
  const result = resolveReconcileTargets([], items, ['claude:plugin']);
  assert.equal(result.length, 1);
  assert.equal(result[0].hasAdapter, false);
});

test('resolveReconcileTargets: providerFilter 指定時は該当 provider の items 以外を除外する', () => {
  const items = [item('claude', 'plugin', 'a'), item('codex', 'plugin', 'b')];
  const result = resolveReconcileTargets(['claude', 'codex'], items, ['claude:plugin', 'codex:plugin'], 'claude');
  assert.equal(result.length, 1);
  assert.equal(result[0].provider, 'claude');
});

test('resolveReconcileTargets: providerFilter 指定時は registry 由来ターゲットも該当 provider のみに絞る', () => {
  const result = resolveReconcileTargets(['claude', 'codex'], [], ['claude:plugin', 'codex:plugin'], 'claude');
  assert.deepEqual(result, [{ provider: 'claude', kind: 'plugin', items: [], hasAdapter: true }]);
});

test('resolveReconcileTargets: items が配列でなくても例外を投げず空扱いにする', () => {
  const result = resolveReconcileTargets(['claude'], undefined, ['claude:plugin']);
  assert.deepEqual(result, [{ provider: 'claude', kind: 'plugin', items: [], hasAdapter: true }]);
});

test('resolveReconcileTargets: providers も items も無ければ空配列', () => {
  assert.deepEqual(resolveReconcileTargets([], [], ['claude:plugin']), []);
});

test('resolveReconcileTargets: 複数 kind の registry キーは provider が一致する分だけ追加される', () => {
  const result = resolveReconcileTargets(['claude'], [], ['claude:plugin', 'claude:skill', 'codex:plugin']);
  assert.deepEqual(result.map(t => `${t.provider}:${t.kind}`).sort(), ['claude:plugin', 'claude:skill']);
});

// ---- hasReportableOutcome（サイクルP1.2: prelaunch の無意味な送信抑止） ----

test('hasReportableOutcome: 全フィールド空なら false', () => {
  assert.equal(hasReportableOutcome([baseResult()]), false);
});

test('hasReportableOutcome: present のみでも false（変化なしは報告しない）', () => {
  assert.equal(hasReportableOutcome([baseResult({ present: ['a@devrelay'] })]), false);
});

test('hasReportableOutcome: installed が 1 件でもあれば true', () => {
  assert.equal(hasReportableOutcome([baseResult({ installed: ['a@devrelay'] })]), true);
});

test('hasReportableOutcome: updated が 1 件でもあれば true', () => {
  assert.equal(hasReportableOutcome([baseResult({ updated: ['a@devrelay'] })]), true);
});

test('hasReportableOutcome: failed が 1 件でもあれば true', () => {
  assert.equal(hasReportableOutcome([baseResult({ failed: [{ id: 'a', reason: 'x' }] })]), true);
});

test('hasReportableOutcome: notAllowed が 1 件でもあれば true', () => {
  assert.equal(hasReportableOutcome([baseResult({ notAllowed: ['a@devrelay'] })]), true);
});

test('hasReportableOutcome: 空配列は false', () => {
  assert.equal(hasReportableOutcome([]), false);
});
