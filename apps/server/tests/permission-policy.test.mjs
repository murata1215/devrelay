// #332 / プランモード書き込みゲート穴の根治: permissionPolicy の組み立てロジックの単体テスト。
// 外部 import ゼロ（apps/server/src/services/permission-policy.ts）を
// コンパイル済み dist から直接 import する（#331 の approval-prompt.test.mjs と同じ流儀）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePermissionPolicy } from '../dist/services/permission-policy.js';

test('MCP 経路（submit_instruction）は strictReadonly を組み立てる（回帰ガード）', () => {
  assert.equal(resolvePermissionPolicy('mcp'), 'strictReadonly');
});

test('exec 経路（approve_implementation / execConversation）は interactive を組み立てる（人間承認済みのフル権限は不変）', () => {
  assert.equal(resolvePermissionPolicy('exec'), 'interactive');
});

test('チャット経路（通常メッセージ）は options 省略時 strictReadonly を組み立てる（fail-closed な既定値）', () => {
  assert.equal(resolvePermissionPolicy('chat'), 'strictReadonly');
});

test('ask 経路（executeCrossProjectQuery / teamexec の ask）は strictReadonly を組み立てる', () => {
  assert.equal(resolvePermissionPolicy('ask'), 'strictReadonly');
});

test('キルスイッチ strictChatPlan:false のときだけ chat は interactive に戻る', () => {
  assert.equal(resolvePermissionPolicy('chat', { strictChatPlan: false }), 'interactive');
  assert.equal(resolvePermissionPolicy('chat', { strictChatPlan: true }), 'strictReadonly');
});

test('キルスイッチは mcp を弱体化できない', () => {
  assert.equal(resolvePermissionPolicy('mcp', { strictChatPlan: false }), 'strictReadonly');
});

test('キルスイッチは exec を強化できない', () => {
  assert.equal(resolvePermissionPolicy('exec', { strictChatPlan: false }), 'interactive');
  assert.equal(resolvePermissionPolicy('exec', { strictChatPlan: true }), 'interactive');
});

test('chat と exec は別値である（既定状態では strictReadonly と interactive で異なる）', () => {
  assert.notEqual(resolvePermissionPolicy('chat'), resolvePermissionPolicy('exec'));
});
