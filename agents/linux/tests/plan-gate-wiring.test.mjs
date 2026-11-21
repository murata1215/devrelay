// サイクルS1（2026-11-12）: ai-runner.ts の plan モード権限ゲート配線に対する静的ガード
// （node:fs のみ、dist/ には依存しない。repo-auth-wiring.test.mjs と同じ手口）。
//
// これが無いと、将来のリファクタで以下が黙って外れても気づけない:
// - PreToolUse フック（唯一の権威）の配線が消える → SDK 0.3 系の auto-mode classifier が
//   canUseTool より前に Bash を allow/deny する既知の回帰（2026-09-20〜2026-11-12）が再発する
// - canUseTool の設定が再び `if (options.onToolApprovalRequest)` の中に戻る
//   （未設定時に canUseTool ごと消える構造的欠陥の再発）
// - strictReadonly のときに sdkOptions.allowedTools を SDK に渡してしまう
//   （裸の mcp__ エントリ等が PreToolUse フックより前に allow を確定させる shadow の再発）
// - decidePlanPermission の呼び出しがフック側／canUseTool 側のどちらかから欠落する

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const agentRoot = path.resolve(__dirname, '..');
const source = readFileSync(path.join(agentRoot, 'src', 'services', 'ai-runner.ts'), 'utf8');

// plan 分岐の本文だけを切り出す（`} else if (options.usePlanMode) {` から次の `} else {` まで）。
function extractPlanBranch(src) {
  const start = src.indexOf('} else if (options.usePlanMode) {');
  assert.ok(start !== -1, 'plan 分岐の開始位置が見つかること');
  const end = src.indexOf('\n  } else {\n    // Exec モード', start);
  assert.ok(end !== -1, 'plan 分岐の終了位置（Exec モード分岐の開始）が見つかること');
  return src.slice(start, end);
}

const planBranch = extractPlanBranch(source);

describe('ai-runner.ts: plan 分岐に PreToolUse フックが配線されている', () => {
  test('sdkOptions.hooks.PreToolUse が設定されている', () => {
    assert.match(planBranch, /sdkOptions\.hooks\s*=\s*\{/);
    assert.match(planBranch, /PreToolUse:\s*\[\{/);
  });

  test('フック本体が decidePlanPermission を呼んでいる', () => {
    assert.match(planBranch, /decidePlanPermission\(\{/);
  });

  test('フックが ExitPlanMode を明示 deny している', () => {
    const hookIdx = planBranch.indexOf('PreToolUse: [{');
    const hookBody = planBranch.slice(hookIdx, hookIdx + 2500);
    assert.match(hookBody, /toolName === 'ExitPlanMode'/);
    assert.match(hookBody, /permissionDecision:\s*'deny'/);
  });

  test('フックが AskUserQuestion を canUseTool に委譲している（判定を返さず {} で pass through）', () => {
    const hookIdx = planBranch.indexOf('PreToolUse: [{');
    const hookBody = planBranch.slice(hookIdx, hookIdx + 3500);
    assert.match(hookBody, /toolName === 'AskUserQuestion'/);
  });
});

describe('ai-runner.ts: canUseTool が onToolApprovalRequest の有無に関わらず常に設定される（構造的欠陥の根治）', () => {
  test('plan 分岐内に `if (options.onToolApprovalRequest) {` で canUseTool 代入全体を囲うブロックが無い', () => {
    // 旧実装は `if (options.onToolApprovalRequest) { sdkOptions.canUseTool = async (...) => {...}; }`
    // という形で canUseTool 代入ごと if の中に入っていた。新実装では
    // `const onApprovalRequest = options.onToolApprovalRequest;` のように値だけを変数に退避し、
    // `sdkOptions.canUseTool = ...` 自体は if の外（トップレベル）に置く。
    const guardedAssignPattern = /if \(options\.onToolApprovalRequest\) \{\s*const onApprovalRequest = options\.onToolApprovalRequest;\s*sdkOptions\.canUseTool = async/;
    assert.ok(
      !guardedAssignPattern.test(planBranch),
      'canUseTool の代入が依然として if (options.onToolApprovalRequest) の内側にある（構造的欠陥が再発している）',
    );
  });

  test('sdkOptions.canUseTool への代入が plan 分岐のトップレベルに存在する', () => {
    assert.match(planBranch, /\n {4}sdkOptions\.canUseTool = async \(toolName, input, opts\) => \{/);
  });

  test('canUseTool 内で AskUserQuestion が onApprovalRequest 未設定時に安全側 deny する', () => {
    const canUseToolIdx = planBranch.lastIndexOf('sdkOptions.canUseTool = async');
    const canUseToolBody = planBranch.slice(canUseToolIdx);
    assert.match(canUseToolBody, /if \(!onApprovalRequest\)/);
    assert.match(canUseToolBody, /behavior:\s*'deny'/);
  });
});

describe('ai-runner.ts: strictReadonly のとき allowedTools を SDK に渡さない', () => {
  test('allowedTools の代入が !options.strictReadonly を条件に含む', () => {
    assert.match(
      planBranch,
      /if \(!options\.strictReadonly && options\.allowedTools && options\.allowedTools\.length > 0\) \{\s*sdkOptions\.allowedTools = options\.allowedTools;/,
    );
  });
});

describe('ai-runner.ts: decidePlanPermission がフック側・canUseTool 側の両方から呼ばれる（第2防衛線）', () => {
  test('decidePlanPermission の呼び出しが plan 分岐内に2回以上ある', () => {
    const matches = planBranch.match(/decidePlanPermission\(\{/g) ?? [];
    assert.ok(matches.length >= 2, `decidePlanPermission の呼び出しが ${matches.length} 回しかない（フック・canUseTool の2箇所が期待値）`);
  });
});

describe('ai-runner.ts: フック到達状況の観測ログが配線されている', () => {
  test('PreToolUse gate enabled のログが plan 分岐にある', () => {
    assert.match(planBranch, /PreToolUse gate enabled/);
  });

  test('finally ブロックにフック到達サマリログがある', () => {
    assert.match(source, /PreToolUse gate summary/);
    assert.match(source, /PLAN GATE REGRESSION/);
  });
});

describe('ai-runner.ts: 設定ファイル由来の shadow 可視化が配線されている', () => {
  test('warnIfSettingsFileHasPermissions が定義され、plan 分岐で user/project 設定の両方に対して呼ばれている', () => {
    assert.match(source, /function warnIfSettingsFileHasPermissions\(/);
    assert.match(planBranch, /warnIfSettingsFileHasPermissions\('user settings'/);
    assert.match(planBranch, /warnIfSettingsFileHasPermissions\('project settings'/);
  });
});
