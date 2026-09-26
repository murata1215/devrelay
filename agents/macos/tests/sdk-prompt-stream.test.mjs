// sdk-prompt-stream: query() に渡す prompt を文字列のまま使うと SDK が最初の result で CLI への stdin を
// 閉じてしまい（isSingleUserTurn=true）、途中 result を延期する bg-task 判定と衝突して
// canUseTool の応答経路（Write/Edit 等の承認）が死ぬ問題の修正（sdk-prompt-stream.ts）の単体テスト。
// コンパイル済み dist から直接 import する（sdk-background-tasks.test.mjs と同じ流儀）。
// agents/macos/tests/sdk-prompt-stream.test.mjs と byte-for-byte 同一。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSdkPromptStream } from '../dist/services/sdk-prompt-stream.js';

/** async iterator の next() が「今すぐには解決しない（pending のまま）」ことを検証するヘルパー。
 * 短いタイムアウトで Promise.race させ、pending 側が勝てば true を返す。 */
async function isPending(promise, ms = 30) {
  const sentinel = Symbol('pending');
  const timeout = new Promise((resolve) => setTimeout(() => resolve(sentinel), ms));
  const winner = await Promise.race([promise, timeout]);
  return winner === sentinel;
}

// ============================================================
// A. yield されるメッセージの形
// ============================================================

test('A1: 1件目は SDK の文字列パスと同形の user メッセージを yield する', async () => {
  const handle = buildSdkPromptStream('こんにちは');
  const it = handle.stream[Symbol.asyncIterator]();
  const { value, done } = await it.next();
  assert.equal(done, false);
  assert.deepEqual(value, {
    type: 'user',
    session_id: '',
    message: {
      role: 'user',
      content: [{ type: 'text', text: 'こんにちは' }],
    },
    parent_tool_use_id: null,
  });
  handle.release();
});

test('A2: 空文字列や長文でも text フィールドがそのまま反映される', async () => {
  for (const text of ['', 'a'.repeat(5000)]) {
    const handle = buildSdkPromptStream(text);
    const it = handle.stream[Symbol.asyncIterator]();
    const { value } = await it.next();
    assert.equal(value.message.content[0].text, text);
    handle.release();
  }
});

// ============================================================
// B. release() までイテレータが完了しないこと（stdin を閉じさせない核心動作）
// ============================================================

test('B1: release() を呼ぶまで2件目の next() は pending のまま', async () => {
  const handle = buildSdkPromptStream('p');
  const it = handle.stream[Symbol.asyncIterator]();
  await it.next(); // 1件目（yield 済み）
  const second = it.next();
  assert.equal(await isPending(second), true, '2件目の next() は release() 前に解決してはいけない');
  handle.release();
  const { done } = await second;
  assert.equal(done, true);
});

test('B2: release() 後は速やかに done:true で完了する', async () => {
  const handle = buildSdkPromptStream('p');
  const it = handle.stream[Symbol.asyncIterator]();
  await it.next();
  handle.release();
  const { done, value } = await it.next();
  assert.equal(done, true);
  assert.equal(value, undefined);
});

test('B3: release() を先に呼んでおいても後から安全に完了する（順序非依存）', async () => {
  const handle = buildSdkPromptStream('p');
  const it = handle.stream[Symbol.asyncIterator]();
  await it.next();
  handle.release();
  // release() 済みなので、この next() はすぐに解決するはず
  assert.equal(await isPending(it.next()), false);
});

// ============================================================
// C. release() の冪等性
// ============================================================

test('C1: release() を複数回呼んでも例外を投げず、2件目以降の完了は1回だけ', async () => {
  const handle = buildSdkPromptStream('p');
  const it = handle.stream[Symbol.asyncIterator]();
  await it.next();
  assert.doesNotThrow(() => {
    handle.release();
    handle.release();
    handle.release();
  });
  const { done } = await it.next();
  assert.equal(done, true);
});

// ============================================================
// D. for-await との統合（SDK の Query.streamInput() が行う消費パターンの模倣）
// ============================================================

test('D1: for-await ループは release() が呼ばれるまで完了しない', async () => {
  const handle = buildSdkPromptStream('p');
  let loopFinished = false;
  const consumer = (async () => {
    for await (const _msg of handle.stream) {
      // 1件受け取ったら消費側は何もせず待つ（SDK 側の write と同等の役割のみ）
    }
    loopFinished = true;
  })();

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(loopFinished, false, 'release() 前に for-await ループが完了してはいけない');

  handle.release();
  await consumer;
  assert.equal(loopFinished, true);
});

test('D2: 複数の独立したストリームが互いに干渉しない', async () => {
  const h1 = buildSdkPromptStream('one');
  const h2 = buildSdkPromptStream('two');
  const it1 = h1.stream[Symbol.asyncIterator]();
  const it2 = h2.stream[Symbol.asyncIterator]();
  const v1 = await it1.next();
  const v2 = await it2.next();
  assert.equal(v1.value.message.content[0].text, 'one');
  assert.equal(v2.value.message.content[0].text, 'two');

  h1.release();
  assert.equal((await it1.next()).done, true);
  // h1 を release しても h2 は影響を受けない
  assert.equal(await isPending(it2.next()), true);
  h2.release();
});
