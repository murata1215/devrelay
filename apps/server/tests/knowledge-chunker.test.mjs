// 高辻ナレッジ サイクル1: apps/server/src/services/knowledge-chunker.ts の単体テスト。
// 外部 import ゼロの純関数をコンパイル済み dist から直接 import する
// （progress-markers.test.mjs / ask-guard.test.mjs と同じ流儀）。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  KNOWLEDGE_SOURCE_TYPE_TURN,
  MAX_CHUNK_LENGTH,
  buildTurnHeader,
  splitOnLineBoundaries,
  buildTurnChunks,
} from '../dist/services/knowledge-chunker.js';

// knowledge-chunker.ts 内の非 export 定数のテスト用コピー（export を増やす変更はしない方針のため）。
const MIN_AI_BODY_LENGTH = 20;
const USER_EXCERPT_LENGTH = 1000;
const HEADER_MAX_LENGTH = 1200;
const BODY_WINDOW_LENGTH = 4500;

describe('定数', () => {
  test('KNOWLEDGE_SOURCE_TYPE_TURN は "turn"', () => {
    assert.equal(KNOWLEDGE_SOURCE_TYPE_TURN, 'turn');
  });

  test('MAX_CHUNK_LENGTH(6000) は BODY_WINDOW_LENGTH(4500) + HEADER_MAX_LENGTH(1200) + 改行1文字を保証する', () => {
    assert.ok(MAX_CHUNK_LENGTH >= BODY_WINDOW_LENGTH + HEADER_MAX_LENGTH + 1);
  });
});

describe('buildTurnHeader', () => {
  test('基本形: 4 行（プロジェクト/スレッド/指示質問/回答ラベル）', () => {
    const header = buildTurnHeader({
      projectName: 'devrelay',
      threadTitle: 'ナレッジ機能の実装',
      userContent: 'search_knowledge を追加して',
    });
    const lines = header.split('\n');
    assert.equal(lines.length, 4);
    assert.equal(lines[0], '【プロジェクト】devrelay');
    assert.equal(lines[1], '【スレッド】ナレッジ機能の実装');
    assert.equal(lines[2], '【指示/質問】search_knowledge を追加して');
    assert.equal(lines[3], '【回答】');
  });

  test('threadTitle が null でも成立する（空の【スレッド】行）', () => {
    const header = buildTurnHeader({ projectName: 'devrelay', threadTitle: null, userContent: 'x' });
    assert.ok(header.split('\n')[1].startsWith('【スレッド】'));
    assert.equal(header.split('\n')[1], '【スレッド】');
  });

  test('userContent が null でも成立する（【指示/質問】は空で【回答】は残る）', () => {
    const header = buildTurnHeader({ projectName: 'devrelay', threadTitle: 'title', userContent: null });
    const lines = header.split('\n');
    assert.equal(lines[2], '【指示/質問】');
    assert.equal(lines[3], '【回答】');
  });

  test('userContent が 1,000 文字超なら 1,000 文字で切る（ヘッダ予算に余裕がある場合）', () => {
    const longUser = 'あ'.repeat(USER_EXCERPT_LENGTH + 500);
    const header = buildTurnHeader({ projectName: 'p', threadTitle: 't', userContent: longUser });
    const line3 = header.split('\n')[2];
    const excerpt = line3.slice('【指示/質問】'.length);
    assert.equal(excerpt.length, USER_EXCERPT_LENGTH);
  });

  test('長い projectName・threadTitle でもヘッダ全体が HEADER_MAX_LENGTH 以下かつ【回答】行が残る', () => {
    const header = buildTurnHeader({
      projectName: 'P'.repeat(500),
      threadTitle: 'T'.repeat(500),
      userContent: 'U'.repeat(2000),
    });
    assert.ok(header.length <= HEADER_MAX_LENGTH, `header.length=${header.length} should be <= ${HEADER_MAX_LENGTH}`);
    const lines = header.split('\n');
    assert.equal(lines[lines.length - 1], '【回答】');
  });
});

describe('splitOnLineBoundaries', () => {
  test('空文字列は [] を返す', () => {
    assert.deepEqual(splitOnLineBoundaries('', 100), []);
  });

  test('窓サイズ以下の短いテキストは 1 要素', () => {
    assert.deepEqual(splitOnLineBoundaries('line1\nline2', 100), ['line1\nline2']);
  });

  test('行境界で非オーバーラップに分割する（結合すると元テキストに戻る）', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line-${i}-xxxxxxxxxx`);
    const text = lines.join('\n');
    const windows = splitOnLineBoundaries(text, 60);
    assert.ok(windows.length > 1);
    assert.equal(windows.join('\n'), text);
    for (const w of windows) {
      assert.ok(w.length <= 60, `window length ${w.length} should be <= 60`);
    }
  });

  test('1 行が窓サイズを超える場合は文字数で強制分割する', () => {
    const hugeLine = 'x'.repeat(250);
    const windows = splitOnLineBoundaries(hugeLine, 100);
    assert.equal(windows.length, 3);
    assert.equal(windows[0].length, 100);
    assert.equal(windows[1].length, 100);
    assert.equal(windows[2].length, 50);
    assert.equal(windows.join(''), hugeLine);
  });

  test('強制分割はサロゲートペアを割らない', () => {
    // U+1F600 (😀) はサロゲートペア（上位+下位の2コードユニット）
    const emoji = '\u{1F600}';
    const text = 'a'.repeat(99) + emoji; // 99 文字 + サロゲートペア2つ = 101 コードユニット
    const windows = splitOnLineBoundaries(text, 100);
    // カット位置100が上位サロゲートの直後になるはずの場合、99に下げてペアを守る
    for (const w of windows) {
      // 各窓の末尾が上位サロゲート単独で終わっていないこと
      const lastCode = w.charCodeAt(w.length - 1);
      const isLoneHighSurrogate = lastCode >= 0xd800 && lastCode <= 0xdbff;
      assert.equal(isLoneHighSurrogate, false);
    }
    assert.equal(windows.join(''), text);
  });
});

describe('buildTurnChunks', () => {
  const baseInput = { projectName: 'devrelay', threadTitle: 'スレッド', userContent: '質問文' };

  test('短い応答 → 1 チャンク、ヘッダが先頭に付く', () => {
    const chunks = buildTurnChunks({ ...baseInput, aiContent: 'これは短い応答です。'.repeat(3) });
    assert.equal(chunks.length, 1);
    assert.ok(chunks[0].startsWith('【プロジェクト】devrelay'));
    assert.ok(chunks[0].includes('【回答】'));
  });

  test('進捗ノイズのみ・20 文字未満 → 0 件', () => {
    assert.deepEqual(buildTurnChunks({ ...baseInput, aiContent: '' }), []);
    assert.deepEqual(buildTurnChunks({ ...baseInput, aiContent: '短い' }), []);
  });

  test(`進捗ノイズ除去後ちょうど ${MIN_AI_BODY_LENGTH} 文字未満は対象外`, () => {
    const shortBody = 'あ'.repeat(MIN_AI_BODY_LENGTH - 1);
    assert.deepEqual(buildTurnChunks({ ...baseInput, aiContent: shortBody }), []);
  });

  test('長い応答 → 複数チャンク、各 6,000 文字以下、行の途中で切れない、連結して本文欠落なし', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `これは行${i}の内容です。`.repeat(20));
    const longBody = lines.join('\n');
    const chunks = buildTurnChunks({ ...baseInput, aiContent: longBody });
    assert.ok(chunks.length > 1, 'expected multiple chunks for a long body');
    for (const chunk of chunks) {
      assert.ok(chunk.length <= MAX_CHUNK_LENGTH, `chunk.length=${chunk.length} should be <= ${MAX_CHUNK_LENGTH}`);
    }
    // 各チャンクからヘッダを取り除いて本文窓だけ連結すると元の本文に戻る
    const header = buildTurnHeader({
      projectName: baseInput.projectName,
      threadTitle: baseInput.threadTitle,
      userContent: baseInput.userContent,
    });
    const bodies = chunks.map((c) => c.slice(header.length + 1)); // ヘッダ + 改行1文字
    assert.equal(bodies.join('\n'), longBody);
  });

  test('1 行が BODY_WINDOW_LENGTH(4500) 超 → 強制分割されたチャンクが複数できる', () => {
    const hugeSingleLine = 'あ'.repeat(BODY_WINDOW_LENGTH * 2 + 100);
    const chunks = buildTurnChunks({ ...baseInput, aiContent: hugeSingleLine });
    assert.ok(chunks.length >= 3, `expected >= 3 chunks, got ${chunks.length}`);
    for (const chunk of chunks) {
      assert.ok(chunk.length <= MAX_CHUNK_LENGTH);
    }
  });
});
