// サイクルP1.2: capability-sync.ts（共通層の I/O 部分）を fake adapter（I/O ゼロ）で駆動するテスト。
// コンパイル済み dist から直接 import する（実行時 import は `./capability-rules.js` のみで
// Claude CLI 呼び出し等の実 I/O を一切引き込まないことを確認済み）。
//
// 注意（module-level singleton の隔離ハザード）:
// - `prelaunchCache` はクリア不可・キーは provider 単位（値の中に projectPath 込みの cacheKey を持つ）。
//   テストごとに **異なる projectPath** を使うことで TTL キャッシュの影響を避ける。
// - `queueState`（machine キュー）もクリア不可。各テストは `requestReconcile()` を必ず await し、
//   同時に複数呼び出しをしないことで in-flight/pending が次のテストに漏れないようにする。
// - fake adapter は同期的に resolve する Promise のみを返す（`withTimeout` の 3 分/タイムアウト経路は
//   実タイマーが必要になるためここではテストしない）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  registerCapabilityAdapter,
  clearCapabilityAdapters,
  setCapabilityConfig,
  setCapabilitySyncSender,
  requestReconcile,
  reconcileForRunner,
} from '../dist/services/capability-sync.js';

/** テストごとに sendResultCallback を差し替えて送信内容をキャプチャする */
function captureOutcomes() {
  const sent = [];
  setCapabilitySyncSender((payload) => sent.push(payload));
  return sent;
}

function emptyPluginResult(overrides = {}) {
  return {
    provider: 'claude',
    kind: 'plugin',
    runtimeVersion: null,
    installed: [],
    updated: [],
    present: [],
    failed: [],
    notAllowed: [],
    ...overrides,
  };
}

function makeFakeClaudeAdapter(machineResult, projectResult) {
  const machineCalls = [];
  const projectCalls = [];
  return {
    adapter: {
      provider: 'claude',
      kind: 'plugin',
      async reconcileMachine(ctx) {
        machineCalls.push(ctx);
        return typeof machineResult === 'function' ? machineResult(ctx) : machineResult;
      },
      async reconcileProject(ctx, projectPath) {
        projectCalls.push({ ctx, projectPath });
        return typeof projectResult === 'function' ? projectResult(ctx, projectPath) : projectResult;
      },
    },
    machineCalls,
    projectCalls,
  };
}

// ---- machine 経路（requestReconcile → runMachineReconcile） ----

test('machine: items 空 + providers.claude あり → adapter が items:[] で 1 回呼ばれる', async () => {
  clearCapabilityAdapters();
  const { adapter, machineCalls } = makeFakeClaudeAdapter(emptyPluginResult({ runtimeVersion: '2.1.263' }), emptyPluginResult());
  registerCapabilityAdapter(adapter);
  setCapabilityConfig({ providers: { claude: { marketplaceName: 'devrelay', marketplaceSource: 'x/y' } }, items: [] });
  const sent = captureOutcomes();

  await requestReconcile('manual');

  assert.equal(machineCalls.length, 1);
  assert.deepEqual(machineCalls[0].items, []);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].status, 'done');
  assert.equal(sent[0].results[0].runtimeVersion, '2.1.263');
});

test('machine: providers 未設定 + items 空 → adapter 未呼び出し、results:[] の done', async () => {
  clearCapabilityAdapters();
  const { adapter, machineCalls } = makeFakeClaudeAdapter(emptyPluginResult(), emptyPluginResult());
  registerCapabilityAdapter(adapter);
  setCapabilityConfig({ providers: {}, items: [] });
  const sent = captureOutcomes();

  await requestReconcile('idle');

  assert.equal(machineCalls.length, 0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].status, 'done');
  assert.deepEqual(sent[0].results, []);
});

test('machine: config が null + manual trigger → skipped が必ず 1 通送られる', async () => {
  clearCapabilityAdapters();
  setCapabilityConfig(null);
  const sent = captureOutcomes();

  await requestReconcile('manual');

  assert.equal(sent.length, 1);
  assert.equal(sent[0].status, 'skipped');
});

test('machine: 未知 kind の item は unsupported-kind として failed に積まれる', async () => {
  clearCapabilityAdapters();
  const { adapter } = makeFakeClaudeAdapter(emptyPluginResult(), emptyPluginResult());
  registerCapabilityAdapter(adapter); // claude:plugin のみ登録
  setCapabilityConfig({ providers: {}, items: [{ provider: 'claude', kind: 'skill', id: 'x' }] });
  const sent = captureOutcomes();

  await requestReconcile('manual');

  assert.equal(sent[0].status, 'error');
  assert.equal(sent[0].results[0].failed[0].reason, 'unsupported-kind');
});

test('回帰ガード: items 2件 + providers.claude あり → adapter に 2 件とも渡り items が [] に潰れない', async () => {
  clearCapabilityAdapters();
  const { adapter, machineCalls } = makeFakeClaudeAdapter(emptyPluginResult({ installed: ['a@devrelay', 'b@devrelay'] }), emptyPluginResult());
  registerCapabilityAdapter(adapter);
  setCapabilityConfig({
    providers: { claude: { marketplaceName: 'devrelay', marketplaceSource: 'x/y' } },
    items: [{ provider: 'claude', kind: 'plugin', id: 'a' }, { provider: 'claude', kind: 'plugin', id: 'b' }],
  });
  const sent = captureOutcomes();

  await requestReconcile('manual');

  assert.equal(machineCalls.length, 1);
  assert.equal(machineCalls[0].items.length, 2);
  assert.deepEqual(sent[0].results[0].installed.sort(), ['a@devrelay', 'b@devrelay']);
});

// ---- prelaunch 経路（reconcileForRunner） ----

test('prelaunch: providers 未設定 → reconcileProject 未呼び出し・送信なし・キャッシュ汚染なし', async () => {
  clearCapabilityAdapters();
  const { adapter, projectCalls } = makeFakeClaudeAdapter(emptyPluginResult(), emptyPluginResult({ installed: ['a@devrelay'] }));
  registerCapabilityAdapter(adapter);
  const projectPath = '/tmp/devrelay-test-p1.2-not-configured';
  setCapabilityConfig({ providers: {}, items: [] });
  const sent = captureOutcomes();

  await reconcileForRunner('claude', projectPath);
  assert.equal(projectCalls.length, 0);
  assert.equal(sent.length, 0);

  // providers.claude を設定後、同じ projectPath でも今度は実行される（キャッシュに汚染されていない証拠）
  setCapabilityConfig({ providers: { claude: { marketplaceName: 'devrelay', marketplaceSource: 'x/y' } }, items: [] });
  await reconcileForRunner('claude', projectPath);
  assert.equal(projectCalls.length, 1);
});

test('prelaunch: items 空 + providers.claude あり → reconcileProject が items:[] で呼ばれる', async () => {
  clearCapabilityAdapters();
  const { adapter, projectCalls } = makeFakeClaudeAdapter(emptyPluginResult(), emptyPluginResult());
  registerCapabilityAdapter(adapter);
  setCapabilityConfig({ providers: { claude: { marketplaceName: 'devrelay', marketplaceSource: 'x/y' } }, items: [] });
  captureOutcomes();

  await reconcileForRunner('claude', '/tmp/devrelay-test-p1.2-empty-items');

  assert.equal(projectCalls.length, 1);
  assert.deepEqual(projectCalls[0].ctx.items, []);
});

test('prelaunch: 結果が全空（present のみ含む）なら送信しない', async () => {
  clearCapabilityAdapters();
  const { adapter } = makeFakeClaudeAdapter(emptyPluginResult(), emptyPluginResult({ present: ['a@devrelay'] }));
  registerCapabilityAdapter(adapter);
  setCapabilityConfig({ providers: { claude: { marketplaceName: 'devrelay', marketplaceSource: 'x/y' } }, items: [] });
  const sent = captureOutcomes();

  await reconcileForRunner('claude', '/tmp/devrelay-test-p1.2-present-only');

  assert.equal(sent.length, 0);
});

test('prelaunch: installed が 1 件でもあれば送信する（payload 形状も確認）', async () => {
  clearCapabilityAdapters();
  const { adapter } = makeFakeClaudeAdapter(emptyPluginResult(), emptyPluginResult({ installed: ['unity@devrelay'] }));
  registerCapabilityAdapter(adapter);
  setCapabilityConfig({ providers: { claude: { marketplaceName: 'devrelay', marketplaceSource: 'x/y' } }, items: [] });
  const sent = captureOutcomes();

  await reconcileForRunner('claude', '/tmp/devrelay-test-p1.2-installed');

  assert.equal(sent.length, 1);
  assert.equal(sent[0].trigger, 'prelaunch');
  assert.equal(sent[0].status, 'done');
  assert.deepEqual(sent[0].results[0].installed, ['unity@devrelay']);
});

test('prelaunch: aiTool が provider に解決できなければ何もしない', async () => {
  clearCapabilityAdapters();
  const { adapter, projectCalls } = makeFakeClaudeAdapter(emptyPluginResult(), emptyPluginResult({ installed: ['x'] }));
  registerCapabilityAdapter(adapter);
  setCapabilityConfig({ providers: { claude: { marketplaceName: 'devrelay', marketplaceSource: 'x/y' } }, items: [] });
  const sent = captureOutcomes();

  await reconcileForRunner('codex', '/tmp/devrelay-test-p1.2-unmapped-tool');

  assert.equal(projectCalls.length, 0);
  assert.equal(sent.length, 0);
});
