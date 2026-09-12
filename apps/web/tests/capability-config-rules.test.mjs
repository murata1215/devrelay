// サイクルP1: Capability 配布基盤の Web UI ↔ CapabilityConfig 変換ロジック（外部 import ゼロの純関数）を
// コンパイル済み dist-test から直接 import する（panel-resize-rules.test.mjs と同じ流儀）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  capabilityConfigToFormState,
  formStateToCapabilityConfig,
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

// ---- formStateToCapabilityConfig ----

test('formStateToCapabilityConfig: 3項目すべて揃えば有効な設定を返す', () => {
  const result = formStateToCapabilityConfig({
    marketplaceName: 'devrelay',
    marketplaceSource: 'murata1215/devrelay-plugins',
    pluginIds: ['commit-commands', 'unity'],
  });
  assert.deepEqual(result, {
    providers: { claude: { marketplaceName: 'devrelay', marketplaceSource: 'murata1215/devrelay-plugins' } },
    items: [
      { provider: 'claude', kind: 'plugin', id: 'commit-commands' },
      { provider: 'claude', kind: 'plugin', id: 'unity' },
    ],
  });
});

test('formStateToCapabilityConfig: marketplaceName 空なら null（機能OFF）', () => {
  const result = formStateToCapabilityConfig({ marketplaceName: '', marketplaceSource: 'src', pluginIds: ['a'] });
  assert.equal(result, null);
});

test('formStateToCapabilityConfig: marketplaceSource 空なら null', () => {
  const result = formStateToCapabilityConfig({ marketplaceName: 'devrelay', marketplaceSource: '', pluginIds: ['a'] });
  assert.equal(result, null);
});

test('formStateToCapabilityConfig: pluginIds 空なら null', () => {
  const result = formStateToCapabilityConfig({ marketplaceName: 'devrelay', marketplaceSource: 'src', pluginIds: [] });
  assert.equal(result, null);
});

test('formStateToCapabilityConfig: 前後の空白と空文字要素は取り除かれる', () => {
  const result = formStateToCapabilityConfig({
    marketplaceName: '  devrelay  ',
    marketplaceSource: '  murata1215/devrelay-plugins  ',
    pluginIds: [' unity ', '', '  '],
  });
  assert.equal(result.providers.claude.marketplaceName, 'devrelay');
  assert.equal(result.providers.claude.marketplaceSource, 'murata1215/devrelay-plugins');
  assert.deepEqual(result.items.map(i => i.id), ['unity']);
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
