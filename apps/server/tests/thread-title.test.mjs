import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveThreadTitle,
  validateThreadTitle,
  THREAD_TITLE_MAX_LENGTH,
} from '../dist/services/thread-title.js';

describe('deriveThreadTitle', () => {
  test('null/undefined は null', () => {
    assert.equal(deriveThreadTitle(null), null);
    assert.equal(deriveThreadTitle(undefined), null);
  });

  test('空文字は null', () => {
    assert.equal(deriveThreadTitle(''), null);
  });

  test('先頭行が空白のみなら null', () => {
    assert.equal(deriveThreadTitle('   \n本文2行目'), null);
  });

  test('先頭行のみを使う', () => {
    assert.equal(deriveThreadTitle('タイトル行\n本文2行目\n本文3行目'), 'タイトル行');
  });

  test('前後の空白を trim する', () => {
    assert.equal(deriveThreadTitle('  空白付き  \n次の行'), '空白付き');
  });

  test('60 文字以下はそのまま', () => {
    const input = 'a'.repeat(60);
    assert.equal(deriveThreadTitle(input), input);
    assert.equal(THREAD_TITLE_MAX_LENGTH, 60);
  });

  test('60 文字超は切り詰めて … を付与', () => {
    const input = 'a'.repeat(70);
    const result = deriveThreadTitle(input);
    assert.equal(result, 'a'.repeat(60) + '…');
  });

  test('サロゲートペア絵文字を含む長文はコードポイント単位で安全に切り詰める', () => {
    // 絵文字（サロゲートペア）を60個より多く含む文字列
    const input = '😀'.repeat(70);
    const result = deriveThreadTitle(input);
    // 文字化け（不完全なサロゲート）が発生していないこと
    assert.equal(Array.from(result).length, 61); // 60コードポイント + '…'
    assert.equal(result, '😀'.repeat(60) + '…');
  });
});

describe('validateThreadTitle', () => {
  test('正常な文字列は ok:true', () => {
    const result = validateThreadTitle('新しいタイトル');
    assert.deepEqual(result, { ok: true, title: '新しいタイトル' });
  });

  test('前後空白は trim される', () => {
    const result = validateThreadTitle('  タイトル  ');
    assert.deepEqual(result, { ok: true, title: 'タイトル' });
  });

  test('空文字は empty エラー', () => {
    const result = validateThreadTitle('');
    assert.deepEqual(result, { ok: false, reason: 'empty' });
  });

  test('空白のみは trim 後 empty エラー', () => {
    const result = validateThreadTitle('   ');
    assert.deepEqual(result, { ok: false, reason: 'empty' });
  });

  test('60 文字ちょうどは ok', () => {
    const input = 'b'.repeat(60);
    const result = validateThreadTitle(input);
    assert.equal(result.ok, true);
  });

  test('61 文字は too_long エラー', () => {
    const input = 'b'.repeat(61);
    const result = validateThreadTitle(input);
    assert.deepEqual(result, { ok: false, reason: 'too_long' });
  });
});
