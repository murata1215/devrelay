import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { stripCommandTag, stripAiNoise } from '../dist/services/thread-label-source.js';

/**
 * 「(無題)」大量発生の根治 サイクルB: `stripCommandTag()` / `stripAiNoise()` の純粋な
 * 単体テスト + 複製元（`progress-markers.ts` / `agent-manager.ts`）との突き合わせ
 * ソースガード（複製ロジックが乖離した場合に検知するため）。
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');

function readServerSource(relPath) {
  return readFileSync(path.join(serverRoot, relPath), 'utf8');
}

describe('stripCommandTag', () => {
  test('[exec] タグ付きは剥がして本文だけを返す', () => {
    assert.equal(stripCommandTag('[exec] 認証を直して'), '認証を直して');
  });
  test('[w] タグ付きも剥がす', () => {
    assert.equal(stripCommandTag('[w] READMEを更新'), 'READMEを更新');
  });
  test('[teamexec] タグ付きも剥がす', () => {
    assert.equal(stripCommandTag('[teamexec] 他プロジェクトに聞いて'), '他プロジェクトに聞いて');
  });
  test('タグ単体（本文なし）は null', () => {
    assert.equal(stripCommandTag('[exec]'), null);
  });
  test('タグ+空白のみも null', () => {
    assert.equal(stripCommandTag('[exec]   '), null);
  });
  test('タグが無い通常テキストはそのまま', () => {
    assert.equal(stripCommandTag('こんにちは'), 'こんにちは');
  });
  test('null は null', () => {
    assert.equal(stripCommandTag(null), null);
  });
  test('空白のみは null', () => {
    assert.equal(stripCommandTag('   '), null);
  });
});

describe('stripAiNoise', () => {
  test('📊 で始まる contextInfo 行を除去する', () => {
    assert.equal(stripAiNoise('📊 Rate Limit: 80%\nこんにちは'), 'こんにちは');
  });
  test('📝 で始まる行も除去する', () => {
    assert.equal(stripAiNoise('📝 メモ\n本文です'), '本文です');
  });
  test('🔧 …を使用中... の進捗マーカー行を除去する（ja）', () => {
    assert.equal(stripAiNoise('🔧 Editを使用中...\n完了しました'), '完了しました');
  });
  test('🔧 Using … の進捗マーカー行を除去する（en）', () => {
    assert.equal(stripAiNoise('🔧 Using Edit...\nDone'), 'Done');
  });
  test('ノイズだけの場合は null', () => {
    assert.equal(stripAiNoise('📊 Rate Limit: 80%\n🔧 Editを使用中...'), null);
  });
  test('null は null', () => {
    assert.equal(stripAiNoise(null), null);
  });
  test('ノイズが無い通常テキストはそのまま（前後空白は行ごとに trim される）', () => {
    assert.equal(stripAiNoise('これは通常のAI応答です'), 'これは通常のAI応答です');
  });
});

describe('thread-label-source: 複製元とのソースガード（乖離検知）', () => {
  test('progress-markers.ts の PROGRESS_LINE_PATTERNS 文言（ja）が一致する', () => {
    const source = readServerSource('src/services/progress-markers.ts');
    assert.match(source, /\/\^🔧\\s\*\.\+を使用中\\\.\\\.\\\.\$\/u/);
  });
  test('progress-markers.ts の PROGRESS_LINE_PATTERNS 文言（en）が一致する', () => {
    const source = readServerSource('src/services/progress-markers.ts');
    assert.match(source, /\/\^🔧\\s\*Using\\s\+\.\+\\\.\\\.\\\.\$\/u/);
  });
  test('agent-manager.ts の contextInfo 行除去パターン（📊📝）が一致する', () => {
    const source = readServerSource('src/services/agent-manager.ts');
    assert.match(source, /\/\^\[📊📝\]\.\+\\n\?\/gm/);
  });
});
