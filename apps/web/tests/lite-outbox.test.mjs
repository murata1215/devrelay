import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  OUTBOX_MAX_ENTRIES,
  appendOutbox,
  removeOutbox,
  composeDisplayMessages,
} from '../dist-test/lib/lite-outbox.js';

// Lite シェル L4 B0: lite-outbox.ts の純ロジックテスト。
// 参照プラン `~/.claude/plans/enchanted-bouncing-kitten.md` R1/R2/B5。

function entry(overrides = {}) {
  return {
    clientId: 'c1',
    sessionId: 's1',
    content: 'hello',
    createdAtMs: 1000,
    knownMessageIds: [],
    ...overrides,
  };
}

describe('appendOutbox（非破壊 + 上限切り詰め）', () => {
  test('追加すると末尾に積まれる', () => {
    const result = appendOutbox([], entry());
    assert.deepEqual(result, [entry()]);
  });

  test('入力配列を破壊しない', () => {
    const before = [entry({ clientId: 'c0' })];
    const beforeCopy = [...before];
    appendOutbox(before, entry({ clientId: 'c1' }));
    assert.deepEqual(before, beforeCopy);
  });

  test('OUTBOX_MAX_ENTRIES を超えたら古い方から切り詰める', () => {
    let outbox = [];
    for (let i = 0; i < OUTBOX_MAX_ENTRIES + 3; i++) {
      outbox = appendOutbox(outbox, entry({ clientId: `c${i}` }));
    }
    assert.equal(outbox.length, OUTBOX_MAX_ENTRIES);
    assert.equal(outbox[0].clientId, 'c3');
    assert.equal(outbox[outbox.length - 1].clientId, `c${OUTBOX_MAX_ENTRIES + 2}`);
  });
});

describe('removeOutbox（非破壊）', () => {
  test('clientId が一致するエントリを取り除く', () => {
    const outbox = [entry({ clientId: 'c1' }), entry({ clientId: 'c2' })];
    const result = removeOutbox(outbox, 'c1');
    assert.deepEqual(result.map((e) => e.clientId), ['c2']);
  });

  test('一致しなければそのまま（要素数不変）', () => {
    const outbox = [entry({ clientId: 'c1' })];
    const result = removeOutbox(outbox, 'unknown');
    assert.deepEqual(result, outbox);
  });

  test('入力配列を破壊しない', () => {
    const before = [entry({ clientId: 'c1' }), entry({ clientId: 'c2' })];
    const beforeCopy = [...before];
    removeOutbox(before, 'c1');
    assert.deepEqual(before, beforeCopy);
  });
});

describe('composeDisplayMessages（B5: 楽観的表示の dedupe）', () => {
  test('空 outbox は messages と同一参照を返す', () => {
    const messages = [{ role: 'system', content: 'hi', timestampMs: 1 }];
    const result = composeDisplayMessages(messages, [], 's1');
    assert.equal(result, messages);
  });

  test('未確定エントリが末尾に 1 件だけ現れる', () => {
    const messages = [{ role: 'system', content: 'welcome', timestampMs: 1 }];
    const outbox = [entry({ clientId: 'c1', content: 'hello', createdAtMs: 2000 })];
    const result = composeDisplayMessages(messages, outbox, 's1');
    assert.equal(result.length, 2);
    assert.equal(result[1].role, 'user');
    assert.equal(result[1].content, 'hello');
    assert.equal(result[1].messageId, 'c1');
  });

  test('サーバー側 user メッセージが届いたら消える（二重にならない）', () => {
    const messages = [
      { role: 'system', content: 'welcome', timestampMs: 1 },
      { role: 'user', content: 'hello', timestampMs: 2, messageId: 'srv-1' },
    ];
    const outbox = [entry({ clientId: 'c1', content: 'hello', createdAtMs: 2000 })];
    const result = composeDisplayMessages(messages, outbox, 's1');
    assert.equal(result, messages); // pending が 0 件なので同一参照
    assert.equal(result.filter((m) => m.content === 'hello').length, 1);
  });

  test('knownMessageIds に含まれる既存 user メッセージとはマッチしない（過去の同文面で誤消滅しない）', () => {
    const messages = [
      { role: 'user', content: 'hello', timestampMs: 1, messageId: 'old-1' },
    ];
    const outbox = [
      entry({ clientId: 'c1', content: 'hello', createdAtMs: 2000, knownMessageIds: ['old-1'] }),
    ];
    const result = composeDisplayMessages(messages, outbox, 's1');
    // old-1 とはマッチしないので pending のまま残る → 末尾に追記される
    assert.equal(result.length, 2);
    assert.equal(result[1].messageId, 'c1');
  });

  test('同一文面の連投2件は貪欲1:1マッチで片方ずつ消える', () => {
    const messages = [
      { role: 'user', content: 'hi', timestampMs: 1, messageId: 'srv-1' },
    ];
    const outbox = [
      entry({ clientId: 'c1', content: 'hi', createdAtMs: 1000 }),
      entry({ clientId: 'c2', content: 'hi', createdAtMs: 2000 }),
    ];
    const result = composeDisplayMessages(messages, outbox, 's1');
    // c1 が srv-1 とマッチして消え、c2 は未確定のまま残る
    assert.equal(result.length, 2);
    assert.equal(result[1].messageId, 'c2');
  });

  test('sessionId が不一致のエントリは表示されない', () => {
    const messages = [{ role: 'system', content: 'welcome', timestampMs: 1 }];
    const outbox = [entry({ clientId: 'c1', sessionId: 's1' })];
    const result = composeDisplayMessages(messages, outbox, 's2');
    assert.equal(result, messages);
  });

  test('sessionId が null なら何も合成しない', () => {
    const messages = [{ role: 'system', content: 'welcome', timestampMs: 1 }];
    const outbox = [entry({ clientId: 'c1' })];
    const result = composeDisplayMessages(messages, outbox, null);
    assert.equal(result, messages);
  });

  test('messages の並びを再ソートしない（末尾追記のみ）', () => {
    const messages = [
      { role: 'system', content: 'b', timestampMs: 5000 },
      { role: 'system', content: 'a', timestampMs: 1 },
    ];
    const outbox = [entry({ clientId: 'c1', content: 'new', createdAtMs: 10 })];
    const result = composeDisplayMessages(messages, outbox, 's1');
    assert.deepEqual(result.map((m) => m.content), ['b', 'a', 'new']);
  });
});
