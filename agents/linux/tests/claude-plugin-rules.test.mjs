// サイクルP1: Claude Code plugin capability の純粋ロジック（外部 import ゼロ）を
// コンパイル済み dist から直接 import する（running-code-stale.test.mjs と同じ流儀）。
// Step 0 実機確認（claude 2.1.263）: `plugin list --json` は `[]`（未インストール）、
// `plugin list`（テキスト）は "No plugins installed. ..."、
// `plugin marketplace list --json` は `[{name,source,repo,installLocation}]`。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePluginListJson,
  parsePluginListText,
  parsePluginList,
  extractEnabledPlugins,
  determinePluginScope,
  checkMarketplaceRegistration,
  findBlockedEntry,
  computeInstallDiff,
  resolveFailureIds,
  resolveInstallScope,
  evaluatePluginAtScope,
  isSatisfiedAtScope,
  parseMarketplaceListJson,
  evaluateMarketplaceList,
  isPluginNotInIndexError,
  PLUGIN_NOT_IN_INDEX_PATTERNS,
} from '../dist/services/capabilities/claude-plugin-rules.js';

// ---- parsePluginListJson ----

test('parsePluginListJson: 実機確認済みの空配列 "[]" を解析できる', () => {
  assert.deepEqual(parsePluginListJson('[]'), []);
});

test('parsePluginListJson: name を含むオブジェクト配列を解析できる', () => {
  const raw = JSON.stringify([{ name: 'commit-commands@devrelay', scope: 'user', version: '1.0.0', enabled: true }]);
  const result = parsePluginListJson(raw);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'commit-commands@devrelay');
  assert.equal(result[0].scope, 'user');
  assert.equal(result[0].enabled, true);
});

test('parsePluginListJson: 不正な JSON は null', () => {
  assert.equal(parsePluginListJson('not json'), null);
});

test('parsePluginListJson: 配列でない JSON は null', () => {
  assert.equal(parsePluginListJson('{}'), null);
});

test('parsePluginListJson: name が無い要素はスキップされる', () => {
  const raw = JSON.stringify([{ foo: 'bar' }, { name: 'x@devrelay' }]);
  const result = parsePluginListJson(raw);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'x@devrelay');
});

// サイクルP1.3 Step 0 実機確認: 実フィールドは `name` ではなく `id`（既存バグの是正）。
// `id` を正式値として `name` は後方互換のエイリアス（常に同値）として両方埋める。
test('parsePluginListJson: 実機の id フィールドを正しく解析し id/name 両方に同値を入れる（P1.3 実機バグ修正）', () => {
  const raw = JSON.stringify([
    { id: 'pr-review-toolkit@devrelay', version: '1.0.0', scope: 'project', enabled: true, projectPath: '/home/x/proj' },
  ]);
  const result = parsePluginListJson(raw);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'pr-review-toolkit@devrelay');
  assert.equal(result[0].name, 'pr-review-toolkit@devrelay');
  assert.equal(result[0].scope, 'project');
  assert.equal(result[0].enabled, true);
  assert.equal(result[0].projectPath, '/home/x/proj');
});

test('parsePluginListJson: id/name のどちらも無い要素はスキップされる', () => {
  const raw = JSON.stringify([{ foo: 'bar' }]);
  assert.deepEqual(parsePluginListJson(raw), []);
});

// ---- parsePluginListText ----

test('parsePluginListText: 実機確認済みの空状態メッセージは空配列', () => {
  const raw = 'No plugins installed. Use `claude plugin install` to install a plugin.';
  assert.deepEqual(parsePluginListText(raw), []);
});

test('parsePluginListText: name@marketplace パターンを含む行から抽出する', () => {
  const raw = '  ❯ commit-commands@devrelay (user)\n  ❯ unity@devrelay (project)';
  const result = parsePluginListText(raw);
  assert.equal(result.length, 2);
  assert.equal(result[0].name, 'commit-commands@devrelay');
  assert.equal(result[1].name, 'unity@devrelay');
});

test('parsePluginListText: 一致しない行は無視される（fail-open）', () => {
  const raw = 'some unrelated line\nanother line without at-sign';
  assert.deepEqual(parsePluginListText(raw), []);
});

// ---- parsePluginList（統合入口） ----

test('parsePluginList: jsonAttempted=true かつ有効な JSON ならそちらを使う', () => {
  const raw = JSON.stringify([{ name: 'x@devrelay' }]);
  const result = parsePluginList(raw, true);
  assert.equal(result.length, 1);
});

test('parsePluginList: jsonAttempted=true でも JSON が無効ならテキストへフォールバック', () => {
  const raw = 'No plugins installed. Use `claude plugin install` to install a plugin.';
  const result = parsePluginList(raw, true);
  assert.deepEqual(result, []);
});

test('parsePluginList: jsonAttempted=false なら最初からテキストパーサー', () => {
  const raw = '❯ a@devrelay';
  const result = parsePluginList(raw, false);
  assert.equal(result[0].name, 'a@devrelay');
});

// ---- extractEnabledPlugins ----

test('extractEnabledPlugins: enabledPlugins の boolean 値のみ抽出する', () => {
  const settings = { enabledPlugins: { 'unity@devrelay': true, 'x@devrelay': false, bad: 'not-bool' } };
  const result = extractEnabledPlugins(settings);
  assert.deepEqual(result, { 'unity@devrelay': true, 'x@devrelay': false });
});

test('extractEnabledPlugins: enabledPlugins が無ければ空オブジェクト', () => {
  assert.deepEqual(extractEnabledPlugins({}), {});
});

test('extractEnabledPlugins: settings が null/非オブジェクトなら空オブジェクト', () => {
  assert.deepEqual(extractEnabledPlugins(null), {});
  assert.deepEqual(extractEnabledPlugins('not-object'), {});
});

// ---- determinePluginScope ----

test('determinePluginScope: local にあれば local が最優先', () => {
  const maps = { user: { x: true }, project: { x: true }, local: { x: false } };
  assert.deepEqual(determinePluginScope('x', maps), { scope: 'local', enabled: false });
});

test('determinePluginScope: local に無ければ project', () => {
  const maps = { user: { x: true }, project: { x: false }, local: {} };
  assert.deepEqual(determinePluginScope('x', maps), { scope: 'project', enabled: false });
});

test('determinePluginScope: project にも無ければ user', () => {
  const maps = { user: { x: true }, project: {}, local: {} };
  assert.deepEqual(determinePluginScope('x', maps), { scope: 'user', enabled: true });
});

test('determinePluginScope: どこにも無ければ unknown', () => {
  const maps = { user: {}, project: {}, local: {} };
  assert.deepEqual(determinePluginScope('x', maps), { scope: 'unknown', enabled: false });
});

// ---- checkMarketplaceRegistration ----

test('checkMarketplaceRegistration: 実機確認済みの known_marketplaces.json 形と完全一致なら ok', () => {
  const known = { 'claude-plugins-official': { source: { repo: 'anthropics/claude-plugins-official' } } };
  const result = checkMarketplaceRegistration(known, 'claude-plugins-official', 'anthropics/claude-plugins-official');
  assert.equal(result, 'ok');
});

test('checkMarketplaceRegistration: marketplace 名が登録されていなければ not-registered', () => {
  const known = {};
  const result = checkMarketplaceRegistration(known, 'devrelay', 'murata1215/devrelay-plugins');
  assert.equal(result, 'not-registered');
});

test('checkMarketplaceRegistration: source が期待値と異なれば name-mismatch', () => {
  const known = { devrelay: { source: { repo: 'someone-else/devrelay-plugins' } } };
  const result = checkMarketplaceRegistration(known, 'devrelay', 'murata1215/devrelay-plugins');
  assert.equal(result, 'name-mismatch');
});

test('checkMarketplaceRegistration: source.url でも一致判定できる', () => {
  const known = { devrelay: { source: { url: 'https://example.com/devrelay-plugins.git' } } };
  const result = checkMarketplaceRegistration(known, 'devrelay', 'https://example.com/devrelay-plugins.git');
  assert.equal(result, 'ok');
});

// ---- findBlockedEntry ----

test('findBlockedEntry: id 一致でエントリを返す', () => {
  const blocklist = [{ id: 'bad@devrelay', reason: 'security' }];
  const entry = findBlockedEntry(blocklist, 'bad@devrelay');
  assert.deepEqual(entry, { id: 'bad@devrelay', reason: 'security' });
});

test('findBlockedEntry: name 一致でも見つかる', () => {
  const blocklist = [{ name: 'bad-plugin', reason: 'security' }];
  const entry = findBlockedEntry(blocklist, 'bad-plugin');
  assert.equal(entry.reason, 'security');
});

test('findBlockedEntry: 一致が無ければ null', () => {
  assert.equal(findBlockedEntry([], 'x@devrelay'), null);
});

// ---- computeInstallDiff ----

test('computeInstallDiff: scope 不明は toInstall（未インストール扱いに倒す）', () => {
  const maps = { user: {}, project: {}, local: {} };
  const result = computeInstallDiff(['unity@devrelay'], maps);
  assert.deepEqual(result, { toInstall: ['unity@devrelay'], alreadyEnabled: [], disabledNeedsEnable: [] });
});

test('computeInstallDiff: enabled:true は alreadyEnabled', () => {
  const maps = { user: { 'unity@devrelay': true }, project: {}, local: {} };
  const result = computeInstallDiff(['unity@devrelay'], maps);
  assert.deepEqual(result, { toInstall: [], alreadyEnabled: ['unity@devrelay'], disabledNeedsEnable: [] });
});

test('computeInstallDiff: enabled:false（scope 判明）は disabledNeedsEnable', () => {
  const maps = { user: { 'unity@devrelay': false }, project: {}, local: {} };
  const result = computeInstallDiff(['unity@devrelay'], maps);
  assert.deepEqual(result, { toInstall: [], alreadyEnabled: [], disabledNeedsEnable: ['unity@devrelay'] });
});

test('computeInstallDiff: 複数 id を混在して正しく分類する', () => {
  const maps = { user: { a: true, b: false }, project: {}, local: {} };
  const result = computeInstallDiff(['a', 'b', 'c'], maps);
  assert.deepEqual(result, { toInstall: ['c'], alreadyEnabled: ['a'], disabledNeedsEnable: ['b'] });
});

// ---- resolveFailureIds（サイクルP1.2: items 0 件でも失敗を無言にしない） ----

test('resolveFailureIds: items があればそのまま返す', () => {
  assert.deepEqual(resolveFailureIds(['a@devrelay', 'b@devrelay'], 'claude:plugin'), ['a@devrelay', 'b@devrelay']);
});

test('resolveFailureIds: items が空なら fallback id を 1 件返す', () => {
  assert.deepEqual(resolveFailureIds([], 'claude:plugin'), ['claude:plugin']);
});

test('resolveFailureIds: fallback は marketplace 名など任意の文字列でよい', () => {
  assert.deepEqual(resolveFailureIds([], 'marketplace:devrelay'), ['marketplace:devrelay']);
});

// ---- resolveInstallScope（サイクルP1.3 要件2） ----

test('resolveInstallScope: project にのみ宣言 → project', () => {
  assert.equal(resolveInstallScope('x@devrelay', { 'x@devrelay': true }, {}), 'project');
});

test('resolveInstallScope: local にのみ宣言 → local', () => {
  assert.equal(resolveInstallScope('x@devrelay', {}, { 'x@devrelay': true }), 'local');
});

test('resolveInstallScope: 両方に宣言 → project を優先（1回だけ install させるため）', () => {
  assert.equal(resolveInstallScope('x@devrelay', { 'x@devrelay': true }, { 'x@devrelay': true }), 'project');
});

test('resolveInstallScope: どちらにも無ければ null', () => {
  assert.equal(resolveInstallScope('x@devrelay', {}, {}), null);
});

// ---- evaluatePluginAtScope / isSatisfiedAtScope（サイクルP1.3 要件3: 実機の scope×projectPath cross-check） ----

test('evaluatePluginAtScope: id が list に無ければ not-installed', () => {
  const result = evaluatePluginAtScope([], 'x@devrelay', 'project', '/proj');
  assert.equal(result, 'not-installed');
});

test('evaluatePluginAtScope: scope が declared と一致し enabled:true なら satisfied', () => {
  const entries = [{ id: 'x@devrelay', name: 'x@devrelay', scope: 'project', enabled: true, projectPath: '/proj' }];
  assert.equal(evaluatePluginAtScope(entries, 'x@devrelay', 'project', '/proj'), 'satisfied');
});

test('evaluatePluginAtScope: scope が declared と異なれば wrong-scope（enabled:true でも）', () => {
  const entries = [{ id: 'x@devrelay', name: 'x@devrelay', scope: 'local', enabled: true, projectPath: '/proj' }];
  assert.equal(evaluatePluginAtScope(entries, 'x@devrelay', 'project', '/proj'), 'wrong-scope');
});

test('evaluatePluginAtScope: scope は一致するが projectPath が異なれば wrong-scope（実機再現ケース）', () => {
  const entries = [{ id: 'x@devrelay', name: 'x@devrelay', scope: 'project', enabled: true, projectPath: '/other-proj' }];
  assert.equal(evaluatePluginAtScope(entries, 'x@devrelay', 'project', '/proj'), 'wrong-scope');
});

test('evaluatePluginAtScope: scope 一致・projectPath 一致だが enabled:false なら disabled', () => {
  const entries = [{ id: 'x@devrelay', name: 'x@devrelay', scope: 'project', enabled: false, projectPath: '/proj' }];
  assert.equal(evaluatePluginAtScope(entries, 'x@devrelay', 'project', '/proj'), 'disabled');
});

test('evaluatePluginAtScope: scope 不明 + unknownScopePolicy=accept（既定）は enabled 値のみで判定', () => {
  const entries = [{ id: 'x@devrelay', name: 'x@devrelay', enabled: true }];
  assert.equal(evaluatePluginAtScope(entries, 'x@devrelay', 'project', '/proj', 'accept'), 'satisfied');
  assert.equal(evaluatePluginAtScope(entries, 'x@devrelay', 'project', '/proj'), 'satisfied');
});

test('evaluatePluginAtScope: scope 不明 + unknownScopePolicy=reject は常に wrong-scope', () => {
  const entries = [{ id: 'x@devrelay', name: 'x@devrelay', enabled: true }];
  assert.equal(evaluatePluginAtScope(entries, 'x@devrelay', 'project', '/proj', 'reject'), 'wrong-scope');
});

test('isSatisfiedAtScope: evaluatePluginAtScope の真偽値版（satisfied のときだけ true）', () => {
  const entries = [{ id: 'x@devrelay', name: 'x@devrelay', scope: 'project', enabled: true, projectPath: '/proj' }];
  assert.equal(isSatisfiedAtScope(entries, 'x@devrelay', 'project', '/proj'), true);
  assert.equal(isSatisfiedAtScope([], 'x@devrelay', 'project', '/proj'), false);
});

// ---- parseMarketplaceListJson / evaluateMarketplaceList（サイクルP1.3 要件5） ----

test('parseMarketplaceListJson: 実機確認済み形状 [{name,source,repo,installLocation}] を解析できる', () => {
  const raw = JSON.stringify([{ name: 'devrelay', source: 'github', repo: 'murata1215/devrelay-plugins', installLocation: '/x' }]);
  const result = parseMarketplaceListJson(raw);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'devrelay');
  assert.equal(result[0].source, 'github');
  assert.equal(result[0].repo, 'murata1215/devrelay-plugins');
});

test('parseMarketplaceListJson: 空配列 "[]" は空配列', () => {
  assert.deepEqual(parseMarketplaceListJson('[]'), []);
});

test('parseMarketplaceListJson: 非配列 JSON は null', () => {
  assert.equal(parseMarketplaceListJson('{}'), null);
});

test('parseMarketplaceListJson: 壊れた文字列は null', () => {
  assert.equal(parseMarketplaceListJson('not json'), null);
});

test('evaluateMarketplaceList: 登録済みなら registered', () => {
  const entries = [{ name: 'devrelay', repo: 'murata1215/devrelay-plugins' }];
  assert.equal(evaluateMarketplaceList(entries, 'devrelay', 'murata1215/devrelay-plugins'), 'registered');
});

test('evaluateMarketplaceList: 名前が見つからなければ not-registered', () => {
  assert.equal(evaluateMarketplaceList([], 'devrelay', 'murata1215/devrelay-plugins'), 'not-registered');
});

test('evaluateMarketplaceList: repo が期待値と異なれば name-mismatch', () => {
  const entries = [{ name: 'devrelay', repo: 'someone-else/devrelay-plugins' }];
  assert.equal(evaluateMarketplaceList(entries, 'devrelay', 'murata1215/devrelay-plugins'), 'name-mismatch');
});

test('evaluateMarketplaceList: entries が null（パース不能/CLI失敗）は unknown（fail-open）', () => {
  assert.equal(evaluateMarketplaceList(null, 'devrelay', 'murata1215/devrelay-plugins'), 'unknown');
});

// ---- isPluginNotInIndexError（サイクルP1.3 要件4） ----

test('isPluginNotInIndexError: 実機確認済み文言（stdout）を検知する', () => {
  const failure = { stdout: 'Plugin "definitely-does-not-exist" not found in marketplace "devrelay"', code: 1 };
  assert.equal(isPluginNotInIndexError(failure), true);
});

test('isPluginNotInIndexError: message に含まれていても検知する（大小文字無視）', () => {
  const failure = { message: 'PLUGIN "X" NOT FOUND IN MARKETPLACE "devrelay"', code: 1 };
  assert.equal(isPluginNotInIndexError(failure), true);
});

test('isPluginNotInIndexError: timeout kill（killed:true）は false', () => {
  const failure = { stdout: 'not found in marketplace', killed: true, code: null };
  assert.equal(isPluginNotInIndexError(failure), false);
});

test('isPluginNotInIndexError: spawn 失敗（code が文字列 ENOENT）は false', () => {
  const failure = { message: 'not found in marketplace', code: 'ENOENT' };
  assert.equal(isPluginNotInIndexError(failure), false);
});

test('isPluginNotInIndexError: 出力が空なら false', () => {
  assert.equal(isPluginNotInIndexError({ code: 1 }), false);
});

test('isPluginNotInIndexError: 分類外の一般的なエラーは false', () => {
  const failure = { message: 'network timeout', stderr: 'ETIMEDOUT', code: 1 };
  assert.equal(isPluginNotInIndexError(failure), false);
});

test('PLUGIN_NOT_IN_INDEX_PATTERNS: 実機確認済み文言が先頭に含まれる', () => {
  assert.ok(PLUGIN_NOT_IN_INDEX_PATTERNS.some(p => p.toLowerCase() === 'not found in marketplace'));
});
