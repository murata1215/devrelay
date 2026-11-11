// サイクルS1（2026-11-12）: PreToolUse フックが実際の SDK バイナリに対して機能しているかを
// 実物の @anthropic-ai/claude-agent-sdk を起動して検証する動的再現テスト。
// `plan-gate-wiring.test.mjs`（静的な配線検査）・`plan-permission.test.mjs`（純関数の単体テスト）
// のいずれも「SDK が実際にフックを呼ぶか」は検証できない（2026-09-20〜2026-11-12 の故障は
// まさにこの層で起きた：DevRelay 側のコードは無傷のまま SDK の内部動作が変わり、
// Bash が canUseTool/フックに来なくなった）。本テストはその再発を実機で検知する。
//
// 既定は skip（`DEVRELAY_PLAN_GATE_LIVE=1` のときだけ実行。sdk-executable-real.test.mjs と同じ
// 「実物に当てる」系の流儀）。実行には Claude Code の認証情報（~/.claude/.credentials.json 等）が
// 必要なため CI の既定実行では走らせない。一時ディレクトリを cwd にし、書き込み・外部送信を
// 伴わないコマンドだけを使う（ゲートが機能しない前提で安全なテストにする）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const LIVE = process.env.DEVRELAY_PLAN_GATE_LIVE === '1';

test('plan-gate-live: PreToolUse フックが auto-mode classifier より前に Bash を捕捉し、decidePlanPermission の判定が honored される', { skip: !LIVE ? 'DEVRELAY_PLAN_GATE_LIVE=1 のときのみ実行（実 SDK 起動・要認証情報）' : false }, async () => {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const {
    DEFAULT_ALLOWED_TOOLS_LINUX,
    PLAN_READONLY_TOOLS,
    PLAN_READONLY_BASH_COMMANDS,
    PLAN_WRITE_BASH_COMMANDS,
    PLAN_WRITE_TOOLS,
  } = await import('@devrelay/shared');
  const { decidePlanPermission } = await import('../dist/services/plan-permission.js');

  const cwd = mkdtempSync(path.join(tmpdir(), 'devrelay-plan-gate-live-'));
  const hookCalls = [];
  const canUseToolCalls = [];

  try {
    const options = {
      cwd,
      maxTurns: 6,
      settingSources: ['user', 'project'],
      env: { ...process.env, DEVRELAY: '1' },
      abortController: new AbortController(),
      permissionMode: 'plan',
      // strictReadonly 本番相当: allowedTools は SDK に渡さない。
      hooks: {
        PreToolUse: [{
          hooks: [async (hookInput) => {
            if (hookInput.hook_event_name !== 'PreToolUse') return {};
            const toolName = hookInput.tool_name;
            const input = hookInput.tool_input ?? {};
            hookCalls.push({ toolName, command: input.command });
            if (toolName === 'AskUserQuestion') return {};
            const decision = decidePlanPermission({
              toolName,
              input,
              strictReadonly: true,
              allowedTools: [],
              defaultAllowedTools: DEFAULT_ALLOWED_TOOLS_LINUX,
              readonlyTools: PLAN_READONLY_TOOLS,
              readonlyBashCommands: PLAN_READONLY_BASH_COMMANDS,
              writeBashCommands: PLAN_WRITE_BASH_COMMANDS,
              writeTools: PLAN_WRITE_TOOLS,
              skipPermissions: false,
            });
            if (decision.behavior === 'deny') {
              return {
                hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: decision.detail ?? decision.reason },
              };
            }
            return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } };
          }],
        }],
      },
      canUseTool: async (toolName, input) => {
        canUseToolCalls.push({ toolName });
        return { behavior: 'allow', updatedInput: input };
      },
    };

    const prompt = 'Run `python3 -c "print(1)"` via Bash, then separately run `ls` via Bash. For each, report literally: TOOL_RESULT: <what the tool returned or the error message>. Nothing else.';

    const toolResults = [];
    for await (const msg of query({ prompt, options })) {
      if (msg.type === 'user' && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === 'tool_result') {
            toolResults.push({
              content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
              is_error: block.is_error ?? false,
            });
          }
        }
      }
    }

    // 1. フックが Bash で呼ばれたこと（0 件なら red = 本件の回帰検知）
    const bashHookCalls = hookCalls.filter((c) => c.toolName === 'Bash');
    assert.ok(bashHookCalls.length >= 2, `PreToolUse フックが Bash で ${bashHookCalls.length} 回しか呼ばれていない（2回以上を期待）: ${JSON.stringify(hookCalls)}`);

    // 2. python3 が deny されたこと（実行されていない）
    const deniedResult = toolResults.find((r) => r.is_error && /python3|not in the allowed/i.test(r.content ?? ''));
    assert.ok(
      toolResults.some((r) => r.is_error),
      `python3 の tool_result が deny（is_error:true）になっていない: ${JSON.stringify(toolResults)}`,
    );

    // 3. ls（読み取り専用コマンド）がフックに到達しかつ実行されていること（classifier に奪われていない）
    const lsHookCall = bashHookCalls.find((c) => /^ls\b/.test((c.command ?? '').trim()));
    assert.ok(lsHookCall, `ls のフック呼び出しが見つからない: ${JSON.stringify(bashHookCalls)}`);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
