// #368 Phase 2a サブサイクルA: devin-plan-prompt.ts の単体テスト。
// 外部 import ゼロの純関数（agents/linux/src/services/devin-plan-prompt.ts）を
// コンパイル済み dist から直接 import する（devin-file-watch.test.mjs と同じ流儀）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDevinPlanPreamble } from '../dist/services/devin-plan-prompt.js';

test('buildDevinPlanPreamble: 文字列を返す', () => {
  const preamble = buildDevinPlanPreamble();
  assert.equal(typeof preamble, 'string');
  assert.ok(preamble.length > 0);
});

test('buildDevinPlanPreamble: 呼び出しごとに同じ内容を返す（純関数）', () => {
  assert.equal(buildDevinPlanPreamble(), buildDevinPlanPreamble());
});

test('buildDevinPlanPreamble: 実装はexec送信後に行う旨が明記されている', () => {
  const preamble = buildDevinPlanPreamble();
  assert.match(preamble, /exec/);
  assert.match(preamble, /調査と説明に徹して/);
});

test('buildDevinPlanPreamble: 書き込み系コマンドを使わない旨が明記されている', () => {
  const preamble = buildDevinPlanPreamble();
  assert.match(preamble, /git commit/);
  assert.match(preamble, /git push/);
  assert.match(preamble, /書き込み系のコマンド/);
});

test('buildDevinPlanPreamble: 複合コマンド（&&・;・パイプ）の使用が明示的に許可されている（#368 Phase1真因への回帰テスト）', () => {
  const preamble = buildDevinPlanPreamble();
  assert.match(preamble, /複合コマンド/);
  assert.match(preamble, /&&/);
  assert.match(preamble, /パイプ/);
  // 「使ってよい／構いません」等の許可表現であり、禁止表現ではないこと
  assert.match(preamble, /構いません/);
  assert.doesNotMatch(preamble, /複合コマンド[^\n]*(使わない|禁止|避けて)/);
});

test('buildDevinPlanPreamble: 勝手にプランモードを抜けない旨が明記されている', () => {
  const preamble = buildDevinPlanPreamble();
  assert.match(preamble, /`e`/);
  assert.match(preamble, /プランモードを抜けない/);
});

test('buildDevinPlanPreamble: 万一の変更もターン後に自動復元される旨が明記されている', () => {
  const preamble = buildDevinPlanPreamble();
  assert.match(preamble, /自動で元の状態へ復元/);
});
