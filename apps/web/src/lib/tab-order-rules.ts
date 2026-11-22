/**
 * チャットタブバー（`ChatPage.tsx` の `TabBar`）の並べ替えルールを決定する純関数群。
 * 外部 import ゼロ（node:test から dist-test/ を直接 import する。
 * chat-scroll-rules.ts / panel-resize-rules.ts と同じ流儀）。
 *
 * 背景（★＝ピン止めタブが並べ替えできない既存バグ、2026-11-18）:
 * 旧実装は描画のたびに `[...pinned, ...unpinned]` で再ソートしていたため、
 * ドラッグで `tabs` state を実際に並べ替えても毎回ピン優先の位置へ巻き戻っていた
 * （★タブを未ピンタブより後ろへ置くことが構造的に不可能だった）。
 * また、ドラッグの index が「表示用に絞り込んだ配列」の index であるにもかかわらず
 * 「絞り込み前の全タブ配列」へ splice していたため、サーバー絞り込み中は無関係な
 * タブが動くというバグも併発していた。
 *
 * 本モジュールは、この2点を構造的に無くすため:
 * - 並び順は「保存済み `tab_order` そのもの」だけで決める（pinned は一切見ない）
 * - 並べ替えの受け渡しは index ではなく projectId で行う（絞り込みの有無に依存しない）
 *
 * 追加の背景（青い棒の位置とドロップ先がずれる既存バグ、2026-11-18 第2弾）:
 * 旧実装はドラッグの「方向」（元の index と目的地の index の大小）だけで挿入位置
 * （対象の前/後ろ）を決めていたが、青い棒（ドラッグオーバー中のハイライト）は常に
 * 対象タブの左端に出していた。そのため右方向へドラッグしたときだけ、線は左端に
 * 出るのに実際は対象の右側に入るという不一致が起きていた。
 * 本モジュールはこれも構造的に無くすため、挿入位置を「方向からの推測」ではなく
 * 「カーソルが対象タブの左半分/右半分のどちらにあるか」（`resolveDropSide`）で
 * 明示的に決める。青い棒の表示もこの判定結果をそのまま使うため、線の位置と
 * 実際の着地点は常に一致する。
 */

/** 並べ替え対象の最小限の形（projectId だけを見る）。 */
export interface ReorderableTab {
  projectId: string;
}

/** ドロップ位置（対象タブの前 / 後ろ）。 */
export type DropSide = 'before' | 'after';

/**
 * カーソルの X 座標が対象タブの左半分・右半分のどちらにあるかを判定する。
 * DOM に依存しないよう、`getBoundingClientRect()` 相当の最小限の数値だけを受け取る。
 * ちょうど中央（`clientX === left + width/2`）は 'after' 側に倒す（`<` 判定のため）。
 *
 * タブバーが多段（flex-wrap）になっていても、Y 座標（どの段か）を見る必要はない。
 * `dragover`/`drop` イベントはブラウザがカーソル直下の要素（＝対象タブ）に対して
 * 発火するため、「どの段のタブが対象か」はブラウザ側が既に決めてくれている。
 * 本関数はその対象タブの中で前/後ろのどちらに挿入するかだけを X 座標で判定する。
 */
export function resolveDropSide(clientX: number, rect: { left: number; width: number }): DropSide {
  const midpoint = rect.left + rect.width / 2;
  return clientX < midpoint ? 'before' : 'after';
}

/**
 * `fromId` のタブを `toId` のタブの `side`（前/後ろ）へ移動した新しい配列を返す。
 *
 * - `fromId === toId`、またはどちらかが `all` に存在しない場合は変化なし
 *   （呼び出し側が「保存不要の no-op」と判定できるよう、元の配列の参照をそのまま返す）
 * - 移動した結果が元の並びと完全に同じになる場合（例: すぐ右隣のタブの 'before' を
 *   指定した場合）も変化なしとして元の参照を返す（無駄な保存・再描画を避ける）。
 * - `side` 省略時は従来どおり方向から推測する後方互換（呼び出し側の移行を容易にするため）。
 */
export function reorderTabsById<T extends ReorderableTab>(all: T[], fromId: string, toId: string, side?: DropSide): T[] {
  if (fromId === toId) return all;
  const fromIndex = all.findIndex(t => t.projectId === fromId);
  const toIndex = all.findIndex(t => t.projectId === toId);
  if (fromIndex === -1 || toIndex === -1) return all;

  const moving = all[fromIndex];
  const withoutMoving = all.filter((_, i) => i !== fromIndex);
  // 除去後の配列中で toId が立っている位置を再探索する
  const targetIndex = withoutMoving.findIndex(t => t.projectId === toId);
  const resolvedSide = side ?? (fromIndex < toIndex ? 'after' : 'before');
  const insertAt = resolvedSide === 'after' ? targetIndex + 1 : targetIndex;

  const next = [...withoutMoving];
  next.splice(insertAt, 0, moving);

  // 結果が元の並びと変わらないなら no-op として元の参照を返す
  if (next.length === all.length && next.every((t, i) => t.projectId === all[i].projectId)) {
    return all;
  }
  return next;
}
