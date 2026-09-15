// サイクルP1: Capability 配布基盤の Web UI ↔ CapabilityConfig 変換ロジック（外部 import ゼロの純関数）を
// コンパイル済み dist-test から直接 import する（panel-resize-rules.test.mjs と同じ流儀）。
//
// サイクルP3-B: `distributeToDevin` チェックボックスを廃止し、pluginIds から
// `claude:plugin` + `agent-skills:standard` の items を常に両方生成するよう変更した。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  capabilityConfigToFormState,
  validateCapabilityForm,
  formatPluginTag,
  normalizePluginIdInput,
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

test('capabilityConfigToFormState: agent-skills:standard の item は claude:plugin と重複しても二重カウントしない', () => {
  const config = {
    providers: { claude: { marketplaceName: 'devrelay', marketplaceSource: 'x/y' } },
    items: [
      { provider: 'claude', kind: 'plugin', id: 'access-migration' },
      { provider: 'agent-skills', kind: 'standard', id: 'access-migration' },
    ],
  };
  const result = capabilityConfigToFormState(config);
  assert.deepEqual(result.pluginIds, ['access-migration']);
});

test('capabilityConfigToFormState: 旧 DB 値（providers.devin + devin:skill items）が残っていても pluginIds に影響しない（後方互換）', () => {
  const config = {
    providers: {
      claude: { marketplaceName: 'devrelay', marketplaceSource: 'x/y' },
      devin: { marketplaceName: 'devrelay', marketplaceSource: 'x/y' },
    },
    items: [
      { provider: 'claude', kind: 'plugin', id: 'access-migration' },
      { provider: 'devin', kind: 'skill', id: 'access-migration' },
    ],
  };
  const result = capabilityConfigToFormState(config);
  assert.deepEqual(result.pluginIds, ['access-migration']);
  assert.equal('distributeToDevin' in result, false);
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

test('validateCapabilityForm: 3項目すべて揃えば claude:plugin + agent-skills:standard の items を常に両方生成する', () => {
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
        { provider: 'agent-skills', kind: 'standard', id: 'commit-commands' },
        { provider: 'agent-skills', kind: 'standard', id: 'unity' },
      ],
    },
  });
});

test('validateCapabilityForm: providers.devin は二度と生成しない', () => {
  const result = validateCapabilityForm({
    marketplaceName: 'devrelay',
    marketplaceSource: 'x/y',
    pluginIds: ['a'],
  });
  assert.equal('devin' in result.config.providers, false);
  assert.deepEqual(Object.keys(result.config.providers), ['claude']);
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
  assert.deepEqual(result.config.items.map(i => i.id), ['unity', 'unity']);
  assert.deepEqual(result.config.items.map(i => i.provider), ['claude', 'agent-skills']);
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

test('formatPluginTag: 既に @marketplaceName 付きの id には二重付与しない（サイクルP3-B §5-9(b)）', () => {
  assert.equal(formatPluginTag('unity@devrelay', 'devrelay'), 'unity@devrelay');
});

test('formatPluginTag: 別マーケットプレイス名のサフィックスが付いていれば末尾一致しないので付与する', () => {
  assert.equal(formatPluginTag('unity@other', 'devrelay'), 'unity@other@devrelay');
});

// ---- normalizePluginIdInput（サイクルP3-B §5-9(a)） ----

test('normalizePluginIdInput: bare id はそのまま採用される', () => {
  assert.deepEqual(normalizePluginIdInput('unity', 'devrelay'), { ok: true, id: 'unity' });
});

test('normalizePluginIdInput: 前後空白は trim される', () => {
  assert.deepEqual(normalizePluginIdInput('  unity  ', 'devrelay'), { ok: true, id: 'unity' });
});

test('normalizePluginIdInput: 末尾の @marketplaceName は1回だけ剥がされる', () => {
  assert.deepEqual(normalizePluginIdInput('context7@devrelay', 'devrelay'), { ok: true, id: 'context7' });
});

test('normalizePluginIdInput: 二重サフィックス値は1回しか剥がさない（1段防御の限界。表示/Agent側で吸収）', () => {
  assert.deepEqual(normalizePluginIdInput('context7@devrelay@devrelay', 'devrelay'), { ok: true, id: 'context7@devrelay' });
});

test('normalizePluginIdInput: 空文字は reason:empty で reject', () => {
  assert.deepEqual(normalizePluginIdInput('', 'devrelay'), { ok: false, reason: 'empty' });
});

test('normalizePluginIdInput: 空白のみは reason:empty で reject', () => {
  assert.deepEqual(normalizePluginIdInput('   ', 'devrelay'), { ok: false, reason: 'empty' });
});

test('normalizePluginIdInput: サフィックスを剥がした結果が空なら reason:empty で reject', () => {
  assert.deepEqual(normalizePluginIdInput('@devrelay', 'devrelay'), { ok: false, reason: 'empty' });
});

test('normalizePluginIdInput: 既存 pluginIds に同じ bare id があれば reason:duplicate で reject（追加しない）', () => {
  assert.deepEqual(normalizePluginIdInput('unity', 'devrelay', ['unity', 'commit-commands']), { ok: false, reason: 'duplicate' });
});

test('normalizePluginIdInput: サフィックス付き入力を剥がした結果が重複していれば reason:duplicate', () => {
  assert.deepEqual(normalizePluginIdInput('unity@devrelay', 'devrelay', ['unity']), { ok: false, reason: 'duplicate' });
});

test('normalizePluginIdInput: marketplaceName が空文字なら剥がす対象なし（bare id 扱い）', () => {
  assert.deepEqual(normalizePluginIdInput('unity', ''), { ok: true, id: 'unity' });
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

test('decideSyncStatusDisplay: status ありなら集計して synced を返す（summary に presentCount/removedCount を含む）', () => {
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
    presentCount: 1,
    failedCount: 1,
    notAllowedCount: 1,
    removedCount: 0,
    trigger: 'manual',
  });
});

test('decideSyncStatusDisplay: 複数 results の集計値を合算する（removed も合算）', () => {
  const status = {
    status: 'done', trigger: 'idle', durationMs: 1, receivedAt: 'x',
    results: [
      { provider: 'claude', kind: 'plugin', runtimeVersion: null, installed: ['a'], updated: ['b'], present: [], failed: [], notAllowed: [] },
      { provider: 'agent-skills', kind: 'standard', runtimeVersion: null, installed: ['c'], updated: [], present: [], failed: [{ id: 'x', reason: 'y' }], notAllowed: [], removed: ['legacy:c/skill'] },
    ],
  };
  const result = decideSyncStatusDisplay(status, true);
  assert.equal(result.summary.installedCount, 2);
  assert.equal(result.summary.updatedCount, 1);
  assert.equal(result.summary.failedCount, 1);
  assert.equal(result.summary.removedCount, 1);
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

// サイクルP1.2以降、results:[] は「provider 設定自体が無い（配布設定が実質空）」ケースのみで発生する
// （providers.<provider> が設定されていれば Agent 側は items 0 件でも results.length>=1 を返すため）
test('decideSyncStatusDisplay: done + results:[] は synced かつ emptyTargets:true', () => {
  const status = { status: 'done', trigger: 'manual', durationMs: 0, receivedAt: 'x', results: [] };
  const result = decideSyncStatusDisplay(status, true);
  assert.equal(result.kind, 'synced');
  assert.equal(result.emptyTargets, true);
});

test('decideSyncStatusDisplay: done + results:[] は perProvider も undefined（0件時の形状回帰ガード）', () => {
  const status = { status: 'done', trigger: 'manual', durationMs: 0, receivedAt: 'x', results: [] };
  const result = decideSyncStatusDisplay(status, true);
  assert.equal(result.perProvider, undefined);
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

// ---- decideSyncStatusDisplay: perProvider（サイクルP3-B §5-10: 1件でも常に出す） ----

test('decideSyncStatusDisplay: results 1件でも perProvider が出る（P3-B で >1 条件を撤去）', () => {
  const status = {
    status: 'done', trigger: 'manual', durationMs: 1, receivedAt: 'x',
    results: [{ provider: 'claude', kind: 'plugin', runtimeVersion: '2.1.263', installed: ['a'], updated: [], present: [], failed: [], notAllowed: [] }],
  };
  const result = decideSyncStatusDisplay(status, true);
  assert.deepEqual(result.perProvider, [
    { provider: 'claude', kind: 'plugin', installedCount: 1, updatedCount: 0, presentCount: 0, failedCount: 0, notAllowedCount: 0, removedCount: 0, runtimeDiagnostics: '2.1.263' },
  ]);
});

test('decideSyncStatusDisplay: runtimeVersion が null なら runtimeDiagnostics キー自体を生やさない', () => {
  const status = {
    status: 'done', trigger: 'manual', durationMs: 1, receivedAt: 'x',
    results: [{ provider: 'claude', kind: 'plugin', runtimeVersion: null, installed: ['a'], updated: [], present: [], failed: [], notAllowed: [] }],
  };
  const result = decideSyncStatusDisplay(status, true);
  assert.equal('runtimeDiagnostics' in result.perProvider[0], false);
});

test('decideSyncStatusDisplay: results 2件（claude:plugin + agent-skills:standard）は perProvider が provider 別に分かれる', () => {
  const status = {
    status: 'done', trigger: 'manual', durationMs: 1, receivedAt: 'x',
    results: [
      { provider: 'claude', kind: 'plugin', runtimeVersion: '2.1.263', installed: ['a@devrelay'], updated: [], present: [], failed: [], notAllowed: [] },
      { provider: 'agent-skills', kind: 'standard', runtimeVersion: 'Devin 3000.6.7 検出 / Codex 設定なし', installed: ['a/skill1'], updated: [], present: [], failed: [], notAllowed: [], removed: ['a/skill2'] },
    ],
  };
  const result = decideSyncStatusDisplay(status, true);
  assert.deepEqual(result.perProvider, [
    { provider: 'claude', kind: 'plugin', installedCount: 1, updatedCount: 0, presentCount: 0, failedCount: 0, notAllowedCount: 0, removedCount: 0, runtimeDiagnostics: '2.1.263' },
    { provider: 'agent-skills', kind: 'standard', installedCount: 1, updatedCount: 0, presentCount: 0, failedCount: 0, notAllowedCount: 0, removedCount: 1, runtimeDiagnostics: 'Devin 3000.6.7 検出 / Codex 設定なし' },
  ]);
});

test('decideSyncStatusDisplay: error でも results 1件以上なら perProvider が付く', () => {
  const status = {
    status: 'error', trigger: 'manual', durationMs: 1, receivedAt: 'x',
    results: [
      { provider: 'claude', kind: 'plugin', runtimeVersion: null, installed: [], updated: [], present: [], failed: [], notAllowed: [] },
      { provider: 'agent-skills', kind: 'standard', runtimeVersion: null, installed: [], updated: [], present: [], failed: [{ id: 'x', reason: 'y' }], notAllowed: [] },
    ],
  };
  const result = decideSyncStatusDisplay(status, true);
  assert.equal(result.kind, 'error');
  assert.equal(result.perProvider.length, 2);
  assert.equal(result.perProvider[1].failedCount, 1);
});

test('decideSyncStatusDisplay: perProvider の removed は legacy: prefix を保ったまま results 側で参照できる（web は removedCount に合算のみ）', () => {
  const status = {
    status: 'done', trigger: 'manual', durationMs: 1, receivedAt: 'x',
    results: [
      { provider: 'agent-skills', kind: 'standard', runtimeVersion: null, installed: [], updated: [], present: [], failed: [], notAllowed: [], removed: ['context7/skill1', 'legacy:context7/skill1'] },
    ],
  };
  const result = decideSyncStatusDisplay(status, true);
  assert.equal(result.perProvider[0].removedCount, 2);
  assert.deepEqual(status.results[0].removed, ['context7/skill1', 'legacy:context7/skill1']);
});
