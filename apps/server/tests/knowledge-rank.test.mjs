// 高辻ナレッジ サイクル1: apps/server/src/services/knowledge-rank.ts の単体テスト。
// 外部 import ゼロの純関数をコンパイル済み dist から直接 import する
// （ask-guard.test.mjs と同じ流儀）。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  isKnowledgeEnabled,
  normalizeKnowledgeParams,
  decideKnowledgeCoverage,
  escapeLikePattern,
  isInputCausedEmbeddingError,
  KNOWLEDGE_RRF_K,
  fuseKnowledgeCandidates,
  buildKnowledgeSnippet,
} from '../dist/services/knowledge-rank.js';

// --- isKnowledgeEnabled ---

describe('isKnowledgeEnabled', () => {
  test('undefined → true（既定 ON）', () => {
    assert.equal(isKnowledgeEnabled(undefined), true);
  });
  test('"0" → false', () => {
    assert.equal(isKnowledgeEnabled('0'), false);
  });
  test('"1"・その他の値 → true', () => {
    assert.equal(isKnowledgeEnabled('1'), true);
    assert.equal(isKnowledgeEnabled('yes'), true);
  });
});

// --- normalizeKnowledgeParams ---

describe('normalizeKnowledgeParams', () => {
  test('query 省略/空文字 → エラー', () => {
    assert.deepEqual(normalizeKnowledgeParams({}), { ok: false, error: 'query is required' });
    assert.deepEqual(normalizeKnowledgeParams({ query: '  ' }), { ok: false, error: 'query is required' });
  });

  test('query が 500 文字 → OK（境界）', () => {
    const result = normalizeKnowledgeParams({ query: 'q'.repeat(500) });
    assert.equal(result.ok, true);
  });

  test('query が 501 文字 → エラー（境界超過）', () => {
    const result = normalizeKnowledgeParams({ query: 'q'.repeat(501) });
    assert.equal(result.ok, false);
    assert.match(result.error, /500/);
  });

  test('既定値: mode=hybrid, kind=all, limit=10', () => {
    const result = normalizeKnowledgeParams({ query: 'test' });
    assert.equal(result.ok, true);
    assert.equal(result.params.mode, 'hybrid');
    assert.equal(result.params.kind, 'all');
    assert.equal(result.params.limit, 10);
  });

  test('limit=31 は 30（最大値）にクランプされる', () => {
    const result = normalizeKnowledgeParams({ query: 'test', limit: 31 });
    assert.equal(result.ok, true);
    assert.equal(result.params.limit, 30);
  });

  test('limit=0 以下は不正', () => {
    const result = normalizeKnowledgeParams({ query: 'test', limit: 0 });
    assert.equal(result.ok, false);
  });

  test('不正な mode / kind はエラー', () => {
    assert.equal(normalizeKnowledgeParams({ query: 'q', mode: 'bogus' }).ok, false);
    assert.equal(normalizeKnowledgeParams({ query: 'q', kind: 'bogus' }).ok, false);
  });

  test('since/until が不正な ISO 文字列ならエラー', () => {
    const result = normalizeKnowledgeParams({ query: 'q', since: 'not-a-date' });
    assert.equal(result.ok, false);
    assert.match(result.error, /since/);
  });

  test('since/until 未指定は許容（undefined）', () => {
    const result = normalizeKnowledgeParams({ query: 'q' });
    assert.equal(result.ok, true);
    assert.equal(result.params.since, undefined);
    assert.equal(result.params.until, undefined);
  });

  test('有効な ISO の since/until はそのまま通る', () => {
    const result = normalizeKnowledgeParams({ query: 'q', since: '2026-01-01T00:00:00Z', until: '2026-12-31T00:00:00Z' });
    assert.equal(result.ok, true);
    assert.equal(result.params.since, '2026-01-01T00:00:00Z');
    assert.equal(result.params.until, '2026-12-31T00:00:00Z');
  });
});

// --- decideKnowledgeCoverage ---

describe('decideKnowledgeCoverage（coverage 5 通り）', () => {
  test('hybrid + キー有 → keyword/vector 両方実行', () => {
    const result = decideKnowledgeCoverage({ mode: 'hybrid', hasApiKey: true });
    assert.deepEqual(result, {
      ok: true,
      runKeyword: true,
      runVector: true,
      coverage: { keyword: true, vector: true },
    });
  });

  test('hybrid + キー無 → keyword のみ、vectorSkippedReason 付き', () => {
    const result = decideKnowledgeCoverage({ mode: 'hybrid', hasApiKey: false });
    assert.equal(result.ok, true);
    assert.equal(result.runKeyword, true);
    assert.equal(result.runVector, false);
    assert.deepEqual(result.coverage, { keyword: true, vector: false, vectorSkippedReason: 'no_openai_api_key' });
  });

  test('keyword + キー有 → keyword のみ', () => {
    const result = decideKnowledgeCoverage({ mode: 'keyword', hasApiKey: true });
    assert.equal(result.ok, true);
    assert.deepEqual(result.coverage, { keyword: true, vector: false });
  });

  test('keyword + キー無 → keyword のみ（キー不要）', () => {
    const result = decideKnowledgeCoverage({ mode: 'keyword', hasApiKey: false });
    assert.equal(result.ok, true);
    assert.deepEqual(result.coverage, { keyword: true, vector: false });
  });

  test('vector + キー有 → vector のみ', () => {
    const result = decideKnowledgeCoverage({ mode: 'vector', hasApiKey: true });
    assert.equal(result.ok, true);
    assert.deepEqual(result.coverage, { keyword: false, vector: true });
  });

  test('vector + キー無 → 明示エラー', () => {
    const result = decideKnowledgeCoverage({ mode: 'vector', hasApiKey: false });
    assert.equal(result.ok, false);
    assert.match(result.error, /OpenAI API key/);
  });
});

// --- escapeLikePattern ---

describe('escapeLikePattern', () => {
  test('% _ \\ をエスケープする', () => {
    assert.equal(escapeLikePattern('100%_done\\x'), '100\\%\\_done\\\\x');
  });
  test('通常文字はそのまま', () => {
    assert.equal(escapeLikePattern('devrelay'), 'devrelay');
  });
});

// --- isInputCausedEmbeddingError（バックフィル承認時の追加指示） ---

describe('isInputCausedEmbeddingError', () => {
  test('400（Bad Request）は入力起因 → true', () => {
    assert.equal(isInputCausedEmbeddingError(400), true);
  });
  test('422（Unprocessable Entity）は入力起因 → true', () => {
    assert.equal(isInputCausedEmbeddingError(422), true);
  });
  test('429（Rate Limit）は入力起因ではない → false（従来のバックオフに委ねる）', () => {
    assert.equal(isInputCausedEmbeddingError(429), false);
  });
  test('500 系（サーバー側）は入力起因ではない → false', () => {
    assert.equal(isInputCausedEmbeddingError(500), false);
    assert.equal(isInputCausedEmbeddingError(503), false);
  });
  test('401/403（認証・権限）は入力起因ではない → false', () => {
    assert.equal(isInputCausedEmbeddingError(401), false);
    assert.equal(isInputCausedEmbeddingError(403), false);
  });
  test('undefined/null（ネットワーク断等でステータス自体が無い）は false', () => {
    assert.equal(isInputCausedEmbeddingError(undefined), false);
    assert.equal(isInputCausedEmbeddingError(null), false);
  });
});

// --- fuseKnowledgeCandidates (RRF) ---

describe('fuseKnowledgeCandidates', () => {
  test('両方のリストでヒットしたターンは片方のみヒットより上位', () => {
    const keyword = [
      { sourceId: 'a', chunkIndex: 0, occurredAtMs: 1000 },
      { sourceId: 'b', chunkIndex: 0, occurredAtMs: 2000 },
    ];
    const vector = [
      { sourceId: 'b', chunkIndex: 0, occurredAtMs: 2000 },
      { sourceId: 'c', chunkIndex: 0, occurredAtMs: 3000 },
    ];
    const fused = fuseKnowledgeCandidates(keyword, vector, 10);
    assert.equal(fused[0].sourceId, 'b');
    assert.deepEqual([...fused[0].matchedBy].sort(), ['keyword', 'vector']);
  });

  test('同一ターンの複数チャンクは 1 件に集約される（最良順位を採用）', () => {
    const keyword = [
      { sourceId: 'a', chunkIndex: 2, occurredAtMs: 1000 }, // 1位
      { sourceId: 'a', chunkIndex: 5, occurredAtMs: 1000 }, // 2位（同一ターン、無視される）
      { sourceId: 'b', chunkIndex: 0, occurredAtMs: 2000 }, // 3位
    ];
    const fused = fuseKnowledgeCandidates(keyword, [], 10);
    const aResult = fused.find((f) => f.sourceId === 'a');
    assert.equal(aResult.bestChunkIndex, 2);
    // 'a' は rank1 (1/61) のみ、'b' は rank2 (1/62)。重複カウントされていれば 'a' のスコアが 2/61 相当になり異常に高くなる
    assert.ok(aResult.score < 2 / (KNOWLEDGE_RRF_K + 1));
  });

  test('ベクトル候補が空でもキーワードだけで順位が付く', () => {
    const keyword = [{ sourceId: 'a', chunkIndex: 0, occurredAtMs: 1000 }];
    const fused = fuseKnowledgeCandidates(keyword, [], 10);
    assert.equal(fused.length, 1);
    assert.deepEqual(fused[0].matchedBy, ['keyword']);
  });

  test('同点スコアは occurredAt 降順', () => {
    const keyword = [
      { sourceId: 'old', chunkIndex: 0, occurredAtMs: 1000 },
      { sourceId: 'new', chunkIndex: 0, occurredAtMs: 2000 },
    ];
    // 両方 keyword のみで rank が異なるとスコアが変わるので、個別の vector リストで同点を作る
    const vector = [
      { sourceId: 'new', chunkIndex: 0, occurredAtMs: 2000 },
      { sourceId: 'old', chunkIndex: 0, occurredAtMs: 1000 },
    ];
    // keyword: old=rank1, new=rank2 / vector: new=rank1, old=rank2 → スコア合計が同点になる
    const fused = fuseKnowledgeCandidates(keyword, vector, 10);
    assert.equal(fused[0].score, fused[1].score);
    assert.equal(fused[0].sourceId, 'new'); // occurredAt 降順
  });

  test('limit で件数が絞られる', () => {
    const keyword = Array.from({ length: 5 }, (_, i) => ({ sourceId: `s${i}`, chunkIndex: 0, occurredAtMs: i }));
    const fused = fuseKnowledgeCandidates(keyword, [], 2);
    assert.equal(fused.length, 2);
  });
});

// --- buildKnowledgeSnippet ---

describe('buildKnowledgeSnippet', () => {
  test('一致ありなら一致位置の前後 200 文字', () => {
    const text = 'x'.repeat(300) + 'MATCHME' + 'y'.repeat(300);
    const snippet = buildKnowledgeSnippet(text, 'MATCHME');
    assert.ok(snippet.includes('MATCHME'));
    assert.ok(snippet.length < text.length);
  });

  test('一致なしなら【回答】以降の先頭 300 文字', () => {
    const text = '【プロジェクト】p\n【スレッド】t\n【指示/質問】q\n【回答】' + 'z'.repeat(500);
    const snippet = buildKnowledgeSnippet(text, 'no-such-query-xyz');
    assert.ok(snippet.startsWith('zzz'));
    assert.equal(snippet.length, 300);
  });

  test('改行は空白に畳まれる', () => {
    const text = '【回答】line1\nline2\nline3';
    const snippet = buildKnowledgeSnippet(text, 'no-match');
    assert.equal(snippet.includes('\n'), false);
    assert.equal(snippet, 'line1 line2 line3');
  });
});
