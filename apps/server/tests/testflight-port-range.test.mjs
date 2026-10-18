// 2026-10-18 testflight ポート衝突事故（手動作成サイトと同じポート 9027 を払い出した）の根治対応。
// 採番を「DB/Caddy/ss を全部見て賢く判定する」のではなく、9001-9299（手動プロジェクト・旧採番サービス）と
// 9300-9499（testflight 自動採番専用）にレンジを分離した。純粋関数 pickTestflightPort / resolvePortRangeStart
// の単体テスト（testflight-killswitch.test.mjs と同じ `../dist/...` から import する流儀）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickTestflightPort, resolvePortRangeStart } from '../dist/services/testflight-manager.js';

test('pickTestflightPort: レンジ外の既存ポート（旧採番 9001-9029）は無視して開始値を返す', () => {
  const existing = [9001, 9009, 9010, 9026, 9027, 9028, 9029];
  assert.equal(pickTestflightPort(existing, 9300, 9499), 9300);
});

test('pickTestflightPort: レンジ内に既存があれば最大値 + 1', () => {
  assert.equal(pickTestflightPort([9300, 9301], 9300, 9499), 9302);
});

test('pickTestflightPort: レンジ内の欠番は再利用しない（単調増加）', () => {
  assert.equal(pickTestflightPort([9300, 9302], 9300, 9499), 9303);
});

test('pickTestflightPort: 空配列なら開始値を返す', () => {
  assert.equal(pickTestflightPort([], 9300, 9499), 9300);
});

test('pickTestflightPort: 上限まで埋まっていたら null', () => {
  const full = [];
  for (let p = 9300; p <= 9499; p++) full.push(p);
  assert.equal(pickTestflightPort(full, 9300, 9499), null);
});

test('resolvePortRangeStart: 未設定は既定 9300', () => {
  assert.equal(resolvePortRangeStart(undefined), 9300);
  assert.equal(resolvePortRangeStart(''), 9300);
});

test('resolvePortRangeStart: 数値指定はそのまま採用', () => {
  assert.equal(resolvePortRangeStart('9400'), 9400);
});

test('resolvePortRangeStart: 非数値・範囲外は既定 9300 に clamp', () => {
  assert.equal(resolvePortRangeStart('abc'), 9300);
  assert.equal(resolvePortRangeStart('8000'), 9300); // 9001 未満
  assert.equal(resolvePortRangeStart('10000'), 9300); // 9900 超
});
