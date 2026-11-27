// 再起動耐性サイクル（2026-11-25）: agents/linux/src/services/outbox-rules.ts の単体テスト。
// 外部 import ゼロの純粋関数をコンパイル済み dist から直接 import する
// （update-guard-rules.test.mjs と同じ流儀）。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { decideOutboxAction, trimOutbox } from '../dist/services/outbox-rules.js';

describe('decideOutboxAction', () => {
  test('agent:ai:output かつ isComplete:true は queue-must（完了報告は失ってはいけない）', () => {
    assert.equal(decideOutboxAction({ type: 'agent:ai:output', isComplete: true }), 'queue-must');
  });

  test('agent:ai:output かつ isComplete:false は queue-best-effort（途中出力は失っても実害が小さい）', () => {
    assert.equal(decideOutboxAction({ type: 'agent:ai:output', isComplete: false }), 'queue-best-effort');
  });

  test('agent:tool:approval:request は queue-must（届かないと人間が永久に気づけない）', () => {
    assert.equal(decideOutboxAction({ type: 'agent:tool:approval:request' }), 'queue-must');
  });

  test('agent:ping は drop（再送の意味が無い即時性のみの情報）', () => {
    assert.equal(decideOutboxAction({ type: 'agent:ping' }), 'drop');
  });

  test('agent:connect は drop（再接続時に専用経路で必ず送り直される）', () => {
    assert.equal(decideOutboxAction({ type: 'agent:connect' }), 'drop');
  });

  test('その他のメッセージ種別は queue-best-effort', () => {
    assert.equal(decideOutboxAction({ type: 'agent:history:dates' }), 'queue-best-effort');
    assert.equal(decideOutboxAction({ type: 'agent:version:info' }), 'queue-best-effort');
  });
});

describe('trimOutbox', () => {
  function entry(id, mustKeep, sizeBytes = 100) {
    return { json: `{"id":"${id}"}`, sizeBytes, mustKeep };
  }

  test('上限内なら何も間引かない', () => {
    const entries = [entry('a', false), entry('b', true)];
    const result = trimOutbox(entries, { maxEntries: 10, maxBytes: 10_000 });
    assert.deepEqual(result.kept.map(e => e.json), entries.map(e => e.json));
    assert.equal(result.droppedBestEffort, 0);
    assert.equal(result.droppedMust, 0);
  });

  test('件数超過: best-effort を古い順に間引く（must-keep は残す）', () => {
    const entries = [entry('a', false), entry('b', false), entry('c', true)];
    const result = trimOutbox(entries, { maxEntries: 2, maxBytes: 10_000 });
    assert.deepEqual(result.kept.map(e => JSON.parse(e.json).id), ['b', 'c']);
    assert.equal(result.droppedBestEffort, 1);
    assert.equal(result.droppedMust, 0);
  });

  test('バイト数超過: best-effort を古い順に間引く', () => {
    const entries = [entry('a', false, 500), entry('b', false, 500), entry('c', true, 100)];
    const result = trimOutbox(entries, { maxEntries: 10, maxBytes: 600 });
    // a(500,best-effort) を間引いて 600 以下にする
    assert.deepEqual(result.kept.map(e => JSON.parse(e.json).id), ['b', 'c']);
    assert.equal(result.droppedBestEffort, 1);
  });

  test('best-effort が尽きてもまだ超過: must-keep も古い順に間引く（最後の手段）', () => {
    const entries = [entry('a', true), entry('b', true), entry('c', true)];
    const result = trimOutbox(entries, { maxEntries: 1, maxBytes: 10_000 });
    assert.deepEqual(result.kept.map(e => JSON.parse(e.json).id), ['c']);
    assert.equal(result.droppedBestEffort, 0);
    assert.equal(result.droppedMust, 2);
  });

  test('must-keep が優先的に残る（best-effort が新しくても先に間引かれる）', () => {
    const entries = [entry('old-must', true), entry('new-best-effort', false)];
    const result = trimOutbox(entries, { maxEntries: 1, maxBytes: 10_000 });
    assert.deepEqual(result.kept.map(e => JSON.parse(e.json).id), ['old-must']);
    assert.equal(result.droppedBestEffort, 1);
  });

  test('空配列は何も起きない', () => {
    const result = trimOutbox([], { maxEntries: 10, maxBytes: 10_000 });
    assert.deepEqual(result.kept, []);
    assert.equal(result.droppedBestEffort, 0);
    assert.equal(result.droppedMust, 0);
  });
});
