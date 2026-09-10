import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { appendMessage, mergeHistory } from '../dist-test/lib/lite-message-log.js';

// Lite シェル L3: `lite-message-log.ts` の純ロジックテスト。
// classic (`ChatPage.tsx` の `addMessageToTab()` / `loadHistory()`) と同一規則であることを、
// 境界値・参照同一性・可換性の観点から固定する。

describe('lite-message-log: appendMessage', () => {
  test('ログが空なら重複排除を一切かけずに追加する', () => {
    const result = appendMessage([], { role: 'user', content: 'hello' }, 1000);
    assert.deepEqual(result, [{ role: 'user', content: 'hello', timestampMs: 1000, messageId: undefined }]);
  });

  test('messageId が一致する行があれば追加せず既存の log 参照をそのまま返す（配列全体を走査）', () => {
    const log = [
      { role: 'user', content: 'a', timestampMs: 0, messageId: 'm0' },
      { role: 'user', content: 'b', timestampMs: 100, messageId: 'm1' },
      { role: 'user', content: 'c', timestampMs: 200, messageId: 'm2' },
      { role: 'user', content: 'd', timestampMs: 300, messageId: 'm3' },
      { role: 'user', content: 'e', timestampMs: 400, messageId: 'm4' },
      { role: 'user', content: 'f', timestampMs: 500, messageId: 'm5' },
    ];
    // m0 は直近 5 件（b..f）の外にあるが、messageId 一致は log 全体を走査するので検出される
    const result = appendMessage(log, { role: 'user', content: 'a', messageId: 'm0' }, 100000);
    assert.strictEqual(result, log);
  });

  test('incoming.messageId が空文字列なら id dedupe を発動しない（content dedupe にフォールバック）', () => {
    const log = [{ role: 'user', content: 'x', timestampMs: 1000, messageId: '' }];
    // messageId が空文字列同士でも id 経路は使われないが、content+role+30s 窓で dedupe される
    const result = appendMessage(log, { role: 'user', content: 'x', messageId: '' }, 1010);
    assert.strictEqual(result, log);
  });

  test('直近 5 件のみを見る: 6 件前の同一内容は重複とみなさず追加する', () => {
    const log = [
      { role: 'user', content: 'dup', timestampMs: 0 },
      { role: 'user', content: 'z1', timestampMs: 100 },
      { role: 'user', content: 'z2', timestampMs: 200 },
      { role: 'user', content: 'z3', timestampMs: 300 },
      { role: 'user', content: 'z4', timestampMs: 400 },
      { role: 'user', content: 'z5', timestampMs: 500 },
    ];
    const result = appendMessage(log, { role: 'user', content: 'dup' }, 600);
    assert.equal(result.length, 7);
    assert.equal(result[6].content, 'dup');
  });

  test('30000ms 境界: 差が 29999ms は重複として skip する', () => {
    const log = [{ role: 'user', content: 'x', timestampMs: 1000 }];
    const result = appendMessage(log, { role: 'user', content: 'x' }, 1000 + 29999);
    assert.strictEqual(result, log);
  });

  test('30000ms 境界: 差がちょうど 30000ms は重複とみなさず追加する', () => {
    const log = [{ role: 'user', content: 'x', timestampMs: 1000 }];
    const result = appendMessage(log, { role: 'user', content: 'x' }, 1000 + 30000);
    assert.equal(result.length, 2);
  });

  test('Math.abs を使う: 新着の timestamp が既存より過去でも同様に dedupe される', () => {
    const log = [{ role: 'user', content: 'x', timestampMs: 5000 }];
    const result = appendMessage(log, { role: 'user', content: 'x' }, 5000 - 100);
    assert.strictEqual(result, log);
  });

  test('role が異なれば内容が同じでも重複とみなさない', () => {
    const log = [{ role: 'user', content: 'x', timestampMs: 1000 }];
    const result = appendMessage(log, { role: 'system', content: 'x' }, 1010);
    assert.equal(result.length, 2);
  });

  test('messageId が無い AI 応答は content dedupe が主役になる（REST+WS 競合の再現）', () => {
    const log = [{ role: 'system', content: 'AI 応答', timestampMs: 1000 }];
    // WS 由来（messageId 無し）が REST 由来（messageId 無し）の直後に届いても dedupe される
    const result = appendMessage(log, { role: 'system', content: 'AI 応答' }, 1500);
    assert.strictEqual(result, log);
  });

  test('50 件上限を超えたら古い方から切り詰める', () => {
    let log = [];
    for (let i = 0; i < 50; i++) {
      log = appendMessage(log, { role: 'user', content: `m${i}` }, i * 100000);
    }
    assert.equal(log.length, 50);
    log = appendMessage(log, { role: 'user', content: 'm50' }, 50 * 100000);
    assert.equal(log.length, 50);
    assert.equal(log[0].content, 'm1');
    assert.equal(log[49].content, 'm50');
  });
});

describe('lite-message-log: mergeHistory', () => {
  test("'replace' モード: 既存ログを一切見ず history を timestampMs 昇順に置換する", () => {
    const log = [{ role: 'user', content: 'stale', timestampMs: 9999 }];
    const history = [
      { role: 'user', content: 'b', timestampMs: 200, messageId: 'h2' },
      { role: 'user', content: 'a', timestampMs: 100, messageId: 'h1' },
    ];
    const result = mergeHistory(log, history, 'replace', 5000);
    assert.deepEqual(
      result.map((m) => m.content),
      ['a', 'b']
    );
  });

  test("'refresh' モード: messageId が history に含まれる live 行は除外する", () => {
    const log = [{ role: 'user', content: 'x', timestampMs: 100, messageId: 'h1' }];
    const history = [{ role: 'user', content: 'x', timestampMs: 100, messageId: 'h1' }];
    const result = mergeHistory(log, history, 'refresh', 5000);
    assert.deepEqual(result, history);
  });

  test("'refresh' モード: history 最古より古い live 行は stale として除外する", () => {
    const log = [{ role: 'user', content: 'older', timestampMs: 50 }];
    const history = [{ role: 'user', content: 'h', timestampMs: 100, messageId: 'h1' }];
    const result = mergeHistory(log, history, 'refresh', 5000);
    assert.deepEqual(
      result.map((m) => m.content),
      ['h']
    );
  });

  test("'refresh' モード: 60000ms 未満の content 一致は重複として除外する（messageId 不一致でも）", () => {
    const log = [{ role: 'system', content: 'AI 応答', timestampMs: 150 }];
    const history = [{ role: 'system', content: 'AI 応答', timestampMs: 100, messageId: 'h1' }];
    const result = mergeHistory(log, history, 'refresh', 5000);
    assert.deepEqual(result, history);
  });

  test("'refresh' モード: 60000ms 以上離れていれば content 一致でも残す", () => {
    const log = [{ role: 'system', content: 'AI 応答', timestampMs: 100 + 60000 }];
    const history = [{ role: 'system', content: 'AI 応答', timestampMs: 100, messageId: 'h1' }];
    const result = mergeHistory(log, history, 'refresh', 5000);
    assert.equal(result.length, 2);
  });

  test('到着順が逆転していても timestampMs 昇順で安定ソートされる', () => {
    const log = [{ role: 'user', content: 'live-old', timestampMs: 50 }];
    const history = [
      { role: 'user', content: 'h-new', timestampMs: 300, messageId: 'h2' },
      { role: 'user', content: 'h-old', timestampMs: 100, messageId: 'h1' },
    ];
    const result = mergeHistory(log, history, 'refresh', 5000);
    assert.deepEqual(
      result.map((m) => m.content),
      ['h-old', 'h-new']
    );
  });

  test('同時刻タイでは history 側が live 側より前に来る（安定ソート）', () => {
    const log = [{ role: 'user', content: 'live', timestampMs: 100, messageId: 'live-id' }];
    const history = [{ role: 'user', content: 'hist', timestampMs: 100, messageId: 'hist-id' }];
    const result = mergeHistory(log, history, 'refresh', 5000);
    assert.deepEqual(
      result.map((m) => m.content),
      ['hist', 'live']
    );
  });

  test('history が空応答なら nowMs より古い live 行はすべて stale 除外される', () => {
    const log = [{ role: 'user', content: 'old-live', timestampMs: 100 }];
    const result = mergeHistory(log, [], 'refresh', 5000);
    assert.deepEqual(result, []);
  });
});

describe('lite-message-log: 参照同一性', () => {
  test('skip されるとき appendMessage は同一の配列参照を返す', () => {
    const log = [{ role: 'user', content: 'x', timestampMs: 1000, messageId: 'm1' }];
    const result = appendMessage(log, { role: 'user', content: 'x', messageId: 'm1' }, 1001);
    assert.strictEqual(result, log);
  });
});

describe('lite-message-log: 可換性（append→refresh と refresh→append が一致）', () => {
  test('同一メッセージが WS append と REST refresh の両方で届いても最終状態は順序に依存しない', () => {
    const incoming = { role: 'system', content: 'hello', messageId: 'm1' };
    const historyEquivalent = { role: 'system', content: 'hello', timestampMs: 1000, messageId: 'm1' };

    // Order A: append → refresh
    const a1 = appendMessage([], incoming, 1000);
    const a2 = mergeHistory(a1, [historyEquivalent], 'refresh', 2000);

    // Order B: refresh → append
    const b1 = mergeHistory([], [historyEquivalent], 'refresh', 2000);
    const b2 = appendMessage(b1, incoming, 3000);

    assert.deepEqual(a2, b2);
    assert.deepEqual(a2, [historyEquivalent]);
  });
});
