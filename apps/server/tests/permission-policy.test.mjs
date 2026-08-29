// #332: permissionPolicy の組み立てロジックの単体テスト。
// 外部 import ゼロの純粋関数（apps/server/src/services/permission-policy.ts）を
// コンパイル済み dist から直接 import する（#331 の approval-prompt.test.mjs と同じ流儀）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePermissionPolicy } from '../dist/services/permission-policy.js';

test('MCP 経路（submit_instruction）は strictReadonly を組み立てる', () => {
  assert.equal(resolvePermissionPolicy('mcp'), 'strictReadonly');
});

test('チャット経路（通常メッセージ）は interactive を組み立てる', () => {
  assert.equal(resolvePermissionPolicy('chat'), 'interactive');
});

test('exec 経路（approve_implementation / execConversation）は interactive を組み立てる', () => {
  assert.equal(resolvePermissionPolicy('exec'), 'interactive');
});

test('mcp 以外の経路はすべて interactive に倒れる（fail-safe な既定値）', () => {
  assert.equal(resolvePermissionPolicy('chat'), resolvePermissionPolicy('exec'));
});
