// #332: plan モードの canUseTool 判定の単体テスト。
// 外部 import ゼロの純粋関数（agents/linux/src/services/plan-permission.ts）を
// コンパイル済み dist から直接 import する（apps/server の approval-prompt.test.mjs と同じ流儀）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesToolRule, isAllowedByRules, decidePlanPermission } from '../dist/services/plan-permission.js';

const READONLY_TOOLS = ['Read', 'Glob', 'Grep', 'NotebookRead', 'Task', 'ToolSearch', 'TaskOutput', 'TaskStop', 'TodoWrite', 'WebFetch', 'WebSearch'];
const ALLOWED_TOOLS = ['Bash(git log *)', 'Bash(pnpm test)'];

test('strictReadonly × allowlist 外のツール（例: Bash(rm -rf /)）は deny になる', () => {
  const decision = decidePlanPermission({
    toolName: 'Bash',
    input: { command: 'rm -rf /' },
    strictReadonly: true,
    allowedTools: ALLOWED_TOOLS,
    readonlyTools: READONLY_TOOLS,
    skipPermissions: false,
  });
  assert.equal(decision.behavior, 'deny');
  assert.equal(decision.reason, 'planPolicy');
});

test('strictReadonly × allowedTools に一致する Bash(git log *) は allow になる', () => {
  const decision = decidePlanPermission({
    toolName: 'Bash',
    input: { command: 'git log --oneline -20' },
    strictReadonly: true,
    allowedTools: ALLOWED_TOOLS,
    readonlyTools: READONLY_TOOLS,
    skipPermissions: false,
  });
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

test('strictReadonly × Write は deny になる（skipPermissions=true でも deny のまま）', () => {
  const decision = decidePlanPermission({
    toolName: 'Write',
    input: { file_path: '/tmp/x.txt', content: 'x' },
    strictReadonly: true,
    allowedTools: ALLOWED_TOOLS,
    readonlyTools: READONLY_TOOLS,
    skipPermissions: true,
  });
  assert.equal(decision.behavior, 'deny');
  assert.equal(decision.reason, 'planPolicy');
});

test('interactive（strictReadonly=false）は Write でも allow になる（従来挙動、AskUserQuestion は呼び出し側で先に処理される前提）', () => {
  const decision = decidePlanPermission({
    toolName: 'Write',
    input: { file_path: '/tmp/x.txt', content: 'x' },
    strictReadonly: false,
    allowedTools: ALLOWED_TOOLS,
    readonlyTools: READONLY_TOOLS,
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
