// タブバー ★（ピン止め）タブが並べ替えできない既存バグ根治（2026-11-18）のテスト。
// 第2弾: 青い棒の位置とドロップ先がずれる既存バグ根治（resolveDropSide の明示判定）のテストも含む。
// node:test から dist-test/ を直接 import する（chat-scroll-rules.test.mjs 等と同じ流儀）。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { reorderTabsById, resolveDropSide } from '../dist-test/lib/tab-order-rules.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, '..');
const readSrc = (relPath) => readFileSync(path.join(webRoot, relPath), 'utf8');

const tabs = (...ids) => ids.map((projectId) => ({ projectId, pinned: false }));

describe('reorderTabsById: 基本の移動', () => {
  test('右方向への移動: 対象の直後に挿入される', () => {
    const result = reorderTabsById(tabs('a', 'b', 'c', 'd'), 'a', 'c');
    assert.deepEqual(result.map((t) => t.projectId), ['b', 'c', 'a', 'd']);
  });

  test('左方向への移動: 対象の直前に挿入される', () => {
    const result = reorderTabsById(tabs('a', 'b', 'c', 'd'), 'd', 'b');
    assert.deepEqual(result.map((t) => t.projectId), ['a', 'd', 'b', 'c']);
  });

  test('隣接タブの入れ替え', () => {
    const result = reorderTabsById(tabs('a', 'b', 'c'), 'a', 'b');
    assert.deepEqual(result.map((t) => t.projectId), ['b', 'a', 'c']);
  });
});

describe('reorderTabsById: no-op 判定（呼び出し側が保存をスキップできるよう同一参照を返す）', () => {
  test('fromId === toId なら同一参照を返す', () => {
    const all = tabs('a', 'b', 'c');
    const result = reorderTabsById(all, 'b', 'b');
    assert.strictEqual(result, all);
  });

  test('fromId が存在しない場合は同一参照を返す', () => {
    const all = tabs('a', 'b', 'c');
    const result = reorderTabsById(all, 'z', 'b');
    assert.strictEqual(result, all);
  });

  test('toId が存在しない場合は同一参照を返す', () => {
    const all = tabs('a', 'b', 'c');
    const result = reorderTabsById(all, 'a', 'z');
    assert.strictEqual(result, all);
  });
});

describe('reorderTabsById: ★（pinned）は並び順に一切関与しない（回帰の本体）', () => {
  test('pinned なタブを unpinned なタブの後ろへ移動できる', () => {
    const all = [
      { projectId: 'pinned1', pinned: true },
      { projectId: 'pinned2', pinned: true },
      { projectId: 'normal1', pinned: false },
      { projectId: 'normal2', pinned: false },
    ];
    const result = reorderTabsById(all, 'pinned1', 'normal2');
    assert.deepEqual(result.map((t) => t.projectId), ['pinned2', 'normal1', 'normal2', 'pinned1']);
  });

  test('unpinned なタブを pinned なタブの前へ移動できる', () => {
    const all = [
      { projectId: 'pinned1', pinned: true },
      { projectId: 'normal1', pinned: false },
      { projectId: 'normal2', pinned: false },
    ];
    const result = reorderTabsById(all, 'normal2', 'pinned1');
    assert.deepEqual(result.map((t) => t.projectId), ['normal2', 'pinned1', 'normal1']);
  });
});

describe('reorderTabsById: サーバー絞り込み中でも全体配列の相対順が壊れない', () => {
  test('見えているタブ（b, d）同士の入れ替えが、見えていないタブ（a, c）の相対位置を保ったまま反映される', () => {
    // visibleTabs は ['b', 'd'] のみだが、onReorder には projectId を渡すので
    // all（= 全タブ state）側の index とは無関係に正しく動く。
    const all = tabs('a', 'b', 'c', 'd');
    const result = reorderTabsById(all, 'b', 'd');
    assert.deepEqual(result.map((t) => t.projectId), ['a', 'c', 'd', 'b']);
  });
});

describe('resolveDropSide: カーソル位置から挿入側（前/後ろ）を判定する', () => {
  test('左端ぎりぎりは before', () => {
    assert.equal(resolveDropSide(100, { left: 100, width: 80 }), 'before');
  });

  test('左半分の内側は before', () => {
    assert.equal(resolveDropSide(130, { left: 100, width: 80 }), 'before');
  });

  test('ちょうど中央は after 側に倒す（< 判定のため）', () => {
    assert.equal(resolveDropSide(140, { left: 100, width: 80 }), 'after');
  });

  test('右半分の内側は after', () => {
    assert.equal(resolveDropSide(170, { left: 100, width: 80 }), 'after');
  });

  test('右端ぎりぎりは after', () => {
    assert.equal(resolveDropSide(179, { left: 100, width: 80 }), 'after');
  });
});

describe('reorderTabsById: side 明示指定（青い棒の表示と着地点を一致させる本体）', () => {
  test("side='before' を指定すると、方向に関わらず対象の直前に入る", () => {
    // 旧実装なら「右方向への移動は対象の後ろ」になるはずのケースで、
    // 明示的に 'before' を指定すると前に入ることを確認する。
    const result = reorderTabsById(tabs('a', 'b', 'c', 'd'), 'a', 'c', 'before');
    assert.deepEqual(result.map((t) => t.projectId), ['b', 'a', 'c', 'd']);
  });

  test("side='after' を指定すると、方向に関わらず対象の直後に入る", () => {
    const result = reorderTabsById(tabs('a', 'b', 'c', 'd'), 'd', 'b', 'after');
    assert.deepEqual(result.map((t) => t.projectId), ['a', 'b', 'd', 'c']);
  });

  test('side 省略時は従来どおり方向から推測する（後方互換）', () => {
    const result = reorderTabsById(tabs('a', 'b', 'c', 'd'), 'a', 'c');
    assert.deepEqual(result.map((t) => t.projectId), ['b', 'c', 'a', 'd']);
  });

  test('結果が元の並びと変わらない場合は同一参照を返す（例: すぐ右隣の before）', () => {
    const all = tabs('a', 'b', 'c');
    const result = reorderTabsById(all, 'a', 'b', 'before');
    assert.strictEqual(result, all);
  });
});

describe('ソースガード: TabBar のピン優先再ソートが復活していない', () => {
  test('ChatPage.tsx に pinned によるフィルタ後の再結合（旧 orderedTabs 相当）が無い', () => {
    const source = readSrc('src/pages/ChatPage.tsx');
    // pinnedIds を集める（保存用）のは正当な既存用途なので対象外。禁止したいのは
    // 「pinnedTabs / unpinnedTabs を作って描画順として再結合する」旧ロジックそのもの。
    assert.equal(source.includes('pinnedTabs'), false, 'ChatPage.tsx にピン優先ソート用の pinnedTabs 変数が復活している');
    assert.equal(source.includes('unpinnedTabs'), false, 'ChatPage.tsx にピン優先ソート用の unpinnedTabs 変数が復活している');
    assert.equal(source.includes('orderedTabs'), false, 'ChatPage.tsx に orderedTabs（旧ピン優先ソート）が復活している');
  });

  test('ChatPage.tsx は tab-order-rules.ts の reorderTabsById を使っている', () => {
    const source = readSrc('src/pages/ChatPage.tsx');
    assert.ok(source.includes("from '../lib/tab-order-rules'"));
    assert.ok(source.includes('reorderTabsById('));
  });

  test('ChatPage.tsx は resolveDropSide でカーソル位置から明示的に side を判定している（方向からの推測への先祖返り防止）', () => {
    const source = readSrc('src/pages/ChatPage.tsx');
    assert.ok(source.includes('resolveDropSide('), 'resolveDropSide を呼んでいない');
    assert.match(source, /onReorder\(dragIdRef\.current,\s*tab\.projectId,\s*side\)/, 'onReorder に side を渡していない（旧2引数形式に戻っている可能性）');
  });
});

describe('ソースガード: D&D を壊した既存の退行3点が再導入されていない（2026-11-18 第3弾の根治対象）', () => {
  const source = () => readSrc('src/pages/ChatPage.tsx');

  test('TabBar コンテナに自動スクロール用の onDragOver が無い（dragover 連射で scrollLeft が暴走し、タブがカーソル下から流れる退行の再発防止）', () => {
    assert.equal(source().includes('scrollContainerRef'), false, 'scrollContainerRef が復活している（自動スクロール機構の再導入）');
    assert.equal(/EDGE_PX|STEP_PX/.test(source()), false, '自動スクロールの定数が復活している');
  });

  test('ドラッグの effectAllowed / dropEffect を明示指定していない（祖先要素の onDragOver と噛み合わず drop 自体が発火しなくなる退行の再発防止）', () => {
    assert.equal(source().includes('effectAllowed'), false, 'e.dataTransfer.effectAllowed の指定が復活している');
    assert.equal(source().includes('dropEffect'), false, 'e.dataTransfer.dropEffect の指定が復活している');
  });

  test('青い棒は border（常時 2px 確保 + 色だけ切替）方式で、絶対配置の子要素を挿入する方式ではない（DOM 増減によるドラッグ不安定化の再発防止）', () => {
    assert.equal(source().includes('border-l-blue-400'), true, 'border-l-blue-400 が無い（before 側ハイライトの実装が見当たらない）');
    assert.equal(source().includes('border-r-blue-400'), true, 'border-r-blue-400 が無い（after 側ハイライトの実装が見当たらない）');
  });
});
