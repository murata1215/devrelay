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
  readExtraHeaderFromGitConfig,
  upsertExtraHeaderInGitConfig,
  isSecureServerUrl,
  shouldRequestServerRepoAuth,
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

test('buildRepoAuthFailureMessage: serverDistributed:true のときは管理者への案内文になる', () => {
  const msg = buildRepoAuthFailureMessage('auth', { serverDistributed: true });
  assert.match(msg, /管理者/);
  assert.match(msg, /DEVRELAY_AGENT_REPO_TOKEN/);
  assert.ok(!msg.includes('--repo-auth-only'));
});

test('buildRepoAuthFailureMessage: serverDistributed 省略時は従来どおり --repo-auth-only の案内文', () => {
  const msg = buildRepoAuthFailureMessage('auth');
  assert.match(msg, /--repo-auth-only/);
});

test('buildRepoAuthFailureMessage: serverDistributed:false は従来どおり --repo-auth-only の案内文', () => {
  const msg = buildRepoAuthFailureMessage('auth', { serverDistributed: false });
  assert.match(msg, /--repo-auth-only/);
});

// =============================================================================
// 読取PATのサーバー配布サイクル: readExtraHeaderFromGitConfig / upsertExtraHeaderInGitConfig /
// isSecureServerUrl / shouldRequestServerRepoAuth
// =============================================================================

const DUMMY_REPO_URL = 'https://github.com/tisa-devin/devrelay.git';
const DUMMY_HEADER = 'Authorization: Basic ZHVtbXlzZWNyZXQ=';

test('readExtraHeaderFromGitConfig: セクションが無ければ null', () => {
  const configText = '[core]\n\trepositoryformatversion = 0\n';
  assert.equal(readExtraHeaderFromGitConfig(configText, DUMMY_REPO_URL), null);
});

test('readExtraHeaderFromGitConfig: 対象セクションの extraHeader を読み取る', () => {
  const configText = `[core]\n\trepositoryformatversion = 0\n[http "${DUMMY_REPO_URL}"]\n\textraHeader = ${DUMMY_HEADER}\n`;
  assert.equal(readExtraHeaderFromGitConfig(configText, DUMMY_REPO_URL), DUMMY_HEADER);
});

test('readExtraHeaderFromGitConfig: 他 URL のセクションとは混同しない', () => {
  const otherUrl = 'https://github.com/other/repo.git';
  const configText = `[http "${otherUrl}"]\n\textraHeader = ${DUMMY_HEADER}\n`;
  assert.equal(readExtraHeaderFromGitConfig(configText, DUMMY_REPO_URL), null);
});

test('readExtraHeaderFromGitConfig: 末尾 .git の有無で一致しない（完全一致制約）', () => {
  const configText = `[http "${DUMMY_REPO_URL}"]\n\textraHeader = ${DUMMY_HEADER}\n`;
  const withoutGit = DUMMY_REPO_URL.replace(/\.git$/, '');
  assert.equal(readExtraHeaderFromGitConfig(configText, withoutGit), null);
});

test('upsertExtraHeaderInGitConfig: 新規追加（既存セクション無し）', () => {
  const configText = '[core]\n\trepositoryformatversion = 0\n';
  const result = upsertExtraHeaderInGitConfig(configText, DUMMY_REPO_URL, DUMMY_HEADER);
  assert.equal(readExtraHeaderFromGitConfig(result, DUMMY_REPO_URL), DUMMY_HEADER);
  assert.match(result, /\[core\]/); // 既存セクションは保持される
});

test('upsertExtraHeaderInGitConfig: 既存セクションを冪等に置換する', () => {
  const configText = `[http "${DUMMY_REPO_URL}"]\n\textraHeader = Authorization: Basic old===\n`;
  const result = upsertExtraHeaderInGitConfig(configText, DUMMY_REPO_URL, DUMMY_HEADER);
  assert.equal(readExtraHeaderFromGitConfig(result, DUMMY_REPO_URL), DUMMY_HEADER);
  // 1回適用しても2回適用しても同じ結果になる（冪等性）
  const result2 = upsertExtraHeaderInGitConfig(result, DUMMY_REPO_URL, DUMMY_HEADER);
  assert.equal(result, result2);
});

test('upsertExtraHeaderInGitConfig: headerValue が null なら削除のみ（新セクション追加なし）', () => {
  const configText = `[http "${DUMMY_REPO_URL}"]\n\textraHeader = ${DUMMY_HEADER}\n`;
  const result = upsertExtraHeaderInGitConfig(configText, DUMMY_REPO_URL, null);
  assert.equal(readExtraHeaderFromGitConfig(result, DUMMY_REPO_URL), null);
  assert.ok(!result.includes('extraHeader'));
});

test('upsertExtraHeaderInGitConfig: 他セクションを保全する', () => {
  const configText = `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${DUMMY_REPO_URL}\n`;
  const result = upsertExtraHeaderInGitConfig(configText, DUMMY_REPO_URL, DUMMY_HEADER);
  assert.match(result, /\[core\]/);
  assert.match(result, /\[remote "origin"\]/);
  assert.match(result, new RegExp(`url = ${DUMMY_REPO_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
});

test('isSecureServerUrl: wss:// は true', () => {
  assert.equal(isSecureServerUrl('wss://devrelay.io/ws/agent'), true);
});

test('isSecureServerUrl: ws://localhost は true', () => {
  assert.equal(isSecureServerUrl('ws://localhost:3000/ws/agent'), true);
  assert.equal(isSecureServerUrl('ws://127.0.0.1:3000/ws/agent'), true);
});

test('isSecureServerUrl: ws://（非ローカル）は false', () => {
  assert.equal(isSecureServerUrl('ws://devrelay.example.com/ws/agent'), false);
});

test('isSecureServerUrl: http:// 等は false', () => {
  assert.equal(isSecureServerUrl('http://devrelay.io'), false);
});

test('shouldRequestServerRepoAuth: origin が公開既定 URL なら false（後方互換の要）', () => {
  assert.equal(
    shouldRequestServerRepoAuth({ originUrl: DEFAULT_AGENT_REPO_URL, serverUrl: 'wss://devrelay.io/ws/agent' }),
    false
  );
});

test('shouldRequestServerRepoAuth: private repo かつ wss:// なら true', () => {
  assert.equal(
    shouldRequestServerRepoAuth({ originUrl: DUMMY_REPO_URL, serverUrl: 'wss://devrelay.io/ws/agent' }),
    true
  );
});

test('shouldRequestServerRepoAuth: private repo でも serverUrl が非 HTTPS/WSS 相当なら false', () => {
  assert.equal(
    shouldRequestServerRepoAuth({ originUrl: DUMMY_REPO_URL, serverUrl: 'ws://devrelay.example.com/ws/agent' }),
    false
  );
});

test('shouldRequestServerRepoAuth: private repo かつローカル ws:// なら true', () => {
  assert.equal(
    shouldRequestServerRepoAuth({ originUrl: DUMMY_REPO_URL, serverUrl: 'ws://localhost:3000/ws/agent' }),
    true
  );
});
