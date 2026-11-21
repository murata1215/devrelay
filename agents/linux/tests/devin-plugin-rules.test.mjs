// サイクルP4-A: devin-plugin-rules.ts（外部 import ゼロの純粋関数群）の単体テスト。
// コンパイル済み dist から直接 import する。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isDevinPluginEnabled,
  resolveDevinPluginStatePath,
  buildDevinInstallSource,
  DEVIN_PLUGIN_STATE_ADAPTER,
  buildDevinPluginState,
  isOwnedDevinPluginState,
  decideDevinPluginAction,
  decideDevinPluginRemovals,
  DEVIN_PLUGIN_ADAPTER_BUDGET_MS,
  hasBudgetLeft,
  formatDevinPluginVersion,
  buildDevinPluginDiagnostics,
  resolveFailureIds,
} from '../dist/services/capabilities/devin-plugin-rules.js';

// ---- isDevinPluginEnabled ----

test('isDevinPluginEnabled: 未設定なら true（既定 ON）', () => {
  assert.equal(isDevinPluginEnabled({}), true);
});

test('isDevinPluginEnabled: "0" なら false', () => {
  assert.equal(isDevinPluginEnabled({ DEVRELAY_DEVIN_PLUGIN: '0' }), false);
});

test('isDevinPluginEnabled: "0" 以外の値（"1"/"false"等）は true のまま', () => {
  assert.equal(isDevinPluginEnabled({ DEVRELAY_DEVIN_PLUGIN: '1' }), true);
  assert.equal(isDevinPluginEnabled({ DEVRELAY_DEVIN_PLUGIN: 'false' }), true);
});

// ---- resolveDevinPluginStatePath ----

test('resolveDevinPluginStatePath: env override 絶対パス(win32) は最優先', () => {
  const r = resolveDevinPluginStatePath({
    platform: 'win32',
    env: { DEVRELAY_DEVIN_PLUGIN_STATE: 'D:\\custom\\devin-plugins.json' },
    configDir: 'C:\\Users\\x\\.devrelay',
  });
  assert.deepEqual(r, { ok: true, path: 'D:\\custom\\devin-plugins.json' });
});

test('resolveDevinPluginStatePath: env override 絶対パス(posix) は最優先', () => {
  const r = resolveDevinPluginStatePath({
    platform: 'linux',
    env: { DEVRELAY_DEVIN_PLUGIN_STATE: '/opt/custom/devin-plugins.json' },
    configDir: '/home/x/.devrelay',
  });
  assert.deepEqual(r, { ok: true, path: '/opt/custom/devin-plugins.json' });
});

test('resolveDevinPluginStatePath: env override が相対パスなら ok:false（黙って無視しない）', () => {
  const r = resolveDevinPluginStatePath({
    platform: 'linux',
    env: { DEVRELAY_DEVIN_PLUGIN_STATE: 'relative/devin-plugins.json' },
    configDir: '/home/x/.devrelay',
  });
  assert.deepEqual(r, { ok: false, reason: 'override-not-absolute' });
});

test('resolveDevinPluginStatePath: 既定（posix）は <configDir>/capabilities/devin-plugins.json', () => {
  const r = resolveDevinPluginStatePath({ platform: 'linux', env: {}, configDir: '/home/x/.devrelay' });
  assert.deepEqual(r, { ok: true, path: '/home/x/.devrelay/capabilities/devin-plugins.json' });
});

test('resolveDevinPluginStatePath: 既定（win32）は区切りが \\\\', () => {
  const r = resolveDevinPluginStatePath({ platform: 'win32', env: {}, configDir: 'C:\\Users\\x\\.devrelay' });
  assert.deepEqual(r, { ok: true, path: 'C:\\Users\\x\\.devrelay\\capabilities\\devin-plugins.json' });
});

test('resolveDevinPluginStatePath: configDir 末尾のセパレータは正規化される', () => {
  const r = resolveDevinPluginStatePath({ platform: 'linux', env: {}, configDir: '/home/x/.devrelay/' });
  assert.deepEqual(r, { ok: true, path: '/home/x/.devrelay/capabilities/devin-plugins.json' });
});

test('resolveDevinPluginStatePath: configDir 空なら ok:false', () => {
  const r = resolveDevinPluginStatePath({ platform: 'linux', env: {}, configDir: '' });
  assert.deepEqual(r, { ok: false, reason: 'config-dir-missing' });
});

// ---- buildDevinInstallSource ----

test('buildDevinInstallSource: owner/repo 形式 + 相対パス → "owner/repo#relPath"', () => {
  const r = buildDevinInstallSource('murata1215/devrelay-plugins', 'plugins/context7');
  assert.deepEqual(r, { ok: true, source: 'murata1215/devrelay-plugins#plugins/context7' });
});

test('buildDevinInstallSource: https://github.com/... 形式も許可', () => {
  const r = buildDevinInstallSource('https://github.com/murata1215/devrelay-plugins.git', 'plugins/context7');
  assert.deepEqual(r, { ok: true, source: 'https://github.com/murata1215/devrelay-plugins.git#plugins/context7' });
});

test('buildDevinInstallSource: gitlab 等サポート外ホストは unsupported-source-format', () => {
  const r = buildDevinInstallSource('https://gitlab.com/acme/review-tools.git', 'plugins/x');
  assert.deepEqual(r, { ok: false, reason: 'unsupported-source-format' });
});

test('buildDevinInstallSource: git@/ssh:// は unsupported-source-format', () => {
  assert.deepEqual(buildDevinInstallSource('git@github.com:acme/x.git', 'plugins/x'), { ok: false, reason: 'unsupported-source-format' });
  assert.deepEqual(buildDevinInstallSource('ssh://git@github.com/acme/x.git', 'plugins/x'), { ok: false, reason: 'unsupported-source-format' });
});

test('buildDevinInstallSource: "-" 始まりは unsupported-source-format（execFile の argv オプション誤認対策）', () => {
  const r = buildDevinInstallSource('-malicious/repo', 'plugins/x');
  assert.deepEqual(r, { ok: false, reason: 'unsupported-source-format' });
});

test('buildDevinInstallSource: ".." を含む marketplaceSource は unsupported-source-format', () => {
  const r = buildDevinInstallSource('owner/../repo', 'plugins/x');
  assert.deepEqual(r, { ok: false, reason: 'unsupported-source-format' });
});

test('buildDevinInstallSource: 空の relPath は unsafe-path', () => {
  const r = buildDevinInstallSource('murata1215/devrelay-plugins', '');
  assert.deepEqual(r, { ok: false, reason: 'unsafe-path' });
});

test('buildDevinInstallSource: NUL バイトを含む relPath は unsafe-path', () => {
  const r = buildDevinInstallSource('murata1215/devrelay-plugins', 'plugins/\0x');
  assert.deepEqual(r, { ok: false, reason: 'unsafe-path' });
});

test('buildDevinInstallSource: marketplaceSource が空文字は unsupported-source-format', () => {
  const r = buildDevinInstallSource('', 'plugins/x');
  assert.deepEqual(r, { ok: false, reason: 'unsupported-source-format' });
});

// ---- state 型・所有判定 ----

test('DEVIN_PLUGIN_STATE_ADAPTER の値', () => {
  assert.equal(DEVIN_PLUGIN_STATE_ADAPTER, 'devin-plugin');
});

test('buildDevinPluginState: schema/managedBy/adapter を固定し entries をそのまま持つ', () => {
  const entries = [{ pluginId: 'context7', installSource: 'owner/repo#plugins/context7', indexCommit: 'abc123', installedAt: '2026-10-31T00:00:00.000Z' }];
  const state = buildDevinPluginState(entries);
  assert.deepEqual(state, { schema: 1, managedBy: 'devrelay', adapter: 'devin-plugin', entries });
});

test('isOwnedDevinPluginState: 正しい形なら true', () => {
  const state = buildDevinPluginState([]);
  assert.equal(isOwnedDevinPluginState(state), true);
});

test('isOwnedDevinPluginState: null/undefined/非オブジェクトは false', () => {
  assert.equal(isOwnedDevinPluginState(null), false);
  assert.equal(isOwnedDevinPluginState(undefined), false);
  assert.equal(isOwnedDevinPluginState('string'), false);
  assert.equal(isOwnedDevinPluginState(42), false);
});

test('isOwnedDevinPluginState: schema が 1 以外は false', () => {
  assert.equal(isOwnedDevinPluginState({ schema: 2, managedBy: 'devrelay', adapter: 'devin-plugin', entries: [] }), false);
});

test('isOwnedDevinPluginState: managedBy が devrelay 以外は false', () => {
  assert.equal(isOwnedDevinPluginState({ schema: 1, managedBy: 'other', adapter: 'devin-plugin', entries: [] }), false);
});

test('isOwnedDevinPluginState: adapter が devin-plugin 以外は false（他 adapter の state を誤認しない）', () => {
  assert.equal(isOwnedDevinPluginState({ schema: 1, managedBy: 'devrelay', adapter: 'agent-skills-standard', entries: [] }), false);
});

test('isOwnedDevinPluginState: entries が配列でなければ false', () => {
  assert.equal(isOwnedDevinPluginState({ schema: 1, managedBy: 'devrelay', adapter: 'devin-plugin', entries: 'not-array' }), false);
});

// ---- decideDevinPluginAction ----

test('decideDevinPluginAction: state 無し & info NG → install', () => {
  const action = decideDevinPluginAction({ hasStateEntry: false, infoOk: false, stateIndexCommit: null, currentIndexCommit: 'c1' });
  assert.equal(action, 'install');
});

test('decideDevinPluginAction: state 無し & info ok（Devin に実在）→ conflict-unmanaged', () => {
  const action = decideDevinPluginAction({ hasStateEntry: false, infoOk: true, stateIndexCommit: null, currentIndexCommit: 'c1' });
  assert.equal(action, 'conflict-unmanaged');
});

test('decideDevinPluginAction: state あり & info NG（Devin 側から消えている）→ install（self-heal）', () => {
  const action = decideDevinPluginAction({ hasStateEntry: true, infoOk: false, stateIndexCommit: 'c1', currentIndexCommit: 'c1' });
  assert.equal(action, 'install');
});

test('decideDevinPluginAction: state あり & info ok & commit 一致 → present', () => {
  const action = decideDevinPluginAction({ hasStateEntry: true, infoOk: true, stateIndexCommit: 'c1', currentIndexCommit: 'c1' });
  assert.equal(action, 'present');
});

test('decideDevinPluginAction: state あり & info ok & commit 不一致 → update', () => {
  const action = decideDevinPluginAction({ hasStateEntry: true, infoOk: true, stateIndexCommit: 'c1', currentIndexCommit: 'c2' });
  assert.equal(action, 'update');
});

test('decideDevinPluginAction: currentIndexCommit が null（取得不能）なら常に update（present に倒さない）', () => {
  const action = decideDevinPluginAction({ hasStateEntry: true, infoOk: true, stateIndexCommit: 'c1', currentIndexCommit: null });
  assert.equal(action, 'update');
});

test('decideDevinPluginAction: state も currentIndexCommit も null 同士でも commit null 同士は一致とみなさない（update）', () => {
  const action = decideDevinPluginAction({ hasStateEntry: true, infoOk: true, stateIndexCommit: null, currentIndexCommit: null });
  assert.equal(action, 'update');
});

// ---- decideDevinPluginRemovals ----

test('decideDevinPluginRemovals: desired に無い state id を返す', () => {
  const removals = decideDevinPluginRemovals(['a', 'b', 'c'], ['a', 'c']);
  assert.deepEqual(removals, ['b']);
});

test('decideDevinPluginRemovals: desired が空なら全件返す', () => {
  const removals = decideDevinPluginRemovals(['a', 'b'], []);
  assert.deepEqual(removals, ['a', 'b']);
});

test('decideDevinPluginRemovals: state が空なら空配列', () => {
  const removals = decideDevinPluginRemovals([], ['a']);
  assert.deepEqual(removals, []);
});

test('decideDevinPluginRemovals: 完全一致なら空配列', () => {
  const removals = decideDevinPluginRemovals(['a', 'b'], ['a', 'b']);
  assert.deepEqual(removals, []);
});

// ---- 予算管理 ----

test('DEVIN_PLUGIN_ADAPTER_BUDGET_MS は 3 分（capability-sync.ts の ADAPTER_TIMEOUT_MS と同値）', () => {
  assert.equal(DEVIN_PLUGIN_ADAPTER_BUDGET_MS, 3 * 60 * 1000);
});

test('hasBudgetLeft: 経過時間が予算未満なら true', () => {
  assert.equal(hasBudgetLeft(1000, 1000 + 10_000, 10_000), true);
});

test('hasBudgetLeft: 経過時間が (予算 - reserve) を超えたら false', () => {
  const started = 1000;
  const now = started + DEVIN_PLUGIN_ADAPTER_BUDGET_MS - 5_000; // reserve 10s より残り少ない
  assert.equal(hasBudgetLeft(started, now, 10_000), false);
});

test('hasBudgetLeft: reserve 0 で予算ぴったりなら false（境界は含まない）', () => {
  const started = 1000;
  const now = started + DEVIN_PLUGIN_ADAPTER_BUDGET_MS;
  assert.equal(hasBudgetLeft(started, now, 0), false);
});

// ---- 診断文字列 ----

test('formatDevinPluginVersion: null/undefined は null', () => {
  assert.equal(formatDevinPluginVersion(null), null);
  assert.equal(formatDevinPluginVersion(undefined), null);
});

test('formatDevinPluginVersion: 空白のみは null', () => {
  assert.equal(formatDevinPluginVersion('   \n  '), null);
});

test('formatDevinPluginVersion: "devin " 接頭辞を除去する（実機出力形式）', () => {
  assert.equal(formatDevinPluginVersion('devin 3000.6.14 (18033302)'), '3000.6.14 (18033302)');
});

test('formatDevinPluginVersion: 接頭辞の大小文字は無視する', () => {
  assert.equal(formatDevinPluginVersion('Devin 3000.6.14'), '3000.6.14');
});

test('formatDevinPluginVersion: 接頭辞が無い場合はそのまま', () => {
  assert.equal(formatDevinPluginVersion('3000.6.14'), '3000.6.14');
});

test('formatDevinPluginVersion: 複数行なら最初の非空行だけを使う', () => {
  assert.equal(formatDevinPluginVersion('\n\ndevin 3000.6.14\nsome other line'), '3000.6.14');
});

test('formatDevinPluginVersion: 240 文字超は丸める', () => {
  const long = 'x'.repeat(300);
  const r = formatDevinPluginVersion(`devin ${long}`);
  assert.equal(r.length, 241); // 240 文字 + "…"
  assert.ok(r.endsWith('…'));
});

test('buildDevinPluginDiagnostics: devin 未検出', () => {
  const r = buildDevinPluginDiagnostics({ devinDetected: false, version: null, pluginsSupported: false });
  assert.equal(r, 'Devin 未検出');
});

test('buildDevinPluginDiagnostics: 検出 + 版あり + plugins 対応', () => {
  const r = buildDevinPluginDiagnostics({ devinDetected: true, version: 'devin 3000.6.14 (18033302)', pluginsSupported: true });
  assert.equal(r, 'Devin 3000.6.14 (18033302) 検出 / plugins: 対応');
});

test('buildDevinPluginDiagnostics: 検出 + 版あり + plugins 非対応', () => {
  const r = buildDevinPluginDiagnostics({ devinDetected: true, version: 'devin 3000.6.14', pluginsSupported: false });
  assert.equal(r, 'Devin 3000.6.14 検出 / plugins: 非対応');
});

test('buildDevinPluginDiagnostics: 検出 + 版取得不能', () => {
  const r = buildDevinPluginDiagnostics({ devinDetected: true, version: null, pluginsSupported: true });
  assert.equal(r, 'Devin 検出 / plugins: 対応');
});

// ---- resolveFailureIds ----

test('resolveFailureIds: itemIds が非空ならそのまま返す', () => {
  assert.deepEqual(resolveFailureIds(['a', 'b'], 'devin:plugin'), ['a', 'b']);
});

test('resolveFailureIds: itemIds が空なら fallbackId 1 件を返す', () => {
  assert.deepEqual(resolveFailureIds([], 'devin:plugin'), ['devin:plugin']);
});
