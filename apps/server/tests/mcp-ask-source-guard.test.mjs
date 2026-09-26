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

  // 2026-09-26 サイクル: get_answer/get_plan から進捗表示行（📊 Rate Limit / 🔧 …を使用中... 等）を
  // 除外する対応が、将来のリファクタで黙って外れないための配線ガード。
  // get_plan の本文だけを抽出（次ツール get_build_status の開始位置まで）。
  const getPlanStart = source.indexOf("'get_plan'");
  const getPlanEnd = source.indexOf("server.tool(\n    'get_build_status'");
  const getPlanBody = source.slice(getPlanStart, getPlanEnd);

  test('get_plan の本文が抽出できている（次ツールの開始位置が見つかっている）', () => {
    assert.ok(getPlanStart > 0);
    assert.ok(getPlanEnd > getPlanStart);
  });

  test('get_plan は sanitizeAiAnswer で進捗表示行を除去してから planMarkdown/summary を組み立てている', () => {
    assert.match(getPlanBody, /sanitizeAiAnswer\(latestMessage\.content\)/);
    // summary は sanitize 後の変数（planMarkdown）から切り出しており、
    // latestMessage.content を直接 slice していない（先頭バイトのズレ防止）
    assert.ok(!/latestMessage\.content\.slice/.test(getPlanBody));
    assert.match(getPlanBody, /summary:\s*planMarkdown\.slice\(0,\s*500\)/);
  });

  // get_answer の本文だけを抽出（次ツール cancel_submission の開始位置まで）。
  const getAnswerStart = source.indexOf("server.tool(\n      'get_answer'");
  const getAnswerEnd = source.indexOf("server.tool(\n    'cancel_submission'");
  const getAnswerBody = source.slice(getAnswerStart, getAnswerEnd);

  test('get_answer の本文が抽出できている（次ツールの開始位置が見つかっている）', () => {
    assert.ok(getAnswerStart > 0);
    assert.ok(getAnswerEnd > getAnswerStart);
  });

  test('get_answer の answered 分岐は sanitizeAiAnswer で進捗表示行を除去してから answer を返している', () => {
    assert.match(getAnswerBody, /sanitizeAiAnswer\(latestAiMessage!\.content\)/);
  });

  test('get_plan/get_answer は DEVRELAY_MCP_ANSWER_RAW キルスイッチで原文へ戻せる', () => {
    assert.match(getPlanBody, /isMcpAnswerRawMode\(process\.env\)/);
    assert.match(getAnswerBody, /isMcpAnswerRawMode\(process\.env\)/);
  });
});
