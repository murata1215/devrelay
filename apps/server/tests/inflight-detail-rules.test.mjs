// 再起動耐性サイクル 追補（2026-11-28）: inflight-detail-rules.ts の単体テスト。
// 外部 import ゼロの純粋関数をコンパイル済み dist から直接 import する。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveInflightDetailLevel,
  formatElapsed,
  truncateLabel,
  formatInflightEntryLine,
} from '../dist/services/inflight-detail-rules.js';

describe('resolveInflightDetailLevel', () => {
  test('未設定（undefined）は既定の label', () => {
    assert.equal(resolveInflightDetailLevel(undefined), 'label');
  });
  test(`'off' はそのまま off`, () => {
    assert.equal(resolveInflightDetailLevel('off'), 'off');
  });
  test(`'id' はそのまま id`, () => {
    assert.equal(resolveInflightDetailLevel('id'), 'id');
  });
  test('不正な値は安全側の label 扱い', () => {
    assert.equal(resolveInflightDetailLevel('nonsense'), 'label');
  });
});

describe('formatElapsed', () => {
  test('null は経過不明', () => {
    assert.equal(formatElapsed(null), '経過不明');
  });
  test('NaN・負値も経過不明', () => {
    assert.equal(formatElapsed(NaN), '経過不明');
    assert.equal(formatElapsed(-100), '経過不明');
  });
  test('60秒未満は秒のみ', () => {
    assert.equal(formatElapsed(45_000), '45秒');
  });
  test('0ms は 0秒', () => {
    assert.equal(formatElapsed(0), '0秒');
  });
  test('60秒以上は分秒', () => {
    assert.equal(formatElapsed(72_000), '1分12秒');
  });
  test('端数は切り捨て（ミリ秒未満は無視）', () => {
    assert.equal(formatElapsed(1_999), '1秒');
  });
});

describe('truncateLabel', () => {
  test('null はそのまま null', () => {
    assert.equal(truncateLabel(null), null);
  });
  test('空白のみの文字列は null（見出しとして出さない）', () => {
    assert.equal(truncateLabel('   '), null);
  });
  test('前後の空白は除去される', () => {
    assert.equal(truncateLabel('  hello  '), 'hello');
  });
  test('maxLen 以下ならそのまま', () => {
    assert.equal(truncateLabel('short', 60), 'short');
  });
  test('maxLen 超過は末尾に … を付けて切り詰める', () => {
    const long = 'a'.repeat(100);
    const result = truncateLabel(long, 60);
    assert.equal(result.length, 61); // 60文字 + …
    assert.ok(result.endsWith('…'));
  });
});

describe('formatInflightEntryLine', () => {
  test('マシン名・プロジェクト名・見出しが揃っている場合は2行', () => {
    const line = formatInflightEntryLine({
      machineName: 'fwjg2507-FMVD34003',
      projectName: 'shiren-ai',
      ageMs: 72_000,
      label: 'チエちゃんのセリフを作ると…',
    });
    assert.match(line, /^fwjg2507-FMVD34003 \/ shiren-ai   実行中 1分12秒\n/);
    assert.match(line, /チエちゃんのセリフを作ると…$/);
  });

  test('label が null なら1行のみ', () => {
    const line = formatInflightEntryLine({
      machineName: 'fwjg2507-FMVD34003',
      projectName: 'shiren-ai',
      ageMs: 5_000,
      label: null,
    });
    assert.equal(line, 'fwjg2507-FMVD34003 / shiren-ai   実行中 5秒');
  });

  test('projectName が無ければマシン名のみで組み立てる', () => {
    const line = formatInflightEntryLine({
      machineName: 'fwjg2507-FMVD34003',
      projectName: null,
      ageMs: 10_000,
      label: null,
    });
    assert.equal(line, 'fwjg2507-FMVD34003   実行中 10秒');
  });

  test('machineName が無ければ (マシン不明) になる', () => {
    const line = formatInflightEntryLine({
      machineName: null,
      projectName: null,
      ageMs: null,
      label: null,
    });
    assert.equal(line, '(マシン不明)   実行中 経過不明');
  });

  test('長い見出しは1行目に影響せず2行目だけ切り詰められる', () => {
    const line = formatInflightEntryLine({
      machineName: 'm',
      projectName: 'p',
      ageMs: 1_000,
      label: 'x'.repeat(100),
    });
    const lines = line.split('\n');
    assert.equal(lines[0], 'm / p   実行中 1秒');
    assert.ok(lines[1].trim().endsWith('…'));
  });
});
