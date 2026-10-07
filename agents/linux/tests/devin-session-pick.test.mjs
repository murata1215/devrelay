// Devin のスレッド跨ぎ文脈汚染サイクル: 「今回のターンの Devin セッション ID」を確定する
// 純関数群（devin-session-pick.ts）の単体テスト。
// 外部 import ゼロの純粋関数をコンパイル済み dist から直接 import する（devin-atif.test.mjs と同じ流儀）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDevinSessionList, pickDevinSessionId } from '../dist/services/devin-session-pick.js';

const PROJECT = '/home/user/myproject';

test('parseDevinSessionList: 空文字列は空配列', () => {
  assert.deepEqual(parseDevinSessionList('', PROJECT), []);
});

test('parseDevinSessionList: 不正な JSON は空配列（例外を投げない）', () => {
  assert.deepEqual(parseDevinSessionList('{not valid json', PROJECT), []);
});

test('parseDevinSessionList: 配列でない JSON（オブジェクト）は空配列', () => {
  assert.deepEqual(parseDevinSessionList(JSON.stringify({ foo: 'bar' }), PROJECT), []);
});

test('parseDevinSessionList: working_directory が一致しないエントリは除外', () => {
  const raw = JSON.stringify([
    { id: 'sess-a', working_directory: '/home/user/otherproject', last_activity_at: 1000 },
    { id: 'sess-b', working_directory: PROJECT, last_activity_at: 2000 },
  ]);
  const result = parseDevinSessionList(raw, PROJECT);
  assert.deepEqual(result.map((e) => e.id), ['sess-b']);
});

test('parseDevinSessionList: working_directory はバックスラッシュ・大小文字を正規化して比較する', () => {
  const raw = JSON.stringify([
    { id: 'sess-win', working_directory: 'C:\\Users\\Foo\\Proj', last_activity_at: 1000 },
  ]);
  const result = parseDevinSessionList(raw, 'c:/users/foo/proj');
  assert.deepEqual(result.map((e) => e.id), ['sess-win']);
});

test('parseDevinSessionList: id が無い/working_directory が無いエントリは除外（例外を投げない）', () => {
  const raw = JSON.stringify([
    { working_directory: PROJECT, last_activity_at: 1000 },
    { id: 'sess-c' },
    null,
    'not-an-object',
  ]);
  assert.deepEqual(parseDevinSessionList(raw, PROJECT), []);
});

test('parseDevinSessionList: last_activity_at の正規化 — 数値 epoch', () => {
  const raw = JSON.stringify([{ id: 'sess-a', working_directory: PROJECT, last_activity_at: 1700000000000 }]);
  const result = parseDevinSessionList(raw, PROJECT);
  assert.equal(result[0].lastActivityMs, 1700000000000);
});

test('parseDevinSessionList: last_activity_at の正規化 — ISO8601 文字列（旧実装の NaN バグ修正の回帰）', () => {
  const raw = JSON.stringify([{ id: 'sess-a', working_directory: PROJECT, last_activity_at: '2026-10-08T12:00:00Z' }]);
  const result = parseDevinSessionList(raw, PROJECT);
  assert.equal(result[0].lastActivityMs, Date.parse('2026-10-08T12:00:00Z'));
  assert.ok(Number.isFinite(result[0].lastActivityMs), 'ISO8601 文字列が NaN にならないこと');
});

test('parseDevinSessionList: last_activity_at の正規化 — null/未定義/不正文字列は -Infinity', () => {
  const raw = JSON.stringify([
    { id: 'sess-a', working_directory: PROJECT, last_activity_at: null },
    { id: 'sess-b', working_directory: PROJECT },
    { id: 'sess-c', working_directory: PROJECT, last_activity_at: 'not-a-date' },
  ]);
  const result = parseDevinSessionList(raw, PROJECT);
  for (const entry of result) {
    assert.equal(entry.lastActivityMs, -Infinity);
  }
});

test('pickDevinSessionId: resumedId があれば即座に確定し beforeIds/afterEntries を見ない', () => {
  const result = pickDevinSessionId({
    resumedId: 'sess-resumed',
    beforeIds: null,
    afterEntries: [{ id: 'sess-other', lastActivityMs: 999999 }],
    ownedByOtherScope: () => true, // 呼ばれないはず（呼ばれたら ownedByOtherScope 扱いになってしまう）
  });
  assert.deepEqual(result, { id: 'sess-resumed', reason: 'resumed' });
});

test('pickDevinSessionId: 新規セッションで新しく現れた ID が1件 → newlyAppeared', () => {
  // last_activity_at が ISO 文字列の3件を想定（旧実装は比較器が NaN になりソートが効かず、
  // 常に devin list の出力順の先頭を返していた）。beforeIds に A・C、after に A・B・C → B が選ばれること。
  const afterEntries = [
    { id: 'sess-a', lastActivityMs: Date.parse('2026-10-08T10:00:00Z') },
    { id: 'sess-b', lastActivityMs: Date.parse('2026-10-08T11:00:00Z') },
    { id: 'sess-c', lastActivityMs: Date.parse('2026-10-08T09:00:00Z') },
  ];
  const result = pickDevinSessionId({
    resumedId: null,
    beforeIds: ['sess-a', 'sess-c'],
    afterEntries,
    ownedByOtherScope: () => false,
  });
  assert.deepEqual(result, { id: 'sess-b', reason: 'newlyAppeared' });
});

test('pickDevinSessionId: 新規に現れたものが無い場合はタイムスタンプ最新へフォールバック', () => {
  const afterEntries = [
    { id: 'sess-a', lastActivityMs: 1000 },
    { id: 'sess-b', lastActivityMs: 3000 },
  ];
  const result = pickDevinSessionId({
    resumedId: null,
    beforeIds: ['sess-a', 'sess-b'],
    afterEntries,
    ownedByOtherScope: () => false,
  });
  assert.deepEqual(result, { id: 'sess-b', reason: 'latestFallback' });
});

test('pickDevinSessionId: 新規に複数件が同時出現 → ambiguous（保存しない）', () => {
  const afterEntries = [
    { id: 'sess-a', lastActivityMs: 1000 },
    { id: 'sess-b', lastActivityMs: 2000 },
    { id: 'sess-c', lastActivityMs: 3000 },
  ];
  const result = pickDevinSessionId({
    resumedId: null,
    beforeIds: ['sess-a'],
    afterEntries,
    ownedByOtherScope: () => false,
  });
  assert.deepEqual(result, { id: null, reason: 'ambiguous' });
});

test('pickDevinSessionId: 候補が既に別スコープに所有されている → ownedByOtherScope（保存しない）', () => {
  const afterEntries = [{ id: 'sess-b', lastActivityMs: 2000 }];
  const result = pickDevinSessionId({
    resumedId: null,
    beforeIds: ['sess-a'],
    afterEntries,
    ownedByOtherScope: (id) => id === 'sess-b',
  });
  assert.deepEqual(result, { id: null, reason: 'ownedByOtherScope' });
});

test('pickDevinSessionId: beforeIds が null（スナップショット取得失敗）→ タイムスタンプ最新フォールバック', () => {
  const afterEntries = [
    { id: 'sess-a', lastActivityMs: Date.parse('2026-10-08T09:00:00Z') },
    { id: 'sess-b', lastActivityMs: Date.parse('2026-10-08T11:00:00Z') },
  ];
  const result = pickDevinSessionId({
    resumedId: null,
    beforeIds: null,
    afterEntries,
    ownedByOtherScope: () => false,
  });
  assert.deepEqual(result, { id: 'sess-b', reason: 'latestFallback' });
});

test('pickDevinSessionId: afterEntries が空 → none（list 結果ゼロ、何も見つからない）', () => {
  const result = pickDevinSessionId({
    resumedId: null,
    beforeIds: ['sess-a'],
    afterEntries: [],
    ownedByOtherScope: () => false,
  });
  assert.deepEqual(result, { id: null, reason: 'none' });
});

test('pickDevinSessionId: フォールバック候補が他スコープ所有でも ownedByOtherScope を返す', () => {
  const afterEntries = [
    { id: 'sess-a', lastActivityMs: 1000 },
    { id: 'sess-b', lastActivityMs: 2000 },
  ];
  const result = pickDevinSessionId({
    resumedId: null,
    beforeIds: null,
    afterEntries,
    ownedByOtherScope: (id) => id === 'sess-b',
  });
  assert.deepEqual(result, { id: null, reason: 'ownedByOtherScope' });
});
