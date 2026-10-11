// 高辻ナレッジ サイクル2: 配線（wiring）のソース静的ガード（node:fs、dist/ には依存しない。
// knowledge-wiring.test.mjs / mcp-ask-source-guard.test.mjs と同じ手口）。
//
// これが無いと、将来のリファクタで以下が黙って外れても気づけない:
// - get_knowledge_thread / set_thread_classification の登録漏れ・キルスイッチ漏れ
// - get_knowledge_thread が「書き込み系ツール」セクションへ混入する
// - set_thread_classification が ask_project/get_answer の間に紛れ込み mcp-ask-source-guard の
//   インデント依存 needle を壊す
// - index.ts での knowledgeAdminApiRoutes 登録漏れ
// - getEmbeddingApiKey が DEVRELAY_EMBEDDING_API_KEY を見ていない／キー値をログに出している
// - org-control.ts の SupervisionAction から 'search_knowledge' が消える

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');

function readServerSource(relPath) {
  return readFileSync(path.join(serverRoot, relPath), 'utf8');
}

describe('tools.ts: get_knowledge_thread は参照系（isKnowledgeEnabled ブロック内）に置かれている', () => {
  const source = readServerSource('src/mcp/tools.ts');

  test('get_knowledge_thread ツールが登録されている', () => {
    assert.match(source, /'get_knowledge_thread'/);
  });

  test('search_knowledge と同じ isKnowledgeEnabled ブロック内にある（search_knowledge の後、書き込み系ツールより前）', () => {
    const searchKnowledgeIndex = source.indexOf("'search_knowledge'");
    const getKnowledgeThreadIndex = source.indexOf("'get_knowledge_thread'");
    const writeSectionIndex = source.indexOf('書き込み系ツール');
    assert.ok(searchKnowledgeIndex > 0, 'search_knowledge not found');
    assert.ok(getKnowledgeThreadIndex > searchKnowledgeIndex, 'get_knowledge_thread は search_knowledge より後に置くこと');
    assert.ok(writeSectionIndex > getKnowledgeThreadIndex, 'get_knowledge_thread は「書き込み系ツール」セクションより前に置くこと');
  });

  test('get_knowledge_thread は getKnowledgeThread サービス関数を呼んでいる', () => {
    const start = source.indexOf("'get_knowledge_thread'");
    const end = source.indexOf('書き込み系ツール');
    const body = source.slice(start, end);
    assert.match(body, /getKnowledgeThread\(\{/);
  });
});

describe('tools.ts: set_thread_classification は approve_implementation の後・MCP ask サイクルより前に置かれている', () => {
  const source = readServerSource('src/mcp/tools.ts');

  test('set_thread_classification ツールが登録されている', () => {
    assert.match(source, /'set_thread_classification'/);
  });

  test('isKnowledgeEnabled(process.env.DEVRELAY_KNOWLEDGE) でガードされている（set_thread_classification の直前）', () => {
    const idx = source.indexOf("'set_thread_classification'");
    const before = source.slice(Math.max(0, idx - 400), idx);
    assert.match(before, /isKnowledgeEnabled\(process\.env\.DEVRELAY_KNOWLEDGE\)/);
  });

  // 注意: 'MCP ask サイクル' という文字列は approve_implementation の本文コメント内
  // （cancelledAt の claim 条件についての説明）にも出現するため、セクション見出しコメントの
  // フル文字列で一意に特定する（短い部分文字列で indexOf すると誤った(早い)位置を拾う）。
  const askSectionHeader = '// MCP ask サイクル: 質問（ask_project / get_answer）と取り消し（cancel_submission）';

  test('approve_implementation より後、MCP ask サイクルのセクション見出しより前に置かれている', () => {
    const approveIndex = source.indexOf("'approve_implementation'");
    const setClassificationIndex = source.indexOf("'set_thread_classification'");
    const askSectionIndex = source.indexOf(askSectionHeader);
    assert.ok(approveIndex > 0, 'approve_implementation not found');
    assert.ok(askSectionIndex > 0, 'MCP ask サイクルのセクション見出しが見つからない');
    assert.ok(setClassificationIndex > approveIndex, 'set_thread_classification は approve_implementation より後に置くこと');
    assert.ok(askSectionIndex > setClassificationIndex, 'set_thread_classification は MCP ask サイクルのセクション見出しより前に置くこと');
  });

  test('set_thread_classification は setThreadClassification サービス関数を呼んでいる', () => {
    const start = source.indexOf("'set_thread_classification'");
    const end = source.indexOf(askSectionHeader);
    const body = source.slice(start, end);
    assert.match(body, /setThreadClassification\(\{/);
  });
});

describe('回帰ガード: mcp-ask-source-guard.test.mjs / knowledge-wiring.test.mjs が壊れていないこと', () => {
  const source = readServerSource('src/mcp/tools.ts');

  test('ask_project / get_answer / cancel_submission は依然として登録されている（インデント位置も不変）', () => {
    assert.match(source, /'ask_project'/);
    assert.match(source, /server\.tool\(\n {6}'get_answer'/);
    assert.match(source, /server\.tool\(\n {4}'cancel_submission'/);
  });

  test('search_knowledge は依然として登録され、searchKnowledge を呼んでいる', () => {
    assert.match(source, /'search_knowledge'/);
    const start = source.indexOf("'search_knowledge'");
    const end = source.indexOf("'get_knowledge_thread'");
    assert.match(source.slice(start, end), /searchKnowledge\(\{/);
  });
});

describe('index.ts: knowledgeAdminApiRoutes の登録', () => {
  const source = readServerSource('src/index.ts');

  test('knowledgeAdminApiRoutes を import している', () => {
    assert.match(source, /import\s*\{\s*knowledgeAdminApiRoutes\s*\}\s*from\s*['"]\.\/routes\/knowledge-admin-api\.js['"]/);
  });

  test('app.register(knowledgeAdminApiRoutes) を呼んでいる', () => {
    assert.match(source, /app\.register\(knowledgeAdminApiRoutes\)/);
  });

  test('既存の knowledgeApiRoutes 登録も無傷である（回帰）', () => {
    assert.match(source, /import\s*\{\s*knowledgeApiRoutes\s*\}\s*from\s*['"]\.\/routes\/knowledge-api\.js['"]/);
    assert.match(source, /app\.register\(knowledgeApiRoutes\)/);
  });
});

describe('knowledge-service.ts: getEmbeddingApiKey が組織共通キーへフォールバックし、キー値をログに出さない', () => {
  const source = readServerSource('src/services/knowledge-service.ts');

  test('getEmbeddingApiKey が存在し、個人キー → DEVRELAY_EMBEDDING_API_KEY の順にフォールバックしている', () => {
    const start = source.indexOf('export async function getEmbeddingApiKey');
    assert.ok(start > 0, 'getEmbeddingApiKey not found');
    const end = source.indexOf('\n}', start);
    const body = source.slice(start, end);
    assert.match(body, /getOpenAiApiKey\(userId\)/);
    assert.match(body, /process\.env\.DEVRELAY_EMBEDDING_API_KEY/);
  });

  test('getEmbeddingApiKey の本体は console.log/console.error でキー変数を出力していない', () => {
    const start = source.indexOf('export async function getEmbeddingApiKey');
    const end = source.indexOf('\n}', start);
    const body = source.slice(start, end);
    assert.ok(!/console\.(log|error)/.test(body), 'getEmbeddingApiKey 内に console 出力がある');
  });

  test('processTurnKnowledge / searchKnowledge は getEmbeddingApiKey を使っている（getOpenAiApiKey 直呼びに戻っていない）', () => {
    const processStart = source.indexOf('export async function processTurnKnowledge');
    const processEnd = source.indexOf('\nexport async function listUserIdsWithPendingChunks');
    assert.match(source.slice(processStart, processEnd), /getEmbeddingApiKey\(userId\)/);

    const searchStart = source.indexOf('export async function searchKnowledge');
    const searchEnd = source.indexOf('\n/** `getKnowledgeThread` の入力');
    assert.match(source.slice(searchStart, searchEnd), /getEmbeddingApiKey\(params\.userId\)/);
  });
});

describe('org-control.ts: SupervisionAction に search_knowledge が追加されている', () => {
  const source = readServerSource('src/services/org-control.ts');

  test("SupervisionAction 型に 'search_knowledge' が含まれる", () => {
    assert.match(source, /export type SupervisionAction =[^;]*'search_knowledge'/);
  });

  test('既存のアクション種別（view_sessions/view_messages/summarize）は無傷である', () => {
    assert.match(source, /'view_sessions'/);
    assert.match(source, /'view_messages'/);
    assert.match(source, /'summarize'/);
  });
});

describe('routes/organization.ts: knowledge-admin-api.ts が再利用するヘルパーが export されている', () => {
  const source = readServerSource('src/routes/organization.ts');

  test('getMembership / requireOrgAdmin / requireOrgManagerOrAdmin が export されている', () => {
    assert.match(source, /export async function getMembership/);
    assert.match(source, /export async function requireOrgAdmin/);
    assert.match(source, /export async function requireOrgManagerOrAdmin/);
  });
});
