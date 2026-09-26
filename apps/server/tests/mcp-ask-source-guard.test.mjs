// MCP ask サイクル: ask_project の読み取り専用強制が将来のリファクタで黙って崩れないための
// ソース静的ガード（node:fs、dist/ には依存しない。thread-list-query.test.mjs と同じ手口）。
//
// これが無いと、将来 ask_project の sendPromptToAgent 呼び出しをリファクタしたとき
// resolvePermissionPolicy('ask') の指定漏れに気づけず、strictReadonly なしで質問ターンが
// 走ってしまう（プランモードの書き込み不可強制が黙って外れる）事故を防ぐ。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const TOOLS_TS_PATH = 'src/mcp/tools.ts';

function readServerSource(relPath) {
  return readFileSync(path.join(serverRoot, relPath), 'utf8');
}

describe('mcp-ask-source-guard: ask_project の実装が読み取り専用強制の配線を保っているか', () => {
  const source = readServerSource(TOOLS_TS_PATH);

  test('ask_project ツールが登録されている', () => {
    assert.match(source, /'ask_project'/);
  });

  test('get_answer ツールが登録されている', () => {
    assert.match(source, /'get_answer'/);
  });

  test('cancel_submission ツールが登録されている', () => {
    assert.match(source, /'cancel_submission'/);
  });

  // ask_project の本文だけを抽出して、その中に必要な配線があることを確認する
  // （ファイル全体に対する正規表現だと、他ツールの記述が偶然マッチしてしまう可能性があるため）。
  const askProjectStart = source.indexOf("'ask_project'");
  const askProjectEnd = source.indexOf("server.tool(\n      'get_answer'");
  const askProjectBody = source.slice(askProjectStart, askProjectEnd);

  test('ask_project の本文が抽出できている（次ツールの開始位置が見つかっている）', () => {
    assert.ok(askProjectStart > 0);
    assert.ok(askProjectEnd > askProjectStart);
  });

  test("ask_project は resolvePermissionPolicy('ask') を渡している（strictReadonly の入口）", () => {
    assert.match(askProjectBody, /resolvePermissionPolicy\('ask'\)/);
  });

  test('ask_project は planTurnId を採番していない（exec への 2 重防御: turnId を送らない）', () => {
    assert.ok(!/turnId:\s*planTurnId/.test(askProjectBody));
    assert.ok(!askProjectBody.includes('buildTurnId('));
  });

  test('ask_project は decideAskReadOnlyEnforcement を呼んでいる', () => {
    assert.match(askProjectBody, /decideAskReadOnlyEnforcement\(/);
  });

  test('ask_project は buildAskPromptPrefix をプロンプトに合成している', () => {
    assert.match(askProjectBody, /buildAskPromptPrefix\(/);
  });

  test('ask_project は Session.kind を SESSION_KIND_QUESTION で記録している', () => {
    assert.match(askProjectBody, /kind:\s*SESSION_KIND_QUESTION/);
  });

  test('approve_implementation の claim where は cancelledAt: null を含む（cancel との相互排他）', () => {
    assert.match(source, /where:\s*\{\s*id:\s*submissionId,\s*approvedAt:\s*null,\s*cancelledAt:\s*null\s*\}/);
  });

  test('cancel_submission は buildCancelClaimWhere を使って atomic claim している', () => {
    assert.match(source, /buildCancelClaimWhere\(submissionId\)/);
  });
});
