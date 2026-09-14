// サイクルP3-A: devin-skill-adapter.ts（deps 注入形）を完全な fake deps（spawn ゼロ・実 fs ゼロ）で
// 駆動するテスト。コンパイル済み dist から直接 import する。
//
// fake deps は「仮想ファイルシステム」を素朴なオブジェクト（Map/Set）でシミュレートする。
// skillsDir 直下のディレクトリ名一覧・marker 内容・clone 済みディレクトリ一覧・
// marketplace.json/plugin.json の内容・skills/ 直下の一覧を全て state に持たせ、
// copyTree/atomicSwap/writeMarker の呼び出しに応じて state を更新することで
// install/update/present/removed の一連の流れを実 I/O ゼロで検証する。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname, basename } from 'node:path';
import {
  reconcileMachineWithDeps,
  reconcileProjectWithDeps,
  hasManagedStateWithDeps,
} from '../dist/services/capabilities/devin-skill-adapter.js';

const marketplaceName = 'devrelay';
const marketplaceSource = 'murata1215/devrelay-plugins';
const machineCwd = '/fake/machine';
const skillsDir = '/fake/skills';
const cloneParentDir = join(machineCwd, 'capabilities', 'marketplaces');
const cloneDir = join(cloneParentDir, marketplaceName);
const manifestPath = join(cloneDir, '.claude-plugin', 'marketplace.json');
const pluginDir = (id) => join(cloneDir, 'plugins', id);
const pluginJsonPath = (id) => join(pluginDir(id), '.claude-plugin', 'plugin.json');
const skillsRootDir = (id) => join(pluginDir(id), 'skills');

const okGit = (stdout = '') => ({ ok: true, stdout, stderr: '', code: 0, killed: false });
const errGit = () => ({ ok: false, stdout: '', stderr: '', code: 1, killed: false, error: 'git-error' });

function buildMarker(overrides = {}) {
  return {
    schema: 1,
    managedBy: 'devrelay',
    provider: 'devin',
    kind: 'skill',
    marketplaceName,
    marketplaceSource,
    pluginId: 'access-migration',
    pluginVersion: '0.1.0',
    skillName: 'access-to-csharp',
    sourceCommit: 'abc123',
    contentHash: 'hash:base',
    installedAt: '2026-09-15T00:00:00.000Z',
    ...overrides,
  };
}

/** fake deps ファクトリ。scenario で初期状態を注入し、calls で呼び出し記録を取得する */
function makeFakeDeps(scenario = {}) {
  const calls = {
    git: [], copyTree: [], atomicSwap: [], removeManagedDir: [], writeMarker: [],
    hashTree: [], readJson: [], listDirNames: [], resolveRuntimeVersion: 0,
    resolveDevinPath: 0, resolveGitPath: 0,
  };
  const state = {
    skillsDirEntries: new Set(scenario.skillsDirEntries ?? []),
    markers: new Map(Object.entries(scenario.markers ?? {})),
    cloneParentEntries: new Set(scenario.cloneParentEntries ?? []),
    jsonFiles: new Map(Object.entries(scenario.jsonFiles ?? {})),
    pluginSkillDirs: new Map(Object.entries(scenario.pluginSkillDirs ?? {})),
    contentHashes: new Map(Object.entries(scenario.contentHashes ?? {})),
    removedNames: [],
  };
  const pendingMarkers = new Map();
  const gitResults = scenario.gitResults ?? ((args) => (args[0] === 'rev-parse' ? okGit('abc123') : okGit('')));
  const copyTreeResult = scenario.copyTreeResult ?? (() => ({ ok: true, fileCount: 1, totalBytes: 10 }));
  const atomicSwapResult = scenario.atomicSwapResult ?? (() => ({ ok: true }));

  const deps = {
    resolveDevinPath: () => { calls.resolveDevinPath += 1; return scenario.devinPath === undefined ? '/usr/bin/devin' : scenario.devinPath; },
    resolveGitPath: () => { calls.resolveGitPath += 1; return scenario.gitPath === undefined ? '/usr/bin/git' : scenario.gitPath; },
    async runGit(gitPath, args, cwd, timeoutMs) {
      calls.git.push({ gitPath, args, cwd, timeoutMs });
      return gitResults(args, cwd);
    },
    async resolveRuntimeVersion() {
      calls.resolveRuntimeVersion += 1;
      return scenario.runtimeVersion ?? '1.2.3';
    },
    async readJson(p) {
      calls.readJson.push(p);
      for (const [name, marker] of state.markers) {
        if (p === join(skillsDir, name, '.devrelay-capability.json')) return marker;
      }
      if (state.jsonFiles.has(p)) return state.jsonFiles.get(p);
      return null;
    },
    machineCwd: () => scenario.machineCwd ?? machineCwd,
    resolveSkillsDir: () => {
      if (scenario.throwOnResolveSkillsDir) throw new Error('boom');
      return scenario.skillsDirResult ?? { ok: true, dir: skillsDir, source: 'xdg' };
    },
    async copyTree(src, dest, limits) {
      calls.copyTree.push({ src, dest, limits });
      return copyTreeResult(src, dest);
    },
    async hashTree(dir) {
      calls.hashTree.push(dir);
      return state.contentHashes.get(dir) ?? `hash:${dir}`;
    },
    async atomicSwap(staging, dest, trash) {
      calls.atomicSwap.push({ staging, dest, trash });
      const result = atomicSwapResult(staging, dest, trash);
      if (result.ok) {
        const name = basename(dest);
        state.skillsDirEntries.add(name);
        const marker = pendingMarkers.get(staging);
        if (marker) state.markers.set(name, marker);
      }
      return result;
    },
    async removeManagedDir(dir) {
      calls.removeManagedDir.push(dir);
      if (dirname(dir) === skillsDir) {
        const name = basename(dir);
        state.skillsDirEntries.delete(name);
        state.markers.delete(name);
        state.removedNames.push(name);
      }
    },
    async listDirNames(dir) {
      calls.listDirNames.push(dir);
      if (dir === skillsDir) return Array.from(state.skillsDirEntries).sort();
      if (dir === cloneParentDir) return Array.from(state.cloneParentEntries).sort();
      if (state.pluginSkillDirs.has(dir)) return state.pluginSkillDirs.get(dir).slice().sort();
      return [];
    },
    async ensureDir() {},
    async cleanupResidue() {},
    uniqueSuffix: () => scenario.uniqueSuffix ?? 'u1',
    nowIso: () => scenario.nowIso ?? '2026-09-15T00:00:00.000Z',
    async writeMarker(filePath, marker) {
      calls.writeMarker.push({ filePath, marker });
      const dir = dirname(filePath);
      pendingMarkers.set(dir, marker);
      // refresh-marker（staging を経由しない直書き）: dirname(dir) === skillsDir なら即座に反映する
      if (dirname(dir) === skillsDir) {
        state.markers.set(basename(dir), marker);
      }
    },
  };
  return { deps, calls, state };
}

function baseCtx(overrides = {}) {
  return {
    config: { providers: { devin: { marketplaceName, marketplaceSource } }, items: [] },
    items: [{ provider: 'devin', kind: 'skill', id: 'access-migration' }],
    ...overrides,
  };
}

function baseJsonFiles(pluginIds = ['access-migration']) {
  const files = {
    [manifestPath]: {
      name: marketplaceName,
      plugins: pluginIds.map((id) => ({ name: id, source: `./plugins/${id}`, version: '0.1.0' })),
    },
  };
  for (const id of pluginIds) {
    files[pluginJsonPath(id)] = { name: id, version: '0.1.0' };
  }
  return files;
}

// -----------------------------------------------------------------------------
// 早期失敗パス（provider config / devin / git / skillsDir / URL）
// -----------------------------------------------------------------------------

test('providerConfig 未設定 → failed(missing-provider-config)、CLI/git 呼び出し0回', async () => {
  const { deps, calls } = makeFakeDeps({});
  const ctx = baseCtx({ config: { providers: {}, items: [] } });

  const result = await reconcileMachineWithDeps(ctx, deps);

  assert.deepEqual(result.failed, [{ id: 'access-migration', reason: 'missing-provider-config' }]);
  assert.equal(calls.resolveDevinPath, 0);
  assert.equal(calls.git.length, 0);
});

test('devin 未検出 → failed(devin-not-found)、git は一切呼ばれない', async () => {
  const { deps, calls } = makeFakeDeps({ devinPath: null });

  const result = await reconcileMachineWithDeps(baseCtx(), deps);

  assert.deepEqual(result.failed, [{ id: 'access-migration', reason: 'devin-not-found' }]);
  assert.equal(calls.resolveGitPath, 0);
  assert.equal(calls.git.length, 0);
});

test('git 未検出 → failed(git-not-found)、clone は一切走らない', async () => {
  const { deps, calls } = makeFakeDeps({ gitPath: null });

  const result = await reconcileMachineWithDeps(baseCtx(), deps);

  assert.deepEqual(result.failed, [{ id: 'access-migration', reason: 'git-not-found' }]);
  assert.equal(calls.git.length, 0);
});

test('skillsDir 解決失敗 → failed(skills-dir-<reason>)、他の deps は一切呼ばれない', async () => {
  const { deps, calls } = makeFakeDeps({ skillsDirResult: { ok: false, reason: 'home-missing' } });

  const result = await reconcileMachineWithDeps(baseCtx(), deps);

  assert.deepEqual(result.failed, [{ id: 'access-migration', reason: 'skills-dir-home-missing' }]);
  assert.equal(calls.resolveDevinPath, 0);
  assert.equal(calls.git.length, 0);
});

test('marketplaceSource が不正 → failed(unsupported-source-format)、git 呼び出し0回', async () => {
  const { deps, calls } = makeFakeDeps({});
  const ctx = baseCtx({ config: { providers: { devin: { marketplaceName, marketplaceSource: 'git@github.com:x/y.git' } }, items: [] } });

  const result = await reconcileMachineWithDeps(ctx, deps);

  assert.deepEqual(result.failed, [{ id: 'access-migration', reason: 'unsupported-source-format' }]);
  assert.equal(calls.git.length, 0);
});

// -----------------------------------------------------------------------------
// 承認ノート#8 CRITICAL RULE: clone/manifest 失敗時は撤去しない
// -----------------------------------------------------------------------------

test('CRITICAL: clone 失敗 → failed(clone-failed)、既存 managed skill は last-known-good のまま残る', async () => {
  const { deps, calls, state } = makeFakeDeps({
    cloneParentEntries: [],
    gitResults: (args) => (args[0] === 'clone' ? errGit() : okGit('abc123')),
    skillsDirEntries: ['access-to-csharp'],
    markers: { 'access-to-csharp': buildMarker() },
  });

  const result = await reconcileMachineWithDeps(baseCtx(), deps);

  assert.deepEqual(result.failed, [{ id: 'access-migration', reason: 'clone-failed' }]);
  // clone 失敗時に掃除されるのは部分 clone の残骸（cloneParentDir 配下）のみ。
  // skillsDir 配下（managed skill 本体）への removeManagedDir 呼び出しは 0 回でなければならない。
  assert.equal(calls.removeManagedDir.filter((dir) => dirname(dir) === skillsDir).length, 0);
  assert.ok(state.skillsDirEntries.has('access-to-csharp'));
  assert.equal(state.markers.has('access-to-csharp'), true);
  assert.equal(result.removed, undefined);
});

test('CRITICAL: manifest 解析失敗 → failed(manifest-invalid)、既存 managed skill は last-known-good のまま残る', async () => {
  const { deps, calls } = makeFakeDeps({
    jsonFiles: { [manifestPath]: { broken: true } }, // name/plugins が無い壊れた manifest
    skillsDirEntries: ['access-to-csharp'],
    markers: { 'access-to-csharp': buildMarker() },
  });

  const result = await reconcileMachineWithDeps(baseCtx(), deps);

  assert.deepEqual(result.failed, [{ id: 'access-migration', reason: 'manifest-invalid' }]);
  assert.equal(calls.removeManagedDir.length, 0);
});

// -----------------------------------------------------------------------------
// fast path（同一 commit）/ update（内容変化）
// -----------------------------------------------------------------------------

test('同一 commit の fast path → present、hashTree/copyTree/atomicSwap は0回', async () => {
  const { deps, calls, state } = makeFakeDeps({
    jsonFiles: baseJsonFiles(),
    pluginSkillDirs: { [skillsRootDir('access-migration')]: ['access-to-csharp'] },
    skillsDirEntries: ['access-to-csharp'],
    markers: { 'access-to-csharp': buildMarker({ sourceCommit: 'abc123' }) },
  });

  const result = await reconcileMachineWithDeps(baseCtx(), deps);

  assert.deepEqual(result.present, ['access-migration/access-to-csharp']);
  assert.deepEqual(result.installed, []);
  assert.deepEqual(result.updated, []);
  assert.equal(calls.hashTree.length, 0);
  assert.equal(calls.copyTree.length, 0);
  assert.equal(calls.atomicSwap.length, 0);
  assert.equal(state.skillsDirEntries.has('access-to-csharp'), true);
});

test('内容が変わっていれば updated（version 同一・contentHash 相違）', async () => {
  const sourceDir = join(skillsRootDir('access-migration'), 'access-to-csharp');
  const { deps } = makeFakeDeps({
    jsonFiles: baseJsonFiles(),
    pluginSkillDirs: { [skillsRootDir('access-migration')]: ['access-to-csharp'] },
    skillsDirEntries: ['access-to-csharp'],
    markers: { 'access-to-csharp': buildMarker({ sourceCommit: 'old-commit', contentHash: 'old-hash' }) },
    contentHashes: { [sourceDir]: 'new-hash' },
  });

  const result = await reconcileMachineWithDeps(baseCtx(), deps);

  assert.deepEqual(result.updated, ['access-migration/access-to-csharp']);
  assert.deepEqual(result.present, []);
});

test('新規インストール（宛先が無い）→ installed、staging→swap が実行される', async () => {
  const { deps, calls, state } = makeFakeDeps({
    jsonFiles: baseJsonFiles(),
    pluginSkillDirs: { [skillsRootDir('access-migration')]: ['access-to-csharp'] },
    skillsDirEntries: [],
  });

  const result = await reconcileMachineWithDeps(baseCtx(), deps);

  assert.deepEqual(result.installed, ['access-migration/access-to-csharp']);
  assert.equal(calls.copyTree.length, 1);
  assert.equal(calls.atomicSwap.length, 1);
  assert.equal(state.skillsDirEntries.has('access-to-csharp'), true);
  assert.equal(state.markers.has('access-to-csharp'), true);
});

// -----------------------------------------------------------------------------
// 承認ノート#9: 非管理ディレクトリの保護
// -----------------------------------------------------------------------------

test('必須①: 同名の unmanaged dir が存在 → failed(dest-occupied-unmanaged)、swap/削除0回で保持される', async () => {
  const { deps, calls, state } = makeFakeDeps({
    jsonFiles: baseJsonFiles(),
    pluginSkillDirs: { [skillsRootDir('access-migration')]: ['access-to-csharp'] },
    skillsDirEntries: ['access-to-csharp'], // marker 無し = unmanaged
  });

  const result = await reconcileMachineWithDeps(baseCtx(), deps);

  assert.deepEqual(result.failed, [{ id: 'access-migration/access-to-csharp', reason: 'dest-occupied-unmanaged' }]);
  assert.equal(calls.atomicSwap.length, 0);
  assert.equal(calls.removeManagedDir.length, 0);
  assert.equal(state.skillsDirEntries.has('access-to-csharp'), true);
});

// -----------------------------------------------------------------------------
// 索引に無い plugin / skills 無し / 同名衝突
// -----------------------------------------------------------------------------

test('索引に無い plugin id → notAllowed', async () => {
  const { deps } = makeFakeDeps({ jsonFiles: baseJsonFiles([]) }); // manifest に plugins 無し
  const result = await reconcileMachineWithDeps(baseCtx(), deps);
  assert.deepEqual(result.notAllowed, ['access-migration']);
});

test('skills/ が無い plugin → present(<id>:no-skills)', async () => {
  const { deps } = makeFakeDeps({
    jsonFiles: baseJsonFiles(),
    pluginSkillDirs: { [skillsRootDir('access-migration')]: [] },
  });
  const result = await reconcileMachineWithDeps(baseCtx(), deps);
  assert.deepEqual(result.present, ['access-migration:no-skills']);
});

test('同名衝突 → 両 plugin ぶん failed(skill-name-conflict)、どちらも install しない', async () => {
  const { deps, calls } = makeFakeDeps({
    jsonFiles: baseJsonFiles(['plugin-a', 'plugin-b']),
    pluginSkillDirs: {
      [skillsRootDir('plugin-a')]: ['shared-skill'],
      [skillsRootDir('plugin-b')]: ['shared-skill'],
    },
  });
  const ctx = baseCtx({ items: [{ provider: 'devin', kind: 'skill', id: 'plugin-a' }, { provider: 'devin', kind: 'skill', id: 'plugin-b' }] });

  const result = await reconcileMachineWithDeps(ctx, deps);

  assert.deepEqual(
    result.failed.sort((a, b) => a.id.localeCompare(b.id)),
    [
      { id: 'plugin-a/shared-skill', reason: 'skill-name-conflict' },
      { id: 'plugin-b/shared-skill', reason: 'skill-name-conflict' },
    ],
  );
  assert.equal(calls.copyTree.length, 0);
});

// -----------------------------------------------------------------------------
// items: [] cleanup-only 経路（承認ノート#6）
// -----------------------------------------------------------------------------

test('items:[] → filesystem-only cleanup。managed skill は撤去、unmanaged は保持、CLI/git は一切呼ばれない', async () => {
  const { deps, calls, state } = makeFakeDeps({
    skillsDirEntries: ['access-to-csharp', 'my-own-skill'],
    markers: { 'access-to-csharp': buildMarker() }, // my-own-skill は marker 無し = unmanaged
  });

  const result = await reconcileMachineWithDeps(baseCtx({ items: [] }), deps);

  assert.deepEqual(result.removed, ['access-to-csharp']);
  assert.equal(state.skillsDirEntries.has('access-to-csharp'), false);
  assert.equal(state.skillsDirEntries.has('my-own-skill'), true);
  assert.equal(calls.resolveDevinPath, 0);
  assert.equal(calls.resolveGitPath, 0);
  assert.equal(calls.git.length, 0);
  assert.equal(calls.resolveRuntimeVersion, 0);
});

test('items:[] かつ managed skill 無し → removed フィールド自体が生えない（純加算・非空のみ）', async () => {
  const { deps } = makeFakeDeps({ skillsDirEntries: [] });
  const result = await reconcileMachineWithDeps(baseCtx({ items: [] }), deps);
  assert.equal('removed' in result, false);
});

// -----------------------------------------------------------------------------
// 撤去（active 経路、desired から外れた managed skill）
// -----------------------------------------------------------------------------

test('active 経路: items から plugin を外す → 旧 managed skill が removed される', async () => {
  const { deps, state } = makeFakeDeps({
    jsonFiles: baseJsonFiles([]), // manifest に該当 plugin なし = 何も desired にならない
    skillsDirEntries: ['old-skill'],
    markers: { 'old-skill': buildMarker({ skillName: 'old-skill' }) },
  });

  const result = await reconcileMachineWithDeps(baseCtx(), deps); // items には access-migration のみ、manifest に無い→notAllowed

  assert.deepEqual(result.removed, ['old-skill']);
  assert.equal(state.skillsDirEntries.has('old-skill'), false);
});

// -----------------------------------------------------------------------------
// reconcileProjectWithDeps（v1 は project/prelaunch 未対応）
// -----------------------------------------------------------------------------

test('reconcileProjectWithDeps は常に空結果を返し、deps を一切呼ばない', async () => {
  const { deps, calls } = makeFakeDeps({});
  const result = await reconcileProjectWithDeps(baseCtx(), '/some/project', deps);

  assert.deepEqual(result, {
    provider: 'devin', kind: 'skill', runtimeVersion: null,
    installed: [], updated: [], present: [], failed: [], notAllowed: [],
  });
  assert.equal(calls.resolveDevinPath, 0);
  assert.equal(calls.git.length, 0);
  assert.equal(calls.listDirNames.length, 0);
});

// -----------------------------------------------------------------------------
// hasManagedStateWithDeps
// -----------------------------------------------------------------------------

test('hasManagedStateWithDeps: managed skill が1件でもあれば true', async () => {
  const { deps } = makeFakeDeps({
    skillsDirEntries: ['access-to-csharp'],
    markers: { 'access-to-csharp': buildMarker() },
  });
  assert.equal(await hasManagedStateWithDeps(deps), true);
});

test('hasManagedStateWithDeps: managed skill が無ければ false（unmanaged のみでも false）', async () => {
  const { deps } = makeFakeDeps({ skillsDirEntries: ['my-own-skill'] });
  assert.equal(await hasManagedStateWithDeps(deps), false);
});

test('hasManagedStateWithDeps: skillsDir 解決失敗なら false', async () => {
  const { deps } = makeFakeDeps({ skillsDirResult: { ok: false, reason: 'home-missing' } });
  assert.equal(await hasManagedStateWithDeps(deps), false);
});

test('hasManagedStateWithDeps: throw しても fail-closed で false', async () => {
  const { deps } = makeFakeDeps({ throwOnResolveSkillsDir: true });
  assert.equal(await hasManagedStateWithDeps(deps), false);
});

// -----------------------------------------------------------------------------
// runtimeVersion（deps 経由の呼び出し回数のみ検証。実際の6時間キャッシュは devin-path.ts 側の責務）
// -----------------------------------------------------------------------------

test('runtimeVersion: active 経路では reconcileMachineWithDeps 呼び出しごとに1回 resolveRuntimeVersion が呼ばれる', async () => {
  const { deps, calls } = makeFakeDeps({
    jsonFiles: baseJsonFiles(),
    pluginSkillDirs: { [skillsRootDir('access-migration')]: ['access-to-csharp'] },
    skillsDirEntries: ['access-to-csharp'],
    markers: { 'access-to-csharp': buildMarker({ sourceCommit: 'abc123' }) },
  });

  await reconcileMachineWithDeps(baseCtx(), deps);
  await reconcileMachineWithDeps(baseCtx(), deps);

  assert.equal(calls.resolveRuntimeVersion, 2);
});
