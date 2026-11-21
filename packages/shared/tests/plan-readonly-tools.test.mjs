// サイクルS1（2026-11-12）: packages/shared/src/constants.ts の PLAN_READONLY_TOOLS の回帰テスト。
// SDK 0.3 系（Claude Code 2.1.282 系）はサブエージェント起動ツールの名称を `Task` から `Agent` に
// 変更している（稼働ログ実測 `Using tool: Agent`）。本サイクルで PreToolUse フック（agents/linux,
// agents/macos）を strictReadonly の唯一の権威にしたため、`Agent` が readonlyTools に無いと
// サブエージェント起動そのものが `planPolicy:notInAllowlist` で deny される二次バグになる。
// このテストはその回帰を機械的に検知する。

import test from 'node:test';
import assert from 'node:assert/strict';
import { PLAN_READONLY_TOOLS } from '../dist/constants.js';

test('PLAN_READONLY_TOOLS に Agent（SDK 0.3 系のサブエージェント起動ツール）が含まれる', () => {
  assert.ok(
    PLAN_READONLY_TOOLS.includes('Agent'),
    `PLAN_READONLY_TOOLS に 'Agent' が無い: ${JSON.stringify(PLAN_READONLY_TOOLS)}`,
  );
});

test('PLAN_READONLY_TOOLS に Task（旧 SDK 互換のため残置）も含まれる', () => {
  assert.ok(
    PLAN_READONLY_TOOLS.includes('Task'),
    `PLAN_READONLY_TOOLS から 'Task' が意図せず削除されている: ${JSON.stringify(PLAN_READONLY_TOOLS)}`,
  );
});

test('PLAN_READONLY_TOOLS に Write/Edit/MultiEdit/NotebookEdit/ExitPlanMode は含まれない（意図的な除外の回帰防止）', () => {
  for (const writeTool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'ExitPlanMode']) {
    assert.ok(
      !PLAN_READONLY_TOOLS.includes(writeTool),
      `PLAN_READONLY_TOOLS に書き込み系ツール '${writeTool}' が誤って含まれている`,
    );
  }
});
