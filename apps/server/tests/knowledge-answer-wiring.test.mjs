// 高辻ナレッジ サイクル4: 配線（wiring）のソース静的ガード（node:fs、dist/ には依存しない。
// knowledge-wiring.test.mjs / mcp-ask-source-guard.test.mjs と同じ手口）。
//
// これが無いと、将来のリファクタで以下が黙って外れても気づけない:
// - `POST /api/knowledge/answer` の killswitch（DEVRELAY_KNOWLEDGE_ANSWER）チェックが外れる
// - WS 配信が `broadcastWebRawMessage`（全ユーザー配信）を誤って使ってしまう
//   （answerId 付きの delta は必ず単一ユーザー宛のはず）
// - `SupervisionAction` から既存の 'search_knowledge' / 'summarize' が消える
// - `ChatProvider.chat()` の既存実装が本サイクルで書き換えられる（既存呼び出し元を壊す）
// - `resolveChatProvider` の既存 3 引数呼び出し（voice-assist.ts）が壊れる

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

describe('routes/knowledge-api.ts: POST /api/knowledge/answer の配線', () => {
  const source = readServerSource('src/routes/knowledge-api.ts');

  test('POST /api/knowledge/answer が登録されている', () => {
    assert.match(source, /app\.post\(\s*['"]\/api\/knowledge\/answer['"]/);
  });

  test('isKnowledgeAnswerEnabled(process.env.DEVRELAY_KNOWLEDGE_ANSWER) でガードされている', () => {
    assert.match(source, /isKnowledgeAnswerEnabled\(process\.env\.DEVRELAY_KNOWLEDGE_ANSWER\)/);
  });

  test('既存 GET /api/knowledge/search の killswitch（DEVRELAY_KNOWLEDGE）は無変更', () => {
    assert.match(source, /isKnowledgeEnabled\(process\.env\.DEVRELAY_KNOWLEDGE\)/);
  });

  test('WS 配信は sendWebRawMessage のみを使い、broadcastWebRawMessage は使わない（単一ユーザー宛のため）', () => {
    assert.match(source, /sendWebRawMessage\(/);
    assert.ok(!source.includes('broadcastWebRawMessage'), 'broadcastWebRawMessage を使ってはいけない（全ユーザー配信になってしまう）');
  });

  test('chatId は web:${userId}:${tabId} の形で組み立てている（既存 chatId 規約と同形）', () => {
    assert.match(source, /`web:\$\{userId\}:\$\{body\.tabId\}`/);
  });

  test('answerGuardState はモジュールスコープで 1 個だけ保持する（raw-completion-guard と同じ流儀）', () => {
    const matches = source.match(/createAnswerGuardState\(\)/g) ?? [];
    assert.equal(matches.length, 1, 'createAnswerGuardState() の呼び出しは 1 回だけであること');
  });

  test('スロット解放（releaseAnswerSlot）が http 経路・ws 経路の両方にある', () => {
    const matches = source.match(/releaseAnswerSlot\(/g) ?? [];
    assert.ok(matches.length >= 2, `releaseAnswerSlot の呼び出しが想定より少ない: ${matches.length}`);
  });
});

describe('services/knowledge-answer.ts: 監査アクション', () => {
  const source = readServerSource('src/services/knowledge-answer.ts');

  test("recordSupervisionAudit は 'summarize' アクションで呼んでいる（search_knowledge とは別アクション）", () => {
    assert.match(source, /recordSupervisionAudit\(\s*params\.userId,\s*ownerId,\s*'summarize'/);
  });

  test('loadKnowledgeTurnTexts を使っている（searchKnowledge の snippet ではなく全文を取得）', () => {
    assert.match(source, /loadKnowledgeTurnTexts\(/);
  });
});

describe("org-control.ts: SupervisionAction に既存の 'search_knowledge' / 'summarize' が残っている", () => {
  const source = readServerSource('src/services/org-control.ts');

  test("'search_knowledge' が残っている", () => {
    assert.match(source, /'search_knowledge'/);
  });

  test("'summarize' が残っている", () => {
    assert.match(source, /'summarize'/);
  });
});

describe('services/chat-provider.ts: 既存 chat() 呼び出し元・既存シグネチャの無変更', () => {
  const source = readServerSource('src/services/chat-provider.ts');

  test('OpenAIChatProvider.chat() は既存の request 形状（response_format/jsonMode）を維持している', () => {
    assert.match(source, /response_format: params\.jsonMode \? \{ type: 'json_object' as const \} : undefined/);
  });

  test('chatStream は任意（optional）メソッドとして追加されている（既存プロバイダーに実装義務を課さない）', () => {
    assert.match(source, /chatStream\?\(/);
  });

  test('resolveChatProvider は 4 引数目（model）を任意で受け取る', () => {
    assert.match(source, /resolveChatProvider\(\s*userId: string,\s*provider: AiProvider,\s*apiKey: string,\s*model\?: string,?\s*\)/);
  });
});

describe('voice-assist.ts: resolveChatProvider の既存 3 引数呼び出しが無変更', () => {
  const source = readServerSource('src/services/voice-assist.ts');

  test('resolveChatProvider(userId, providerInfo.provider, providerInfo.apiKey) のまま（4 引数目を渡していない）', () => {
    assert.match(source, /resolveChatProvider\(userId, providerInfo\.provider, providerInfo\.apiKey\)/);
  });
});

describe('回帰ガード: knowledge-wiring.test.mjs が前提にしている既存配線が壊れていないこと', () => {
  test('index.ts: knowledgeApiRoutes の登録は本サイクルでも 1 本のまま（同一ファイルに POST を追加したため index.ts 自体は無変更）', () => {
    const source = readServerSource('src/index.ts');
    const matches = source.match(/app\.register\(knowledgeApiRoutes\)/g) ?? [];
    assert.equal(matches.length, 1);
  });
});
