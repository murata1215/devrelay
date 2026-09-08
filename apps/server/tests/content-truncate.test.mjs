// #380: メッセージ本文の行境界切り詰め（content-truncate.ts）の単体テスト。
// 外部 import ゼロの純粋関数（apps/server/src/services/content-truncate.ts）を
// コンパイル済み dist から直接 import する（stop-reason.test.mjs と同じ流儀）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  truncateOnLineBoundary,
  CONVERSATION_MAX_CONTENT_LENGTH,
  BUILD_STATUS_TAIL_LENGTH,
} from '../dist/services/content-truncate.js';

// ============================================================
// G1: 切り詰めなし（両方向）
// ============================================================

test('G1: n < maxLength は verbatim（head）', () => {
  const r = truncateOnLineBoundary('short text', 100, 'head');
  assert.equal(r.content, 'short text');
  assert.equal(r.truncated, false);
  assert.equal(r.truncatedSide, undefined);
});

test('G1: n < maxLength は verbatim（tail）', () => {
  const r = truncateOnLineBoundary('short text', 100, 'tail');
  assert.equal(r.content, 'short text');
  assert.equal(r.truncated, false);
  assert.equal(r.truncatedSide, undefined);
});

test('G1: n === maxLength（境界）は verbatim', () => {
  const text = 'a'.repeat(10);
  const rh = truncateOnLineBoundary(text, 10, 'head');
  const rt = truncateOnLineBoundary(text, 10, 'tail');
  assert.equal(rh.content, text);
  assert.equal(rh.truncated, false);
  assert.equal(rt.content, text);
  assert.equal(rt.truncated, false);
});

test('G1: 空文字は空文字のまま', () => {
  const r = truncateOnLineBoundary('', 10, 'head');
  assert.equal(r.content, '');
  assert.equal(r.truncated, false);
  assert.equal(r.truncatedSide, undefined);
});

// ============================================================
// G2: keep = 'head'
// ============================================================

test("G2: 複数行の行境界カット（末尾に改行を残さない）", () => {
  const lines = [];
  for (let i = 0; i < 50; i++) lines.push(`line-${i}-` + 'x'.repeat(20));
  const text = lines.join('\n');
  const r = truncateOnLineBoundary(text, 100, 'head');
  assert.equal(r.truncated, true);
  assert.equal(r.truncatedSide, 'tail');
  assert.ok(r.content.length <= 100);
  assert.ok(!r.content.endsWith('\n'));
  assert.ok(text.startsWith(r.content));
});

test('G2: 小さな固定 fixture の完全一致', () => {
  const text = 'abcde\nfghij\nklmno';
  // maxLength=8 → 窓は 'abcde\nfg' → 窓内最後の \n は index5 → 'abcde'
  const r = truncateOnLineBoundary(text, 8, 'head');
  assert.equal(r.content, 'abcde');
  assert.equal(r.truncated, true);
  assert.equal(r.truncatedSide, 'tail');
});

test('G2: 改行なし → ハードカット', () => {
  const text = 'x'.repeat(500);
  const r = truncateOnLineBoundary(text, 100, 'head');
  assert.equal(r.content.length, 100);
  assert.equal(r.truncated, true);
  assert.equal(r.truncatedSide, 'tail');
  assert.notEqual(r.content, '');
});

test('G2: 改行が index 0 のみ → 空文字にならない（ハードカットへフォールスルー）', () => {
  const text = '\n' + 'x'.repeat(100);
  const r = truncateOnLineBoundary(text, 10, 'head');
  assert.equal(r.content.length, 10);
  assert.notEqual(r.content, '');
});

test('G2: CRLF は孤立 \\r を残さない', () => {
  const text = 'aaa\r\nbbb\r\nccc\r\nddd\r\nzzzzzzzzzzzzzzzzzzzzzz';
  const r = truncateOnLineBoundary(text, 10, 'head');
  assert.ok(!r.content.endsWith('\r'));
  assert.ok(!r.content.endsWith('\n'));
});

test('G2: 奇数 max のサロゲート境界で孤立上位サロゲートを残さない', () => {
  const text = '\u{1F600}'.repeat(20); // 😀 x20（各2コードユニット、改行なし）
  const r = truncateOnLineBoundary(text, 9, 'head'); // 奇数 → ペアの境目に当たる
  assert.equal(r.content.length, 8);
  const lastCode = r.content.charCodeAt(r.content.length - 1);
  assert.ok(!(lastCode >= 0xd800 && lastCode <= 0xdbff), '孤立上位サロゲートが残っていない');
});

test('G2: \\n 終端の本文は通常どおり境界カット', () => {
  const text = 'a'.repeat(50) + '\n' + 'b'.repeat(50) + '\n';
  const r = truncateOnLineBoundary(text, 60, 'head');
  assert.equal(r.truncated, true);
  assert.ok(!r.content.endsWith('\n'));
});

test("G2: keep 省略時は 'head' と同結果", () => {
  const text = 'line1\nline2\nline3\nline4';
  const explicit = truncateOnLineBoundary(text, 12, 'head');
  const omitted = truncateOnLineBoundary(text, 12);
  assert.deepEqual(omitted, explicit);
});

// ============================================================
// G3: keep = 'tail'
// ============================================================

test('G3: 複数行の行境界カット（先頭に余計な断片を残さない）', () => {
  const lines = [];
  for (let i = 0; i < 50; i++) lines.push(`line-${i}-` + 'x'.repeat(20));
  const text = lines.join('\n');
  const r = truncateOnLineBoundary(text, 100, 'tail');
  assert.equal(r.truncated, true);
  assert.equal(r.truncatedSide, 'head');
  assert.ok(r.content.length <= 100);
  assert.ok(text.endsWith(r.content));
});

test('G3: 窓の先頭が既に行境界なら余計に1行落とさない', () => {
  // 'AAAA\n' (5) + 'BBBBBBBBBB' (10) = 15文字、maxLength=10 → start=5 は '\n' の直後
  const text = 'AAAA\n' + 'B'.repeat(10);
  const r = truncateOnLineBoundary(text, 10, 'tail');
  assert.equal(r.content, 'B'.repeat(10));
  assert.equal(r.content.length, 10);
});

test('G3: 改行なし → ハードカット', () => {
  const text = 'y'.repeat(500);
  const r = truncateOnLineBoundary(text, 100, 'tail');
  assert.equal(r.content.length, 100);
  assert.equal(r.truncated, true);
  assert.equal(r.truncatedSide, 'head');
  assert.notEqual(r.content, '');
});

test('G3: 改行が最終文字のみ → 空文字にならない', () => {
  const text = 'x'.repeat(100) + '\n';
  const r = truncateOnLineBoundary(text, 10, 'tail');
  assert.equal(r.content.length, 10);
  assert.notEqual(r.content, '');
});

test('G3: 窓より前にしか改行がない巨大最終行 → ハードカット', () => {
  const text = 'short\n' + 'z'.repeat(200);
  const r = truncateOnLineBoundary(text, 50, 'tail');
  assert.equal(r.content.length, 50);
  assert.ok(text.endsWith(r.content));
});

test('G3: 奇数 max のサロゲート境界で孤立下位サロゲートを残さない', () => {
  const text = '\u{1F600}'.repeat(20);
  const r = truncateOnLineBoundary(text, 9, 'tail');
  assert.equal(r.content.length, 8);
  const firstCode = r.content.charCodeAt(0);
  assert.ok(!(firstCode >= 0xdc00 && firstCode <= 0xdfff), '孤立下位サロゲートが残っていない');
});

test('G3: CRLF は先頭に孤立文字を残さない', () => {
  const text = 'aaa\r\nbbb\r\nccc\r\nddd\r\nzzzzzzzzzzzzzzzzzzzzzz';
  const r = truncateOnLineBoundary(text, 10, 'tail');
  assert.ok(!r.content.startsWith('\n'));
  assert.ok(!r.content.startsWith('\r'));
});

test('G3: \\n 始まりの本文でも正しい suffix を返す', () => {
  const text = '\n' + 'a'.repeat(50) + '\n' + 'b'.repeat(50);
  const r = truncateOnLineBoundary(text, 60, 'tail');
  assert.equal(r.truncated, true);
  assert.ok(text.endsWith(r.content));
});

// ============================================================
// G4: 退化した maxLength
// ============================================================

test('G4: maxLength=0 かつ非空 → 空文字 + truncated=true + 逆側', () => {
  const rh = truncateOnLineBoundary('abc', 0, 'head');
  assert.equal(rh.content, '');
  assert.equal(rh.truncated, true);
  assert.equal(rh.truncatedSide, 'tail');

  const rt = truncateOnLineBoundary('abc', 0, 'tail');
  assert.equal(rt.content, '');
  assert.equal(rt.truncated, true);
  assert.equal(rt.truncatedSide, 'head');
});

test('G4: maxLength=0 かつ空文字 → truncated=false', () => {
  const r = truncateOnLineBoundary('', 0, 'head');
  assert.equal(r.content, '');
  assert.equal(r.truncated, false);
  assert.equal(r.truncatedSide, undefined);
});

test('G4: maxLength=-5 でも例外を投げない（0 と同じ扱い）', () => {
  const r = truncateOnLineBoundary('abc', -5, 'head');
  assert.equal(r.content, '');
  assert.equal(r.truncated, true);
  assert.equal(r.truncatedSide, 'tail');
});

// ============================================================
// G5: 不変条件
// ============================================================

const G5_CASES = [
  ['', 10],
  ['abc', 10],
  ['abc', 3],
  ['abc', 2],
  ['line1\nline2\nline3', 8],
  ['x'.repeat(3000) + '\ny'.repeat(3000), 2000],
];

test('G5: truncated === (text.length > maxLength) が両方向で成立', () => {
  for (const [text, max] of G5_CASES) {
    for (const keep of ['head', 'tail']) {
      const r = truncateOnLineBoundary(text, max, keep);
      assert.equal(r.truncated, text.length > max, `text.length=${text.length} max=${max} keep=${keep}`);
    }
  }
});

test('G5: 部分文字列不変条件（head=prefix, tail=suffix）', () => {
  for (const [text, max] of G5_CASES) {
    const rh = truncateOnLineBoundary(text, max, 'head');
    assert.ok(text.startsWith(rh.content), `head content should be a prefix: text=${JSON.stringify(text)} max=${max}`);
    const rt = truncateOnLineBoundary(text, max, 'tail');
    assert.ok(text.endsWith(rt.content), `tail content should be a suffix: text=${JSON.stringify(text)} max=${max}`);
  }
});

test('G5: 空文字を返さない不変条件（text非空 かつ maxLength>0）', () => {
  for (const [text, max] of G5_CASES) {
    if (text === '' || max <= 0) continue;
    for (const keep of ['head', 'tail']) {
      const r = truncateOnLineBoundary(text, max, keep);
      assert.notEqual(r.content, '', `should not be empty: text=${JSON.stringify(text)} max=${max} keep=${keep}`);
    }
  }
});

test('G5: truncatedSide は keep の逆（truncated=true のとき）', () => {
  for (const [text, max] of G5_CASES) {
    for (const keep of ['head', 'tail']) {
      const r = truncateOnLineBoundary(text, max, keep);
      if (r.truncated) {
        const expectedSide = keep === 'head' ? 'tail' : 'head';
        assert.equal(r.truncatedSide, expectedSide);
      } else {
        assert.equal(r.truncatedSide, undefined);
      }
    }
  }
});

test('G5: 定数値の固定', () => {
  assert.equal(CONVERSATION_MAX_CONTENT_LENGTH, 2000);
  assert.equal(BUILD_STATUS_TAIL_LENGTH, 1500);
});

// ============================================================
// G6: 実バグの再現 fixture（exec 完了報告の末尾を読めるか）
// ============================================================

test('G6: tail 保持は末尾の commit/push 行を含み、head 保持は含まない', () => {
  const preamble = 'AI が実行した詳細な作業ログ。'.repeat(300); // 十分に長い前置き
  const text = preamble + '\ncommit a1b2c3d\npush: ok\n';
  assert.ok(text.length > 4000, 'fixture should exceed both limits');

  const tailResult = truncateOnLineBoundary(text, 1500, 'tail');
  assert.ok(tailResult.content.includes('commit a1b2c3d'), 'tail should include commit hash line');
  assert.ok(tailResult.content.includes('push: ok'), 'tail should include push result line');

  const headResult = truncateOnLineBoundary(text, 2000, 'head');
  assert.ok(!headResult.content.includes('commit a1b2c3d'), 'head should NOT include commit hash line');
});
