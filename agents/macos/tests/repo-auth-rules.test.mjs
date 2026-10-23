// 会社 private リポジトリ clone 対応サイクル: agents/linux/src/services/repo-auth-rules.ts の単体テスト。
// 外部 import ゼロの純粋関数をコンパイル済み dist から直接 import する（update-guard-rules.test.mjs と同じ流儀）。
// PAT は実値を書かず、ダミー文字列のみを使う。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_AGENT_REPO_URL,
  buildExtraHeaderConfigKey,
  buildBasicAuthHeaderValue,
  GIT_NONINTERACTIVE_ENV,
  classifyGitRemoteFailure,
  buildRepoAuthFailureMessage,
  redactSecrets,
} from '../dist/services/repo-auth-rules.js';

test('DEFAULT_AGENT_REPO_URL は public murata1215/devrelay', () => {
  assert.equal(DEFAULT_AGENT_REPO_URL, 'https://github.com/murata1215/devrelay.git');
});

test('buildExtraHeaderConfigKey: .git 付き URL はそのまま key 化される', () => {
  assert.equal(
    buildExtraHeaderConfigKey('https://github.com/tisa-devin/devrelay.git'),
    'http.https://github.com/tisa-devin/devrelay.git.extraHeader'
  );
});

test('buildExtraHeaderConfigKey: .git なし URL は補わない（呼び出し側が渡した文字列をそのまま使う）', () => {
  assert.equal(
    buildExtraHeaderConfigKey('https://github.com/tisa-devin/devrelay'),
    'http.https://github.com/tisa-devin/devrelay.extraHeader'
  );
});

test('buildExtraHeaderConfigKey: 前後の空白は trim する', () => {
  assert.equal(
    buildExtraHeaderConfigKey('  https://github.com/tisa-devin/devrelay.git  '),
    'http.https://github.com/tisa-devin/devrelay.git.extraHeader'
  );
});

test('buildBasicAuthHeaderValue: x-access-token:PAT を base64 して Basic ヘッダにする', () => {
  const fakeBase64 = (s) => Buffer.from(s, 'utf-8').toString('base64');
  assert.equal(
    buildBasicAuthHeaderValue('ghp_dummyTokenForTestOnly', fakeBase64),
    `Authorization: Basic ${Buffer.from('x-access-token:ghp_dummyTokenForTestOnly', 'utf-8').toString('base64')}`
  );
});

test('GIT_NONINTERACTIVE_ENV: GIT_TERMINAL_PROMPT=0 と GCM_INTERACTIVE=never を持つ', () => {
  assert.equal(GIT_NONINTERACTIVE_ENV.GIT_TERMINAL_PROMPT, '0');
  assert.equal(GIT_NONINTERACTIVE_ENV.GCM_INTERACTIVE, 'never');
});

test('classifyGitRemoteFailure: 認証系メッセージは auth と判定する', () => {
  assert.equal(classifyGitRemoteFailure('fatal: Authentication failed for ...'), 'auth');
  assert.equal(classifyGitRemoteFailure('fatal: could not read Username for ...'), 'auth');
  assert.equal(classifyGitRemoteFailure('fatal: terminal prompts disabled'), 'auth');
  assert.equal(classifyGitRemoteFailure('remote: Repository not found.'), 'auth');
  assert.equal(classifyGitRemoteFailure('fatal: HTTP 403 Forbidden'), 'auth');
  assert.equal(classifyGitRemoteFailure('remote: Bad credentials'), 'auth');
});

test('classifyGitRemoteFailure: 大文字小文字を無視する', () => {
  assert.equal(classifyGitRemoteFailure('FATAL: AUTHENTICATION FAILED'), 'auth');
});

test('classifyGitRemoteFailure: ネットワーク系メッセージは network と判定する', () => {
  assert.equal(classifyGitRemoteFailure('fatal: unable to access: Could not resolve host: github.com'), 'network');
  assert.equal(classifyGitRemoteFailure('ssl certificate problem: unable to get local issuer certificate'), 'network');
});

test('classifyGitRemoteFailure: 不明なメッセージは other と判定する', () => {
  assert.equal(classifyGitRemoteFailure('fatal: something unexpected happened'), 'other');
  assert.equal(classifyGitRemoteFailure(''), 'other');
});

test('buildRepoAuthFailureMessage: auth は PAT 期限切れ・権限不足の案内文を返す', () => {
  const msg = buildRepoAuthFailureMessage('auth');
  assert.match(msg, /PAT/);
  assert.match(msg, /--repo-auth-only/);
});

test('buildRepoAuthFailureMessage: network/other も空文字ではない', () => {
  assert.ok(buildRepoAuthFailureMessage('network').length > 0);
  assert.ok(buildRepoAuthFailureMessage('other').length > 0);
});

test('redactSecrets: Authorization: Basic ヘッダを伏せ字にする', () => {
  const input = 'request failed, header was Authorization: Basic ZHVtbXlzZWNyZXQ= (rejected)';
  const out = redactSecrets(input);
  assert.ok(!out.includes('ZHVtbXlzZWNyZXQ='));
  assert.match(out, /Authorization: Basic \*\*\*/);
});

test('redactSecrets: URL 埋め込みの userinfo（ダミー PAT）を伏せ字にする', () => {
  const input = "fatal: unable to access 'https://x-access-token:dummyPatValueXYZ@github.com/org/repo.git/'";
  const out = redactSecrets(input);
  assert.ok(!out.includes('dummyPatValueXYZ'));
  assert.match(out, /https:\/\/\*\*\*@github\.com/);
});

test('redactSecrets: 秘密情報が無い文字列は変化しない', () => {
  const input = 'git fetch failed, aborting update (agent kept alive)';
  assert.equal(redactSecrets(input), input);
});
