// サイクル P3-B: agent-skills-adapter.ts（deps 注入形）を完全な fake deps（spawn ゼロ・実 fs ゼロ）で
// 駆動するテスト。コンパイル済み dist から直接 import する（devin-skill-adapter.test.mjs からの移設+拡張）。
//
// fake deps は「仮想ファイルシステム」を素朴なオブジェクト（Map/Set）でシミュレートする。
// 新配布先（skillsDir）と legacy（P3-A Devin 専用、legacyDir）を別々の Set/Map で持たせ、
// copyTree/atomicSwap/writeMarker/removeManagedDir の呼び出しに応じて state を更新することで
// install/update/present/removed（新配布先 + legacy 移行の両方）を実 I/O ゼロで検証する。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname, basename } from 'node:path';
import {
  reconcileMachineWithDeps,
  reconcileProjectWithDeps,
  hasManagedStateWithDeps,
  defaultDeps,
  setAiToolsSnapshot,
} from '../dist/services/capabilities/agent-skills-adapter.js';

const marketplaceName = 'devrelay';
const marketplaceSource = 'murata1215/devrelay-plugins';
const machineCwd = '/fake/machine';
const skillsDir = '/fake/skills';
const legacyDir = '/fake/legacy';
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
    adapter: 'agent-skills-standard',
    provider: 'agent-skills',
    kind: 'standard',
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

function buildLegacyMarker(overrides = {}) {
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
    installedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

/** fake deps ファクトリ。scenario で初期状態を注入し、calls で呼び出し記録を取得する */
function makeFakeDeps(scenario = {}) {
  const calls = {
    git: [], copyTree: [], atomicSwap: [], removeManagedDir: [], writeMarker: [],
    hashTree: [], readJson: [], listDirNames: [], resolveRuntimeVersion: 0,
    resolveDevinPath: 0, resolveGitPath: 0, hasAiTool: [],
  };
  const state = {
    skillsDirEntries: new Set(scenario.skillsDirEntries ?? []),
    markers: new Map(Object.entries(scenario.markers ?? {})),
    legacyDirEntries: new Set(scenario.legacyDirEntries ?? []),
    legacyMarkers: new Map(Object.entries(scenario.legacyMarkers ?? {})),
    cloneParentEntries: new Set(scenario.cloneParentEntries ?? []),
    jsonFiles: new Map(Object.entries(scenario.jsonFiles ?? {})),
    pluginSkillDirs: new Map(Object.entries(scenario.pluginSkillDirs ?? {})),
    contentHashes: new Map(Object.entries(scenario.contentHashes ?? {})),
    removedNames: [],
    removedLegacyNames: [],
  };
  const pendingMarkers = new Map();
  const gitResults = scenario.gitResults ?? ((args) => (args[0] === 'rev-parse' ? okGit('abc123') : okGit('')));
  const copyTreeResult = scenario.copyTreeResult ?? (() => ({ ok: true, fileCount: 1, totalBytes: 10 }));
  const atomicSwapResult = scenario.atomicSwapResult ?? (() => ({ ok: true }));
  const aiTools = scenario.aiTools ?? {};
  const forceInvalidMarkerFor = scenario.forceInvalidMarkerFor ?? new Set();

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
    hasAiTool: (name) => {
      calls.hasAiTool.push(name);
      return Object.prototype.hasOwnProperty.call(aiTools, name);
    },
    async readJson(p) {
      calls.readJson.push(p);
      for (const [name, marker] of state.markers) {
        if (p === join(skillsDir, name, '.devrelay-capability.json')) return marker;
      }
      for (const [name, marker] of state.legacyMarkers) {
        if (p === join(legacyDir, name, '.devrelay-capability.json')) return marker;
      }
      if (state.jsonFiles.has(p)) return state.jsonFiles.get(p);
      return null;
    },
    machineCwd: () => scenario.machineCwd ?? machineCwd,
    resolveSkillsDir: () => {
      if (scenario.throwOnResolveSkillsDir) throw new Error('boom');
      return scenario.skillsDirResult ?? { ok: true, dir: skillsDir, source: 'default' };
    },
    resolveLegacySkillsDir: () => {
      if (scenario.throwOnResolveLegacySkillsDir) throw new Error('boom');
      return scenario.legacyDirResult ?? { ok: true, dir: legacyDir, source: 'legacy' };
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
        if (marker) {
          state.markers.set(name, forceInvalidMarkerFor.has(name) ? { invalid: true } : marker);
        }
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
      } else if (dirname(dir) === legacyDir) {
        const name = basename(dir);
        state.legacyDirEntries.delete(name);
        state.legacyMarkers.delete(name);
        state.removedLegacyNames.push(name);
      }
    },
    async listDirNames(dir) {
      calls.listDirNames.push(dir);
      if (dir === skillsDir) return Array.from(state.skillsDirEntries).sort();
      if (dir === legacyDir) return Array.from(state.legacyDirEntries).sort();
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
        const name = basename(dir);
        state.markers.set(name, forceInvalidMarkerFor.has(name) ? { invalid: true } : marker);
      }
    },
  };
  return { deps, calls, state };
}

function baseCtx(overrides = {}) {
  return {
    config: { providers: { claude: { marketplaceName, marketplaceSource } }, items: [] },
    items: [{ provider: 'agent-skills', kind: 'standard', id: 'access-migration' }],
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
// setAiToolsSnapshot（connection.ts との DI 配線）
// -----------------------------------------------------------------------------

test('setAiToolsSnapshot: 注入後 defaultDeps.hasAiTool が反映される（spawn ゼロ）', () => {
  setAiToolsSnapshot({ codex: { version: '1.0' } });
  assert.equal(defaultDeps.hasAiTool('codex'), true);
  assert.equal(defaultDeps.hasAiTool('gemini'), false);
  setAiToolsSnapshot(null);
  assert.equal(defaultDeps.hasAiTool('codex'), false);
});

// -----------------------------------------------------------------------------
// 早期失敗パス（marketplace 索引宣言 / git / skillsDir / URL）
// -----------------------------------------------------------------------------

test('providers.claude 未設定 → failed(missing-marketplace-config)、診断は計算されるが git 呼び出しは0回', async () => {
  const { deps, calls } = makeFakeDeps({});
  const ctx = baseCtx({ config: { providers: {}, items: [] } });

  const result = await reconcileMachineWithDeps(ctx, deps);

  assert.deepEqual(result.failed, [{ id: 'access-migration', reason: 'missing-marketplace-config' }]);
  // §5-6: 診断（Devin 実機検出 / Codex 設定有無）は provider config 確認より先に走る
  assert.equal(calls.resolveDevinPath, 1);
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
  const ctx = baseCtx({ config: { providers: { claude: { marketplaceName, marketplaceSource: 'git@github.com:x/y.git' } }, items: [] } });

  const result = await reconcileMachineWithDeps(ctx, deps);

  assert.deepEqual(result.failed, [{ id: 'access-migration', reason: 'unsupported-source-format' }]);
  assert.equal(calls.git.length, 0);
});

// -----------------------------------------------------------------------------
// 承認ノート#8 CRITICAL RULE（P3-A から継続）: clone/manifest 失敗時は撤去しない。
// P3-B ではこれに legacy 移行も一切行われないことを追加検証する。
// -----------------------------------------------------------------------------

test('CRITICAL: clone 失敗 → failed(clone-failed)、新配布先・legacy とも last-known-good のまま', async () => {
  const { deps, calls, state } = makeFakeDeps({
    cloneParentEntries: [],
    gitResults: (args) => (args[0] === 'clone' ? errGit() : okGit('abc123')),
    skillsDirEntries: ['access-to-csharp'],
    markers: { 'access-to-csharp': buildMarker() },
    legacyDirEntries: ['access-to-csharp'],
    legacyMarkers: { 'access-to-csharp': buildLegacyMarker() },
  });

  const result = await reconcileMachineWithDeps(baseCtx(), deps);

  assert.deepEqual(result.failed, [{ id: 'access-migration', reason: 'clone-failed' }]);
  // clone 失敗時に掃除されるのは部分 clone の残骸（cloneParentDir 配下）のみ。
  // skillsDir / legacyDir 配下（managed skill 本体）への removeManagedDir 呼び出しは 0 回でなければならない。
  assert.equal(calls.removeManagedDir.filter((dir) => dirname(dir) === skillsDir).length, 0);
  assert.equal(calls.removeManagedDir.filter((dir) => dirname(dir) === legacyDir).length, 0);
  assert.ok(state.skillsDirEntries.has('access-to-csharp'));
  assert.ok(state.legacyDirEntries.has('access-to-csharp'));
  assert.equal(result.removed, undefined);
});

test('CRITICAL: manifest 解析失敗 → failed(manifest-invalid)、新配布先・legacy とも last-known-good のまま', async () => {
  const { deps, calls, state } = makeFakeDeps({
    jsonFiles: { [manifestPath]: { broken: true } }, // name/plugins が無い壊れた manifest
    skillsDirEntries: ['access-to-csharp'],
    markers: { 'access-to-csharp': buildMarker() },
    legacyDirEntries: ['access-to-csharp'],
    legacyMarkers: { 'access-to-csharp': buildLegacyMarker() },
  });

  const result = await reconcileMachineWithDeps(baseCtx(), deps);

  assert.deepEqual(result.failed, [{ id: 'access-migration', reason: 'manifest-invalid' }]);
  assert.equal(calls.removeManagedDir.length, 0);
  assert.ok(state.legacyDirEntries.has('access-to-csharp'));
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
// 承認ノート#9（P3-A から継続、reason 名は §5-5 で unmanaged-conflict に統一）:
// 非管理ディレクトリの保護（新配布先・legacy 双方）
// -----------------------------------------------------------------------------

test('必須①: 同名の unmanaged dir が存在 → failed(unmanaged-conflict)、swap/削除0回で保持される', async () => {
  const { deps, calls, state } = makeFakeDeps({
    jsonFiles: baseJsonFiles(),
    pluginSkillDirs: { [skillsRootDir('access-migration')]: ['access-to-csharp'] },
    skillsDirEntries: ['access-to-csharp'], // marker 無し = unmanaged
  });

  const result = await reconcileMachineWithDeps(baseCtx(), deps);

  assert.deepEqual(result.failed, [{ id: 'access-migration/access-to-csharp', reason: 'unmanaged-conflict' }]);
  assert.equal(calls.atomicSwap.length, 0);
  assert.equal(calls.removeManagedDir.length, 0);
  assert.equal(state.skillsDirEntries.has('access-to-csharp'), true);
});

test('T6: legacy 側の unmanaged ディレクトリ（marker 無し）は一切触らない（新配布先の install には影響しない）', async () => {
  const { deps, calls, state } = makeFakeDeps({
    jsonFiles: baseJsonFiles(),
    pluginSkillDirs: { [skillsRootDir('access-migration')]: ['access-to-csharp'] },
    skillsDirEntries: [],
    legacyDirEntries: ['access-to-csharp'], // legacyMarkers 無し = unmanaged
  });

  const result = await reconcileMachineWithDeps(baseCtx(), deps);

  assert.deepEqual(result.installed, ['access-migration/access-to-csharp']);
  assert.equal(calls.removeManagedDir.filter((d) => dirname(d) === legacyDir).length, 0);
  assert.equal(state.legacyDirEntries.has('access-to-csharp'), true);
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
  const ctx = baseCtx({ items: [{ provider: 'agent-skills', kind: 'standard', id: 'plugin-a' }, { provider: 'agent-skills', kind: 'standard', id: 'plugin-b' }] });

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
// items: [] cleanup-only 経路（承認ノート#6、P3-B では legacy も含めて全撤去）
// -----------------------------------------------------------------------------

test('items:[] → filesystem-only cleanup。新配布先+legacy 両方の managed skill を撤去、unmanaged は保持、CLI/git は一切呼ばれない', async () => {
  const { deps, calls, state } = makeFakeDeps({
    skillsDirEntries: ['access-to-csharp', 'my-own-skill'],
    markers: { 'access-to-csharp': buildMarker() }, // my-own-skill は marker 無し = unmanaged
    legacyDirEntries: ['legacy-skill', 'legacy-unmanaged'],
    legacyMarkers: { 'legacy-skill': buildLegacyMarker({ skillName: 'legacy-skill' }) },
  });

  const result = await reconcileMachineWithDeps(baseCtx({ items: [] }), deps);

  assert.ok(result.removed.includes('access-to-csharp'));
  assert.ok(result.removed.includes('legacy:access-migration/legacy-skill'));
  assert.equal(state.skillsDirEntries.has('access-to-csharp'), false);
  assert.equal(state.skillsDirEntries.has('my-own-skill'), true);
  assert.equal(state.legacyDirEntries.has('legacy-skill'), false);
  assert.equal(state.legacyDirEntries.has('legacy-unmanaged'), true);
  assert.equal(calls.resolveDevinPath, 0);
  assert.equal(calls.resolveGitPath, 0);
  assert.equal(calls.git.length, 0);
  assert.equal(calls.resolveRuntimeVersion, 0);
});

test('items:[] かつ managed skill 無し（新配布先・legacy とも）→ removed フィールド自体が生えない（純加算・非空のみ）', async () => {
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
// §5-4 legacy 移行（T4/T5、最重要）
// -----------------------------------------------------------------------------

test('T4 移行成功: 新配布先への install 成功 + marker 再読込検証OK → legacy marker 付きディレクトリが removed(legacy:...) に載る', async () => {
  const { deps, state } = makeFakeDeps({
    jsonFiles: baseJsonFiles(),
    pluginSkillDirs: { [skillsRootDir('access-migration')]: ['access-to-csharp'] },
    skillsDirEntries: [],
    legacyDirEntries: ['access-to-csharp'],
    legacyMarkers: { 'access-to-csharp': buildLegacyMarker() },
  });

  const result = await reconcileMachineWithDeps(baseCtx(), deps);

  assert.deepEqual(result.installed, ['access-migration/access-to-csharp']);
  assert.ok(result.removed.includes('legacy:access-migration/access-to-csharp'));
  assert.equal(state.legacyDirEntries.has('access-to-csharp'), false);
});

test('T4 移行成功（present 経路）: fast path で present になった skill も marker 検証済み扱いで legacy を回収する', async () => {
  const { deps, state } = makeFakeDeps({
    jsonFiles: baseJsonFiles(),
    pluginSkillDirs: { [skillsRootDir('access-migration')]: ['access-to-csharp'] },
    skillsDirEntries: ['access-to-csharp'],
    markers: { 'access-to-csharp': buildMarker({ sourceCommit: 'abc123' }) },
    legacyDirEntries: ['access-to-csharp'],
    legacyMarkers: { 'access-to-csharp': buildLegacyMarker() },
  });

  const result = await reconcileMachineWithDeps(baseCtx(), deps);

  assert.deepEqual(result.present, ['access-migration/access-to-csharp']);
  assert.ok(result.removed.includes('legacy:access-migration/access-to-csharp'));
  assert.equal(state.legacyDirEntries.has('access-to-csharp'), false);
});

test('T5a 移行失敗ゲート: 新配布先への install が失敗 → legacy を削除しない', async () => {
  const { deps, state } = makeFakeDeps({
    jsonFiles: baseJsonFiles(),
    pluginSkillDirs: { [skillsRootDir('access-migration')]: ['access-to-csharp'] },
    skillsDirEntries: [],
    copyTreeResult: () => ({ ok: false, reason: 'too-large' }),
    legacyDirEntries: ['access-to-csharp'],
    legacyMarkers: { 'access-to-csharp': buildLegacyMarker() },
  });

  const result = await reconcileMachineWithDeps(baseCtx(), deps);

  assert.deepEqual(result.failed, [{ id: 'access-migration/access-to-csharp', reason: 'skill-too-large' }]);
  assert.equal(state.legacyDirEntries.has('access-to-csharp'), true);
  assert.equal('removed' in result, false);
});

test('T5b 移行失敗ゲート: marker 再読込検証がNG → legacy を削除しない（install 自体は installed に積まれる）', async () => {
  const { deps, state } = makeFakeDeps({
    jsonFiles: baseJsonFiles(),
    pluginSkillDirs: { [skillsRootDir('access-migration')]: ['access-to-csharp'] },
    skillsDirEntries: [],
    forceInvalidMarkerFor: new Set(['access-to-csharp']),
    legacyDirEntries: ['access-to-csharp'],
    legacyMarkers: { 'access-to-csharp': buildLegacyMarker() },
  });

  const result = await reconcileMachineWithDeps(baseCtx(), deps);

  assert.deepEqual(result.installed, ['access-migration/access-to-csharp']);
  assert.equal(state.legacyDirEntries.has('access-to-csharp'), true);
});

test('legacy dir 解決失敗（ok:false）→ 新配布先の reconcile には影響せず、migration は単に no-op', async () => {
  const { deps } = makeFakeDeps({
    jsonFiles: baseJsonFiles(),
    pluginSkillDirs: { [skillsRootDir('access-migration')]: ['access-to-csharp'] },
    skillsDirEntries: [],
    legacyDirResult: { ok: false, reason: 'home-missing' },
  });

  const result = await reconcileMachineWithDeps(baseCtx(), deps);

  assert.deepEqual(result.installed, ['access-migration/access-to-csharp']);
  assert.equal('removed' in result, false);
});

test('legacy に desired から外れた skill がある（config から外れた/別 skill 名）→ canRemove:true なら回収する', async () => {
  const { deps, state } = makeFakeDeps({
    jsonFiles: baseJsonFiles(),
    pluginSkillDirs: { [skillsRootDir('access-migration')]: ['access-to-csharp'] },
    skillsDirEntries: ['access-to-csharp'],
    markers: { 'access-to-csharp': buildMarker({ sourceCommit: 'abc123' }) },
    legacyDirEntries: ['orphan-legacy-skill'],
    legacyMarkers: { 'orphan-legacy-skill': buildLegacyMarker({ pluginId: 'old-plugin', skillName: 'orphan-legacy-skill' }) },
  });

  const result = await reconcileMachineWithDeps(baseCtx(), deps);

  assert.ok(result.removed.includes('legacy:old-plugin/orphan-legacy-skill'));
  assert.equal(state.legacyDirEntries.has('orphan-legacy-skill'), false);
});

// -----------------------------------------------------------------------------
// T8: item id の二重サフィックス防御（Agent 側最終防波堤）
// -----------------------------------------------------------------------------

test('T8 二重サフィックス防御: item id が "id@marketplaceName" 形式でも1回だけ剥がして処理する', async () => {
  const { deps } = makeFakeDeps({
    jsonFiles: baseJsonFiles(),
    pluginSkillDirs: { [skillsRootDir('access-migration')]: ['access-to-csharp'] },
    skillsDirEntries: ['access-to-csharp'],
    markers: { 'access-to-csharp': buildMarker({ sourceCommit: 'abc123' }) },
  });
  const ctx = baseCtx({ items: [{ provider: 'agent-skills', kind: 'standard', id: 'access-migration@devrelay' }] });

  const result = await reconcileMachineWithDeps(ctx, deps);

  assert.deepEqual(result.present, ['access-migration/access-to-csharp']);
});

// -----------------------------------------------------------------------------
// reconcileProjectWithDeps（v1 は project/prelaunch 未対応）
// -----------------------------------------------------------------------------

test('reconcileProjectWithDeps は常に空結果を返し、deps を一切呼ばない', async () => {
  const { deps, calls } = makeFakeDeps({});
  const result = await reconcileProjectWithDeps(baseCtx(), '/some/project', deps);

  assert.deepEqual(result, {
    provider: 'agent-skills', kind: 'standard', runtimeVersion: null,
    installed: [], updated: [], present: [], failed: [], notAllowed: [],
  });
  assert.equal(calls.resolveDevinPath, 0);
  assert.equal(calls.git.length, 0);
  assert.equal(calls.listDirNames.length, 0);
});

// -----------------------------------------------------------------------------
// hasManagedStateWithDeps（D4: 新配布先 or legacy のどちらかにあれば true）
// -----------------------------------------------------------------------------

test('hasManagedStateWithDeps: 新配布先に managed skill が1件でもあれば true', async () => {
  const { deps } = makeFakeDeps({
    skillsDirEntries: ['access-to-csharp'],
    markers: { 'access-to-csharp': buildMarker() },
  });
  assert.equal(await hasManagedStateWithDeps(deps), true);
});

test('hasManagedStateWithDeps: legacy のみに managed skill があっても true（回帰テスト: D4）', async () => {
  const { deps } = makeFakeDeps({
    legacyDirEntries: ['access-to-csharp'],
    legacyMarkers: { 'access-to-csharp': buildLegacyMarker() },
  });
  assert.equal(await hasManagedStateWithDeps(deps), true);
});

test('hasManagedStateWithDeps: managed skill が無ければ false（unmanaged のみでも false）', async () => {
  const { deps } = makeFakeDeps({
    skillsDirEntries: ['my-own-skill'],
    legacyDirEntries: ['legacy-unmanaged'],
  });
  assert.equal(await hasManagedStateWithDeps(deps), false);
});

test('hasManagedStateWithDeps: skillsDir 解決失敗でも legacy に managed があれば true', async () => {
  const { deps } = makeFakeDeps({
    skillsDirResult: { ok: false, reason: 'home-missing' },
    legacyDirEntries: ['access-to-csharp'],
    legacyMarkers: { 'access-to-csharp': buildLegacyMarker() },
  });
  assert.equal(await hasManagedStateWithDeps(deps), true);
});

test('hasManagedStateWithDeps: 両方 throw しても fail-closed で false', async () => {
  const { deps } = makeFakeDeps({ throwOnResolveSkillsDir: true, throwOnResolveLegacySkillsDir: true });
  assert.equal(await hasManagedStateWithDeps(deps), false);
});

// -----------------------------------------------------------------------------
// runtimeVersion / 診断（§5-6: 配布判断には非関与、items 空ではスキップ）
// -----------------------------------------------------------------------------

test('runtimeVersion: active 経路では呼び出しごとに resolveRuntimeVersion/hasAiTool が呼ばれ、診断文字列が入る', async () => {
  const { deps, calls } = makeFakeDeps({
    jsonFiles: baseJsonFiles(),
    pluginSkillDirs: { [skillsRootDir('access-migration')]: ['access-to-csharp'] },
    skillsDirEntries: ['access-to-csharp'],
    markers: { 'access-to-csharp': buildMarker({ sourceCommit: 'abc123' }) },
    aiTools: { codex: {} },
  });

  const result1 = await reconcileMachineWithDeps(baseCtx(), deps);
  await reconcileMachineWithDeps(baseCtx(), deps);

  assert.equal(calls.resolveRuntimeVersion, 2);
  assert.equal(calls.hasAiTool.filter((n) => n === 'codex').length, 2);
  assert.match(result1.runtimeVersion, /Devin/);
  assert.match(result1.runtimeVersion, /Codex/);
});

test('items:[] cleanup-only 経路では診断を計算しない（runtimeVersion は null のまま、無駄な spawn をしない）', async () => {
  const { deps, calls } = makeFakeDeps({ skillsDirEntries: [] });
  const result = await reconcileMachineWithDeps(baseCtx({ items: [] }), deps);
  assert.equal(result.runtimeVersion, null);
  assert.equal(calls.resolveDevinPath, 0);
  assert.equal(calls.resolveRuntimeVersion, 0);
  assert.equal(calls.hasAiTool.length, 0);
});
