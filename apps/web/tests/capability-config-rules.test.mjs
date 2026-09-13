// サイクルP1: Capability 配布基盤の Web UI ↔ CapabilityConfig 変換ロジック（外部 import ゼロの純関数）を
// コンパイル済み dist-test から直接 import する（panel-resize-rules.test.mjs と同じ流儀）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  capabilityConfigToFormState,
  validateCapabilityForm,
  formatPluginTag,
  decideSyncStatusDisplay,
} from '../dist-test/lib/capability-config-rules.js';

// ---- capabilityConfigToFormState ----

test('capabilityConfigToFormState: null は空フォーム', () => {
  const result = capabilityConfigToFormState(null);
  assert.deepEqual(result, { marketplaceName: '', marketplaceSource: '', pluginIds: [] });
});

test('capabilityConfigToFormState: providers.claude と items から復元する', () => {
  const config = {
    providers: { claude: { marketplaceName: 'devrelay', marketplaceSource: 'murata1215/devrelay-plugins' } },
    items: [
      { provider: 'claude', kind: 'plugin', id: 'commit-commands' },
      { provider: 'claude', kind: 'plugin', id: 'unity' },
    ],
  };
  const result = capabilityConfigToFormState(config);
  assert.equal(result.marketplaceName, 'devrelay');
  assert.equal(result.marketplaceSource, 'murata1215/devrelay-plugins');
  assert.deepEqual(result.pluginIds, ['commit-commands', 'unity']);
});

test('capabilityConfigToFormState: provider/kind が claude/plugin 以外の item は無視する', () => {
  const config = {
    providers: { claude: { marketplaceName: 'devrelay', marketplaceSource: 'src' } },
    items: [
      { provider: 'claude', kind: 'plugin', id: 'a' },
      { provider: 'claude', kind: 'skill', id: 'b' },
      { provider: 'codex', kind: 'plugin', id: 'c' },
    ],
  };
  const result = capabilityConfigToFormState(config);
  assert.deepEqual(result.pluginIds, ['a']);
});

test('capabilityConfigToFormState: providers.claude が無ければ空文字', () => {
  const result = capabilityConfigToFormState({ providers: {}, items: [] });
  assert.equal(result.marketplaceName, '');
  assert.equal(result.marketplaceSource, '');
});

// ---- validateCapabilityForm ----

test('validateCapabilityForm: 3項目すべて揃えば有効な設定を返す', () => {
  const result = validateCapabilityForm({
    marketplaceName: 'devrelay',
    marketplaceSource: 'murata1215/devrelay-plugins',
    pluginIds: ['commit-commands', 'unity'],
  });
  assert.deepEqual(result, {
    ok: true,
    config: {
      providers: { claude: { marketplaceName: 'devrelay', marketplaceSource: 'murata1215/devrelay-plugins' } },
      items: [
        { provider: 'claude', kind: 'plugin', id: 'commit-commands' },
        { provider: 'claude', kind: 'plugin', id: 'unity' },
      ],
    },
  });
});

test('validateCapabilityForm: name+source が揃っていれば pluginIds が空でも有効（items:[]）← P1.1 の回帰ガード', () => {
  const result = validateCapabilityForm({
    marketplaceName: 'devrelay',
    marketplaceSource: 'murata1215/devrelay-plugins',
    pluginIds: [],
  });
  assert.deepEqual(result, {
    ok: true,
    config: {
      providers: { claude: { marketplaceName: 'devrelay', marketplaceSource: 'murata1215/devrelay-plugins' } },
      items: [],
    },
  });
});

test('validateCapabilityForm: 全項目空なら ok:true, config:null（機能OFF）', () => {
  const result = validateCapabilityForm({ marketplaceName: '', marketplaceSource: '', pluginIds: [] });
  assert.deepEqual(result, { ok: true, config: null });
});

test('validateCapabilityForm: 全項目が空白のみなら ok:true, config:null', () => {
  const result = validateCapabilityForm({ marketplaceName: '  ', marketplaceSource: '  ', pluginIds: ['  ', ''] });
  assert.deepEqual(result, { ok: true, config: null });
});

test('validateCapabilityForm: marketplaceName のみ入力なら marketplace-source-required', () => {
  const result = validateCapabilityForm({ marketplaceName: 'devrelay', marketplaceSource: '', pluginIds: [] });
  assert.deepEqual(result, { ok: false, error: 'marketplace-source-required' });
});

test('validateCapabilityForm: marketplaceSource のみ入力なら marketplace-name-required', () => {
  const result = validateCapabilityForm({ marketplaceName: '', marketplaceSource: 'src', pluginIds: [] });
  assert.deepEqual(result, { ok: false, error: 'marketplace-name-required' });
});

test('validateCapabilityForm: pluginIds あり + marketplace 両方空なら marketplace-required-for-plugins', () => {
  const result = validateCapabilityForm({ marketplaceName: '', marketplaceSource: '', pluginIds: ['a'] });
  assert.deepEqual(result, { ok: false, error: 'marketplace-required-for-plugins' });
});

test('validateCapabilityForm: 前後の空白と空文字要素は取り除かれる', () => {
  const result = validateCapabilityForm({
    marketplaceName: '  devrelay  ',
    marketplaceSource: '  murata1215/devrelay-plugins  ',
    pluginIds: [' unity ', '', '  '],
  });
  assert.equal(result.ok, true);
  assert.equal(result.config.providers.claude.marketplaceName, 'devrelay');
  assert.equal(result.config.providers.claude.marketplaceSource, 'murata1215/devrelay-plugins');
  assert.deepEqual(result.config.items.map(i => i.id), ['unity']);
});

test('validateCapabilityForm: pluginIds が空白要素だけなら items は空配列で ok:true', () => {
  const result = validateCapabilityForm({
    marketplaceName: 'devrelay',
    marketplaceSource: 'src',
    pluginIds: ['  ', ''],
  });
  assert.deepEqual(result, {
    ok: true,
    config: { providers: { claude: { marketplaceName: 'devrelay', marketplaceSource: 'src' } }, items: [] },
  });
});

// ---- formatPluginTag ----

test('formatPluginTag: marketplace 修飾子を補完する', () => {
  assert.equal(formatPluginTag('unity', 'devrelay'), 'unity@devrelay');
});

test('formatPluginTag: marketplaceName が空なら bare 名のまま', () => {
  assert.equal(formatPluginTag('unity', ''), 'unity');
});

// ---- decideSyncStatusDisplay ----

test('decideSyncStatusDisplay: status null かつ未対応 Agent は unsynced-unsupported', () => {
  const result = decideSyncStatusDisplay(null, false);
  assert.deepEqual(result, { kind: 'unsynced-unsupported' });
});

test('decideSyncStatusDisplay: status null かつ対応済み Agent は unsynced', () => {
  const result = decideSyncStatusDisplay(null, true);
  assert.deepEqual(result, { kind: 'unsynced' });
});

test('decideSyncStatusDisplay: status null かつ判定不能(null)は unsynced 扱い', () => {
  const result = decideSyncStatusDisplay(null, null);
  assert.deepEqual(result, { kind: 'unsynced' });
});

test('decideSyncStatusDisplay: status ありなら集計して synced を返す', () => {
  const status = {
    status: 'done',
    trigger: 'manual',
    durationMs: 1234,
    receivedAt: '2026-09-13T00:00:00.000Z',
    results: [
      {
        provider: 'claude', kind: 'plugin', runtimeVersion: '2.1.263',
        installed: ['a@devrelay'], updated: [], present: ['b@devrelay'],
        failed: [{ id: 'c@devrelay', reason: 'blocked' }], notAllowed: ['d@other'],
      },
    ],
  };
  const result = decideSyncStatusDisplay(status, true);
  assert.equal(result.kind, 'synced');
  assert.deepEqual(result.summary, {
    receivedAt: '2026-09-13T00:00:00.000Z',
    installedCount: 1,
    updatedCount: 0,
    failedCount: 1,
    notAllowedCount: 1,
    trigger: 'manual',
  });
});

test('decideSyncStatusDisplay: 複数 results の集計値を合算する', () => {
  const status = {
    status: 'done', trigger: 'idle', durationMs: 1, receivedAt: 'x',
    results: [
      { provider: 'claude', kind: 'plugin', runtimeVersion: null, installed: ['a'], updated: ['b'], present: [], failed: [], notAllowed: [] },
      { provider: 'claude', kind: 'plugin', runtimeVersion: null, installed: ['c'], updated: [], present: [], failed: [{ id: 'x', reason: 'y' }], notAllowed: [] },
    ],
  };
  const result = decideSyncStatusDisplay(status, true);
  assert.equal(result.summary.installedCount, 2);
  assert.equal(result.summary.updatedCount, 1);
  assert.equal(result.summary.failedCount, 1);
});

// ---- decideSyncStatusDisplay: P1.1 で追加した skipped/error/emptyTargets 区別 ----

test('decideSyncStatusDisplay: skipped + savedConfigPresent:false は skipped-no-config', () => {
  const status = { status: 'skipped', results: [], durationMs: 0, trigger: 'manual', receivedAt: 'x' };
  const result = decideSyncStatusDisplay(status, true, false);
  assert.equal(result.kind, 'skipped-no-config');
});

test('decideSyncStatusDisplay: skipped + savedConfigPresent:true は skipped-agent-stale', () => {
  const status = { status: 'skipped', results: [], durationMs: 0, trigger: 'manual', receivedAt: 'x' };
  const result = decideSyncStatusDisplay(status, true, true);
  assert.equal(result.kind, 'skipped-agent-stale');
});

test('decideSyncStatusDisplay: skipped + savedConfigPresent 省略(fail-open)は skipped-agent-stale', () => {
  const status = { status: 'skipped', results: [], durationMs: 0, trigger: 'manual', receivedAt: 'x' };
  const result = decideSyncStatusDisplay(status, true);
  assert.equal(result.kind, 'skipped-agent-stale');
});

test('decideSyncStatusDisplay: error は kind:error + failures を返す', () => {
  const status = {
    status: 'error', trigger: 'manual', durationMs: 1, receivedAt: 'x',
    results: [
      { provider: 'claude', kind: 'plugin', runtimeVersion: null, installed: [], updated: [], present: [], failed: [{ id: 'a', reason: 'blocked' }, { id: 'b', reason: 'timeout' }], notAllowed: [] },
    ],
  };
  const result = decideSyncStatusDisplay(status, true);
  assert.equal(result.kind, 'error');
  assert.equal(result.summary.failedCount, 2);
  assert.deepEqual(result.failures, [{ id: 'a', reason: 'blocked' }, { id: 'b', reason: 'timeout' }]);
});

test('decideSyncStatusDisplay: error は failures を最大 MAX_FAILURE_DETAILS 件に打ち切る', () => {
  const failed = Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, reason: 'blocked' }));
  const status = {
    status: 'error', trigger: 'idle', durationMs: 1, receivedAt: 'x',
    results: [{ provider: 'claude', kind: 'plugin', runtimeVersion: null, installed: [], updated: [], present: [], failed, notAllowed: [] }],
  };
  const result = decideSyncStatusDisplay(status, true);
  assert.equal(result.summary.failedCount, 6);
  assert.equal(result.failures.length, 5);
});

test('decideSyncStatusDisplay: done + results:[] は synced かつ emptyTargets:true', () => {
  const status = { status: 'done', trigger: 'manual', durationMs: 0, receivedAt: 'x', results: [] };
  const result = decideSyncStatusDisplay(status, true);
  assert.equal(result.kind, 'synced');
  assert.equal(result.emptyTargets, true);
});

test('decideSyncStatusDisplay: done + results 1件は emptyTargets が undefined（形状回帰ガード）', () => {
  const status = {
    status: 'done', trigger: 'manual', durationMs: 1, receivedAt: 'x',
    results: [{ provider: 'claude', kind: 'plugin', runtimeVersion: null, installed: ['a'], updated: [], present: [], failed: [], notAllowed: [] }],
  };
  const result = decideSyncStatusDisplay(status, true);
  assert.equal(result.kind, 'synced');
  assert.equal(result.emptyTargets, undefined);
});
