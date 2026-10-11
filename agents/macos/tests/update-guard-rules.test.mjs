// サイクル3.1: Agent 自己更新の保留判定（agents/linux/src/services/update-guard-rules.ts）の単体テスト。
// 外部 import ゼロの純粋関数をコンパイル済み dist から直接 import する（resume-priority.test.mjs と同じ流儀）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideAgentUpdateAction, isTurnStale } from '../dist/services/update-guard-rules.js';

test('decideAgentUpdateAction: force=true なら実行中ターンがあっても常に start', () => {
  assert.equal(decideAgentUpdateAction({ activeAiTurns: 5, pendingUpdate: false, force: true }), 'start');
  assert.equal(decideAgentUpdateAction({ activeAiTurns: 5, pendingUpdate: true, force: true }), 'start');
});

test('decideAgentUpdateAction: 実行中ターンあり ＋ まだ保留していない → defer', () => {
  assert.equal(decideAgentUpdateAction({ activeAiTurns: 1, pendingUpdate: false }), 'defer');
});

test('decideAgentUpdateAction: 実行中ターンあり ＋ すでに保留中 → wait（再送しない）', () => {
  assert.equal(decideAgentUpdateAction({ activeAiTurns: 1, pendingUpdate: true }), 'wait');
});

test('decideAgentUpdateAction: 実行中ターン無し → start（pendingUpdate の値に関わらず）', () => {
  assert.equal(decideAgentUpdateAction({ activeAiTurns: 0, pendingUpdate: false }), 'start');
  assert.equal(decideAgentUpdateAction({ activeAiTurns: 0, pendingUpdate: true }), 'start');
});

test('decideAgentUpdateAction: force 省略時は false 相当（通常判定になる）', () => {
  assert.equal(decideAgentUpdateAction({ activeAiTurns: 1, pendingUpdate: false }), 'defer');
});

test('isTurnStale: TTL 未満は false', () => {
  assert.equal(isTurnStale(1000, 1999, 1000), false);
});

test('isTurnStale: ちょうど TTL で true（境界値）', () => {
  assert.equal(isTurnStale(1000, 2000, 1000), true);
});

test('isTurnStale: TTL 超過は true', () => {
  assert.equal(isTurnStale(1000, 9999, 1000), true);
});
