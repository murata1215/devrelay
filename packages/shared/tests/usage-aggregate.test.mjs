// Usage（コスト集計）サイクル: usage-aggregate.ts の単体テスト（dist を直接 import、node:test）。
// JST 暦月の境目・タグなし/案件なしの扱い・同名プロジェクトのまとめ・入れ子集計・CSV を固定する。

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  jstMonthRange,
  jstMonthKey,
  shiftMonthKey,
  isValidMonthKey,
  summarizeUsage,
  summarizeUsageNested,
  totalUsage,
  normalizeUsageLabel,
  usageRowsToCsv,
  usageChangeRatio,
  formatUsageUsd,
  isUsageAxis,
} from '../dist/usage-aggregate.js';

function row(over) {
  return {
    sessionId: 's',
    userId: 'u1',
    userName: '村田',
    group: 'CIT',
    projectName: 'LAFIT',
    caseName: '案件名1',
    threadTitle: 'a',
    costUsd: 1,
    turns: 1,
    unknownTurns: 0,
    lastAt: '2026-11-01T00:00:00.000Z',
    ...over,
  };
}

test('jstMonthRange: JST の 1 日 0:00 〜 翌月 1 日 0:00 を UTC で返す', () => {
  const { start, end } = jstMonthRange('2026-11');
  assert.equal(start.toISOString(), '2026-10-31T15:00:00.000Z');
  assert.equal(end.toISOString(), '2026-11-30T15:00:00.000Z');
  const dec = jstMonthRange('2026-12');
  assert.equal(dec.end.toISOString(), '2026-12-31T15:00:00.000Z');
});

test('jstMonthKey: UTC 15:00 を境に JST の月が切り替わる', () => {
  assert.equal(jstMonthKey(new Date('2026-10-31T14:59:59.999Z')), '2026-10');
  assert.equal(jstMonthKey(new Date('2026-10-31T15:00:00.000Z')), '2026-11');
});

test('shiftMonthKey: 年をまたぐ', () => {
  assert.equal(shiftMonthKey('2026-01', -1), '2025-12');
  assert.equal(shiftMonthKey('2026-12', 1), '2027-01');
  assert.equal(shiftMonthKey('2026-11', -1), '2026-10');
});

test('isValidMonthKey / isUsageAxis', () => {
  assert.equal(isValidMonthKey('2026-11'), true);
  assert.equal(isValidMonthKey('2026-13'), false);
  assert.equal(isValidMonthKey('2026-1'), false);
  assert.equal(isValidMonthKey(null), false);
  assert.equal(isUsageAxis('case'), true);
  assert.equal(isUsageAxis('thread'), false);
});

test('summarizeUsage: 金額の多い順、タグなしは最後', () => {
  const rows = [
    row({ group: 'CIT', costUsd: 21 }),
    row({ group: 'CIT', costUsd: 23 }),
    row({ group: null, costUsd: 100 }),
    row({ group: 'BIT', costUsd: 5 }),
  ];
  const b = summarizeUsage(rows, 'group');
  assert.deepEqual(b.map((x) => [x.key, x.costUsd, x.threads]), [
    ['CIT', 44, 2],
    ['BIT', 5, 1],
    [null, 100, 1],
  ]);
});

test('summarizeUsage: 同名プロジェクト（別マシン）は 1 つにまとまる / 利用者は userId で分ける', () => {
  const rows = [
    row({ projectName: 'LAFIT', userId: 'u1', userName: '村田' }),
    row({ projectName: 'LAFIT', userId: 'u2', userName: '村田' }),
  ];
  assert.equal(summarizeUsage(rows, 'project').length, 1);
  assert.equal(summarizeUsage(rows, 'user').length, 2);
});

test('summarizeUsage: 金額不明ターンは件数だけ数える', () => {
  const rows = [row({ costUsd: 2, turns: 3, unknownTurns: 1 }), row({ costUsd: 0, turns: 1, unknownTurns: 1 })];
  const t = totalUsage(rows);
  assert.deepEqual(t, { costUsd: 2, turns: 4, unknownTurns: 2, threads: 2 });
});

test('summarizeUsageNested: グループ → 案件', () => {
  const rows = [
    row({ group: 'CIT', caseName: '案件名1', costUsd: 21 }),
    row({ group: 'CIT', caseName: '案件名1', costUsd: 23 }),
    row({ group: 'CIT', caseName: '案件名2', costUsd: 58 }),
    row({ group: 'CIT', caseName: null, costUsd: 1 }),
    row({ group: 'BIT', caseName: '案件名5', costUsd: 17 }),
  ];
  const n = summarizeUsageNested(rows, 'group', 'case');
  assert.equal(n[0].key, 'CIT');
  assert.equal(n[0].costUsd, 103);
  assert.deepEqual(n[0].items.map((i) => [i.key, i.costUsd]), [
    ['案件名2', 58],
    ['案件名1', 44],
    [null, 1],
  ]);
  assert.equal(n[1].key, 'BIT');
  assert.equal(n[1].items.length, 1);
});

test('normalizeUsageLabel', () => {
  assert.deepEqual(normalizeUsageLabel('  CIT  '), { ok: true, value: 'CIT' });
  assert.deepEqual(normalizeUsageLabel('案件　名  1'), { ok: true, value: '案件 名 1' });
  assert.deepEqual(normalizeUsageLabel(''), { ok: true, value: null });
  assert.deepEqual(normalizeUsageLabel(null), { ok: true, value: null });
  assert.equal(normalizeUsageLabel(1).ok, false);
  assert.equal(normalizeUsageLabel('x'.repeat(41)).ok, false);
});

test('usageRowsToCsv: BOM 付き・カンマと引用符をエスケープ', () => {
  const csv = usageRowsToCsv([row({ threadTitle: 'a,"b"', group: null })], { noneGroup: 'タグなし', noneCase: '案件なし' });
  assert.ok(csv.startsWith('﻿'));
  assert.ok(csv.includes('"a,""b"""'));
  assert.ok(csv.includes('タグなし,村田'));
});

test('usageChangeRatio / formatUsageUsd', () => {
  assert.equal(usageChangeRatio(150, 100), 50);
  assert.equal(usageChangeRatio(10, 0), null);
  assert.equal(formatUsageUsd(1234.567), '$1,234.57');
  assert.equal(formatUsageUsd(0), '$0.00');
});
