import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  canReplacePreview,
  openPreviewTab,
  promoteTabById,
  collectPersistedTabIds,
} from '../dist-test/lib/tab-preview-rules.js';

/** テスト用の最小限のタブを作るヘルパ */
function tab(projectId, overrides = {}) {
  return {
    projectId,
    pinned: false,
    preview: false,
    inputText: '',
    progress: null,
    ...overrides,
  };
}

describe('canReplacePreview', () => {
  test('preview が未設定なら false', () => {
    assert.equal(canReplacePreview(tab('a')), false);
  });

  test('preview: true のみなら true', () => {
    assert.equal(canReplacePreview(tab('a', { preview: true })), true);
  });

  test('pinned なら false', () => {
    assert.equal(canReplacePreview(tab('a', { preview: true, pinned: true })), false);
  });

  test('下書き（空白のみ）は true', () => {
    assert.equal(canReplacePreview(tab('a', { preview: true, inputText: '   ' })), true);
  });

  test('下書きあり（実文字）は false', () => {
    assert.equal(canReplacePreview(tab('a', { preview: true, inputText: 'hello' })), false);
  });

  test('実行中（progress 非 null）は false', () => {
    assert.equal(canReplacePreview(tab('a', { preview: true, progress: {} })), false);
  });

  test("kind: 'cross' は false", () => {
    assert.equal(canReplacePreview(tab('a', { preview: true, kind: 'cross' })), false);
  });

  test('null/undefined は false', () => {
    assert.equal(canReplacePreview(null), false);
    assert.equal(canReplacePreview(undefined), false);
  });
});

describe('openPreviewTab', () => {
  test('既存タブ（通常）があれば何もせず同一参照を返す', () => {
    const tabs = [tab('a'), tab('b')];
    const result = openPreviewTab(tabs, tab('a', { preview: true }));
    assert.strictEqual(result.tabs, tabs);
    assert.equal(result.mode, 'focus');
    assert.equal(result.replacedId, null);
    assert.equal(result.promotedId, null);
  });

  test('既存プレビュータブ自身を再度開いても何もしない', () => {
    const tabs = [tab('a'), tab('b', { preview: true })];
    const result = openPreviewTab(tabs, tab('b', { preview: true }));
    assert.strictEqual(result.tabs, tabs);
    assert.equal(result.mode, 'focus');
  });

  test('プレビューが無ければ末尾に追加する', () => {
    const tabs = [tab('a'), tab('b')];
    const result = openPreviewTab(tabs, tab('c', { preview: true }));
    assert.deepEqual(result.tabs.map(t => t.projectId), ['a', 'b', 'c']);
    assert.equal(result.mode, 'appended');
    assert.equal(result.replacedId, null);
    assert.equal(result.promotedId, null);
  });

  test('差し替え可能な既存プレビューは同じ index に差し込まれる', () => {
    const tabs = [tab('a'), tab('prev', { preview: true }), tab('c')];
    const result = openPreviewTab(tabs, tab('new', { preview: true }));
    assert.deepEqual(result.tabs.map(t => t.projectId), ['a', 'new', 'c']);
    assert.equal(result.mode, 'replaced');
    assert.equal(result.replacedId, 'prev');
    assert.equal(result.promotedId, null);
  });

  test('差し替え不可（下書きあり）な既存プレビューは昇格して残り、新規は末尾に追加される', () => {
    const tabs = [tab('a'), tab('prev', { preview: true, inputText: 'draft' })];
    const result = openPreviewTab(tabs, tab('new', { preview: true }));
    assert.deepEqual(result.tabs.map(t => t.projectId), ['a', 'prev', 'new']);
    assert.equal(result.tabs.find(t => t.projectId === 'prev').preview, false);
    assert.equal(result.mode, 'appended');
    assert.equal(result.promotedId, 'prev');
    assert.equal(result.replacedId, null);
  });

  test('差し替え不可（実行中）な既存プレビューも昇格して残る', () => {
    const tabs = [tab('prev', { preview: true, progress: { label: 'running' } })];
    const result = openPreviewTab(tabs, tab('new', { preview: true }));
    assert.deepEqual(result.tabs.map(t => t.projectId), ['prev', 'new']);
    assert.equal(result.tabs.find(t => t.projectId === 'prev').preview, false);
    assert.equal(result.promotedId, 'prev');
  });

  test('プレビューは常に最大1枚（連続して複数回開いても preview は常に1つ）', () => {
    let tabs = [];
    for (const id of ['a', 'b', 'c']) {
      tabs = openPreviewTab(tabs, tab(id, { preview: true })).tabs;
    }
    assert.equal(tabs.filter(t => t.preview).length, 1);
    assert.equal(tabs.find(t => t.preview).projectId, 'c');
  });
});

describe('promoteTabById', () => {
  test('プレビュータブを昇格させる', () => {
    const tabs = [tab('a', { preview: true }), tab('b')];
    const result = promoteTabById(tabs, 'a');
    assert.equal(result.find(t => t.projectId === 'a').preview, false);
    assert.notStrictEqual(result, tabs);
  });

  test('対象が通常タブなら同一参照を返す', () => {
    const tabs = [tab('a'), tab('b')];
    assert.strictEqual(promoteTabById(tabs, 'a'), tabs);
  });

  test('対象が存在しないなら同一参照を返す', () => {
    const tabs = [tab('a')];
    assert.strictEqual(promoteTabById(tabs, 'nope'), tabs);
  });

  test('projectId が null なら同一参照を返す', () => {
    const tabs = [tab('a', { preview: true })];
    assert.strictEqual(promoteTabById(tabs, null), tabs);
  });
});

describe('collectPersistedTabIds', () => {
  test('プレビュータブを除外し順序を保つ', () => {
    const tabs = [tab('a'), tab('b', { preview: true }), tab('c')];
    assert.deepEqual(collectPersistedTabIds(tabs), ['a', 'c']);
  });

  test('全部プレビューなら空配列', () => {
    const tabs = [tab('a', { preview: true }), tab('b', { preview: true })];
    assert.deepEqual(collectPersistedTabIds(tabs), []);
  });

  test('preview 未定義のタブは残る（既存互換）', () => {
    const tabs = [{ projectId: 'a', pinned: false, inputText: '', progress: null }];
    assert.deepEqual(collectPersistedTabIds(tabs), ['a']);
  });
});
