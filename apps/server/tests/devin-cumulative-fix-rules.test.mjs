// Usage 累計補正サイクル: services/devin-cumulative-fix-rules.ts の単体テスト（dist を直接 import）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planCumulativeFix, applyFixToUsageData, looksCumulative } from '../dist/services/devin-cumulative-fix-rules.js';

const U = (i, o, c) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: c, cache_creation_input_tokens: 0 });
const row = (id, usage, extra = {}) => ({ id, usageData: { tool: 'devin', model: 'm', usage, modelUsage: { m: usage }, ...extra } });

test('planCumulativeFix: 累計の列を前ターンとの差分にする（先頭はそのまま）', () => {
  const plans = planCumulativeFix([row('a', U(100, 10, 50)), row('b', U(250, 15, 120)), row('c', U(300, 20, 120))]);
  assert.deepEqual(plans.map((p) => p.turnUsage), [U(100, 10, 50), U(150, 5, 70), U(50, 5, 0)]);
  assert.deepEqual(plans.map((p) => p.changed), [false, true, true]);
});

test('planCumulativeFix: 減った項目があれば新しいトラジェクトリとしてそのまま', () => {
  const plans = planCumulativeFix([row('a', U(100, 10, 50)), row('b', U(40, 12, 60))]);
  assert.deepEqual(plans[1].turnUsage, U(40, 12, 60));
  assert.equal(plans[1].changed, false);
});

test('planCumulativeFix: 再実行しても同じ（補正済み行は cumulativeUsage から計算）', () => {
  const first = planCumulativeFix([row('a', U(100, 10, 50)), row('b', U(250, 15, 120))]);
  const fixedB = applyFixToUsageData(row('b', U(250, 15, 120)).usageData, first[1]);
  const second = planCumulativeFix([row('a', U(100, 10, 50)), { id: 'b', usageData: fixedB }]);
  assert.deepEqual(second[1].turnUsage, U(150, 5, 70));
  assert.equal(second[1].changed, false);
});

test('planCumulativeFix: 新 Agent のターン分の行は書き換えず、累計だけ基準に使う / usage 無しは飛ばす', () => {
  const plans = planCumulativeFix([
    row('a', U(100, 10, 50)),
    { id: 'x', usageData: { tool: 'devin' } },
    row('b', U(150, 5, 70), { usageMode: 'delta', cumulativeUsage: U(250, 15, 120) }),
    row('c', U(300, 20, 120)),
  ]);
  assert.deepEqual(plans.map((p) => p.id), ['a', 'c']);
  assert.deepEqual(plans[1].turnUsage, U(50, 5, 0));
});

test('applyFixToUsageData: modelUsage も揃え、元の累計を残す', () => {
  const [p] = planCumulativeFix([row('a', U(100, 10, 50)), row('b', U(250, 15, 120))]).slice(1);
  const d = applyFixToUsageData(row('b', U(250, 15, 120)).usageData, p);
  assert.deepEqual(d.usage, U(150, 5, 70));
  assert.deepEqual(d.modelUsage.m, U(150, 5, 70));
  assert.deepEqual(d.cumulativeUsage, U(250, 15, 120));
  assert.equal(d.usageMode, 'delta-fixed');
  assert.equal(d.tool, 'devin');
});

test('looksCumulative', () => {
  assert.equal(looksCumulative(U(1, 1, 1), U(2, 1, 1)), true);
  assert.equal(looksCumulative(U(1, 1, 1), U(1, 1, 1)), false);
  assert.equal(looksCumulative(U(5, 1, 1), U(4, 9, 9)), false);
});
