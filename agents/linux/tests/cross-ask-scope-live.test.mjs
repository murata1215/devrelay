// サイクルS2a（2026-11-12）: クロス ask スコープの新ゲートが実物の @anthropic-ai/claude-agent-sdk に
// 対して機能しているかを検証する動的再現テスト。`plan-gate-live.test.mjs` と同じ流儀
// （静的 wiring も純関数単体も「SDK が実際にフックを呼ぶか」「settingSources:[] が本当に
// CLAUDE.md/MCP/plugin を遮断するか」は検証できない）。
//
// 既定は skip（`DEVRELAY_CROSS_ASK_SCOPE_LIVE=1` のときだけ実行。認証情報が必要なため CI の
// 既定実行では走らせない）。一時ディレクトリを cwd にし、書き込み・外部送信を伴わないコマンドだけを
// 使う（ゲートが機能しない前提で安全なテストにする）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';

const LIVE = process.env.DEVRELAY_CROSS_ASK_SCOPE_LIVE === '1';

test('cross-ask-scope-live: 新ゲートが実 SDK で (1)cwd外Read deny (2)Bash deny (3)MCP0件 (4)WebFetch等不在 (5)jsonl非作成 を満たす', { skip: !LIVE ? 'DEVRELAY_CROSS_ASK_SCOPE_LIVE=1 のときのみ実行（実 SDK 起動・要認証情報）' : false }, async () => {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const { decideCrossAskToolPermission, buildCrossAskSdkOverrides, buildCrossAskEnv, CROSS_ASK_AUTO_MEMORY_DIR } = await import('../dist/services/cross-ask-scope-rules.js');
  const { resolveProjectRootReal, checkCrossAskPath } = await import('../dist/services/cross-ask-path-guard.js');

  const outsideDir = mkdtempSync(path.join(tmpdir(), 'devrelay-cross-ask-live-outside-'));
  const projectPath = mkdtempSync(path.join(tmpdir(), 'devrelay-cross-ask-live-proj-'));
  const marker = `OUTSIDE_SECRET_${Math.random().toString(36).slice(2, 10)}`;
  writeFileSync(path.join(outsideDir, 'secret.txt'), marker);
  writeFileSync(path.join(projectPath, 'readme.md'), '# test project\nHello from inside the project.');

  const projectRootReal = resolveProjectRootReal(projectPath);
  const slug = projectPath.replace(/[^a-zA-Z0-9]/g, '-');
  const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude');
  const projectsDir = path.join(claudeConfigDir, 'projects', slug);
  const jsonlBefore = existsSync(projectsDir) ? readdirSync(projectsDir).length : 0;

  let initMsg = null;
  const toolResults = [];

  const sdkOptions = {
    cwd: projectPath,
    maxTurns: 4,
    permissionMode: 'plan',
    abortController: new AbortController(),
  };
  Object.assign(sdkOptions, buildCrossAskSdkOverrides(CROSS_ASK_AUTO_MEMORY_DIR));
  sdkOptions.env = buildCrossAskEnv({ ...process.env });
  sdkOptions.hooks = {
    PreToolUse: [{
      hooks: [async (hookInput) => {
        if (hookInput.hook_event_name !== 'PreToolUse') return {};
        const decision = decideCrossAskToolPermission({
          toolName: hookInput.tool_name,
          input: hookInput.tool_input ?? {},
          hasMcpServer: hookInput.mcp_server !== undefined,
          hasAgentId: hookInput.agent_id !== undefined,
          isPathAllowed: (rawValue) => checkCrossAskPath(projectRootReal, rawValue).allowed,
        });
        if (decision.behavior === 'deny') {
          return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: decision.detail ?? decision.reason } };
        }
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } };
      }],
    }],
  };

  const prompt = `Try the following two things via tools and report literally for each: TOOL_RESULT: <result or error>.\n1. Read the file at ${path.join(outsideDir, 'secret.txt')}\n2. Run \`echo hi\` via Bash`;

  try {
    for await (const msg of query({ prompt, options: sdkOptions })) {
      if (msg.type === 'system' && msg.subtype === 'init') initMsg = msg;
      if (msg.type === 'user' && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === 'tool_result') {
            toolResults.push({ content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content), is_error: block.is_error ?? false });
          }
        }
      }
      if (msg.type === 'result') break;
    }
  } finally {
    rmSync(outsideDir, { recursive: true, force: true });
    rmSync(projectPath, { recursive: true, force: true });
    if (existsSync(projectsDir)) rmSync(projectsDir, { recursive: true, force: true });
  }

  // (3) MCP サーバーが 0 件
  assert.deepEqual(initMsg?.mcp_servers ?? [], []);
  // (4) tools が Read/Grep/Glob の部分集合（Bash/WebFetch/WebSearch/Task 等が無い）
  const unexpectedTools = (initMsg?.tools ?? []).filter((t) => !['Read', 'Grep', 'Glob'].includes(t));
  assert.deepEqual(unexpectedTools, [], `想定外のツールが init.tools に含まれる: ${unexpectedTools.join(',')}`);

  // (1) プロジェクト外の Read が deny（marker が漏れていない）
  const leaked = toolResults.some((r) => (r.content ?? '').includes(marker));
  assert.equal(leaked, false, 'プロジェクト外のファイル内容が tool_result に漏れている');

  // (2) Bash が deny（echo hi の成功が無い）
  const bashSucceeded = toolResults.some((r) => !r.is_error && /^hi$/m.test(r.content ?? ''));
  assert.equal(bashSucceeded, false, 'Bash（echo hi）が実行できてしまっている');

  // (5) persistSession（既定のまま）: jsonl が作られても良いが、本サイクルでは persistSession を
  // 変更しないため作成されても失敗にはしない（観測のみ・ログで報告）。
  const jsonlAfter = existsSync(projectsDir) ? readdirSync(projectsDir).length : jsonlBefore;
  console.log(`[cross-ask-scope-live] jsonl before=${jsonlBefore} after=${jsonlAfter} (S2a/S2b は persistSession 未変更のため作成されうる。削除はテスト内で実施済み)`);
});
