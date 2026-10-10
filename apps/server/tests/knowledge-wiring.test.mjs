// 高辻ナレッジ サイクル1: 配線（wiring）のソース静的ガード（node:fs、dist/ には依存しない。
// thread-list-filter.test.mjs / mcp-ask-source-guard.test.mjs と同じ手口）。
//
// これが無いと、将来のリファクタで以下が黙って外れても気づけない:
// - agent-manager.ts の fire-and-forget 呼び出し（AI 出力保存時にナレッジ化が走らなくなる）
// - tools.ts の search_knowledge が「書き込み系」セクションへ混入する（readOnlyHint の意図が崩れる）
// - index.ts での knowledgeApiRoutes 登録漏れ（REST が 404 のまま気づかれない）
// - bootstrap.sql のセクション 5・6 欠落（embedding 列・HNSW 索引の手順が失われる）

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

describe('agent-manager.ts: processTurnKnowledge の fire-and-forget 配線', () => {
  const source = readServerSource('src/services/agent-manager.ts');

  test('processTurnKnowledge を import している', () => {
    assert.match(source, /import\s*\{\s*processTurnKnowledge\s*\}\s*from\s*['"]\.\/knowledge-service\.js['"]/);
  });

  test('isKnowledgeEnabled(process.env.DEVRELAY_KNOWLEDGE) でガードされている', () => {
    assert.match(source, /isKnowledgeEnabled\(process\.env\.DEVRELAY_KNOWLEDGE\)/);
  });

  test('processTurnKnowledge(aiMessage.id) を fire-and-forget（.catch で握り、await/returnしない）で呼んでいる', () => {
    assert.match(source, /processTurnKnowledge\(aiMessage\.id\)\s*\.catch\(/);
    // await processTurnKnowledge( のような同期待ちになっていないこと
    assert.ok(!/await\s+processTurnKnowledge\(/.test(source));
  });
});

describe('tools.ts: search_knowledge が参照系セクションに置かれている', () => {
  const source = readServerSource('src/mcp/tools.ts');

  test('search_knowledge ツールが登録されている', () => {
    assert.match(source, /'search_knowledge'/);
  });

  test('isKnowledgeEnabled(process.env.DEVRELAY_KNOWLEDGE) でガードされている', () => {
    assert.match(source, /isKnowledgeEnabled\(process\.env\.DEVRELAY_KNOWLEDGE\)/);
  });

  test('search_knowledge は「書き込み系ツール」セクションより前（参照系）に置かれている', () => {
    const searchKnowledgeIndex = source.indexOf("'search_knowledge'");
    const writeSectionIndex = source.indexOf('書き込み系ツール');
    assert.ok(searchKnowledgeIndex > 0, 'search_knowledge not found');
    assert.ok(writeSectionIndex > 0, '書き込み系ツール セクションコメントが見つからない');
    assert.ok(
      searchKnowledgeIndex < writeSectionIndex,
      'search_knowledge は「書き込み系ツール」セクションより前に置くこと'
    );
  });

  test('search_knowledge は searchKnowledge サービス関数を呼んでいる', () => {
    const start = source.indexOf("'search_knowledge'");
    const end = source.indexOf('書き込み系ツール');
    const body = source.slice(start, end);
    assert.match(body, /searchKnowledge\(\{/);
  });
});

describe('index.ts: knowledgeApiRoutes の登録', () => {
  const source = readServerSource('src/index.ts');

  test('knowledgeApiRoutes を import している', () => {
    assert.match(source, /import\s*\{\s*knowledgeApiRoutes\s*\}\s*from\s*['"]\.\/routes\/knowledge-api\.js['"]/);
  });

  test('app.register(knowledgeApiRoutes) を呼んでいる', () => {
    assert.match(source, /app\.register\(knowledgeApiRoutes\)/);
  });
});

describe('bootstrap.sql: KnowledgeChunk 用のセクション 5・6 が存在する', () => {
  const source = readServerSource('prisma/bootstrap.sql');

  test('セクション 5（KnowledgeChunk.embedding 列）が存在する', () => {
    assert.match(source, /ALTER TABLE "KnowledgeChunk" ADD COLUMN IF NOT EXISTS embedding vector\(1536\)/);
  });

  test('セクション 6（HNSW 索引）が存在する', () => {
    assert.match(source, /CREATE INDEX IF NOT EXISTS idx_knowledgechunk_embedding/);
    assert.match(source, /USING hnsw \(embedding vector_cosine_ops\)/);
  });

  test('db push が稼働中 DB の embedding 列を DROP する旨の警告コメントがある', () => {
    assert.match(source, /DROP COLUMN/);
  });
});

describe('回帰ガード: mcp-ask-source-guard.test.mjs が壊れていないこと（tools.ts を共に触るため）', () => {
  test('ask_project / get_answer / cancel_submission は依然として登録されている', () => {
    const source = readServerSource('src/mcp/tools.ts');
    assert.match(source, /'ask_project'/);
    assert.match(source, /'get_answer'/);
    assert.match(source, /'cancel_submission'/);
  });
});
