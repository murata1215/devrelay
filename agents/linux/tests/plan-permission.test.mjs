// #332: plan モードの canUseTool 判定の単体テスト。
// #333: strictReadonly の Bash 判定をセグメント分割＋トークン判定に変更したことに伴い拡張。
// 外部 import ゼロの純粋関数（agents/linux/src/services/plan-permission.ts）を
// コンパイル済み dist から直接 import する（apps/server の approval-prompt.test.mjs と同じ流儀）。

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
  hasGitScopeEscapeFlag,
} from '../dist/services/plan-permission.js';

const READONLY_TOOLS = ['Read', 'Glob', 'Grep', 'NotebookRead', 'Task', 'ToolSearch', 'TaskOutput', 'TaskStop', 'TodoWrite', 'WebFetch', 'WebSearch'];
const ALLOWED_TOOLS = ['Bash(git log *)', 'Bash(pnpm test)'];
const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

// packages/shared/src/constants.ts の PLAN_READONLY_BASH_COMMANDS / PLAN_WRITE_BASH_COMMANDS と
// 同じ内容をこのテストファイル内に複製する（このテストは dist の純関数のみを対象にするため、
// production 定数への依存を持たせない。#332 の既存 ALLOWED_TOOLS 定義と同じ方針）。
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

// ---- 既存9件（#332）。うち2件は #333 でコマンド/ツールが書き込み系と判定できるようになったため reason が具体化される ----

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

// ---- プランモード書き込みゲート穴の根治サイクル: write tool 早期 deny の回帰テスト ----
// 旧テスト「interactive（strictReadonly=false）は Write でも allow になる」はこのサイクルの
// 修正対象そのもの（09:41 の無承認 Write 成功）を assert していたため削除し、以下に置換する。

test('#根治-1: strictReadonly=false でも Write は planPolicy:writeTool で deny になる（最終防衛線）', () => {
  const decision = decidePlanPermission({
    toolName: 'Write',
    input: { file_path: '/tmp/x.txt', content: 'x' },
    strictReadonly: false,
    allowedTools: ALLOWED_TOOLS,
    readonlyTools: READONLY_TOOLS,
    writeTools: WRITE_TOOLS,
    skipPermissions: false,
  });
  assert.equal(decision.behavior, 'deny');
  assert.equal(decision.reason, 'planPolicy:writeTool');
});

test('#根治-2: strictReadonly=false でも Edit/MultiEdit/NotebookEdit は同様に deny になる', () => {
  for (const toolName of ['Edit', 'MultiEdit', 'NotebookEdit']) {
    const decision = decidePlanPermission({
      toolName,
      input: {},
      strictReadonly: false,
      allowedTools: ALLOWED_TOOLS,
      readonlyTools: READONLY_TOOLS,
      writeTools: WRITE_TOOLS,
      skipPermissions: false,
    });
    assert.equal(decision.behavior, 'deny', `${toolName} は deny になるべき`);
    assert.equal(decision.reason, 'planPolicy:writeTool');
  }
});

test('#根治-3: strictReadonly=false ＋ writeTools 未指定は従来どおり allow（後方互換、旧 server × 新 agent 等）', () => {
  const decision = decidePlanPermission({
    toolName: 'Write',
    input: { file_path: '/tmp/x.txt', content: 'x' },
    strictReadonly: false,
    allowedTools: ALLOWED_TOOLS,
    readonlyTools: READONLY_TOOLS,
    // writeTools を意図的に渡さない
    skipPermissions: false,
  });
  assert.equal(decision.behavior, 'allow');
});

test('#根治-4: strictReadonly=false の Read は allow のまま', () => {
  const decision = decidePlanPermission({
    toolName: 'Read',
    input: { file_path: '/opt/devrelay/CLAUDE.md' },
    strictReadonly: false,
    allowedTools: ALLOWED_TOOLS,
    readonlyTools: READONLY_TOOLS,
    writeTools: WRITE_TOOLS,
    skipPermissions: false,
  });
  assert.equal(decision.behavior, 'allow');
});

test('#根治-5: strictReadonly=false の Bash は allow のまま（第2層の適用範囲が write tool 限定であることを固定）', () => {
  const decision = decideBash('rm -rf /', { strictReadonly: false, writeTools: WRITE_TOOLS });
  assert.equal(decision.behavior, 'allow');
});

test('#根治-6: strictReadonly=true の Write deny は reason/detail とも従来と完全一致（MCP 経路は無変更）', () => {
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
  assert.equal(decision.detail, '書き込み系ツール: Write');
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

// ---- #333 新規: グロブ false positive 修正の回帰テスト ----

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

test('#333-8→S2b: git -C /opt/devrelay log --oneline は deny になる（サイクルS2bで方針変更）', () => {
  // #333 時点では「グローバルフラグの読み飛ばし」で allow としていたが、サイクルS2b（新発見②）で
  // これが `git -C <任意のパス> log` を allowedTools の Bash(git log *) に一致させてしまう
  // 既存バイパスだと判明し、方針を反転した（`hasGitScopeEscapeFlag()` 参照）。
  // ルール一致の「読み飛ばし」自体は write 判定（isWriteBashCommand）専用に限定し、
  // allowedTools のルール一致判定には使わない。
  assert.equal(decideBash('git -C /opt/devrelay log --oneline').behavior, 'deny');
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

// ---- #333 追加: 人間承認時の追記（allowedTools ∪ defaultAllowedTools の和集合）の検証 ----

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

// ---- #333 補助関数の直接テスト ----

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

// ---- サイクルS1（2026-11-12）: PreToolUse フック導入に伴う回帰テスト。 ----
// 2026-11-11 夜のクロスユーザー ask ターンで実際に通過したコマンド群（python3 / node / 複合コマンド）を
// decidePlanPermission に通した場合の期待結果を固定する（フック側も canUseTool 側も同じ
// decidePlanPermission を呼ぶため、ここでの固定がフック導入後のゲート全体の正しさを保証する）。

test('S1-1: python3 -c "print(1)" は許可コマンド一覧になく deny/notInAllowlist になる', () => {
  const decision = decideBash('python3 -c "print(1)"');
  assert.equal(decision.behavior, 'deny');
  assert.equal(decision.reason, 'planPolicy:notInAllowlist');
});

test('S1-2: node -e "console.log(1)" は許可コマンド一覧になく deny/notInAllowlist になる', () => {
  const decision = decideBash('node -e "console.log(1)"');
  assert.equal(decision.behavior, 'deny');
  assert.equal(decision.reason, 'planPolicy:notInAllowlist');
});

test('S1-3: cd /opt/devrelay && grep -c foo bar.txt （全セグメント読み取り専用の複合コマンド）は allow になる', () => {
  const decision = decideBash('cd /opt/devrelay && grep -c foo bar.txt');
  assert.equal(decision.behavior, 'allow');
});

test('S1-4: echo a > b （書き込みリダイレクト）は deny/writeTool になる', () => {
  const decision = decideBash('echo a > b');
  assert.equal(decision.behavior, 'deny');
  assert.equal(decision.reason, 'planPolicy:writeTool');
});

test('S1-5: Agent ツール名（SDK 0.3 系のサブエージェント起動ツール）は readonlyTools に含まれていれば allow になる', () => {
  const decision = decidePlanPermission({
    toolName: 'Agent',
    input: {},
    strictReadonly: true,
    allowedTools: ALLOWED_TOOLS,
    readonlyTools: [...READONLY_TOOLS, 'Agent'],
    readonlyBashCommands: READONLY_BASH_COMMANDS,
    writeBashCommands: WRITE_BASH_COMMANDS,
    skipPermissions: false,
  });
  assert.equal(decision.behavior, 'allow');
});

test('S1-6: 利用者が Allowed Tools (Plan Mode) に追加した裸の MCP エントリ（context7 の2ツール）は strictReadonly でも allow になる', () => {
  const userAllowedTools = [
    'Bash(pm2 logs)', 'Bash(git log *)',
    'mcp__plugin_context7_context7__resolve-library-id',
    'mcp__plugin_context7_context7__query-docs',
  ];
  for (const toolName of ['mcp__plugin_context7_context7__resolve-library-id', 'mcp__plugin_context7_context7__query-docs']) {
    const decision = decidePlanPermission({
      toolName,
      input: {},
      strictReadonly: true,
      allowedTools: userAllowedTools,
      readonlyTools: READONLY_TOOLS,
      readonlyBashCommands: READONLY_BASH_COMMANDS,
      writeBashCommands: WRITE_BASH_COMMANDS,
      skipPermissions: false,
    });
    assert.equal(decision.behavior, 'allow', `${toolName} が deny された`);
  }
});

test('S1-7: プランターンで通常使う読み取り専用ツール（Read/Grep/Glob/Agent/ToolSearch/TodoWrite/WebFetch/WebSearch）は拒否されない', () => {
  const commonTools = ['Read', 'Grep', 'Glob', 'Agent', 'ToolSearch', 'TodoWrite', 'WebFetch', 'WebSearch'];
  for (const toolName of commonTools) {
    const decision = decidePlanPermission({
      toolName,
      input: {},
      strictReadonly: true,
      allowedTools: ALLOWED_TOOLS,
      readonlyTools: [...READONLY_TOOLS, 'Agent'],
      readonlyBashCommands: READONLY_BASH_COMMANDS,
      writeBashCommands: WRITE_BASH_COMMANDS,
      skipPermissions: false,
    });
    assert.equal(decision.behavior, 'allow', `${toolName} が deny された`);
  }
});

// --- サイクルS2b（新発見②）: git の経路またぎフラグは allowedTools ルールに関わらず deny ---

test('hasGitScopeEscapeFlag: -C/-c/--git-dir/--work-tree/--exec-path/--namespace を検出する', () => {
  assert.equal(hasGitScopeEscapeFlag(['git', '-C', '/tmp', 'log']), true);
  assert.equal(hasGitScopeEscapeFlag(['git', '-c', 'core.pager=cat', 'log']), true);
  assert.equal(hasGitScopeEscapeFlag(['git', '--git-dir=/tmp/.git', 'log']), true);
  assert.equal(hasGitScopeEscapeFlag(['git', '--work-tree', '/tmp', 'status']), true);
  assert.equal(hasGitScopeEscapeFlag(['git', '--exec-path', '/usr/lib/git', 'log']), true);
  assert.equal(hasGitScopeEscapeFlag(['git', '--namespace', 'foo', 'log']), true);
});

test('hasGitScopeEscapeFlag: フラグが無い通常の git コマンドは false', () => {
  assert.equal(hasGitScopeEscapeFlag(['git', 'log']), false);
  assert.equal(hasGitScopeEscapeFlag(['git', 'status']), false);
  assert.equal(hasGitScopeEscapeFlag(['git', 'diff', '--stat']), false);
});

test('hasGitScopeEscapeFlag: git 以外のコマンドは常に false', () => {
  assert.equal(hasGitScopeEscapeFlag(['ls', '-C', '/tmp']), false);
  assert.equal(hasGitScopeEscapeFlag([]), false);
});

test('【実機再現】strictReadonly: git -C <他プロジェクト> log は Bash(git log *) に一致しても deny（本サイクルの発見事例）', () => {
  // サイクルS2 Step 0/Plan フェーズで実測: 修正前はこのコマンドが Bash(git log *) に一致して
  // allow されていた（この会話自身のプランモードで `git -C /opt/devrelay status` が通った）。
  const decision = decideBash('git -C /opt/devrelay status');
  assert.equal(decision.behavior, 'deny');
  assert.equal(decision.reason, 'planPolicy:notInAllowlist');
  assert.match(decision.detail, /経路変更フラグ/);
});

test('strictReadonly: git -c core.pager=... log は deny（設定注入の防止）', () => {
  const decision = decideBash('git -c core.pager=cat log');
  assert.equal(decision.behavior, 'deny');
});

test('strictReadonly: git --git-dir/--work-tree を使った log/status/diff/show は deny', () => {
  for (const cmd of [
    'git --git-dir=/tmp/other/.git log',
    'git --work-tree=/tmp/other status',
    'git -C /tmp/other diff',
    'git -C /tmp/other show HEAD',
  ]) {
    const decision = decideBash(cmd);
    assert.equal(decision.behavior, 'deny', `${cmd} should be denied`);
  }
});

test('strictReadonly: フラグ無しの通常の git log/status/diff/show は従来どおり allow（回帰確認）', () => {
  for (const cmd of ['git log', 'git log --oneline', 'git status', 'git diff', 'git show HEAD']) {
    // show は DEFAULT_ALLOWED_TOOLS_LINUX の Bash(git show *) ルールを使うため allowedTools に追加
    const decision = decideBash(cmd, { allowedTools: [...ALLOWED_TOOLS, 'Bash(git status)', 'Bash(git diff)', 'Bash(git show *)'] });
    assert.equal(decision.behavior, 'allow', `${cmd} should still be allowed`);
  }
});

test('write 判定（isWriteBashCommand 相当）は git -C があっても正しく write と判定する（回帰確認）', () => {
  // -C 等のフラグを剥がして write 判定するロジック（isWriteBashCommand）自体は変更していない。
  const decision = decideBash('git -C /tmp commit -m "x"');
  assert.equal(decision.behavior, 'deny');
  assert.equal(decision.reason, 'planPolicy:writeTool');
});
