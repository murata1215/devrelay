// 高辻ナレッジ サイクル4.5: MCP `ask_knowledge` の配線ソース静的ガード（node:fs、dist/ には依存しない。
// knowledge-wiring.test.mjs / knowledge-admin-wiring.test.mjs / mcp-ask-source-guard.test.mjs と同じ手口）。
//
// これが無いと、将来のリファクタで以下が黙って外れても気づけない:
// - ask_knowledge が isKnowledgeEnabled(DEVRELAY_KNOWLEDGE) ブロックの外に出てしまう
// - ask_knowledge が isKnowledgeAnswerEnabled(DEVRELAY_KNOWLEDGE_ANSWER) で入れ子になっていない
//   （DEVRELAY_KNOWLEDGE_ANSWER=0 でも ask_knowledge が登録されてしまう）
// - ask_knowledge が search_knowledge より前、または get_knowledge_thread より後、あるいは
//   「書き込み系ツール」セクションの後ろに紛れ込む（readOnlyHint の意図が崩れる）
// - ask_knowledge が REST と別の流量制御状態を持ってしまう（answerGuardState の共有が外れる）
// - ask_knowledge の本文に、禁止されている引用符つきの他ツール名文字列が紛れ込む（既存
//   wiring テストの indexOf/slice 境界がずれる事故の再発防止）

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

describe('mcp/tools.ts: ask_knowledge の配置・killswitch', () => {
  const source = readServerSource(TOOLS_TS_PATH);

  const searchKnowledgeIndex = source.indexOf("'search_knowledge'");
  const askKnowledgeIndex = source.indexOf("'ask_knowledge'");
  const getKnowledgeThreadIndex = source.indexOf("'get_knowledge_thread'");
  const writeSectionIndex = source.indexOf('書き込み系ツール');

  test('ask_knowledge ツールが登録されている', () => {
    assert.ok(askKnowledgeIndex > 0, 'ask_knowledge not found');
  });

  test('search_knowledge の後、get_knowledge_thread の前、「書き込み系ツール」セクションより前に置かれている', () => {
    assert.ok(searchKnowledgeIndex > 0, 'search_knowledge not found');
    assert.ok(getKnowledgeThreadIndex > 0, 'get_knowledge_thread not found');
    assert.ok(writeSectionIndex > 0, '書き込み系ツール セクションコメントが見つからない');
    assert.ok(askKnowledgeIndex > searchKnowledgeIndex, 'ask_knowledge は search_knowledge より後に置くこと');
    assert.ok(getKnowledgeThreadIndex > askKnowledgeIndex, 'ask_knowledge は get_knowledge_thread より前に置くこと');
    assert.ok(writeSectionIndex > askKnowledgeIndex, 'ask_knowledge は「書き込み系ツール」セクションより前に置くこと');
  });

  // ask_knowledge の本文だけを抽出（次ツール get_knowledge_thread の開始位置まで）。
  const askKnowledgeBody = source.slice(askKnowledgeIndex, getKnowledgeThreadIndex);

  test('ask_knowledge の本文が抽出できている', () => {
    assert.ok(askKnowledgeBody.length > 0);
  });

  test('isKnowledgeAnswerEnabled(process.env.DEVRELAY_KNOWLEDGE_ANSWER) で入れ子になっている', () => {
    // ask_knowledge 登録の直前にある isKnowledgeAnswerEnabled ガードを検出する
    // （search_knowledge と get_knowledge_thread の間に 1 箇所だけあるはず）。
    const betweenSearchAndThread = source.slice(searchKnowledgeIndex, getKnowledgeThreadIndex);
    assert.match(betweenSearchAndThread, /isKnowledgeAnswerEnabled\(process\.env\.DEVRELAY_KNOWLEDGE_ANSWER\)/);
  });

  test('answerKnowledge( を呼んでいる（REST と同じオーケストレーション関数）', () => {
    assert.match(askKnowledgeBody, /answerKnowledge\(/);
  });

  test('acquireAnswerSlot( で流量制御を取得し、finally で releaseAnswerSlot( している（REST と同じ answerGuardState を共有）', () => {
    assert.match(askKnowledgeBody, /acquireAnswerSlot\(answerGuardState,/);
    assert.match(askKnowledgeBody, /releaseAnswerSlot\(answerGuardState, userId\)/);
    assert.match(askKnowledgeBody, /\}\s*finally\s*\{/);
  });

  test('resolveUserLanguage(userId) で言語を解決している（REST の resolveUserLanguage と同じ流儀）', () => {
    assert.match(askKnowledgeBody, /resolveUserLanguage\(userId\)/);
  });

  test('history/knownSources を zod で任意引数として受けている', () => {
    assert.match(askKnowledgeBody, /history:\s*z\.array/);
    assert.match(askKnowledgeBody, /knownSources:\s*z\.array/);
  });

  test('禁止文字列（引用符つきの他ツール名・書き込み系ツール）が本文に混入していない（indexOf/slice 境界事故の再発防止）', () => {
    for (const forbidden of ["'search_knowledge'", "'get_knowledge_thread'", "'approve_implementation'", "'set_thread_classification'", '書き込み系ツール']) {
      assert.equal(askKnowledgeBody.includes(forbidden), false, `ask_knowledge の本文に禁止文字列が含まれている: ${forbidden}`);
    }
  });

  test('戻り値の sources マッピングに sourceId（aiMessageId のエイリアス）を含めている（会話継続の往復用）', () => {
    assert.match(askKnowledgeBody, /sourceId:\s*s\.aiMessageId/);
  });
});

describe('mcp/tools.ts: import 配線（answerGuardState の共有・crypto の追加）', () => {
  const source = readServerSource(TOOLS_TS_PATH);

  test('answerGuardState を knowledge-answer-slot.ts から import している（createAnswerGuardState を自前で呼ばない）', () => {
    assert.match(source, /import\s*\{\s*answerGuardState\s*\}\s*from\s*['"]\.\.\/services\/knowledge-answer-slot\.js['"]/);
    assert.equal(source.includes('createAnswerGuardState'), false);
  });

  test('answerKnowledge/AnswerSink/KnowledgeAnswerDoneResult を services/knowledge-answer.js から import している', () => {
    assert.match(source, /import\s*\{\s*answerKnowledge,\s*type\s*AnswerSink,\s*type\s*KnowledgeAnswerDoneResult\s*\}\s*from\s*['"]\.\.\/services\/knowledge-answer\.js['"]/);
  });
});

describe('mcp/server.ts: SERVER_INSTRUCTIONS が ask_knowledge に言及している', () => {
  test('instructions 文字列に ask_knowledge が含まれる', () => {
    const source = readServerSource('src/mcp/server.ts');
    assert.match(source, /ask_knowledge/);
  });
});

describe('回帰ガード: 既存 4 本の wiring テストが前提にする境界が ask_knowledge 挿入後も保たれている', () => {
  const source = readServerSource(TOOLS_TS_PATH);

  test('knowledge-wiring.test.mjs の search_knowledge 本文抽出（search_knowledge→書き込み系ツール）に searchKnowledge( が含まれる', () => {
    const start = source.indexOf("'search_knowledge'");
    const end = source.indexOf('書き込み系ツール');
    assert.match(source.slice(start, end), /searchKnowledge\(/);
  });

  test('knowledge-admin-wiring.test.mjs の search_knowledge→get_knowledge_thread 抽出に searchKnowledge({ が含まれる', () => {
    const start = source.indexOf("'search_knowledge'");
    const end = source.indexOf("'get_knowledge_thread'");
    assert.match(source.slice(start, end), /searchKnowledge\(\{/);
  });

  test('mcp-ask-source-guard.test.mjs の get_plan→get_build_status 抽出境界が無傷', () => {
    const getPlanStart = source.indexOf("'get_plan'");
    const getPlanEnd = source.indexOf("server.tool(\n    'get_build_status'");
    assert.ok(getPlanStart > 0 && getPlanEnd > getPlanStart);
  });

  test('mcp-ask-source-guard.test.mjs の get_answer→cancel_submission 抽出境界が無傷', () => {
    const getAnswerStart = source.indexOf("server.tool(\n      'get_answer'");
    const getAnswerEnd = source.indexOf("server.tool(\n    'cancel_submission'");
    assert.ok(getAnswerStart > 0 && getAnswerEnd > getAnswerStart);
  });
});
