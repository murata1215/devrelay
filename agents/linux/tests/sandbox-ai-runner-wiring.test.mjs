// サイクル SB-1a-2: ai-runner.ts の Sandbox 実行配線に対する静的ガード（node:fs のみ、dist/ には
// 依存しない。cross-ask-scope-wiring.test.mjs と同じ手口）。
//
// これが無いと、将来のリファクタで以下が黙って外れても気づけない:
// - Sandbox 対象判定（decideSandboxTarget）が複数箇所に増え「判定は1か所」の原則が崩れる
// - 判定が端末モード/SDK 分岐より後に移動し、対象プロジェクトで terminalMode 等が素通りする
// - spawnClaudeCodeProcess の差し替えが sandbox 分岐の外で行われ、対象外ターンにも影響する
// - connection.ts に判定ロジックが漏れ出す（「呼び出し元から引き回さない」の原則が崩れる）

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const agentRoot = path.resolve(__dirname, '..');
const aiRunnerSource = readFileSync(path.join(agentRoot, 'src', 'services', 'ai-runner.ts'), 'utf8');
const connectionSource = readFileSync(path.join(agentRoot, 'src', 'services', 'connection.ts'), 'utf8');

describe('ai-runner.ts: Sandbox 対象判定は 1 か所だけ', () => {
  test('decideSandboxTarget( の呼び出しが ai-runner.ts 全体でちょうど 1 回だけ', () => {
    const matches = aiRunnerSource.match(/decideSandboxTarget\(/g) ?? [];
    assert.equal(matches.length, 1, `decideSandboxTarget の呼び出しが ${matches.length} 回ある（1 回のはず）`);
  });

  test('decideSandboxTarget が connection.ts には出現しない（判定を呼び出し元に漏らさない）', () => {
    assert.doesNotMatch(connectionSource, /decideSandboxTarget/);
  });

  test('decideSandboxTarget の呼び出しが sendPromptToAiImpl() の中にある', () => {
    const implStart = aiRunnerSource.indexOf('async function sendPromptToAiImpl(');
    assert.ok(implStart !== -1, 'sendPromptToAiImpl の開始位置が見つかること');
    const nextFunctionStart = aiRunnerSource.indexOf('\nasync function ', implStart + 50);
    const implEnd = nextFunctionStart !== -1 ? nextFunctionStart : aiRunnerSource.length;
    const implBody = aiRunnerSource.slice(implStart, implEnd);
    assert.match(implBody, /decideSandboxTarget\(/);
  });

  test('判定（decideSandboxTarget の呼び出し）が端末モード分岐（terminalMode 判定）より前にある', () => {
    const targetIdx = aiRunnerSource.indexOf('decideSandboxTarget(');
    const terminalBranchIdx = aiRunnerSource.indexOf(
      "if (aiTool === 'claude' && options.terminalMode) {",
    );
    assert.ok(targetIdx !== -1 && terminalBranchIdx !== -1, '両方の位置が見つかること');
    assert.ok(targetIdx < terminalBranchIdx, 'Sandbox 対象判定が端末モード分岐より後にある');
  });

  test('判定が SDK 分岐（aiTool === claude の起動）より前にある', () => {
    const targetIdx = aiRunnerSource.indexOf('decideSandboxTarget(');
    const sdkBranchIdx = aiRunnerSource.indexOf("if (aiTool === 'claude') {\n    return sendPromptToAiSdk(");
    assert.ok(targetIdx !== -1 && sdkBranchIdx !== -1, '両方の位置が見つかること');
    assert.ok(targetIdx < sdkBranchIdx, 'Sandbox 対象判定が SDK 分岐より後にある');
  });
});

describe('ai-runner.ts: spawnClaudeCodeProcess の差し替えは sandbox 分岐の中だけ', () => {
  test('sdkOptions.spawnClaudeCodeProcess の代入が ai-runner.ts 全体でちょうど 1 回だけ', () => {
    const matches = aiRunnerSource.match(/sdkOptions\.spawnClaudeCodeProcess\s*=/g) ?? [];
    assert.equal(matches.length, 1, `spawnClaudeCodeProcess の代入が ${matches.length} 回ある（1 回のはず）`);
  });

  test('spawnClaudeCodeProcess が connection.ts には出現しない', () => {
    assert.doesNotMatch(connectionSource, /spawnClaudeCodeProcess/);
  });

  test('spawnClaudeCodeProcess の代入が if (sandboxLaunch) { ブロックの中にある', () => {
    const assignIdx = aiRunnerSource.indexOf('sdkOptions.spawnClaudeCodeProcess =');
    assert.ok(assignIdx !== -1);
    const guardIdx = aiRunnerSource.lastIndexOf('if (sandboxLaunch) {', assignIdx);
    assert.ok(guardIdx !== -1, 'if (sandboxLaunch) { が代入より前に見つかること');
    // ガードの開始から代入までの間に閉じ括弧（ブロック終端）が無いことを簡易確認
    const between = aiRunnerSource.slice(guardIdx, assignIdx);
    assert.doesNotMatch(between, /\n  \}\n/);
  });

  test('sendPromptToAiSdk() が sandboxLaunch を引数として受け取り、呼び出し側から渡されている', () => {
    assert.match(aiRunnerSource, /sandboxLaunch\?: SandboxLaunch\s*\n\): Promise<AiRunResult>/);
    assert.match(
      aiRunnerSource,
      /sendPromptToAiSdk\(sessionId, prompt, projectPath, claudeSessionId, config, onOutput, options, sandboxLaunch\)/,
    );
  });

  test('ターン終了時に sandboxLaunch.dispose() を呼ぶ finally ガードがある', () => {
    assert.match(aiRunnerSource, /if \(sandboxLaunch\) \{\s*\n\s*await sandboxLaunch\.dispose\(\);/);
  });
});

describe('connection.ts: handoverTurn の配線（本番呼び出し・retryOptions の両方）', () => {
  test('sendOptions に handoverTurn: payload.handoverTurn が渡されている', () => {
    assert.match(connectionSource, /handoverTurn:\s*payload\.handoverTurn,/);
  });

  test('retryOptions にも handoverTurn: sendOptions.handoverTurn が渡されている', () => {
    assert.match(connectionSource, /handoverTurn:\s*sendOptions\.handoverTurn,/);
  });
});
