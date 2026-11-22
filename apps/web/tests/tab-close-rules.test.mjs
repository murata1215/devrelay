// タブバー 一括クローズ（他のタブ/以降のタブ/すべて閉じる）のルールテスト（2026-11-22）。
// node:test から dist-test/ を直接 import する（tab-order-rules.test.mjs 等と同じ流儀）。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTabClose, clampContextMenuPosition } from '../dist-test/lib/tab-close-rules.js';

const tabs = (...entries) => entries.map(e =>
  typeof e === 'string' ? { projectId: e, pinned: false } : { pinned: false, ...e }
);
const ids = (tabs) => tabs.map(t => t.projectId);

describe('resolveTabClose: self（単体クローズ）', () => {
  test('ピン止めタブは閉じない（同一参照）', () => {
    const all = tabs({ projectId: 'a', pinned: true });
    const result = resolveTabClose({ tabs: all, scopeIds: ids(all), scope: 'self', targetId: 'a', activeTabId: 'a' });
    assert.strictEqual(result.tabs, all);
    assert.deepEqual(result.closedIds, []);
  });

  test('アクティブタブを閉じたら元 index に近い生存タブへ移る', () => {
    const all = tabs('a', 'b', 'c');
    const result = resolveTabClose({ tabs: all, scopeIds: ids(all), scope: 'self', targetId: 'b', activeTabId: 'b' });
    assert.deepEqual(ids(result.tabs), ['a', 'c']);
    assert.equal(result.nextActiveTabId, 'c');
  });

  test('末尾のアクティブタブを閉じたら手前へ移る', () => {
    const all = tabs('a', 'b', 'c');
    const result = resolveTabClose({ tabs: all, scopeIds: ids(all), scope: 'self', targetId: 'c', activeTabId: 'c' });
    assert.deepEqual(ids(result.tabs), ['a', 'b']);
    assert.equal(result.nextActiveTabId, 'b');
  });

  test('最後の1枚を閉じたら nextActiveTabId は null', () => {
    const all = tabs('a');
    const result = resolveTabClose({ tabs: all, scopeIds: ids(all), scope: 'self', targetId: 'a', activeTabId: 'a' });
    assert.deepEqual(ids(result.tabs), []);
    assert.equal(result.nextActiveTabId, null);
  });

  test('非アクティブタブを閉じてもアクティブは変わらない', () => {
    const all = tabs('a', 'b', 'c');
    const result = resolveTabClose({ tabs: all, scopeIds: ids(all), scope: 'self', targetId: 'a', activeTabId: 'b' });
    assert.equal(result.nextActiveTabId, 'b');
  });
});

describe('resolveTabClose: others（他のタブを閉じる）', () => {
  test('ピン止めと targetId 以外が閉じる', () => {
    const all = tabs('a', { projectId: 'b', pinned: true }, 'c', 'd');
    const result = resolveTabClose({ tabs: all, scopeIds: ids(all), scope: 'others', targetId: 'c', activeTabId: 'a' });
    assert.deepEqual(ids(result.tabs), ['b', 'c']);
    assert.equal(result.nextActiveTabId, 'c');
  });

  test('アクティブが targetId ならそのまま', () => {
    const all = tabs('a', 'b', 'c');
    const result = resolveTabClose({ tabs: all, scopeIds: ids(all), scope: 'others', targetId: 'b', activeTabId: 'b' });
    assert.equal(result.nextActiveTabId, 'b');
  });

  test('候補が無い（1枚しかない）なら no-op', () => {
    const all = tabs('a');
    const result = resolveTabClose({ tabs: all, scopeIds: ids(all), scope: 'others', targetId: 'a', activeTabId: 'a' });
    assert.strictEqual(result.tabs, all);
    assert.deepEqual(result.closedIds, []);
  });
});

describe('resolveTabClose: right（以降のタブを閉じる）', () => {
  test('scopeIds 上で targetId より後ろだけが閉じる', () => {
    const all = tabs('a', 'b', 'c', 'd');
    const result = resolveTabClose({ tabs: all, scopeIds: ids(all), scope: 'right', targetId: 'b', activeTabId: 'a' });
    assert.deepEqual(ids(result.tabs), ['a', 'b']);
  });

  test('最後尾を対象にすると候補が0で no-op', () => {
    const all = tabs('a', 'b', 'c');
    const result = resolveTabClose({ tabs: all, scopeIds: ids(all), scope: 'right', targetId: 'c', activeTabId: 'a' });
    assert.strictEqual(result.tabs, all);
  });

  test('アクティブが右側にあれば targetId へ移る', () => {
    const all = tabs('a', 'b', 'c');
    const result = resolveTabClose({ tabs: all, scopeIds: ids(all), scope: 'right', targetId: 'a', activeTabId: 'c' });
    assert.equal(result.nextActiveTabId, 'a');
  });
});

describe('resolveTabClose: all（すべて閉じる）', () => {
  test('ピン止めのみ残る', () => {
    const all = tabs('a', { projectId: 'b', pinned: true }, 'c');
    const result = resolveTabClose({ tabs: all, scopeIds: ids(all), scope: 'all', targetId: null, activeTabId: 'a' });
    assert.deepEqual(ids(result.tabs), ['b']);
    assert.equal(result.nextActiveTabId, 'b');
  });

  test('ピン止めが0枚ならアクティブは null', () => {
    const all = tabs('a', 'b');
    const result = resolveTabClose({ tabs: all, scopeIds: ids(all), scope: 'all', targetId: null, activeTabId: 'a' });
    assert.deepEqual(ids(result.tabs), []);
    assert.equal(result.nextActiveTabId, null);
  });
});

describe('resolveTabClose: サーバー絞り込み中（scopeIds が tabs の部分集合）', () => {
  test('scopeIds 外のタブは一括クローズの対象にならない（WYSIWYG の核心）', () => {
    const all = tabs('a', 'b', 'c', 'd');
    // 絞り込み表示中は b, c のみが見えているとする
    const result = resolveTabClose({ tabs: all, scopeIds: ['b', 'c'], scope: 'all', targetId: null, activeTabId: 'a' });
    assert.deepEqual(ids(result.tabs), ['a', 'd']);
    // アクティブ a は候補に含まれないため生存し、そのまま
    assert.equal(result.nextActiveTabId, 'a');
  });
});

describe('clampContextMenuPosition', () => {
  test('右端・下端ではみ出す場合は画面内に収まる', () => {
    const result = clampContextMenuPosition({
      x: 990, y: 590, width: 200, height: 150, viewportWidth: 1000, viewportHeight: 600, margin: 4,
    });
    assert.ok(result.left + 200 <= 1000);
    assert.ok(result.top + 150 <= 600);
  });

  test('余白内に収まる場合はそのままの座標', () => {
    const result = clampContextMenuPosition({
      x: 100, y: 100, width: 200, height: 150, viewportWidth: 1000, viewportHeight: 600, margin: 4,
    });
    assert.equal(result.left, 100);
    assert.equal(result.top, 100);
  });

  test('画面よりメニューが大きい場合でも負値にならない', () => {
    const result = clampContextMenuPosition({
      x: 50, y: 50, width: 2000, height: 2000, viewportWidth: 1000, viewportHeight: 600, margin: 4,
    });
    assert.ok(result.left >= 4);
    assert.ok(result.top >= 4);
  });
});
