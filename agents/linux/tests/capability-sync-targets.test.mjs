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
  resetCapabilityConfigDeliveredForTests,
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

/** サイクルP3-A §2: `hasManagedState` を持つ fake adapter（devin:skill 想定）を作る */
function makeFakeManagedAdapter(provider, kind, { hasManagedState, machineResult } = {}) {
  const machineCalls = [];
  return {
    adapter: {
      provider,
      kind,
      async reconcileMachine(ctx) {
        machineCalls.push(ctx);
        const result = typeof machineResult === 'function' ? machineResult(ctx) : machineResult;
        return result ?? emptyPluginResult({ provider, kind });
      },
      async reconcileProject() {
        return emptyPluginResult({ provider, kind });
      },
      ...(hasManagedState !== undefined ? { hasManagedState } : {}),
    },
    machineCalls,
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

// ---- サイクルP1.3 要件5: requestMachineReconcile の注入（prelaunch のみ） ----

test('P1.3: prelaunch の ctx には requestMachineReconcile（function）が注入される', async () => {
  clearCapabilityAdapters();
  const { adapter, projectCalls } = makeFakeClaudeAdapter(emptyPluginResult(), emptyPluginResult());
  registerCapabilityAdapter(adapter);
  setCapabilityConfig({ providers: { claude: { marketplaceName: 'devrelay', marketplaceSource: 'x/y' } }, items: [] });
  captureOutcomes();

  await reconcileForRunner('claude', '/tmp/devrelay-test-p1.3-request-machine-reconcile');

  assert.equal(projectCalls.length, 1);
  assert.equal(typeof projectCalls[0].ctx.requestMachineReconcile, 'function');
});

test('P1.3: machine 経路の ctx には requestMachineReconcile が注入されない（undefined）', async () => {
  clearCapabilityAdapters();
  const { adapter, machineCalls } = makeFakeClaudeAdapter(emptyPluginResult(), emptyPluginResult());
  registerCapabilityAdapter(adapter);
  setCapabilityConfig({ providers: { claude: { marketplaceName: 'devrelay', marketplaceSource: 'x/y' } }, items: [] });
  captureOutcomes();

  await requestReconcile('manual');

  assert.equal(machineCalls.length, 1);
  assert.equal(machineCalls[0].requestMachineReconcile, undefined);
});

// ---- サイクルP1.3 要件6: fake adapter が deferred のみの failed を返すと status:'skipped' ----

test('P1.3: fake adapter が marketplace-not-registered のみの failed を返すと送信 payload が status:skipped + 非空 results になる', async () => {
  clearCapabilityAdapters();
  const { adapter } = makeFakeClaudeAdapter(
    emptyPluginResult(),
    emptyPluginResult({ failed: [{ id: 'marketplace:devrelay', reason: 'marketplace-not-registered' }] }),
  );
  registerCapabilityAdapter(adapter);
  setCapabilityConfig({ providers: { claude: { marketplaceName: 'devrelay', marketplaceSource: 'x/y' } }, items: [] });
  const sent = captureOutcomes();

  await reconcileForRunner('claude', '/tmp/devrelay-test-p1.3-skipped-status');

  assert.equal(sent.length, 1);
  assert.equal(sent[0].status, 'skipped');
  assert.ok(sent[0].results.length > 0);
  assert.equal(sent[0].results[0].failed[0].reason, 'marketplace-not-registered');
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

// -----------------------------------------------------------------------------
// サイクルP3-A §2: 撤去経路（cleanup パス）の配線テスト
// -----------------------------------------------------------------------------

test('回帰ガード: hasManagedState 未実装の fake claude + providers:{} → reconcileMachine 呼び出し 0 回', async () => {
  clearCapabilityAdapters();
  const { adapter, machineCalls } = makeFakeClaudeAdapter(emptyPluginResult(), emptyPluginResult());
  registerCapabilityAdapter(adapter); // hasManagedState 未実装
  setCapabilityConfig({ providers: {}, items: [] });
  const sent = captureOutcomes();

  await requestReconcile('manual');

  assert.equal(machineCalls.length, 0);
  assert.equal(sent[0].status, 'done');
});

test('ケース(b): providers から外れた managed devin → items:[] かつ providers.devin===undefined の ctx で cleanup が1回呼ばれる', async () => {
  clearCapabilityAdapters();
  const { adapter, machineCalls } = makeFakeManagedAdapter('devin', 'skill', {
    hasManagedState: async () => true,
    machineResult: emptyPluginResult({ provider: 'devin', kind: 'skill', removed: ['access-to-csharp'] }),
  });
  registerCapabilityAdapter(adapter);
  setCapabilityConfig({ providers: {}, items: [] }); // devin が providers から外れた状態
  const sent = captureOutcomes();

  await requestReconcile('manual');

  assert.equal(machineCalls.length, 1);
  assert.deepEqual(machineCalls[0].items, []);
  assert.equal(machineCalls[0].config.providers.devin, undefined);
  assert.equal(sent[0].status, 'done');
  assert.deepEqual(sent[0].results[0].removed, ['access-to-csharp']);
});

test('hasManagedState が false を返す devin adapter は cleanup で呼ばれない', async () => {
  clearCapabilityAdapters();
  const { adapter, machineCalls } = makeFakeManagedAdapter('devin', 'skill', { hasManagedState: async () => false });
  registerCapabilityAdapter(adapter);
  setCapabilityConfig({ providers: {}, items: [] });
  captureOutcomes();

  await requestReconcile('manual');

  assert.equal(machineCalls.length, 0);
});

test('ケース(c): capabilityConfig 全体が null でも configDelivered なら managed devin が cleanup される', async () => {
  clearCapabilityAdapters();
  const { adapter, machineCalls } = makeFakeManagedAdapter('devin', 'skill', {
    hasManagedState: async () => true,
    machineResult: emptyPluginResult({ provider: 'devin', kind: 'skill', removed: ['x'] }),
  });
  registerCapabilityAdapter(adapter);
  setCapabilityConfig(null); // 直前までの他テストで configDelivered は既に true（キー自体は存在した扱い）
  const sent = captureOutcomes();

  await requestReconcile('manual');

  assert.equal(machineCalls.length, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].status, 'done');
  assert.deepEqual(sent[0].results[0].removed, ['x']);
});

test('ケース(c): capabilityConfig 全体が null かつ managed adapter 無し → manual で skipped 1通のみ', async () => {
  clearCapabilityAdapters();
  const { adapter, machineCalls } = makeFakeManagedAdapter('devin', 'skill', { hasManagedState: async () => false });
  registerCapabilityAdapter(adapter);
  setCapabilityConfig(null);
  const sent = captureOutcomes();

  await requestReconcile('manual');

  assert.equal(machineCalls.length, 0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].status, 'skipped');
});

test('hasManagedState が throw しても fail-closed で呼ばれずクラッシュしない', async () => {
  clearCapabilityAdapters();
  const { adapter, machineCalls } = makeFakeManagedAdapter('devin', 'skill', {
    hasManagedState: async () => { throw new Error('boom'); },
  });
  registerCapabilityAdapter(adapter);
  setCapabilityConfig({ providers: {}, items: [] });
  const sent = captureOutcomes();

  await requestReconcile('manual');

  assert.equal(machineCalls.length, 0);
  assert.equal(sent[0].status, 'done');
});

test('prelaunch は cleanup を起動しない（reconcileForRunner は hasManagedState を呼ばない）', async () => {
  clearCapabilityAdapters();
  const { adapter: claudeAdapter } = makeFakeClaudeAdapter(emptyPluginResult(), emptyPluginResult());
  registerCapabilityAdapter(claudeAdapter);
  let hasManagedStateCalls = 0;
  const devinAdapter = {
    provider: 'devin',
    kind: 'skill',
    async reconcileMachine() { return emptyPluginResult({ provider: 'devin', kind: 'skill' }); },
    async reconcileProject() { return emptyPluginResult({ provider: 'devin', kind: 'skill' }); },
    async hasManagedState() { hasManagedStateCalls += 1; return true; },
  };
  registerCapabilityAdapter(devinAdapter);
  setCapabilityConfig({ providers: { claude: { marketplaceName: 'devrelay', marketplaceSource: 'x/y' } }, items: [] });
  captureOutcomes();

  await reconcileForRunner('claude', '/tmp/devrelay-test-p3a-prelaunch-no-cleanup');

  assert.equal(hasManagedStateCalls, 0);
});

test('configDelivered が false のまま（旧 server 相当）→ config null でも cleanup は起動せず skipped', async () => {
  clearCapabilityAdapters();
  resetCapabilityConfigDeliveredForTests();
  const { adapter, machineCalls } = makeFakeManagedAdapter('devin', 'skill', { hasManagedState: async () => true });
  registerCapabilityAdapter(adapter);
  const sent = captureOutcomes();

  await requestReconcile('manual');

  assert.equal(machineCalls.length, 0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].status, 'skipped');
});

// -----------------------------------------------------------------------------
// サイクルP3-B §5-3（T11・最重要の回帰テスト）: normalizeCapabilityItems() 配線後、
// legacy devin:skill items だけの config でも agent-skills:standard が「covered」になり、
// cleanup パス（破壊的な再撤去呼び出し）の対象にならないことを保証する。
// -----------------------------------------------------------------------------

test('正規化後のtargets: legacy devin:skill items だけ → agent-skills:standard adapter が正規化済み items で呼ばれる', async () => {
  clearCapabilityAdapters();
  const { adapter, machineCalls } = makeFakeManagedAdapter('agent-skills', 'standard', {
    hasManagedState: async () => true,
    machineResult: emptyPluginResult({ provider: 'agent-skills', kind: 'standard', installed: ['context7/doc-lookup'] }),
  });
  registerCapabilityAdapter(adapter);
  setCapabilityConfig({
    providers: { claude: { marketplaceName: 'devrelay', marketplaceSource: 'x/y' } },
    items: [{ provider: 'devin', kind: 'skill', id: 'context7/doc-lookup' }],
  });
  const sent = captureOutcomes();

  await requestReconcile('manual');

  assert.equal(machineCalls.length, 1);
  assert.deepEqual(machineCalls[0].items, [{ provider: 'agent-skills', kind: 'standard', id: 'context7/doc-lookup' }]);
  assert.equal(sent[0].status, 'done');
});

test('回帰ガード（最重要）: legacy items のみでも agent-skills:standard は covered になり、cleanup による2回目呼び出し（items:[]の再撤去）が起きない', async () => {
  clearCapabilityAdapters();
  const { adapter, machineCalls } = makeFakeManagedAdapter('agent-skills', 'standard', {
    hasManagedState: async () => true,
    machineResult: emptyPluginResult({ provider: 'agent-skills', kind: 'standard', installed: ['context7/doc-lookup'] }),
  });
  registerCapabilityAdapter(adapter);
  setCapabilityConfig({
    providers: {},
    items: [{ provider: 'devin', kind: 'skill', id: 'context7/doc-lookup' }],
  });
  captureOutcomes();

  await requestReconcile('manual');

  // covered なら呼び出しは 1 回だけ（cleanup パスによる items:[] の破壊的再呼び出しが無い）
  assert.equal(machineCalls.length, 1);
  assert.notDeepEqual(machineCalls[0].items, []);
});

test('正規化後のtargets: legacy items と canonical items が混在しても同一キーに統合される（2件とも渡る）', async () => {
  clearCapabilityAdapters();
  const { adapter, machineCalls } = makeFakeManagedAdapter('agent-skills', 'standard', {
    hasManagedState: async () => true,
    machineResult: emptyPluginResult({ provider: 'agent-skills', kind: 'standard' }),
  });
  registerCapabilityAdapter(adapter);
  setCapabilityConfig({
    providers: {},
    items: [
      { provider: 'devin', kind: 'skill', id: 'legacy-one' },
      { provider: 'agent-skills', kind: 'standard', id: 'canonical-one' },
    ],
  });
  captureOutcomes();

  await requestReconcile('manual');

  assert.equal(machineCalls.length, 1);
  assert.equal(machineCalls[0].items.length, 2);
  assert.deepEqual(
    machineCalls[0].items.map((i) => i.id).sort(),
    ['canonical-one', 'legacy-one'],
  );
});

test('正規化後のtargets: providers.devin（legacy な設定キー）が残っていても registry に devin:* が無いので targets に混入しない', async () => {
  clearCapabilityAdapters();
  const { adapter, machineCalls } = makeFakeManagedAdapter('agent-skills', 'standard', {
    hasManagedState: async () => true,
    machineResult: emptyPluginResult({ provider: 'agent-skills', kind: 'standard' }),
  });
  registerCapabilityAdapter(adapter); // agent-skills:standard のみ登録（devin:* は登録しない）
  setCapabilityConfig({
    providers: { devin: { marketplaceName: 'devrelay', marketplaceSource: 'x/y' } },
    items: [{ provider: 'devin', kind: 'skill', id: 'context7' }],
  });
  const sent = captureOutcomes();

  await requestReconcile('manual');

  assert.equal(machineCalls.length, 1);
  assert.equal(sent[0].results.length, 1);
  assert.equal(sent[0].results[0].provider, 'agent-skills');
});

test('正規化後のtargets: canonical items のみ（legacy 無し）でも従来どおり動く（非退行確認）', async () => {
  clearCapabilityAdapters();
  const { adapter, machineCalls } = makeFakeManagedAdapter('agent-skills', 'standard', {
    hasManagedState: async () => true,
    machineResult: emptyPluginResult({ provider: 'agent-skills', kind: 'standard' }),
  });
  registerCapabilityAdapter(adapter);
  setCapabilityConfig({
    providers: {},
    items: [{ provider: 'agent-skills', kind: 'standard', id: 'context7/doc-lookup' }],
  });
  captureOutcomes();

  await requestReconcile('manual');

  assert.equal(machineCalls.length, 1);
  assert.deepEqual(machineCalls[0].items, [{ provider: 'agent-skills', kind: 'standard', id: 'context7/doc-lookup' }]);
});
