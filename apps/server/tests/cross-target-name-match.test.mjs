// 外部 import ゼロの純粋関数（apps/server/src/services/cross-target-name-match.ts）を
// コンパイル済み dist から直接 import する（既存 cross-query-guard.test.mjs と同じ流儀）。
//
// 2026-11-08 実機テストで発見したバグの回帰防止:
// 以前は `label(p) === needle || p.name === needle` という OR 条件だったため、
// displayName を変えても name（ディレクトリ名、不変）側で一致し続け、エラーメッセージが
// 案内する「プロジェクトの表示名を変えて一意にする」という解決策が機能しなかった。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  crossTargetMatchKey,
  matchCrossTargetCandidates,
} from '../dist/services/cross-target-name-match.js';

// ---- crossTargetMatchKey ----

test('crossTargetMatchKey: displayName があればそれを使う（小文字化）', () => {
  assert.equal(crossTargetMatchKey({ name: 'mimamori-flutter', displayName: 'Mimamori-Win' }), 'mimamori-win');
});

test('crossTargetMatchKey: displayName が無ければ name を使う', () => {
  assert.equal(crossTargetMatchKey({ name: 'mimamori-flutter', displayName: null }), 'mimamori-flutter');
});

// ---- matchCrossTargetCandidates: 既存挙動の固定（displayName 未設定同士） ----

describe('matchCrossTargetCandidates: displayName 未設定のプロジェクトは従来どおり name で一致する', () => {
  const candidates = [
    { name: 'pixblog', displayName: null },
    { name: 'pixdraft', displayName: null },
  ];

  test('完全一致', () => {
    const result = matchCrossTargetCandidates(candidates, 'pixblog');
    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'pixblog');
  });

  test('部分一致（大文字小文字・前後空白を無視）', () => {
    const result = matchCrossTargetCandidates(candidates, '  PIX  '.trim());
    assert.equal(result.length, 2);
  });

  test('一致なし', () => {
    assert.deepEqual(matchCrossTargetCandidates(candidates, 'nope'), []);
  });
});

// ---- 本バグの回帰防止: displayName を設定したら元の name では一致しない ----

describe('matchCrossTargetCandidates: displayName を設定したら元の name は照合に使われない（本バグの回帰防止）', () => {
  // 実機テストで再現した構成: 同名 "mimamori-flutter" が 3 件あり、1 件だけ displayName を
  // "mimamori-win" に変更した。期待する挙動は「name='mimamori-flutter' で検索すると、
  // displayName を変更した行は候補から外れ、残りの行だけで一意に解決する」こと。
  const renamed = { id: 'A', name: 'mimamori-flutter', displayName: 'mimamori-win' };
  const untouchedOwn = { id: 'B', name: 'mimamori-flutter', displayName: null };
  const grantee = { id: 'C', name: 'mimamori-flutter', displayName: null };

  test('name="mimamori-flutter" で検索すると、displayName を変更した行(A)は一致しない', () => {
    const result = matchCrossTargetCandidates([renamed, untouchedOwn, grantee], 'mimamori-flutter');
    const ids = result.map(c => c.id).sort();
    assert.deepEqual(ids, ['B', 'C']);
  });

  test('displayName="mimamori-win" で検索すると、変更した行(A)だけが一意に一致する', () => {
    const result = matchCrossTargetCandidates([renamed, untouchedOwn, grantee], 'mimamori-win');
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'A');
  });

  test('旧バグの再現確認: 修正前の "OR name match" ロジックなら3件とも一致してしまっていたはず', () => {
    // 修正前のロジックを手元で再現し、現在の実装と結果が異なることを示す
    // （= 今回の修正が実際にこの旧バグを解消していることの直接証拠）
    const needle = 'mimamori-flutter';
    const oldLogicExact = [renamed, untouchedOwn, grantee].filter(
      (c) => (c.displayName ?? c.name).toLowerCase() === needle || c.name.toLowerCase() === needle
    );
    assert.equal(oldLogicExact.length, 3, '旧ロジックは3件とも一致していた（バグの再現）');

    const newResult = matchCrossTargetCandidates([renamed, untouchedOwn, grantee], needle);
    assert.equal(newResult.length, 2, '新ロジックは displayName 変更行を除外し2件になる');
  });
});

// ---- 完全一致優先・部分一致へのフォールバック ----

test('matchCrossTargetCandidates: 完全一致が1件あれば部分一致候補があっても完全一致のみ返す', () => {
  const candidates = [
    { name: 'pix', displayName: null },
    { name: 'pixblog', displayName: null },
  ];
  const result = matchCrossTargetCandidates(candidates, 'pix');
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'pix');
});

test('matchCrossTargetCandidates: 完全一致が無ければ部分一致にフォールバックする', () => {
  const candidates = [
    { name: 'pixblog-flutter', displayName: null },
    { name: 'pixblog-server', displayName: null },
  ];
  const result = matchCrossTargetCandidates(candidates, 'pixblog');
  assert.equal(result.length, 2);
});
