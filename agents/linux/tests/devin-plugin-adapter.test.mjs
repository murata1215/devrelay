// サイクルP4-A: devin-plugin-adapter.ts（deps 注入形）を完全な fake deps（spawn ゼロ・実 fs ゼロ）で
// 駆動するテスト。コンパイル済み dist から直接 import する。
//
// 注意: `claude-plugin-adapter.test.mjs` と同じ流儀で、`dist/services/connection.js` を import しない
// （`reconcileMachineWithDeps`/`hasManagedStateWithDeps` は named export であり、実行時 import は
// node builtins + `devin-plugin-rules.js` + `devin-cli.js` + `marketplace-clone.js` +
// `agent-skills-rules.js`（純関数のみ）+ `skill-tree-io.js` + `../devin-path.js` + `../config.js` +
// `../atomic-write.js` のみ。`@devrelay/shared` と `../capability-sync.js` は型のみの import）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  reconcileMachineWithDeps,
  reconcileProjectWithDeps,
  hasManagedStateWithDeps,
} from '../dist/services/capabilities/devin-plugin-adapter.js';

const marketplaceName = 'devrelay';
const marketplaceSource = 'murata1215/devrelay-plugins';
const machineCwd = '/fake/machine';
const statePath = '/fake/machine/capabilities/devin-plugins.json';
const cloneParentDir = join(machineCwd, 'capabilities', 'marketplaces');
const cloneDir = join(cloneParentDir, marketplaceName);
const manifestPath = join(cloneDir, '.claude-plugin', 'marketplace.json');

const okResult = (stdout = '') => ({ ok: true, stdout, stderr: '', code: 0, killed: false });
const errResult = (overrides = {}) => ({ ok: false, stdout: '', stderr: '', code: 1, killed: false, error: 'devin-error', ...overrides });
const okGit = (stdout = '') => ({ ok: true, stdout, stderr: '', code: 0, killed: false });
const errGit = () => ({ ok: false, stdout: '', stderr: '', code: 1, killed: false, error: 'git-error' });

function buildManifest(plugins) {
  return { name: marketplaceName, plugins };
}

function buildState(entries) {
  return { schema: 1, managedBy: 'devrelay', adapter: 'devin-plugin', entries };
}

const baseCtx = (pluginIds = [], providers = { claude: { marketplaceName, marketplaceSource } }) => ({
  config: { providers, items: [] },
  items: pluginIds.map((id) => ({ provider: 'devin', kind: 'plugin', id })),
});

/** fake deps ファクトリ。scenario で初期状態・応答を注入し、calls で呼び出し記録を取得する */
function makeFakeDeps(scenario = {}) {
  const calls = { devin: [], git: [], readJson: [], writeState: [], listDirNames: [], ensureDir: [], removeManagedDir: [] };
  const jsonFiles = new Map(Object.entries(scenario.jsonFiles ?? {}));
  const cloneParentEntries = new Set(scenario.cloneParentEntries ?? []);
  let writtenState = null;

  const devinHandler = scenario.devinHandler ?? (() => undefined);
  const gitResults = scenario.gitResults ?? ((args) => (args[0] === 'rev-parse' ? okGit('abc123') : okGit('')));

  const deps = {
    isEnabled: () => scenario.enabled ?? true,
    resolveDevinPath: () => (scenario.devinPath === undefined ? '/usr/bin/devin' : scenario.devinPath),
    async runDevin(devinPath, args, cwd) {
      calls.devin.push({ devinPath, args, cwd });
      const custom = devinHandler(args, calls.devin.length);
      if (custom) return custom;
      if (args[0] === 'plugins' && args[1] === '--help') return scenario.pluginsHelp ?? okResult();
      // 既定は「Devin 側にまだ存在しない」（info NG）＝新規 install シナリオを素直に通す。
      // 「既に存在する」を試したいテストは scenario.infoDefault で明示的に上書きする。
      if (args[0] === 'plugins' && args[1] === 'info') return scenario.infoDefault ?? errResult();
      if (args[0] === 'plugins' && args[1] === 'install') return scenario.installDefault ?? okResult();
      if (args[0] === 'plugins' && args[1] === 'update') return scenario.updateDefault ?? okResult();
      if (args[0] === 'plugins' && args[1] === 'remove') return scenario.removeDefault ?? okResult();
      return okResult();
    },
    async resolveRuntimeVersion() {
      return scenario.runtimeVersion === undefined ? 'devin 3000.6.14 (18033302)' : scenario.runtimeVersion;
    },
    resolveGitPath: () => (scenario.gitPath === undefined ? '/usr/bin/git' : scenario.gitPath),
    async runGit(gitPath, args, cwd, timeoutMs) {
      calls.git.push({ gitPath, args, cwd, timeoutMs });
      return gitResults(args, cwd);
    },
    async readJson(p) {
      calls.readJson.push(p);
      return jsonFiles.has(p) ? jsonFiles.get(p) : null;
    },
    async writeState(p, state) {
      calls.writeState.push({ path: p, state });
      writtenState = state;
    },
    machineCwd: () => scenario.machineCwd ?? machineCwd,
    async removeManagedDir(dir) {
      calls.removeManagedDir.push(dir);
    },
    async listDirNames(dir) {
      calls.listDirNames.push(dir);
      if (dir === cloneParentDir) return Array.from(cloneParentEntries);
      return [];
    },
    async ensureDir(dir) {
      calls.ensureDir.push(dir);
    },
    resolveStatePath: () => scenario.statePathResult ?? { ok: true, path: statePath },
    nowIso: () => scenario.nowIso ?? '2026-10-31T00:00:00.000Z',
  };
  return { deps, calls, getWrittenState: () => writtenState };
}

/** manifest + clone が揃った「正常系の前提」を持つ scenario を組み立てる */
function withCloneAndManifest(overrides = {}) {
  // 注意: スプレッド順序に意味がある。`jsonFiles` は個別にマージし、それ以外の override（例:
  // `infoDefault`）だけを後から展開する（`...overrides` を最後に展開すると overrides.jsonFiles が
  // マージ済み jsonFiles を丸ごと上書きしてしまうため、jsonFiles は明示的に除いてから展開する）。
  const { jsonFiles: overrideJsonFiles, ...restOverrides } = overrides;
  return {
    cloneParentEntries: [marketplaceName],
    ...restOverrides,
    jsonFiles: {
      [manifestPath]: buildManifest([
        { name: 'context7', source: './plugins/context7', version: null },
        { name: 'access-migration', source: './plugins/access-migration', version: null },
      ]),
      [statePath]: buildState([]),
      ...(overrideJsonFiles ?? {}),
    },
  };
}

// -----------------------------------------------------------------------------
// enabled()=false で deps 未呼び出し
// -----------------------------------------------------------------------------

test('enabled()=false: reconcileMachineWithDeps は空結果を返し devin/git を一切呼ばない', async () => {
  const { deps, calls } = makeFakeDeps({ enabled: false, ...withCloneAndManifest() });
  const result = await reconcileMachineWithDeps(baseCtx(['context7']), deps);
  assert.deepEqual(result, { provider: 'devin', kind: 'plugin', runtimeVersion: null, installed: [], updated: [], present: [], failed: [], notAllowed: [] });
  assert.equal(calls.devin.length, 0);
  assert.equal(calls.git.length, 0);
});

test('enabled()=false: hasManagedStateWithDeps は false（state を読まない）', async () => {
  const { deps, calls } = makeFakeDeps({ enabled: false, jsonFiles: { [statePath]: buildState([{ pluginId: 'x', installSource: 's', indexCommit: 'c', installedAt: 'now' }]) } });
  const result = await hasManagedStateWithDeps(deps);
  assert.equal(result, false);
  assert.equal(calls.readJson.length, 0);
});

// -----------------------------------------------------------------------------
// devin 未検出
// -----------------------------------------------------------------------------

test('devin 未検出: failed は積まず runtimeVersion のみ設定する', async () => {
  const { deps, calls } = makeFakeDeps({ devinPath: null });
  const result = await reconcileMachineWithDeps(baseCtx(['context7']), deps);
  assert.equal(result.runtimeVersion, 'Devin 未検出');
  assert.deepEqual(result.failed, []);
  assert.equal(calls.devin.length, 0);
});

// -----------------------------------------------------------------------------
// plugins --help 非 0: 以降の CLI を 1 回も呼ばない
// -----------------------------------------------------------------------------

test('plugins --help が非 0: items 全件を failed にし、以降 CLI を 1 回も呼ばない', async () => {
  const { deps, calls } = makeFakeDeps({ pluginsHelp: errResult() });
  const result = await reconcileMachineWithDeps(baseCtx(['context7', 'access-migration']), deps);
  assert.deepEqual(result.failed.map((f) => f.id).sort(), ['access-migration', 'context7']);
  assert.ok(result.failed.every((f) => f.reason === 'plugins-subcommand-unsupported'));
  assert.equal(calls.devin.length, 1); // '--help' の 1 回だけ
  assert.equal(calls.git.length, 0); // marketplace clone にも進まない
});

test('plugins --help が非 0 かつ items 0 件: cleanup-only でも何もできず空結果', async () => {
  const { deps, calls } = makeFakeDeps({ pluginsHelp: errResult() });
  const result = await reconcileMachineWithDeps(baseCtx([]), deps);
  assert.deepEqual(result.failed, []);
  assert.equal(calls.devin.length, 1);
});

// -----------------------------------------------------------------------------
// argv/cwd の直接アサート（P1.3 の cwd バグ再発防止）
// -----------------------------------------------------------------------------

test('install 呼び出しの argv と cwd を直接アサートする', async () => {
  const { deps, calls } = makeFakeDeps(withCloneAndManifest());
  await reconcileMachineWithDeps(baseCtx(['context7']), deps);

  const installCall = calls.devin.find((c) => c.args[1] === 'install');
  assert.ok(installCall, 'install が呼ばれていること');
  assert.deepEqual(installCall.args, ['plugins', 'install', 'murata1215/devrelay-plugins#plugins/context7', '--yes']);
  assert.equal(installCall.cwd, machineCwd);
  assert.equal(installCall.devinPath, '/usr/bin/devin');

  for (const c of calls.devin) assert.equal(c.cwd, machineCwd);
});

// -----------------------------------------------------------------------------
// state にあれば install を打たない（present 判定）
// -----------------------------------------------------------------------------

test('state にあり info ok・commit 一致なら present になり install は 1 回も呼ばれない', async () => {
  const scenario = withCloneAndManifest({
    jsonFiles: {
      [statePath]: buildState([{ pluginId: 'context7', installSource: 'murata1215/devrelay-plugins#plugins/context7', indexCommit: 'abc123', installedAt: '2026-10-01T00:00:00.000Z' }]),
    },
    infoDefault: okResult(), // state どおり Devin 側にも実在する
  });
  const { deps, calls } = makeFakeDeps(scenario);
  const result = await reconcileMachineWithDeps(baseCtx(['context7']), deps);

  assert.deepEqual(result.present, ['context7']);
  assert.deepEqual(result.installed, []);
  assert.ok(!calls.devin.some((c) => c.args[1] === 'install'));
  assert.ok(!calls.devin.some((c) => c.args[1] === 'update'));
});

// -----------------------------------------------------------------------------
// install が非 0 なら state に書かない
// -----------------------------------------------------------------------------

test('install が非 0 なら written state にそのエントリが含まれない', async () => {
  const { deps, getWrittenState } = makeFakeDeps({
    ...withCloneAndManifest(),
    installDefault: errResult({ error: 'install-boom' }),
  });
  const result = await reconcileMachineWithDeps(baseCtx(['context7']), deps);

  assert.equal(result.installed.length, 0);
  assert.ok(result.failed.some((f) => f.id === 'context7' && f.reason === 'install-boom'));
  const written = getWrittenState();
  assert.ok(written);
  assert.ok(!written.entries.some((e) => e.pluginId === 'context7'));
});

test('install 成功後の info 再検証が失敗したら install-verify-failed で state にも書かない', async () => {
  let infoCallCount = 0;
  const { deps, getWrittenState } = makeFakeDeps({
    ...withCloneAndManifest(),
    devinHandler: (args) => {
      if (args[1] === 'info') {
        infoCallCount += 1;
        // 1 回目（conflict/self-heal 判定）は not-present、2 回目（install 後の再検証）も失敗させる
        return errResult();
      }
      return undefined;
    },
  });
  const result = await reconcileMachineWithDeps(baseCtx(['context7']), deps);

  assert.ok(result.failed.some((f) => f.id === 'context7' && f.reason === 'install-verify-failed'));
  const written = getWrittenState();
  assert.ok(!written.entries.some((e) => e.pluginId === 'context7'));
  assert.ok(infoCallCount >= 2);
});

// -----------------------------------------------------------------------------
// clone 失敗時: removed 0 件・state 無傷
// -----------------------------------------------------------------------------

test('marketplace clone 失敗時は全 item が failed:clone-failed になり state を一切書かない', async () => {
  const { deps, calls } = makeFakeDeps({
    cloneParentEntries: [], // 未 clone なので新規 clone を試みる
    gitResults: () => errGit(), // clone 自体を失敗させる
  });
  const result = await reconcileMachineWithDeps(baseCtx(['context7']), deps);

  assert.ok(result.failed.every((f) => f.reason === 'clone-failed'));
  assert.equal(result.removed, undefined);
  assert.equal(calls.writeState.length, 0); // 既存 state に一切触らない（last-known-good）
});

test('manifest パース失敗時も撤去しない（failed:manifest-invalid・state 無傷）', async () => {
  const { deps, calls } = makeFakeDeps({
    cloneParentEntries: [marketplaceName],
    jsonFiles: { [manifestPath]: { not: 'a valid manifest' } },
  });
  const result = await reconcileMachineWithDeps(baseCtx(['context7']), deps);

  assert.ok(result.failed.every((f) => f.reason === 'manifest-invalid'));
  assert.equal(calls.writeState.length, 0);
});

// -----------------------------------------------------------------------------
// その他の分岐（notAllowed / conflict-unmanaged / self-heal / update / 撤去）
// -----------------------------------------------------------------------------

test('manifest に無い id は notAllowed に積まれる（install を試みない）', async () => {
  const { deps, calls } = makeFakeDeps(withCloneAndManifest());
  const result = await reconcileMachineWithDeps(baseCtx(['not-in-manifest']), deps);

  assert.deepEqual(result.notAllowed, ['not-in-manifest']);
  assert.equal(calls.devin.filter((c) => c.args[1] !== '--help').length, 0);
});

test('state 無し & info ok（Devin に実在）は conflict-unmanaged になり install/remove しない', async () => {
  const { deps, calls } = makeFakeDeps({
    ...withCloneAndManifest(),
    infoDefault: okResult(), // 既に Devin 側に存在する扱い
  });
  const result = await reconcileMachineWithDeps(baseCtx(['context7']), deps);

  assert.ok(result.failed.some((f) => f.id === 'context7' && f.reason === 'unmanaged-conflict'));
  assert.ok(!calls.devin.some((c) => c.args[1] === 'install'));
  assert.ok(!calls.devin.some((c) => c.args[1] === 'remove'));
});

test('state あり & info NG（Devin から消えている）は self-heal で install する', async () => {
  const scenario = withCloneAndManifest({
    jsonFiles: {
      [statePath]: buildState([{ pluginId: 'context7', installSource: 'murata1215/devrelay-plugins#plugins/context7', indexCommit: 'old-commit', installedAt: '2026-01-01T00:00:00.000Z' }]),
    },
  });
  let infoCallCount = 0;
  const { deps } = makeFakeDeps({
    ...scenario,
    devinHandler: (args) => {
      if (args[1] === 'info') {
        infoCallCount += 1;
        // 1 回目（self-heal 判定）は NG、install 後の再検証（2 回目）は ok
        return infoCallCount === 1 ? errResult() : okResult();
      }
      return undefined;
    },
  });
  const result = await reconcileMachineWithDeps(baseCtx(['context7']), deps);
  assert.deepEqual(result.installed, ['context7']);
});

test('commit 不一致なら update が呼ばれ、成功すれば updated に積まれる', async () => {
  const scenario = withCloneAndManifest({
    jsonFiles: {
      [statePath]: buildState([{ pluginId: 'context7', installSource: 'murata1215/devrelay-plugins#plugins/context7', indexCommit: 'old-commit', installedAt: '2026-01-01T00:00:00.000Z' }]),
    },
    infoDefault: okResult(), // Devin 側には実在する（commit だけ古い）
  });
  const { deps, calls } = makeFakeDeps(scenario); // rev-parse は既定で 'abc123' を返す（state の 'old-commit' と不一致）
  const result = await reconcileMachineWithDeps(baseCtx(['context7']), deps);

  assert.deepEqual(result.updated, ['context7']);
  assert.ok(calls.devin.some((c) => c.args[1] === 'update' && c.args[2] === 'context7'));
});

test('desired から外れた state entry は remove され removed に積まれる', async () => {
  const scenario = withCloneAndManifest({
    jsonFiles: {
      [statePath]: buildState([{ pluginId: 'access-migration', installSource: 'murata1215/devrelay-plugins#plugins/access-migration', indexCommit: 'abc123', installedAt: '2026-01-01T00:00:00.000Z' }]),
    },
  });
  const { deps, calls, getWrittenState } = makeFakeDeps(scenario);
  // context7 のみ desired にし、access-migration は desired から外す
  const result = await reconcileMachineWithDeps(baseCtx(['context7']), deps);

  assert.deepEqual(result.removed, ['access-migration']);
  assert.ok(calls.devin.some((c) => c.args[1] === 'remove' && c.args[2] === 'access-migration' && c.args[3] === '--yes'));
  const written = getWrittenState();
  assert.ok(!written.entries.some((e) => e.pluginId === 'access-migration'));
});

test('remove が失敗したら failed に積み state には残す（次回リトライ用）', async () => {
  const scenario = withCloneAndManifest({
    jsonFiles: {
      [statePath]: buildState([{ pluginId: 'access-migration', installSource: 'murata1215/devrelay-plugins#plugins/access-migration', indexCommit: 'abc123', installedAt: '2026-01-01T00:00:00.000Z' }]),
    },
  });
  const { deps, getWrittenState } = makeFakeDeps({ ...scenario, removeDefault: errResult() });
  const result = await reconcileMachineWithDeps(baseCtx(['context7']), deps);

  assert.equal(result.removed, undefined);
  assert.ok(result.failed.some((f) => f.id === 'access-migration'));
  const written = getWrittenState();
  assert.ok(written.entries.some((e) => e.pluginId === 'access-migration'));
});

// -----------------------------------------------------------------------------
// cleanup-only 経路（items 0 件）
// -----------------------------------------------------------------------------

test('cleanup-only（items 0 件）: state の全エントリを remove し、成功分は removed に積んで state を空にする', async () => {
  const scenario = {
    jsonFiles: {
      [statePath]: buildState([
        { pluginId: 'context7', installSource: 'murata1215/devrelay-plugins#plugins/context7', indexCommit: 'abc123', installedAt: '2026-01-01T00:00:00.000Z' },
        { pluginId: 'access-migration', installSource: 'murata1215/devrelay-plugins#plugins/access-migration', indexCommit: 'abc123', installedAt: '2026-01-01T00:00:00.000Z' },
      ]),
    },
  };
  const { deps, calls, getWrittenState } = makeFakeDeps(scenario);
  const result = await reconcileMachineWithDeps(baseCtx([]), deps);

  assert.deepEqual(result.removed.sort(), ['access-migration', 'context7']);
  assert.ok(!calls.git.length); // cleanup-only は git を一切呼ばない
  const written = getWrittenState();
  assert.deepEqual(written.entries, []);
});

test('cleanup-only で一部 remove が失敗したら、その分だけ state に残る', async () => {
  const scenario = {
    jsonFiles: {
      [statePath]: buildState([
        { pluginId: 'context7', installSource: 'murata1215/devrelay-plugins#plugins/context7', indexCommit: 'abc123', installedAt: '2026-01-01T00:00:00.000Z' },
      ]),
    },
    removeDefault: errResult(),
  };
  const { deps, getWrittenState } = makeFakeDeps(scenario);
  const result = await reconcileMachineWithDeps(baseCtx([]), deps);

  assert.equal(result.removed, undefined);
  assert.ok(result.failed.some((f) => f.id === 'context7'));
  const written = getWrittenState();
  assert.deepEqual(written.entries.map((e) => e.pluginId), ['context7']);
});

// -----------------------------------------------------------------------------
// state-path 解決失敗 / provider 設定なし / git 不在
// -----------------------------------------------------------------------------

test('state path 解決失敗なら items 全件 failed になり CLI を一切呼ばない', async () => {
  const { deps, calls } = makeFakeDeps({ statePathResult: { ok: false, reason: 'override-not-absolute' } });
  const result = await reconcileMachineWithDeps(baseCtx(['context7']), deps);
  assert.ok(result.failed.every((f) => f.reason === 'state-path-override-not-absolute'));
  assert.equal(calls.devin.length, 0);
});

test('providers.claude が無ければ missing-marketplace-config で全件 failed', async () => {
  const { deps } = makeFakeDeps({ pluginsHelp: okResult() });
  const result = await reconcileMachineWithDeps(baseCtx(['context7'], {}), deps);
  assert.ok(result.failed.every((f) => f.reason === 'missing-marketplace-config'));
});

test('git 不在なら git-not-found で全件 failed', async () => {
  const { deps } = makeFakeDeps({ gitPath: null });
  const result = await reconcileMachineWithDeps(baseCtx(['context7']), deps);
  assert.ok(result.failed.every((f) => f.reason === 'git-not-found'));
});

// -----------------------------------------------------------------------------
// reconcileProjectWithDeps / hasManagedStateWithDeps
// -----------------------------------------------------------------------------

test('reconcileProjectWithDeps は常に空結果を返し deps を一切呼ばない', async () => {
  const { deps, calls } = makeFakeDeps(withCloneAndManifest());
  const result = await reconcileProjectWithDeps(baseCtx(['context7']), '/fake/project', deps);
  assert.deepEqual(result, { provider: 'devin', kind: 'plugin', runtimeVersion: null, installed: [], updated: [], present: [], failed: [], notAllowed: [] });
  assert.equal(calls.devin.length, 0);
  assert.equal(calls.readJson.length, 0);
});

test('hasManagedStateWithDeps: state に 1 件以上あれば true', async () => {
  const { deps } = makeFakeDeps({
    jsonFiles: { [statePath]: buildState([{ pluginId: 'context7', installSource: 's', indexCommit: 'c', installedAt: 'now' }]) },
  });
  assert.equal(await hasManagedStateWithDeps(deps), true);
});

test('hasManagedStateWithDeps: state が空なら false', async () => {
  const { deps } = makeFakeDeps({ jsonFiles: { [statePath]: buildState([]) } });
  assert.equal(await hasManagedStateWithDeps(deps), false);
});

test('hasManagedStateWithDeps: state ファイルが無ければ false（throw しない）', async () => {
  const { deps } = makeFakeDeps({ jsonFiles: {} });
  assert.equal(await hasManagedStateWithDeps(deps), false);
});
