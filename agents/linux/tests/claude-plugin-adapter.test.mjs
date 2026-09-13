// サイクルP1.3: claude-plugin-adapter.ts（deps 注入形にリファクタ済み）を
// 完全な fake deps（spawn ゼロ）で駆動するテスト。コンパイル済み dist から直接 import する。
//
// 注意: このファイルは `dist/services/connection.js` を一切 import しない
// （`reconcileMachineWithDeps`/`reconcileProjectWithDeps` は `claude-plugin-adapter.js` からの
// named export であり、実行時 import は node builtins + `claude-plugin-rules.js` + `claude-cli.js` +
// `../claude-path.js` + `../config.js` のみ。`@devrelay/shared` と `../capability-sync.js` は
// 型のみの import のためコンパイル後は消える）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  reconcileMachineWithDeps,
  reconcileProjectWithDeps,
} from '../dist/services/capabilities/claude-plugin-adapter.js';

// ---- adapter 内部のパス規約と同一のヘルパー（fake readJson のキー合わせ用） ----
function projectSettingsPath(p) { return path.join(p, '.claude', 'settings.json'); }
function localSettingsPath(p) { return path.join(p, '.claude', 'settings.local.json'); }
function userSettingsPath() { return path.join(os.homedir(), '.claude', 'settings.json'); }
function blocklistPath() { return path.join(os.homedir(), '.claude', 'plugins', 'blocklist.json'); }
function knownMarketplacesPath() { return path.join(os.homedir(), '.claude', 'plugins', 'known_marketplaces.json'); }

const okResult = (stdout = '') => ({ ok: true, stdout, stderr: '', code: 0, killed: false });
const errResult = (overrides = {}) => ({ ok: false, stdout: '', stderr: '', code: 1, killed: false, error: 'error', ...overrides });
const marketplaceListOk = () => okResult(JSON.stringify([{ name: 'devrelay', source: 'github', repo: 'murata1215/devrelay-plugins' }]));

/** `runClaude`/`readJson` を記録しつつ差し替え可能にする fake deps ファクトリ */
function makeFakeDeps({ claudePath = '/usr/bin/claude', machineCwd = '/home/devrelay/.devrelay', jsonFiles = {}, onCall } = {}) {
  const calls = [];
  const deps = {
    resolveClaudePath: () => claudePath,
    async runClaude(cp, args, cwd) {
      calls.push({ claudePath: cp, args, cwd });
      if (onCall) {
        const outcome = await onCall(args, cwd, calls);
        if (outcome) return outcome;
      }
      return okResult('[]');
    },
    async readJson(p) {
      return Object.prototype.hasOwnProperty.call(jsonFiles, p) ? jsonFiles[p] : null;
    },
    machineCwd: () => machineCwd,
  };
  return { deps, calls };
}

const baseCtx = (overrides = {}) => ({
  config: { providers: { claude: { marketplaceName: 'devrelay', marketplaceSource: 'murata1215/devrelay-plugins' } }, items: [] },
  items: [],
  ...overrides,
});

function isPluginArgs(args, sub) {
  return args[0] === 'plugin' && args[1] === sub;
}

// -----------------------------------------------------------------------------
// 要件1: cwd 固定
// -----------------------------------------------------------------------------

test('要件1: reconcileProjectWithDeps の全 CLI 呼び出しは cwd === projectPath（list/install/marketplace list を含む）', async () => {
  const projectPath = '/tmp/devrelay-test-adapter-cwd-project';
  const id = 'unity@devrelay';
  let listCallCount = 0;
  const { deps, calls } = makeFakeDeps({
    jsonFiles: {
      [projectSettingsPath(projectPath)]: { enabledPlugins: { [id]: true } },
      [localSettingsPath(projectPath)]: {},
      [blocklistPath()]: [],
    },
    onCall: (args) => {
      if (isPluginArgs(args, 'marketplace') && args[2] === 'list') return marketplaceListOk();
      if (isPluginArgs(args, 'list')) {
        listCallCount += 1;
        const entries = listCallCount === 1 ? [] : [{ id, version: '1.0.0', scope: 'project', enabled: true, projectPath }];
        return okResult(JSON.stringify(entries));
      }
      if (isPluginArgs(args, 'install')) return okResult();
      return undefined;
    },
  });

  const result = await reconcileProjectWithDeps(baseCtx(), projectPath, deps);

  assert.deepEqual(result.installed, [id]);
  assert.ok(calls.length >= 3);
  for (const c of calls) assert.equal(c.cwd, projectPath);
});

test('要件1: reconcileMachineWithDeps の全 CLI 呼び出しは cwd === deps.machineCwd()（projectPath とは無関係）', async () => {
  const machineCwd = '/home/devrelay/.devrelay';
  const { deps, calls } = makeFakeDeps({
    machineCwd,
    jsonFiles: {
      [knownMarketplacesPath()]: { devrelay: { source: { repo: 'murata1215/devrelay-plugins' } } },
      [userSettingsPath()]: {},
      [blocklistPath()]: [],
    },
    onCall: (args) => {
      if (args[0] === '--version') return okResult('2.1.263');
      return undefined;
    },
  });

  await reconcileMachineWithDeps(baseCtx(), deps);

  assert.ok(calls.length > 0);
  for (const c of calls) {
    assert.equal(c.cwd, machineCwd);
    assert.notEqual(c.cwd, '/tmp/devrelay-test-adapter-cwd-project');
  }
});

// -----------------------------------------------------------------------------
// 要件2: install scope の不変条件 + 宣言元一致
// -----------------------------------------------------------------------------

test('不変条件: machine 経路の引数に --scope project / --scope local は一切現れない', async () => {
  const { deps, calls } = makeFakeDeps({
    jsonFiles: {
      [knownMarketplacesPath()]: { devrelay: { source: { repo: 'murata1215/devrelay-plugins' } } },
      [userSettingsPath()]: {},
      [blocklistPath()]: [],
    },
    onCall: (args) => (args[0] === '--version' ? okResult('2.1.263') : undefined),
  });
  const ctx = baseCtx({ items: [{ provider: 'claude', kind: 'plugin', id: 'unity' }] });

  await reconcileMachineWithDeps(ctx, deps);

  for (const c of calls) {
    assert.equal(c.args.includes('project') && c.args.includes('--scope'), false);
    const scopeIdx = c.args.indexOf('--scope');
    if (scopeIdx !== -1) {
      assert.notEqual(c.args[scopeIdx + 1], 'project');
      assert.notEqual(c.args[scopeIdx + 1], 'local');
    }
  }
});

test('不変条件: reconcileMachineWithDeps / reconcileProjectWithDeps のどちらにも uninstall 呼び出しは無い', async () => {
  const projectPath = '/tmp/devrelay-test-adapter-no-uninstall';
  const { deps: machineDeps, calls: machineCalls } = makeFakeDeps({
    jsonFiles: {
      [knownMarketplacesPath()]: { devrelay: { source: { repo: 'murata1215/devrelay-plugins' } } },
      [userSettingsPath()]: {},
      [blocklistPath()]: [],
    },
  });
  await reconcileMachineWithDeps(baseCtx({ items: [{ provider: 'claude', kind: 'plugin', id: 'unity' }] }), machineDeps);

  const { deps: projectDeps, calls: projectCalls } = makeFakeDeps({
    jsonFiles: {
      [projectSettingsPath(projectPath)]: { enabledPlugins: { 'unity@devrelay': true } },
      [localSettingsPath(projectPath)]: {},
      [blocklistPath()]: [],
    },
    onCall: (args) => (isPluginArgs(args, 'marketplace') && args[2] === 'list' ? marketplaceListOk() : undefined),
  });
  await reconcileProjectWithDeps(baseCtx(), projectPath, projectDeps);

  for (const c of [...machineCalls, ...projectCalls]) {
    assert.notEqual(c.args[1], 'uninstall');
  }
});

test('要件2: project にのみ宣言 → --scope project で install される', async () => {
  const projectPath = '/tmp/devrelay-test-adapter-scope-project-only';
  const id = 'x@devrelay';
  let listCallCount = 0;
  const { deps, calls } = makeFakeDeps({
    jsonFiles: {
      [projectSettingsPath(projectPath)]: { enabledPlugins: { [id]: true } },
      [localSettingsPath(projectPath)]: {},
      [blocklistPath()]: [],
    },
    onCall: (args) => {
      if (isPluginArgs(args, 'marketplace') && args[2] === 'list') return marketplaceListOk();
      if (isPluginArgs(args, 'list')) {
        listCallCount += 1;
        // 1回目（present判定）: まだ未インストール。2回目（install後の再検証）: satisfied。
        const entries = listCallCount === 1 ? [] : [{ id, version: '1.0.0', scope: 'project', enabled: true, projectPath }];
        return okResult(JSON.stringify(entries));
      }
      return undefined;
    },
  });

  const result = await reconcileProjectWithDeps(baseCtx(), projectPath, deps);

  const installCall = calls.find(c => isPluginArgs(c.args, 'install'));
  assert.deepEqual(installCall.args, ['plugin', 'install', id, '--scope', 'project']);
  assert.deepEqual(result.installed, [id]);
});

test('要件2: local にのみ宣言 → --scope local で install される', async () => {
  const projectPath = '/tmp/devrelay-test-adapter-scope-local-only';
  const id = 'x@devrelay';
  let listCallCount = 0;
  const { deps, calls } = makeFakeDeps({
    jsonFiles: {
      [projectSettingsPath(projectPath)]: {},
      [localSettingsPath(projectPath)]: { enabledPlugins: { [id]: true } },
      [blocklistPath()]: [],
    },
    onCall: (args) => {
      if (isPluginArgs(args, 'marketplace') && args[2] === 'list') return marketplaceListOk();
      if (isPluginArgs(args, 'list')) {
        listCallCount += 1;
        const entries = listCallCount === 1 ? [] : [{ id, version: '1.0.0', scope: 'local', enabled: true, projectPath }];
        return okResult(JSON.stringify(entries));
      }
      return undefined;
    },
  });

  const result = await reconcileProjectWithDeps(baseCtx(), projectPath, deps);

  const installCall = calls.find(c => isPluginArgs(c.args, 'install'));
  assert.deepEqual(installCall.args, ['plugin', 'install', id, '--scope', 'local']);
  assert.deepEqual(result.installed, [id]);
});

test('要件2: 両方に宣言 → install は project で 1 回だけ（local への重複 install は無い）', async () => {
  const projectPath = '/tmp/devrelay-test-adapter-scope-both';
  const id = 'x@devrelay';
  let listCallCount = 0;
  const { deps, calls } = makeFakeDeps({
    jsonFiles: {
      [projectSettingsPath(projectPath)]: { enabledPlugins: { [id]: true } },
      [localSettingsPath(projectPath)]: { enabledPlugins: { [id]: true } },
      [blocklistPath()]: [],
    },
    onCall: (args) => {
      if (isPluginArgs(args, 'marketplace') && args[2] === 'list') return marketplaceListOk();
      if (isPluginArgs(args, 'list')) {
        listCallCount += 1;
        const entries = listCallCount === 1 ? [] : [{ id, version: '1.0.0', scope: 'project', enabled: true, projectPath }];
        return okResult(JSON.stringify(entries));
      }
      return undefined;
    },
  });

  const result = await reconcileProjectWithDeps(baseCtx(), projectPath, deps);

  const installCalls = calls.filter(c => isPluginArgs(c.args, 'install'));
  assert.equal(installCalls.length, 1);
  assert.deepEqual(installCalls[0].args, ['plugin', 'install', id, '--scope', 'project']);
  assert.deepEqual(result.installed, [id]);
});

// -----------------------------------------------------------------------------
// 要件3: present 判定の scope cross-check + install 後の再検証
// -----------------------------------------------------------------------------

test('要件3: list に居るが scope が違う場合は present にせず install する', async () => {
  const projectPath = '/tmp/devrelay-test-adapter-wrong-scope';
  const id = 'x@devrelay';
  let listCallCount = 0;
  const { deps } = makeFakeDeps({
    jsonFiles: {
      [projectSettingsPath(projectPath)]: { enabledPlugins: { [id]: true } },
      [localSettingsPath(projectPath)]: {},
      [blocklistPath()]: [],
    },
    onCall: (args) => {
      if (isPluginArgs(args, 'marketplace') && args[2] === 'list') return marketplaceListOk();
      if (isPluginArgs(args, 'list')) {
        listCallCount += 1;
        // 1回目: 別 scope（local）で存在。宣言は project なので present 扱いしてはいけない
        // 2回目（install 後の再検証）: project scope で satisfied
        const entries = listCallCount === 1
          ? [{ id, version: '1.0.0', scope: 'local', enabled: true, projectPath: '/other-project' }]
          : [{ id, version: '1.0.0', scope: 'project', enabled: true, projectPath }];
        return okResult(JSON.stringify(entries));
      }
      if (isPluginArgs(args, 'install')) return okResult();
      return undefined;
    },
  });

  const result = await reconcileProjectWithDeps(baseCtx(), projectPath, deps);

  assert.deepEqual(result.present, []);
  assert.deepEqual(result.installed, [id]);
});

test('要件3: enabled:false のエントリは present にしない（install される）', async () => {
  const projectPath = '/tmp/devrelay-test-adapter-disabled-entry';
  const id = 'x@devrelay';
  let listCallCount = 0;
  const { deps } = makeFakeDeps({
    jsonFiles: {
      [projectSettingsPath(projectPath)]: { enabledPlugins: { [id]: true } },
      [localSettingsPath(projectPath)]: {},
      [blocklistPath()]: [],
    },
    onCall: (args) => {
      if (isPluginArgs(args, 'marketplace') && args[2] === 'list') return marketplaceListOk();
      if (isPluginArgs(args, 'list')) {
        listCallCount += 1;
        const entries = listCallCount === 1
          ? [{ id, version: '1.0.0', scope: 'project', enabled: false, projectPath }]
          : [{ id, version: '1.0.0', scope: 'project', enabled: true, projectPath }];
        return okResult(JSON.stringify(entries));
      }
      if (isPluginArgs(args, 'install')) return okResult();
      return undefined;
    },
  });

  const result = await reconcileProjectWithDeps(baseCtx(), projectPath, deps);

  assert.deepEqual(result.present, []);
  assert.deepEqual(result.installed, [id]);
});

test('要件3再検証: install 成功でも直後の list が satisfied でなければ installed ではなく failed（install-verify-failed）', async () => {
  const projectPath = '/tmp/devrelay-test-adapter-verify-failed';
  const id = 'x@devrelay';
  const { deps, calls } = makeFakeDeps({
    jsonFiles: {
      [projectSettingsPath(projectPath)]: { enabledPlugins: { [id]: true } },
      [localSettingsPath(projectPath)]: {},
      [blocklistPath()]: [],
    },
    onCall: (args) => {
      if (isPluginArgs(args, 'marketplace') && args[2] === 'list') return marketplaceListOk();
      // install 前後どちらの list も id が入っていない（= 再検証に失敗する）
      if (isPluginArgs(args, 'list')) return okResult('[]');
      if (isPluginArgs(args, 'install')) return okResult();
      return undefined;
    },
  });

  const result = await reconcileProjectWithDeps(baseCtx(), projectPath, deps);

  assert.deepEqual(result.installed, []);
  assert.deepEqual(result.failed, [{ id, reason: 'install-verify-failed' }]);
  const listCalls = calls.filter(c => isPluginArgs(c.args, 'list'));
  assert.ok(listCalls.length >= 2, '再検証用の list 呼び出しが存在すること');
  for (const c of listCalls) assert.equal(c.cwd, projectPath);
});

// -----------------------------------------------------------------------------
// 要件4: 索引未知 ID → marketplace update 1回のみ再試行
// -----------------------------------------------------------------------------

test('要件4: 索引ミス文言のエラー → marketplace update を1回実行し install を1回再試行、成功で installed', async () => {
  const projectPath = '/tmp/devrelay-test-adapter-index-miss-retry';
  const id = 'x@devrelay';
  let installAttempt = 0;
  const { deps, calls } = makeFakeDeps({
    jsonFiles: {
      [projectSettingsPath(projectPath)]: { enabledPlugins: { [id]: true } },
      [localSettingsPath(projectPath)]: {},
      [blocklistPath()]: [],
    },
    onCall: (args) => {
      if (isPluginArgs(args, 'marketplace') && args[2] === 'list') return marketplaceListOk();
      if (isPluginArgs(args, 'marketplace') && args[2] === 'update') return okResult();
      if (isPluginArgs(args, 'list')) return okResult(JSON.stringify(installAttempt > 0 ? [{ id, version: '1.0.0', scope: 'project', enabled: true, projectPath }] : []));
      if (isPluginArgs(args, 'install')) {
        installAttempt += 1;
        if (installAttempt === 1) {
          return errResult({ stdout: `Plugin "${id}" not found in marketplace "devrelay"`, code: 1 });
        }
        return okResult();
      }
      return undefined;
    },
  });

  const result = await reconcileProjectWithDeps(baseCtx(), projectPath, deps);

  const updateCalls = calls.filter(c => isPluginArgs(c.args, 'marketplace') && c.args[2] === 'update');
  const installCalls = calls.filter(c => isPluginArgs(c.args, 'install'));
  assert.equal(updateCalls.length, 1);
  assert.equal(installCalls.length, 2);
  assert.deepEqual(result.installed, [id]);
});

test('要件4上限: 索引ミスの ID が2件でも marketplace update は合計1回', async () => {
  const projectPath = '/tmp/devrelay-test-adapter-index-miss-cap';
  const idA = 'a@devrelay';
  const idB = 'b@devrelay';
  const { deps, calls } = makeFakeDeps({
    jsonFiles: {
      [projectSettingsPath(projectPath)]: { enabledPlugins: { [idA]: true, [idB]: true } },
      [localSettingsPath(projectPath)]: {},
      [blocklistPath()]: [],
    },
    onCall: (args) => {
      if (isPluginArgs(args, 'marketplace') && args[2] === 'list') return marketplaceListOk();
      if (isPluginArgs(args, 'marketplace') && args[2] === 'update') return okResult();
      if (isPluginArgs(args, 'list')) return okResult('[]');
      if (isPluginArgs(args, 'install')) {
        const id = args[2];
        return errResult({ stdout: `Plugin "${id}" not found in marketplace "devrelay"`, code: 1 });
      }
      return undefined;
    },
  });

  await reconcileProjectWithDeps(baseCtx(), projectPath, deps);

  const updateCalls = calls.filter(c => isPluginArgs(c.args, 'marketplace') && c.args[2] === 'update');
  assert.equal(updateCalls.length, 1);
});

test('要件4陰性: 索引ミス以外のエラーでは marketplace update も再試行もしない', async () => {
  const projectPath = '/tmp/devrelay-test-adapter-index-miss-negative';
  const id = 'x@devrelay';
  const { deps, calls } = makeFakeDeps({
    jsonFiles: {
      [projectSettingsPath(projectPath)]: { enabledPlugins: { [id]: true } },
      [localSettingsPath(projectPath)]: {},
      [blocklistPath()]: [],
    },
    onCall: (args) => {
      if (isPluginArgs(args, 'marketplace') && args[2] === 'list') return marketplaceListOk();
      if (isPluginArgs(args, 'list')) return okResult('[]');
      if (isPluginArgs(args, 'install')) return errResult({ stderr: 'ETIMEDOUT: network error', code: 1 });
      return undefined;
    },
  });

  const result = await reconcileProjectWithDeps(baseCtx(), projectPath, deps);

  const updateCalls = calls.filter(c => isPluginArgs(c.args, 'marketplace') && c.args[2] === 'update');
  const installCalls = calls.filter(c => isPluginArgs(c.args, 'install'));
  assert.equal(updateCalls.length, 0);
  assert.equal(installCalls.length, 1);
  assert.equal(result.failed[0].id, id);
});

// -----------------------------------------------------------------------------
// 要件5: 初回フォールバック（marketplace 未登録）
// -----------------------------------------------------------------------------

test('要件5: marketplace list が not-registered → install/marketplace add 0回・requestMachineReconcile 1回・failed 1件', async () => {
  const projectPath = '/tmp/devrelay-test-adapter-marketplace-not-registered';
  const id = 'x@devrelay';
  const { deps, calls } = makeFakeDeps({
    jsonFiles: {
      [projectSettingsPath(projectPath)]: { enabledPlugins: { [id]: true } },
      [localSettingsPath(projectPath)]: {},
      [blocklistPath()]: [],
    },
    onCall: (args) => {
      if (isPluginArgs(args, 'marketplace') && args[2] === 'list') return okResult('[]');
      return undefined;
    },
  });
  let requestCount = 0;
  const ctx = baseCtx({ requestMachineReconcile: () => { requestCount += 1; } });

  const result = await reconcileProjectWithDeps(ctx, projectPath, deps);

  const installCalls = calls.filter(c => isPluginArgs(c.args, 'install'));
  const addCalls = calls.filter(c => isPluginArgs(c.args, 'marketplace') && c.args[2] === 'add');
  assert.equal(installCalls.length, 0);
  assert.equal(addCalls.length, 0);
  assert.equal(requestCount, 1);
  assert.deepEqual(result.failed, [{ id: 'marketplace:devrelay', reason: 'marketplace-not-registered' }]);
});

test('要件5 fail-open: requestMachineReconcile が undefined でも throw しない', async () => {
  const projectPath = '/tmp/devrelay-test-adapter-marketplace-not-registered-no-callback';
  const id = 'x@devrelay';
  const { deps } = makeFakeDeps({
    jsonFiles: {
      [projectSettingsPath(projectPath)]: { enabledPlugins: { [id]: true } },
      [localSettingsPath(projectPath)]: {},
      [blocklistPath()]: [],
    },
    onCall: (args) => (isPluginArgs(args, 'marketplace') && args[2] === 'list' ? okResult('[]') : undefined),
  });

  await assert.doesNotReject(reconcileProjectWithDeps(baseCtx(), projectPath, deps));
});

// -----------------------------------------------------------------------------
// 回帰: claude 未検出 / candidate 0件
// -----------------------------------------------------------------------------

test('回帰: resolveClaudePath() が null なら CLI 呼び出し 0 回、全候補が claude-not-found', async () => {
  const projectPath = '/tmp/devrelay-test-adapter-claude-not-found';
  const id = 'x@devrelay';
  const { deps, calls } = makeFakeDeps({
    claudePath: null,
    jsonFiles: {
      [projectSettingsPath(projectPath)]: { enabledPlugins: { [id]: true } },
      [localSettingsPath(projectPath)]: {},
    },
  });

  const result = await reconcileProjectWithDeps(baseCtx(), projectPath, deps);

  assert.equal(calls.length, 0);
  assert.deepEqual(result.failed, [{ id, reason: 'claude-not-found' }]);
});

test('回帰: candidate 0件（enabledPlugins 空）なら CLI 呼び出し 0 回', async () => {
  const projectPath = '/tmp/devrelay-test-adapter-no-candidates';
  const { deps, calls } = makeFakeDeps({
    jsonFiles: {
      [projectSettingsPath(projectPath)]: {},
      [localSettingsPath(projectPath)]: {},
    },
  });

  const result = await reconcileProjectWithDeps(baseCtx(), projectPath, deps);

  assert.equal(calls.length, 0);
  assert.deepEqual(result, {
    provider: 'claude', kind: 'plugin', runtimeVersion: null,
    installed: [], updated: [], present: [], failed: [], notAllowed: [],
  });
});

test('回帰: providerConfig 未設定なら reconcileProjectWithDeps は即 empty result（CLI 呼び出し 0 回）', async () => {
  const projectPath = '/tmp/devrelay-test-adapter-no-provider-config';
  const { deps, calls } = makeFakeDeps({});
  const ctx = { config: { providers: {}, items: [] }, items: [] };

  const result = await reconcileProjectWithDeps(ctx, projectPath, deps);

  assert.equal(calls.length, 0);
  assert.deepEqual(result.failed, []);
});
