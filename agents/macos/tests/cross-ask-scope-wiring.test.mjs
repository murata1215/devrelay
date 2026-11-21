// サイクルS2a/S2b: ai-runner.ts / connection.ts のクロス ask スコープ配線に対する静的ガード
// （node:fs のみ、dist/ には依存しない。plan-gate-wiring.test.mjs と同じ手口）。
//
// これが無いと、将来のリファクタで以下が黙って外れても気づけない:
// - クロス ask の新ゲート（decideCrossAskToolPermission）が `options.crossAskScope` の
//   条件外で呼ばれる／exec・raw 分岐に漏れ出す（通常利用への誤爆）
// - buildCrossAskSdkOverrides() の適用が crossAskScope 条件の外に出る
// - init アサート（decideCrossAskInitAssertion）の呼び出しが消える
// - connection.ts の fail-closed チェック（statePolicy.crossAskScope && !strictReadonly）が消える
// - sendOptions.crossAskScope の配線が消える

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const agentRoot = path.resolve(__dirname, '..');
const aiRunnerSource = readFileSync(path.join(agentRoot, 'src', 'services', 'ai-runner.ts'), 'utf8');
const connectionSource = readFileSync(path.join(agentRoot, 'src', 'services', 'connection.ts'), 'utf8');

// plan 分岐の本文だけを切り出す（`} else if (options.usePlanMode) {` から次の `} else {` まで）。
function extractPlanBranch(src) {
  const start = src.indexOf('} else if (options.usePlanMode) {');
  assert.ok(start !== -1, 'plan 分岐の開始位置が見つかること');
  const end = src.indexOf('\n  } else {\n    // Exec モード', start);
  assert.ok(end !== -1, 'plan 分岐の終了位置（Exec モード分岐の開始）が見つかること');
  return src.slice(start, end);
}

// exec 分岐（`} else {` から次のトップレベル `}` まで、簡易的に次の2000文字で十分）。
function extractExecBranchHead(src) {
  const start = src.indexOf('\n  } else {\n    // Exec モード');
  assert.ok(start !== -1, 'exec 分岐の開始位置が見つかること');
  return src.slice(start, start + 4000);
}

// raw-completion 分岐（`if (options.rawMode) {` から `} else if (options.usePlanMode)` まで）。
function extractRawBranch(src) {
  const start = src.indexOf('if (options.rawMode) {');
  assert.ok(start !== -1, 'raw 分岐の開始位置が見つかること');
  const end = src.indexOf('} else if (options.usePlanMode) {', start);
  assert.ok(end !== -1, 'raw 分岐の終了位置が見つかること');
  return src.slice(start, end);
}

const planBranch = extractPlanBranch(aiRunnerSource);
const execBranchHead = extractExecBranchHead(aiRunnerSource);
const rawBranch = extractRawBranch(aiRunnerSource);

describe('ai-runner.ts: クロス ask スコープの新ゲートが plan 分岐内に配線されている', () => {
  test('decideCrossAskToolPermission の呼び出しが plan 分岐内に2回以上ある（フック・canUseTool の2箇所）', () => {
    const matches = planBranch.match(/decideCrossAskToolPermission\(\{/g) ?? [];
    assert.ok(matches.length >= 2, `decideCrossAskToolPermission の呼び出しが ${matches.length} 回しかない`);
  });

  test('buildCrossAskSdkOverrides の適用が options.crossAskScope の条件内にある', () => {
    const guardIdx = planBranch.indexOf('if (options.crossAskScope) {');
    assert.ok(guardIdx !== -1, 'if (options.crossAskScope) { ブロックが無い');
    const guardBody = planBranch.slice(guardIdx, guardIdx + 800);
    assert.match(guardBody, /buildCrossAskSdkOverrides\(/);
    assert.match(guardBody, /buildCrossAskEnv\(/);
  });

  test('クロス ask のフック分岐が decidePlanPermission より前に return している', () => {
    const hookIdx = planBranch.indexOf('PreToolUse: [{');
    const crossAskCheckIdx = planBranch.indexOf('if (options.crossAskScope) {', hookIdx);
    const decidePlanIdx = planBranch.indexOf('decidePlanPermission({', hookIdx);
    assert.ok(crossAskCheckIdx !== -1 && decidePlanIdx !== -1, '両方の呼び出しが見つかること');
    assert.ok(crossAskCheckIdx < decidePlanIdx, 'クロス ask チェックが decidePlanPermission より前に無い');
  });

  test('init アサート（decideCrossAskInitAssertion）の呼び出しが plan 分岐の外側（for-await ループ）にある', () => {
    assert.match(aiRunnerSource, /decideCrossAskInitAssertion\(/);
    assert.match(aiRunnerSource, /CROSS-ASK GATE REGRESSION/);
  });

  test('buildSdkPromptStream の呼び出しが options.crossAskScope を第2引数として渡している（新発見①: @パス展開の抑止）', () => {
    assert.match(aiRunnerSource, /buildSdkPromptStream\(prompt, !!options\.crossAskScope\)/);
  });

  test('crossAskProjectRootReal が plan 分岐の外側（関数スコープ）で宣言されている', () => {
    assert.match(aiRunnerSource, /let crossAskProjectRootReal: string \| undefined;/);
    // 関数スコープの宣言が plan 分岐の外（sdkOptions 宣言より前）にあることを確認
    const declIdx = aiRunnerSource.indexOf('let crossAskProjectRootReal: string | undefined;');
    const planStartIdx = aiRunnerSource.indexOf('} else if (options.usePlanMode) {');
    assert.ok(declIdx < planStartIdx, 'crossAskProjectRootReal の宣言が plan 分岐より後にある（ブロックスコープで for-await から参照できない）');
  });
});

describe('ai-runner.ts: クロス ask スコープの新ゲートが exec / raw 分岐には一切出現しない（通常利用への非関与）', () => {
  test('exec 分岐の冒頭に decideCrossAskToolPermission / buildCrossAskSdkOverrides が無い', () => {
    assert.doesNotMatch(execBranchHead, /decideCrossAskToolPermission/);
    assert.doesNotMatch(execBranchHead, /buildCrossAskSdkOverrides/);
  });

  test('raw 分岐に decideCrossAskToolPermission / buildCrossAskSdkOverrides が無い', () => {
    assert.doesNotMatch(rawBranch, /decideCrossAskToolPermission/);
    assert.doesNotMatch(rawBranch, /buildCrossAskSdkOverrides/);
  });
});

describe('connection.ts: statePolicy.crossAskScope の fail-closed チェックと sendOptions 配線', () => {
  test('strictReadonly が立たない場合に crossAskScope を拒否するガードがある', () => {
    assert.match(connectionSource, /if \(statePolicy\.crossAskScope && !strictReadonly\) \{/);
  });

  test('sendOptions に crossAskScope: statePolicy.crossAskScope が渡されている', () => {
    assert.match(connectionSource, /crossAskScope:\s*statePolicy\.crossAskScope,/);
  });

  test('fail-closed ガードが permissionPolicy/strictReadonly の計算より後、sendOptions 組み立てより前にある', () => {
    const strictReadonlyIdx = connectionSource.indexOf('const strictReadonly = permissionPolicy ===');
    const guardIdx = connectionSource.indexOf('if (statePolicy.crossAskScope && !strictReadonly) {');
    const sendOptionsIdx = connectionSource.indexOf('crossAskScope: statePolicy.crossAskScope,');
    assert.ok(strictReadonlyIdx !== -1 && guardIdx !== -1 && sendOptionsIdx !== -1, '3つの位置が全て見つかること');
    assert.ok(strictReadonlyIdx < guardIdx, 'strictReadonly 計算より前に fail-closed ガードがある');
    assert.ok(guardIdx < sendOptionsIdx, 'fail-closed ガードより後に sendOptions 組み立てが無い');
  });

  test('CLAUDE.md 安全注入（buildCrossAskClaudeMdPrompt）が statePolicy.crossAskScope の条件内にある', () => {
    const guardIdx = connectionSource.indexOf('if (statePolicy.crossAskScope) {');
    assert.ok(guardIdx !== -1);
    const guardBody = connectionSource.slice(guardIdx, guardIdx + 500);
    assert.match(guardBody, /buildCrossAskClaudeMdPrompt\(/);
  });
});

describe('session-scope.ts: crossAskScope フィールドと isolated の forcePlanTurn:true', () => {
  const sessionScopeSource = readFileSync(path.join(agentRoot, 'src', 'services', 'session-scope.ts'), 'utf8');

  test('SessionStatePolicy インターフェースに crossAskScope が定義されている', () => {
    assert.match(sessionScopeSource, /crossAskScope: boolean;/);
  });

  test('ISOLATED_STATE_POLICY の forcePlanTurn が true である', () => {
    const idx = sessionScopeSource.indexOf('const ISOLATED_STATE_POLICY: SessionStatePolicy = {');
    assert.ok(idx !== -1);
    const body = sessionScopeSource.slice(idx, idx + 600);
    assert.match(body, /forcePlanTurn:\s*true,/);
    assert.match(body, /crossAskScope:\s*true,/);
  });
});
