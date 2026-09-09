// #381 サブサイクル C: Windows Agent の agentScopeId 配線が壊れていないかの回帰テスト。
//
// R-B2（このサイクル最大の静かな事故源）: ai-runner.ts の saveClaudeSessionId は
// `(projectPath, sessionId, mode?, agentScopeId?)` の4引数形。3引数形にすると agentScopeId が
// 誤って mode スロットに入り、型エラーなしで不正な claude-session-meta.json を書いてしまう。
// このテストはその形が壊れて再発していないことをソース grep で確認する（R-B2 トリップワイヤ）。
//
// 他の回帰テストと同じ流儀で、ビルド成果物ではなく src を直接読んでテキストパターンを検証する
// （リファクタで消えないようにするため）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONNECTION_TS = join(__dirname, '..', 'src', 'services', 'connection.ts');
const AI_RUNNER_TS = join(__dirname, '..', 'src', 'services', 'ai-runner.ts');

test('scope-wiring: saveClaudeSessionId は4引数形（agentScopeId を明示 undefined 越しに渡す）', async () => {
  const src = await readFile(AI_RUNNER_TS, 'utf-8');
  assert.match(
    src,
    /saveClaudeSessionId\(projectPath, parsed\.sessionId, undefined, options\.agentScopeId\)/,
    '4引数形の saveClaudeSessionId(projectPath, parsed.sessionId, undefined, options.agentScopeId) が見当たらない'
  );
});

test('scope-wiring: R-B2 再発防止（saveClaudeSessionId の2引数形/3引数形が存在しない）', async () => {
  const src = await readFile(AI_RUNNER_TS, 'utf-8');
  assert.equal(
    /saveClaudeSessionId\(projectPath, parsed\.sessionId\)/.test(src),
    false,
    'saveClaudeSessionId の2引数形が再発している'
  );
  assert.equal(
    /saveClaudeSessionId\(projectPath, parsed\.sessionId, options\.agentScopeId\)/.test(src),
    false,
    'saveClaudeSessionId の3引数形（agentScopeId が mode スロットに誤って入る形）が再発している'
  );
});

test('scope-wiring: ai-runner.ts の options.agentScopeId 配線が18箇所以上ある', async () => {
  const src = await readFile(AI_RUNNER_TS, 'utf-8');
  const matches = src.match(/options\.agentScopeId/g) || [];
  assert.ok(matches.length >= 18, `options.agentScopeId の出現数が想定より少ない (${matches.length})`);
});

test('scope-wiring: connection.ts の agentScopeId 配線が存在する（A/Bでは0件だった）', async () => {
  const src = await readFile(CONNECTION_TS, 'utf-8');
  const matches = src.match(/agentScopeId/g) || [];
  assert.ok(matches.length > 0, 'connection.ts に agentScopeId の配線が見当たらない');
});

test('scope-wiring: handleAgreementApply の範囲内に agentScopeId が現れない（将来の親切な修正で誤って追加されないための固定化）', async () => {
  const src = await readFile(CONNECTION_TS, 'utf-8');
  const startMarker = 'async function handleAgreementApply(';
  const startIndex = src.indexOf(startMarker);
  assert.ok(startIndex >= 0, 'handleAgreementApply が見当たらない（関数名変更等の可能性）');
  // 次の `\nasync function ` または `\nfunction ` を関数の終端とみなす（雑だが十分な精度）
  const afterStart = src.slice(startIndex + startMarker.length);
  const nextFnMatch = afterStart.match(/\n(?:async )?function /);
  const body = nextFnMatch ? afterStart.slice(0, nextFnMatch.index) : afterStart;
  assert.equal(/agentScopeId/.test(body), false, 'handleAgreementApply 内に agentScopeId が追加されている（プランのスコープ外）');
});
