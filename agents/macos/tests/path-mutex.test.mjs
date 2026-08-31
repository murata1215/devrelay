// #348: プロセス内パスロック（path-mutex.ts）の単体テスト + mutateConversation の
// 10並行 fs 統合テスト（実際に lost update が起きない＝件数が減らないことを実測で担保する、
// プラン §Step 2-8 の要求）。外部 import ゼロの純粋関数部分は control-response.test.mjs と同じ流儀で
// コンパイル済み dist から直接 import する。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeLockKey, withPathLock, getActiveLockCount } from '../dist/services/path-mutex.js';
import { mutateConversation, loadConversation } from '../dist/services/conversation-store.js';

test('normalizeLockKey: 末尾スラッシュを除去する', () => {
  assert.equal(normalizeLockKey('/tmp/foo/'), '/tmp/foo');
  assert.equal(normalizeLockKey('/tmp/foo///'), '/tmp/foo');
});

test('normalizeLockKey: バックスラッシュをスラッシュに統一する', () => {
  assert.equal(normalizeLockKey('C:\\Users\\foo\\bar'), 'C:/Users/foo/bar');
});

test('normalizeLockKey: 前後の空白を除去する', () => {
  assert.equal(normalizeLockKey('  /tmp/foo  '), '/tmp/foo');
});

test('normalizeLockKey: ルート1文字（"/"）は末尾スラッシュを消しすぎない', () => {
  assert.equal(normalizeLockKey('/'), '/');
});

test('withPathLock: 同一キーへの呼び出しは直列実行される', async () => {
  const order = [];
  const key = 'serial-test-key';

  const task = (id, delayMs) => withPathLock(key, async () => {
    order.push(`start-${id}`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    order.push(`end-${id}`);
    return id;
  });

  const results = await Promise.all([task('a', 30), task('b', 10), task('c', 5)]);

  assert.deepEqual(results, ['a', 'b', 'c']);
  // 直列実行なら a が完全に終わってから b が始まり、b が終わってから c が始まる
  assert.deepEqual(order, ['start-a', 'end-a', 'start-b', 'end-b', 'start-c', 'end-c']);
});

test('withPathLock: 異なるキー同士は並行実行される（待たされない）', async () => {
  const start = Date.now();
  await Promise.all([
    withPathLock('key-x', () => new Promise((resolve) => setTimeout(resolve, 50))),
    withPathLock('key-y', () => new Promise((resolve) => setTimeout(resolve, 50))),
  ]);
  const elapsed = Date.now() - start;
  // 直列なら100ms以上かかるはずだが、並行なら50ms程度で終わる（マージンを見て80ms未満とする）
  assert.ok(elapsed < 80, `expected concurrent execution (<80ms), got ${elapsed}ms`);
});

test('withPathLock: fn が reject しても次の待機者は実行される（ロックは永久に塞がれない）', async () => {
  const key = 'reject-test-key';
  let secondRan = false;

  await assert.rejects(
    withPathLock(key, async () => { throw new Error('boom'); }),
    /boom/,
  );

  await withPathLock(key, async () => { secondRan = true; });
  assert.equal(secondRan, true);
});

test('withPathLock: 呼び出し元には fn の例外がそのまま伝播する', async () => {
  const key = 'propagate-test-key';
  await assert.rejects(
    withPathLock(key, async () => { throw new TypeError('specific error'); }),
    TypeError,
  );
});

test('getActiveLockCount: 完了後はチェーンがクリーンアップされる', async () => {
  const key = `cleanup-test-key-${Date.now()}`;
  await withPathLock(key, async () => 'done');
  // 掃除用の finally は戻り値の Promise（runAfterPrevious）よりさらに後段のチェーン
  // （chainEntry.finally）にぶら下がっているため、await 直後の時点ではまだ実行されていない
  // 場合がある。マクロタスクを1回挟んでマイクロタスクキューを掃かせてから確認する。
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(getActiveLockCount(), 0);
});

test('mutateConversation: 10並行書き込みでも lost update が起きない（実測、10件全て残る）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'devrelay-348-mutex-'));
  try {
    const tasks = [];
    for (let i = 0; i < 10; i++) {
      tasks.push(mutateConversation(dir, (current) => [
        ...current,
        { role: 'user', content: `msg-${i}`, timestamp: new Date().toISOString() },
      ]));
    }
    await Promise.all(tasks);

    const finalHistory = await loadConversation(dir);
    assert.equal(finalHistory.length, 10, `expected 10 messages, got ${finalHistory.length} (lost update if fewer)`);

    // 10件全てのメッセージが揃っていること（順序は問わない）
    const contents = new Set(finalHistory.map((h) => h.content));
    for (let i = 0; i < 10; i++) {
      assert.ok(contents.has(`msg-${i}`), `missing msg-${i}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
