// サイクルP3-A: devin-skill-rules.ts（外部 import ゼロの純粋関数群）の単体テスト。
// コンパイル済み dist から直接 import する。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SKILL_TREE_MAX_BYTES,
  SKILL_TREE_MAX_FILES,
  SKILL_TREE_MAX_DEPTH,
  resolveDevinSkillsDirPath,
  resolveGitCloneUrl,
  isSafeRelativePath,
  resolvePluginSourceRelPath,
  isSafeSkillDirName,
  sanitizeMarketplaceDirName,
  allocateGitTimeoutMs,
  parseMarketplaceManifest,
  parsePluginManifest,
  resolveDesiredPluginVersion,
  isOwnedMarker,
  buildSkillMarker,
  decideSkillActionFast,
  decideSkillActionSlow,
  buildDesiredSkillPlan,
  decideRemovals,
  canPerformRemoval,
  resolveFailureIds,
} from '../dist/services/capabilities/devin-skill-rules.js';

// ---- 安全上限の定数 ----

test('安全上限の定数: v1 暫定値', () => {
  assert.equal(SKILL_TREE_MAX_BYTES, 20 * 1024 * 1024);
  assert.equal(SKILL_TREE_MAX_FILES, 500);
  assert.equal(SKILL_TREE_MAX_DEPTH, 16);
});

// ---- resolveDevinSkillsDirPath ----

test('resolveDevinSkillsDirPath: env override 絶対パス(win32) は最優先', () => {
  const r = resolveDevinSkillsDirPath({ platform: 'win32', env: { DEVRELAY_DEVIN_SKILLS_DIR: 'D:\\custom\\skills' }, homeDir: 'C:\\Users\\x' });
  assert.deepEqual(r, { ok: true, dir: 'D:\\custom\\skills', source: 'env-override' });
});

test('resolveDevinSkillsDirPath: env override 絶対パス(posix) は最優先', () => {
  const r = resolveDevinSkillsDirPath({ platform: 'linux', env: { DEVRELAY_DEVIN_SKILLS_DIR: '/opt/custom-skills' }, homeDir: '/home/x' });
  assert.deepEqual(r, { ok: true, dir: '/opt/custom-skills', source: 'env-override' });
});

test('resolveDevinSkillsDirPath: env override が相対パスなら ok:false（黙って無視しない）', () => {
  const r = resolveDevinSkillsDirPath({ platform: 'linux', env: { DEVRELAY_DEVIN_SKILLS_DIR: 'relative/skills' }, homeDir: '/home/x' });
  assert.deepEqual(r, { ok: false, reason: 'override-not-absolute' });
});

test('resolveDevinSkillsDirPath: win32 で APPDATA 設定済みならそれを使う', () => {
  const r = resolveDevinSkillsDirPath({ platform: 'win32', env: { APPDATA: 'C:\\Users\\x\\AppData\\Roaming' }, homeDir: 'C:\\Users\\x' });
  assert.deepEqual(r, { ok: true, dir: 'C:\\Users\\x\\AppData\\Roaming\\devin\\skills', source: 'appdata' });
});

test('resolveDevinSkillsDirPath: win32 で APPDATA 未設定なら home から組み立てる', () => {
  const r = resolveDevinSkillsDirPath({ platform: 'win32', env: {}, homeDir: 'C:\\Users\\x' });
  assert.deepEqual(r, { ok: true, dir: 'C:\\Users\\x\\AppData\\Roaming\\devin\\skills', source: 'appdata' });
});

test('resolveDevinSkillsDirPath: win32 で APPDATA も home も無ければ home-missing', () => {
  const r = resolveDevinSkillsDirPath({ platform: 'win32', env: {}, homeDir: '' });
  assert.deepEqual(r, { ok: false, reason: 'home-missing' });
});

test('resolveDevinSkillsDirPath: posix で XDG_CONFIG_HOME 絶対パスならそれを使う', () => {
  const r = resolveDevinSkillsDirPath({ platform: 'linux', env: { XDG_CONFIG_HOME: '/home/x/.myconfig' }, homeDir: '/home/x' });
  assert.deepEqual(r, { ok: true, dir: '/home/x/.myconfig/devin/skills', source: 'xdg' });
});

test('resolveDevinSkillsDirPath: posix で XDG_CONFIG_HOME が相対なら無視し home-default', () => {
  const r = resolveDevinSkillsDirPath({ platform: 'darwin', env: { XDG_CONFIG_HOME: 'relative' }, homeDir: '/Users/x' });
  assert.deepEqual(r, { ok: true, dir: '/Users/x/.config/devin/skills', source: 'home-default' });
});

test('resolveDevinSkillsDirPath: posix で XDG 未設定なら ~/.config/devin/skills', () => {
  const r = resolveDevinSkillsDirPath({ platform: 'linux', env: {}, homeDir: '/home/x' });
  assert.deepEqual(r, { ok: true, dir: '/home/x/.config/devin/skills', source: 'home-default' });
});

test('resolveDevinSkillsDirPath: posix で home も無ければ home-missing', () => {
  const r = resolveDevinSkillsDirPath({ platform: 'linux', env: {}, homeDir: '' });
  assert.deepEqual(r, { ok: false, reason: 'home-missing' });
});

// ---- resolveGitCloneUrl ----

test('resolveGitCloneUrl: owner/repo 形式を https URL に変換する', () => {
  assert.deepEqual(resolveGitCloneUrl('murata1215/devrelay-plugins'), { ok: true, url: 'https://github.com/murata1215/devrelay-plugins.git' });
});

test('resolveGitCloneUrl: https://github.com/... はそのまま許可', () => {
  const url = 'https://github.com/murata1215/devrelay-plugins';
  assert.deepEqual(resolveGitCloneUrl(url), { ok: true, url });
});

test('resolveGitCloneUrl: git@ 形式は拒否', () => {
  assert.deepEqual(resolveGitCloneUrl('git@github.com:murata1215/devrelay-plugins.git'), { ok: false, reason: 'unsupported-source-format' });
});

test('resolveGitCloneUrl: ssh:// 形式は拒否', () => {
  assert.deepEqual(resolveGitCloneUrl('ssh://git@github.com/x/y.git'), { ok: false, reason: 'unsupported-source-format' });
});

test('resolveGitCloneUrl: `-` 始まりは拒否（argv オプション化対策）', () => {
  assert.deepEqual(resolveGitCloneUrl('-x/y'), { ok: false, reason: 'unsupported-source-format' });
});

test('resolveGitCloneUrl: `..` を含む文字列は拒否', () => {
  assert.deepEqual(resolveGitCloneUrl('../etc/passwd'), { ok: false, reason: 'unsupported-source-format' });
});

// ---- isSafeRelativePath / resolvePluginSourceRelPath ----

test('isSafeRelativePath: 通常の相対パスは true', () => {
  assert.equal(isSafeRelativePath('plugins/access-migration'), true);
});

test('isSafeRelativePath: `..` を含むと false', () => {
  assert.equal(isSafeRelativePath('plugins/../../etc/passwd'), false);
});

test('isSafeRelativePath: 絶対パス(POSIX)は false', () => {
  assert.equal(isSafeRelativePath('/etc/passwd'), false);
});

test('isSafeRelativePath: 絶対パス(Windows ドライブレター)は false', () => {
  assert.equal(isSafeRelativePath('C:/Users/x'), false);
});

test('resolvePluginSourceRelPath: `./plugins/x` は先頭の ./ を除去して受理', () => {
  assert.deepEqual(resolvePluginSourceRelPath('./plugins/access-migration'), { ok: true, relPath: 'plugins/access-migration' });
});

test('resolvePluginSourceRelPath: 危険なパスは拒否', () => {
  assert.deepEqual(resolvePluginSourceRelPath('../../etc'), { ok: false, reason: 'unsafe-path' });
});

// ---- isSafeSkillDirName ----

test('isSafeSkillDirName: 通常名は true', () => {
  assert.equal(isSafeSkillDirName('access-to-csharp'), true);
});

test('isSafeSkillDirName: `..` は false', () => {
  assert.equal(isSafeSkillDirName('..'), false);
});

test('isSafeSkillDirName: `/` を含むと false', () => {
  assert.equal(isSafeSkillDirName('a/b'), false);
});

test('isSafeSkillDirName: Windows 予約名は false', () => {
  assert.equal(isSafeSkillDirName('CON'), false);
  assert.equal(isSafeSkillDirName('con.txt'), false);
});

test('isSafeSkillDirName: 末尾ドットは false', () => {
  assert.equal(isSafeSkillDirName('foo.'), false);
});

test('isSafeSkillDirName: 64 文字超は false', () => {
  assert.equal(isSafeSkillDirName('a'.repeat(65)), false);
  assert.equal(isSafeSkillDirName('a'.repeat(64)), true);
});

// ---- sanitizeMarketplaceDirName ----

test('sanitizeMarketplaceDirName: 安全な文字だけに変換する', () => {
  assert.equal(sanitizeMarketplaceDirName('devrelay plugins!!'), 'devrelay_plugins__');
});

// ---- allocateGitTimeoutMs ----

test('allocateGitTimeoutMs: 予定呼び出し数で均等割りする', () => {
  assert.equal(allocateGitTimeoutMs(90_000, 3), 30_000);
});

test('allocateGitTimeoutMs: 予定呼び出し0件なら0', () => {
  assert.equal(allocateGitTimeoutMs(90_000, 0), 0);
});

test('allocateGitTimeoutMs: 最低1秒は保証する', () => {
  assert.equal(allocateGitTimeoutMs(1000, 10), 1000);
});

// ---- parseMarketplaceManifest / parsePluginManifest ----

test('parseMarketplaceManifest: 正しい形は配列を返す', () => {
  const m = parseMarketplaceManifest({ name: 'devrelay', plugins: [{ name: 'access-migration', source: './plugins/access-migration' }] });
  assert.deepEqual(m, { name: 'devrelay', plugins: [{ name: 'access-migration', source: './plugins/access-migration', version: null }] });
});

test('parseMarketplaceManifest: 壊れた形は null', () => {
  assert.equal(parseMarketplaceManifest({ foo: 1 }), null);
  assert.equal(parseMarketplaceManifest(null), null);
  assert.equal(parseMarketplaceManifest('not an object'), null);
});

test('parsePluginManifest: 正しい形を返す', () => {
  assert.deepEqual(parsePluginManifest({ name: 'access-migration', version: '0.1.0' }), { name: 'access-migration', version: '0.1.0' });
});

test('parsePluginManifest: name が無ければ null', () => {
  assert.equal(parsePluginManifest({ version: '0.1.0' }), null);
});

test('resolveDesiredPluginVersion: plugin.json 優先、無ければ marketplace entry', () => {
  assert.equal(resolveDesiredPluginVersion('0.2.0', '0.1.0'), '0.2.0');
  assert.equal(resolveDesiredPluginVersion(null, '0.1.0'), '0.1.0');
  assert.equal(resolveDesiredPluginVersion(null, null), null);
});

// ---- isOwnedMarker ----

test('isOwnedMarker: 正しい marker は true', () => {
  assert.equal(isOwnedMarker({ schema: 1, managedBy: 'devrelay', provider: 'devin', kind: 'skill', skillName: 'x' }), true);
});

test('isOwnedMarker: marketplaceName は所有権の条件に含まれない（別索引でも回収できる）', () => {
  assert.equal(isOwnedMarker({ schema: 1, managedBy: 'devrelay', provider: 'devin', kind: 'skill', skillName: 'x', marketplaceName: 'other' }), true);
});

test('isOwnedMarker: provider/kind が違えば false', () => {
  assert.equal(isOwnedMarker({ schema: 1, managedBy: 'devrelay', provider: 'claude', kind: 'skill', skillName: 'x' }), false);
  assert.equal(isOwnedMarker({ schema: 1, managedBy: 'devrelay', provider: 'devin', kind: 'plugin', skillName: 'x' }), false);
});

test('isOwnedMarker: 不正な形（null/文字列/空オブジェクト）は false', () => {
  assert.equal(isOwnedMarker(null), false);
  assert.equal(isOwnedMarker('x'), false);
  assert.equal(isOwnedMarker({}), false);
});

test('buildSkillMarker: 入力どおりに組み立てる', () => {
  const m = buildSkillMarker({
    marketplaceName: 'devrelay', marketplaceSource: 'x/y', pluginId: 'access-migration',
    pluginVersion: '0.1.0', skillName: 'access-to-csharp', sourceCommit: 'abc', contentHash: 'sha256:def', nowIso: '2026-09-15T00:00:00.000Z',
  });
  assert.equal(m.schema, 1);
  assert.equal(m.managedBy, 'devrelay');
  assert.equal(m.provider, 'devin');
  assert.equal(m.kind, 'skill');
  assert.equal(m.skillName, 'access-to-csharp');
  assert.equal(isOwnedMarker(m), true);
});

// ---- decideSkillActionFast / decideSkillActionSlow ----

test('decideSkillActionFast: 宛先が無ければ install', () => {
  assert.equal(decideSkillActionFast(false, null, 'abc'), 'install');
});

test('decideSkillActionFast: 宛先はあるが marker 無し/非所有 → conflict-unmanaged', () => {
  assert.equal(decideSkillActionFast(true, null, 'abc'), 'conflict-unmanaged');
});

test('decideSkillActionFast: sourceCommit 一致で present（fast path）', () => {
  const marker = { schema: 1, managedBy: 'devrelay', provider: 'devin', kind: 'skill', skillName: 'x', sourceCommit: 'abc' };
  assert.equal(decideSkillActionFast(true, marker, 'abc'), 'present');
});

test('decideSkillActionFast: sourceCommit 不一致なら needs-comparison', () => {
  const marker = { schema: 1, managedBy: 'devrelay', provider: 'devin', kind: 'skill', skillName: 'x', sourceCommit: 'old' };
  assert.equal(decideSkillActionFast(true, marker, 'new'), 'needs-comparison');
});

test('decideSkillActionSlow: version が両方non-nullで異なれば update', () => {
  assert.equal(decideSkillActionSlow('0.1.0', '0.2.0', 'sha:a', 'sha:a'), 'update');
});

test('decideSkillActionSlow: version で決まらず hash が異なれば update', () => {
  assert.equal(decideSkillActionSlow(null, null, 'sha:old', 'sha:new'), 'update');
});

test('decideSkillActionSlow: 内容同一だが commit だけ違う → refresh-marker', () => {
  assert.equal(decideSkillActionSlow('0.1.0', '0.1.0', 'sha:a', 'sha:a'), 'refresh-marker');
});

// ---- buildDesiredSkillPlan ----

test('buildDesiredSkillPlan: 索引に無い plugin id は notAllowed', () => {
  const r = buildDesiredSkillPlan([{ pluginId: 'unknown', manifestEntry: null, pluginJsonVersion: null, skillDirNames: [] }]);
  assert.deepEqual(r.notAllowed, ['unknown']);
  assert.deepEqual(r.desired, []);
});

test('buildDesiredSkillPlan: skills/ が無い plugin は present(no-skills)', () => {
  const r = buildDesiredSkillPlan([
    { pluginId: 'access-migration', manifestEntry: { name: 'access-migration', source: './plugins/access-migration', version: '0.1.0' }, pluginJsonVersion: null, skillDirNames: [] },
  ]);
  assert.deepEqual(r.noSkillsPresent, ['access-migration:no-skills']);
});

test('buildDesiredSkillPlan: 通常ケースは pluginId/skillName 形式で desired に積む', () => {
  const r = buildDesiredSkillPlan([
    { pluginId: 'access-migration', manifestEntry: { name: 'access-migration', source: './plugins/access-migration', version: '0.1.0' }, pluginJsonVersion: '0.1.0', skillDirNames: ['access-to-csharp', 'access-export-reading'] },
  ]);
  assert.deepEqual(r.desired.map((d) => d.resultId), ['access-migration/access-to-csharp', 'access-migration/access-export-reading']);
  assert.equal(r.desired[0].desiredVersion, '0.1.0');
});

test('buildDesiredSkillPlan: 同名衝突は先着優先にせず両方 failed に積む', () => {
  const r = buildDesiredSkillPlan([
    { pluginId: 'plugin-a', manifestEntry: { name: 'plugin-a', source: './plugins/plugin-a', version: null }, pluginJsonVersion: null, skillDirNames: ['shared-skill'] },
    { pluginId: 'plugin-b', manifestEntry: { name: 'plugin-b', source: './plugins/plugin-b', version: null }, pluginJsonVersion: null, skillDirNames: ['shared-skill'] },
  ]);
  assert.deepEqual(r.desired, []);
  const reasons = r.failed.map((f) => f.reason);
  assert.deepEqual(reasons, ['skill-name-conflict', 'skill-name-conflict']);
  assert.deepEqual(r.failed.map((f) => f.id).sort(), ['plugin-a/shared-skill', 'plugin-b/shared-skill']);
});

test('buildDesiredSkillPlan: 安全でない skill 名は failed(unsafe-skill-name)', () => {
  const r = buildDesiredSkillPlan([
    { pluginId: 'access-migration', manifestEntry: { name: 'access-migration', source: './plugins/access-migration', version: null }, pluginJsonVersion: null, skillDirNames: ['..'] },
  ]);
  assert.deepEqual(r.failed, [{ id: 'access-migration/..', reason: 'unsafe-skill-name' }]);
  assert.deepEqual(r.desired, []);
});

test('buildDesiredSkillPlan: 順序は入力順で安定する', () => {
  const r1 = buildDesiredSkillPlan([
    { pluginId: 'a', manifestEntry: { name: 'a', source: './plugins/a', version: null }, pluginJsonVersion: null, skillDirNames: ['s1'] },
    { pluginId: 'b', manifestEntry: { name: 'b', source: './plugins/b', version: null }, pluginJsonVersion: null, skillDirNames: ['s2'] },
  ]);
  const r2 = buildDesiredSkillPlan([
    { pluginId: 'a', manifestEntry: { name: 'a', source: './plugins/a', version: null }, pluginJsonVersion: null, skillDirNames: ['s1'] },
    { pluginId: 'b', manifestEntry: { name: 'b', source: './plugins/b', version: null }, pluginJsonVersion: null, skillDirNames: ['s2'] },
  ]);
  assert.deepEqual(r1.desired.map((d) => d.resultId), r2.desired.map((d) => d.resultId));
  assert.deepEqual(r1.desired.map((d) => d.resultId), ['a/s1', 'b/s2']);
});

// ---- decideRemovals ----

test('decideRemovals: desired に無い managed 名だけを返す', () => {
  assert.deepEqual(decideRemovals(['a', 'b', 'c'], ['b']), ['a', 'c']);
});

test('decideRemovals: 全て desired に含まれれば空配列', () => {
  assert.deepEqual(decideRemovals(['a', 'b'], ['a', 'b']), []);
});

// ---- canPerformRemoval ----

test('canPerformRemoval: ok / skipped-empty-items のみ true', () => {
  assert.equal(canPerformRemoval('ok'), true);
  assert.equal(canPerformRemoval('skipped-empty-items'), true);
  assert.equal(canPerformRemoval('clone-failed'), false);
  assert.equal(canPerformRemoval('manifest-invalid'), false);
  assert.equal(canPerformRemoval('devin-not-found'), false);
  assert.equal(canPerformRemoval('git-not-found'), false);
});

// ---- resolveFailureIds ----

test('resolveFailureIds: items があればそのまま返す', () => {
  assert.deepEqual(resolveFailureIds(['a', 'b'], 'fallback'), ['a', 'b']);
});

test('resolveFailureIds: items が空なら fallback 1件', () => {
  assert.deepEqual(resolveFailureIds([], 'fallback'), ['fallback']);
});
