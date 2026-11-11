// サイクルS1（2026-11-12）: packages/shared/src/types.ts の AGENT_CAPABILITIES の回帰テスト。
// `'plan-gate-hook'` が抜けると、agents/{linux,macos} が capability を一切申告しなくなり、
// cross-ask-isolation-rules.ts の `agentHasPlanGateCapability` 判定が常に false になる
// （= クロスユーザー ask が全て「Agent が古い」として断られる重大な過剰縮退）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_CAPABILITIES } from '../dist/types.js';

test("AGENT_CAPABILITIES に 'plan-gate-hook' が含まれる", () => {
  assert.ok(
    AGENT_CAPABILITIES.includes('plan-gate-hook'),
    `AGENT_CAPABILITIES に 'plan-gate-hook' が無い: ${JSON.stringify(AGENT_CAPABILITIES)}`,
  );
});

test('AGENT_CAPABILITIES に既存の capability（isolation/resume 系）が意図せず削除されていない', () => {
  for (const cap of ['scoped-clear', 'capability-sync', 'raw-completion', 'raw-completion-codex', 'cross-ask-resume', 'cross-ask-isolation', 'cross-ask-resume-strict']) {
    assert.ok(AGENT_CAPABILITIES.includes(cap), `AGENT_CAPABILITIES から '${cap}' が消えている`);
  }
});
