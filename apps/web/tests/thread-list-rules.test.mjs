import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  sortThreadsDesc,
  deriveThreadLabel,
  isDefaultThread,
  truncateDisplay,
  applyThreadRename,
  upsertThread,
} from '../dist-test/lib/thread-list-rules.js';

const mkItem = (sessionId, overrides = {}) => ({
  sessionId,
  title: null,
  firstUserMessage: null,
  isScoped: true,
  lastActiveAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

describe('sortThreadsDesc（§6: lastActiveAt desc）', () => {
  test('lastActiveAt の新しい順にソートする', () => {
    const a = mkItem('a', { lastActiveAt: '2026-01-01T00:00:00Z' });
    const b = mkItem('b', { lastActiveAt: '2026-01-03T00:00:00Z' });
    const c = mkItem('c', { lastActiveAt: '2026-01-02T00:00:00Z' });
    const sorted = sortThreadsDesc([a, b, c]);
    assert.deepEqual(sorted.map((t) => t.sessionId), ['b', 'c', 'a']);
  });

  test('非破壊（元配列を変更しない）', () => {
    const a = mkItem('a', { lastActiveAt: '2026-01-01T00:00:00Z' });
    const b = mkItem('b', { lastActiveAt: '2026-01-03T00:00:00Z' });
    const original = [a, b];
    sortThreadsDesc(original);
    assert.deepEqual(original.map((t) => t.sessionId), ['a', 'b']);
  });

  test('サーバーが既に正しい順で返した場合は順序を保つ', () => {
    const a = mkItem('a', { lastActiveAt: '2026-01-05T00:00:00Z' });
    const b = mkItem('b', { lastActiveAt: '2026-01-01T00:00:00Z' });
    const sorted = sortThreadsDesc([a, b]);
    assert.deepEqual(sorted.map((t) => t.sessionId), ['a', 'b']);
  });
});

describe('truncateDisplay（サロゲート境界安全・#297の教訓）', () => {
  test('max 以下ならそのまま返す', () => {
    assert.equal(truncateDisplay('hello', 40), 'hello');
  });

  test('max を超えたら切り詰める', () => {
    assert.equal(truncateDisplay('a'.repeat(60), 40), 'a'.repeat(40));
  });

  test('絵文字（サロゲートペア）の境界で割れない', () => {
    // 😀 は UTF-16 で2コード単位（サロゲートペア）。1文字境界で切ると壊れる。
    const text = '😀'.repeat(41); // 41コードポイント
    const truncated = truncateDisplay(text, 40);
    assert.equal(Array.from(truncated).length, 40);
    assert.equal(truncated, '😀'.repeat(40));
  });
});

describe('deriveThreadLabel（§5: title / firstUserMessage 先頭40字 / fallback）', () => {
  test('title があればそれを返す（kind: title）', () => {
    const label = deriveThreadLabel({ title: 'My Thread', firstUserMessage: 'hello world' });
    assert.deepEqual(label, { text: 'My Thread', kind: 'title' });
  });

  test('title が空白のみなら無視してfirstUserMessageへフォールバック（kind: firstMessage）', () => {
    const label = deriveThreadLabel({ title: '   ', firstUserMessage: 'hello world' });
    assert.deepEqual(label, { text: 'hello world', kind: 'firstMessage' });
  });

  test('title が無ければ firstUserMessage の先頭40字', () => {
    const long = 'a'.repeat(60);
    const label = deriveThreadLabel({ title: null, firstUserMessage: long });
    assert.equal(label.text, 'a'.repeat(40));
    assert.equal(label.kind, 'firstMessage');
  });

  test('max を指定すればその文字数で切り詰める', () => {
    const label = deriveThreadLabel({ title: null, firstUserMessage: 'a'.repeat(60) }, 10);
    assert.equal(label.text, 'a'.repeat(10));
  });

  test('title も firstUserMessage も無ければ fallback（text は空文字、呼び出し側がi18nで解決）', () => {
    const label = deriveThreadLabel({ title: null, firstUserMessage: null });
    assert.deepEqual(label, { text: '', kind: 'fallback' });
  });

  test('firstUserMessage が空白のみなら fallback', () => {
    const label = deriveThreadLabel({ title: null, firstUserMessage: '   ' });
    assert.equal(label.kind, 'fallback');
  });
});

describe('isDefaultThread（§6: agentScopeId = NULL は「既定」ラベル付きで常に表示）', () => {
  test('isScoped=false（agentScopeId=NULL）なら既定スレッド', () => {
    assert.equal(isDefaultThread({ isScoped: false }), true);
  });

  test('isScoped=true なら既定スレッドではない', () => {
    assert.equal(isDefaultThread({ isScoped: true }), false);
  });

  test('既定スレッドでも title があればラベルはtitleが優先される（既定判定とは独立）', () => {
    const item = { title: 'Renamed', firstUserMessage: null, isScoped: false };
    assert.equal(isDefaultThread(item), true);
    assert.deepEqual(deriveThreadLabel(item), { text: 'Renamed', kind: 'title' });
  });
});

describe('applyThreadRename（楽観的リネーム・非破壊）', () => {
  test('対象の title を更新する', () => {
    const list = [mkItem('a', { title: 'old' }), mkItem('b')];
    const result = applyThreadRename(list, 'a', 'new');
    assert.equal(result.find((t) => t.sessionId === 'a').title, 'new');
    assert.equal(result.find((t) => t.sessionId === 'b').title, null);
  });

  test('非破壊（元配列を変更しない）', () => {
    const list = [mkItem('a', { title: 'old' })];
    applyThreadRename(list, 'a', 'new');
    assert.equal(list[0].title, 'old');
  });

  test('対象が無ければ変更なしの新しい配列を返す', () => {
    const list = [mkItem('a', { title: 'old' })];
    const result = applyThreadRename(list, 'missing', 'new');
    assert.deepEqual(result, list);
    assert.notEqual(result, list);
  });
});

describe('upsertThread（楽観的挿入/更新・再ソート済み・非破壊）', () => {
  test('新規なら先頭に追加し再ソートする', () => {
    const list = [mkItem('a', { lastActiveAt: '2026-01-01T00:00:00Z' })];
    const newItem = mkItem('b', { lastActiveAt: '2026-01-05T00:00:00Z' });
    const result = upsertThread(list, newItem);
    assert.deepEqual(result.map((t) => t.sessionId), ['b', 'a']);
  });

  test('既存なら置き換える', () => {
    const list = [mkItem('a', { title: 'old', lastActiveAt: '2026-01-01T00:00:00Z' })];
    const updated = mkItem('a', { title: 'updated', lastActiveAt: '2026-01-01T00:00:00Z' });
    const result = upsertThread(list, updated);
    assert.equal(result.length, 1);
    assert.equal(result[0].title, 'updated');
  });

  test('非破壊（元配列を変更しない）', () => {
    const list = [mkItem('a')];
    upsertThread(list, mkItem('b'));
    assert.equal(list.length, 1);
  });
});
