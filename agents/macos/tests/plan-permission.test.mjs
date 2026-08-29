// #332: plan モードの canUseTool 判定の単体テスト（macOS 版）。
// #333: strictReadonly の Bash 判定をセグメント分割＋トークン判定に変更したことに伴い拡張。
// linux 版（agents/linux/tests/plan-permission.test.mjs）と同一の 26+ ケースを、
// macOS 自己完結方針で複製した plan-permission.ts の dist に対して実行する（#333 でテストが
// 0 件だった穴を塞ぐ）。外部 import ゼロの純粋関数をコンパイル済み dist から直接 import する。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchesToolRule,
  isAllowedByRules,
  decidePlanPermission,
  matchesBashRuleByTokens,
  splitShellSegments,
  hasWriteRedirect,
  hasCommandSubstitution,
  tokenizeSegment,
} from '../dist/services/plan-permission.js';

const READONLY_TOOLS = ['Read', 'Glob', 'Grep', 'NotebookRead', 'Task', 'ToolSearch', 'TaskOutput', 'TaskStop', 'TodoWrite', 'WebFetch', 'WebSearch'];
const ALLOWED_TOOLS = ['Bash(git log *)', 'Bash(pnpm test)'];
const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

const READONLY_BASH_COMMANDS = [
  'ls', 'cat', 'head', 'tail', 'wc',
  'grep', 'egrep', 'fgrep', 'rg',
  'find', 'locate', 'which', 'file', 'stat',
  'sort', 'uniq', 'cut', 'tr', 'nl', 'column', 'diff', 'jq',
  'basename', 'dirname', 'realpath', 'readlink', 'pwd', 'cd',
  'date', 'whoami', 'id', 'hostname', 'uname', 'printenv',
  'df', 'du', 'free', 'uptime', 'ps', 'pgrep', 'lsof', 'ss', 'netstat',
  'dir', 'type', 'where',
];
const WRITE_BASH_COMMANDS = [
  'rm', 'mv', 'cp', 'touch', 'mkdir', 'rmdir', 'chmod', 'chown', 'chgrp',
  'ln', 'dd', 'truncate', 'tee', 'install', 'kill', 'pkill',
  'git add', 'git commit', 'git push', 'git checkout', 'git reset',
  'git rm', 'git mv', 'git clean', 'git merge', 'git rebase',
  'git cherry-pick', 'git stash',
  'pm2 restart', 'pm2 stop', 'pm2 delete', 'pm2 kill',
  'systemctl start', 'systemctl stop', 'systemctl restart',
  'systemctl enable', 'systemctl disable', 'systemctl mask',
  'docker run', 'docker rm', 'docker exec', 'docker stop', 'docker kill',
  'docker rmi', 'docker build',
  'npm install', 'npm i', 'npm build', 'npm add', 'npm uninstall',
  'npm remove', 'npm ci', 'npm update', 'npm publish',
  'pnpm install', 'pnpm add', 'pnpm build', 'pnpm remove',
  'pnpm update', 'pnpm publish',
  'yarn install', 'yarn add', 'yarn build', 'yarn remove', 'yarn upgrade',
];

function decideBash(command, overrides = {}) {
  return decidePlanPermission({
    toolName: 'Bash',
    input: { command },
    strictReadonly: true,
    allowedTools: ALLOWED_TOOLS,
    readonlyTools: READONLY_TOOLS,
    readonlyBashCommands: READONLY_BASH_COMMANDS,
    writeBashCommands: WRITE_BASH_COMMANDS,
    skipPermissions: false,
    ...overrides,
  });
}

test('strictReadonly × allowlist 外の書き込みコマンド（Bash(rm -rf /)）は deny/writeTool になる', () => {
  const decision = decideBash('rm -rf /');
  assert.equal(decision.behavior, 'deny');
  assert.equal(decision.reason, 'planPolicy:writeTool');
});

test('strictReadonly × allowedTools に一致する Bash(git log *) は allow になる', () => {
  const decision = decideBash('git log --oneline -20');
  assert.equal(decision.behavior, 'allow');
});

test('strictReadonly × Read（PLAN_READONLY_TOOLS）は allow になる', () => {
  const decision = decidePlanPermission({
    toolName: 'Read',
    input: { file_path: '/opt/devrelay/CLAUDE.md' },
    strictReadonly: true,
    allowedTools: ALLOWED_TOOLS,
    readonlyTools: READONLY_TOOLS,
    skipPermissions: false,
  });
  assert.equal(decision.behavior, 'allow');
});

test('strictReadonly × Write は deny/writeTool になる（skipPermissions=true でも deny のまま）', () => {
  const decision = decidePlanPermission({
    toolName: 'Write',
    input: { file_path: '/tmp/x.txt', content: 'x' },
    strictReadonly: true,
    allowedTools: ALLOWED_TOOLS,
    readonlyTools: READONLY_TOOLS,
    writeTools: WRITE_TOOLS,
    skipPermissions: true,
  });
  assert.equal(decision.behavior, 'deny');
  assert.equal(decision.reason, 'planPolicy:writeTool');
});

test('interactive（strictReadonly=false）は Write でも allow になる（従来挙動、AskUserQuestion は呼び出し側で先に処理される前提）', () => {
  const decision = decidePlanPermission({
    toolName: 'Write',
    input: { file_path: '/tmp/x.txt', content: 'x' },
    strictReadonly: false,
    allowedTools: ALLOWED_TOOLS,
    readonlyTools: READONLY_TOOLS,
    writeTools: WRITE_TOOLS,
    skipPermissions: false,
  });
  assert.equal(decision.behavior, 'allow');
});

test('interactive × skipPermissions=true でも decidePlanPermission 自体は allow（skipPermissions 分岐は呼び出し側の canUseTool で先に処理される）', () => {
  const decision = decidePlanPermission({
    toolName: 'Bash',
    input: { command: 'anything not in allowlist' },
    strictReadonly: false,
    allowedTools: ALLOWED_TOOLS,
    readonlyTools: READONLY_TOOLS,
    skipPermissions: true,
  });
  assert.equal(decision.behavior, 'allow');
});

test('matchesToolRule: ツール名のみのルールは完全一致で判定する', () => {
  assert.equal(matchesToolRule('Read', 'Read', {}), true);
  assert.equal(matchesToolRule('Read', 'Write', {}), false);
});

test('matchesToolRule: Bash(cmd *) は前方一致（cmd 自体 or "cmd " で始まる）で判定する', () => {
  assert.equal(matchesToolRule('Bash(git log *)', 'Bash', { command: 'git log' }), true);
  assert.equal(matchesToolRule('Bash(git log *)', 'Bash', { command: 'git log --oneline' }), true);
  assert.equal(matchesToolRule('Bash(git log *)', 'Bash', { command: 'git logout' }), false);
});

test('isAllowedByRules: いずれかのルールにマッチすれば true', () => {
  assert.equal(isAllowedByRules(ALLOWED_TOOLS, 'Bash', { command: 'pnpm test' }), true);
  assert.equal(isAllowedByRules(ALLOWED_TOOLS, 'Bash', { command: 'curl evil.example' }), false);
  assert.equal(isAllowedByRules(undefined, 'Bash', { command: 'git log' }), false);
});

test('#333-1: ls doc/* はグロブがあっても allow になる（読み取り専用コマンド表）', () => {
  assert.equal(decideBash('ls doc/*').behavior, 'allow');
});

test('#333-2: ls PLAN_PROBE_* は allow になる', () => {
  assert.equal(decideBash('ls PLAN_PROBE_*').behavior, 'allow');
});

test('#333-3: cat *.md は allow になる', () => {
  assert.equal(decideBash('cat *.md').behavior, 'allow');
});

test('#333-4: grep -r foo src/* は allow になる', () => {
  assert.equal(decideBash('grep -r foo src/*').behavior, 'allow');
});

test("#333-5: find . -name '*.ts' は allow になる", () => {
  assert.equal(decideBash("find . -name '*.ts'").behavior, 'allow');
});

test('#333-6: wc -l *.ts は allow になる', () => {
  assert.equal(decideBash('wc -l *.ts').behavior, 'allow');
});

test('#333-7: ls -la doc 2>&1 は allow になる（2>&1 は fd 複製でリダイレクト書き込みではない）', () => {
  assert.equal(decideBash('ls -la doc 2>&1').behavior, 'allow');
});

test('#333-8: git -C /opt/devrelay log --oneline は allow になる（グローバルフラグの読み飛ばし）', () => {
  assert.equal(decideBash('git -C /opt/devrelay log --oneline').behavior, 'allow');
});

test('#333-9: ls doc/* | head は allow になる（パイプ先が read-only なら許可する方針）', () => {
  assert.equal(decideBash('ls doc/* | head').behavior, 'allow');
});

test('#333-10: touch x は deny/writeTool になる', () => {
  const decision = decideBash('touch x');
  assert.equal(decision.behavior, 'deny');
  assert.equal(decision.reason, 'planPolicy:writeTool');
});

test('#333-11: echo hi > x は deny/writeTool になる（書き込みリダイレクト）', () => {
  const decision = decideBash('echo hi > x');
  assert.equal(decision.behavior, 'deny');
  assert.equal(decision.reason, 'planPolicy:writeTool');
});

test('#333-12: sed -i s/a/b/ f は deny/writeTool になる', () => {
  const decision = decideBash('sed -i s/a/b/ f');
  assert.equal(decision.behavior, 'deny');
  assert.equal(decision.reason, 'planPolicy:writeTool');
});

test('#333-13: git log --oneline > /tmp/x は deny/writeTool になる（旧実装の書き込み抜け穴の回帰テスト）', () => {
  const decision = decideBash('git log --oneline > /tmp/x');
  assert.equal(decision.behavior, 'deny');
  assert.equal(decision.reason, 'planPolicy:writeTool');
});

test('#333-14: ls doc/* | tee out.txt は deny/compoundCommand になる（tee は書き込み系）', () => {
  const decision = decideBash('ls doc/* | tee out.txt');
  assert.equal(decision.behavior, 'deny');
  assert.equal(decision.reason, 'planPolicy:compoundCommand');
});

test('#333-15: ls *; rm -rf x は deny/compoundCommand になる', () => {
  const decision = decideBash('ls *; rm -rf x');
  assert.equal(decision.behavior, 'deny');
  assert.equal(decision.reason, 'planPolicy:compoundCommand');
});

test('#333-16: psql -c "select 1" は deny/notInAllowlist になる', () => {
  const decision = decideBash('psql -c "select 1"');
  assert.equal(decision.behavior, 'deny');
  assert.equal(decision.reason, 'planPolicy:notInAllowlist');
});

test('#333-17: ls $(cat x) は deny/compoundCommand になる（コマンド置換は中身を検査できない）', () => {
  const decision = decideBash('ls $(cat x)');
  assert.equal(decision.behavior, 'deny');
  assert.equal(decision.reason, 'planPolicy:compoundCommand');
});

test('#333-18: カスタム allowedTools のみに存在するルールは引き続き allow になる（default より緩い差分を尊重）', () => {
  const decision = decideBash('curl https://example.com', {
    allowedTools: [...ALLOWED_TOOLS, 'Bash(curl *)'],
    defaultAllowedTools: ['Bash(pm2 status *)'],
  });
  assert.equal(decision.behavior, 'allow');
});

test('#333-19: defaultAllowedTools のみに存在しカスタムに無いルールも和集合で allow になる（副次発見1対策）', () => {
  const decision = decideBash('pm2 status', {
    allowedTools: ALLOWED_TOOLS,
    defaultAllowedTools: ['Bash(pm2 status *)'],
  });
  assert.equal(decision.behavior, 'allow');
});

test('#333-20: defaultAllowedTools を渡さない場合は #333-19 と同じコマンドが deny になる（和集合が効いていることの裏取り）', () => {
  const decision = decideBash('pm2 status', {
    allowedTools: ALLOWED_TOOLS,
    defaultAllowedTools: undefined,
  });
  assert.equal(decision.behavior, 'deny');
  assert.equal(decision.reason, 'planPolicy:notInAllowlist');
});

test('splitShellSegments: クォート内の ; & | は分割対象にならない', () => {
  assert.deepEqual(splitShellSegments('echo "a;b" && echo c'), ['echo "a;b"', 'echo c']);
});

test('hasWriteRedirect: 2>&1 は書き込みとみなさず、> file は書き込みとみなす', () => {
  assert.equal(hasWriteRedirect('ls -la doc 2>&1'), false);
  assert.equal(hasWriteRedirect('echo hi > x'), true);
  assert.equal(hasWriteRedirect('cmd >> x'), true);
});

test('hasCommandSubstitution: $(...) / バッククォート / <(...) を検出する', () => {
  assert.equal(hasCommandSubstitution('ls $(cat x)'), true);
  assert.equal(hasCommandSubstitution('ls `cat x`'), true);
  assert.equal(hasCommandSubstitution('diff <(cat a) <(cat b)'), true);
  assert.equal(hasCommandSubstitution('ls doc/*'), false);
});

test('tokenizeSegment: クォートで囲まれた空白入りトークンは1トークンとして扱う', () => {
  assert.deepEqual(tokenizeSegment('psql -c "select 1"'), ['psql', '-c', 'select 1']);
});

test('matchesBashRuleByTokens: Bash(git log *) は git -C <dir> log の正規化後トークンにも一致する', () => {
  const tokens = ['git', '-C', '/opt/devrelay', 'log', '--oneline'];
  assert.equal(matchesBashRuleByTokens('Bash(git log *)', tokens), true);
});
