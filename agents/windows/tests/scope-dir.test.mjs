// core#336: MCP submission 単位スコープディレクトリ解決（scope-dir.ts）の単体テスト。
// 外部 import ゼロではなく `path` に依存するモジュールだが、他の純粋関数テストと同じ流儀で
// コンパイル済み dist から直接 import する。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve, sep } from 'node:path';
import { isValidAgentScopeId, resolveScopeDir } from '../dist/services/scope-dir.js';

const PROJECT_PATH = '/tmp/devrelay-scope-dir-test-project';

// --- isValidAgentScopeId ---

test('isValidAgentScopeId: 英数字・アンダースコア・ハイフンのみ許可', () => {
  assert.equal(isValidAgentScopeId('abc123'), true);
  assert.equal(isValidAgentScopeId('abc_123-XYZ'), true);
});

test('isValidAgentScopeId: 空文字は不正', () => {
  assert.equal(isValidAgentScopeId(''), false);
});

test('isValidAgentScopeId: 129 文字は不正（上限 128）', () => {
  assert.equal(isValidAgentScopeId('a'.repeat(128)), true);
  assert.equal(isValidAgentScopeId('a'.repeat(129)), false);
});

test('isValidAgentScopeId: スラッシュ・ドットを含む文字列は不正', () => {
  assert.equal(isValidAgentScopeId('../etc/passwd'), false);
  assert.equal(isValidAgentScopeId('a/b'), false);
  assert.equal(isValidAgentScopeId('.'), false);
  assert.equal(isValidAgentScopeId('a.b'), false);
});

// --- resolveScopeDir ---

test('resolveScopeDir: agentScopeId 未指定はプロジェクト直下 .devrelay/ を返す（従来どおり）', () => {
  const dir = resolveScopeDir(PROJECT_PATH);
  assert.equal(dir, resolve(PROJECT_PATH, '.devrelay'));
});

test('resolveScopeDir: agentScopeId 指定時は .devrelay/sessions/<id>/ を返す', () => {
  const dir = resolveScopeDir(PROJECT_PATH, 'submission123');
  assert.equal(dir, resolve(PROJECT_PATH, '.devrelay', 'sessions', 'submission123'));
});

test('resolveScopeDir: 不正な agentScopeId（トラバーサル）は throw する', () => {
  assert.throws(() => resolveScopeDir(PROJECT_PATH, '../../../etc/passwd'));
});

test('resolveScopeDir: 不正な agentScopeId（スラッシュ混入）は throw する', () => {
  assert.throws(() => resolveScopeDir(PROJECT_PATH, 'a/b'));
});

test('resolveScopeDir: 不正な agentScopeId（空文字）は throw する', () => {
  assert.throws(() => resolveScopeDir(PROJECT_PATH, ''));
});

test('resolveScopeDir: 不正な agentScopeId（129文字）は throw する', () => {
  assert.throws(() => resolveScopeDir(PROJECT_PATH, 'a'.repeat(129)));
});

test('resolveScopeDir: 正常な agentScopeId（128文字）は throw しない', () => {
  assert.doesNotThrow(() => resolveScopeDir(PROJECT_PATH, 'a'.repeat(128)));
});

test('resolveScopeDir: プラットフォーム区切り文字（path.sep）非依存で scopedRoot 配下と判定できる', () => {
  const dir = resolveScopeDir(PROJECT_PATH, 'abc');
  assert.ok(dir.startsWith(join(PROJECT_PATH, '.devrelay', 'sessions') + sep));
});
