/**
 * classic チャット画面の左右ペイン（スレッド一覧・右レール）共通のリサイズ純ロジック集。
 * 外部 import ゼロ（node:test から dist-test/ を直接 import する。
 * apps/server の thread-routing.ts / apps/web の right-rail-rules.ts と同じ流儀）。
 *
 * `usePanelResize`（hooks/usePanelResize.ts）が本モジュールの算術関数を呼び出す唯一の場所であり、
 * フック自身には `Math.min`/`Math.max` を書かない（テスト不能な場所に算術を漏らさないため）。
 *
 * 「幅の当て方」は consumer ごとに異なる（右レールはインライン style、スレッド一覧は CSS 変数）。
 * これは意図的な非対称であり統一しない — 右レールは `hidden md:flex` でモバイルに存在しないため
 * インライン style で十分だが、スレッド一覧はモバイルでも表示されるため CSS の `@media` で
 * ブレークポイントごとに幅の適用方法を切り替える必要があり、インライン style では実現できない。
 */

/** リサイズハンドルが付いている辺（ドラッグの符号を決める） */
export type PanelResizeEdge = 'left' | 'right';

/** 幅を [min, max] の範囲に収める */
export function clampWidth(width: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, width));
}

/**
 * localStorage の生の文字列から幅を復元する。
 * `null`・数値変換不能（NaN）・非有限値は `fallback` にフォールバックする（この場合は clamp しない）。
 * それ以外は常に `clampWidth` を通す（保存後に min/max を変更した場合の異常値も吸収する）。
 *
 * 契約は `right-rail-rules.ts` が持っていた旧・幅読み取り関数と同一（移植元）。
 * 例: `readWidth('', {min,max,fallback})` は `Number('') === 0` のため min を返す（fallback ではない）。
 */
export function readWidth(raw: string | null, args: { min: number; max: number; fallback: number }): number {
  if (raw === null) return args.fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return args.fallback;
  return clampWidth(parsed, args.min, args.max);
}

/**
 * ドラッグ中の新しい幅を計算する。
 * `edge: 'left'`（右レール。ハンドルが左端にあり、左にドラッグ = 幅拡大）→ `startX - clientX`
 * `edge: 'right'`（スレッド一覧。ハンドルが右端にあり、右にドラッグ = 幅拡大）→ `clientX - startX`
 * 結果は常に `clampWidth` を通す。
 */
export function computeResizeWidth(args: {
  startWidth: number;
  startX: number;
  clientX: number;
  edge: PanelResizeEdge;
  min: number;
  max: number;
}): number {
  const delta = args.edge === 'left' ? args.startX - args.clientX : args.clientX - args.startX;
  return clampWidth(args.startWidth + delta, args.min, args.max);
}

/** スレッド一覧ペインの幅を保存する localStorage キー */
export const THREAD_PANE_WIDTH_STORAGE_KEY = 'devrelay-thread-list-width';
/** スレッド一覧ペインの既定幅（px）。14rem = 旧 `ThreadList.tsx` の `w-56` と同値（初回表示を変えない） */
export const THREAD_PANE_WIDTH_DEFAULT = 224;
/** スレッド一覧ペインの最小幅（px） */
export const THREAD_PANE_WIDTH_MIN = 200;
/** スレッド一覧ペインの最大幅（px） */
export const THREAD_PANE_WIDTH_MAX = 480;

/**
 * スレッド一覧ペインの外側ラッパー（`ThreadPane.tsx` の `<div>`）に付与する静的クラス文字列。
 * `flex` であることが必須（`ThreadList.tsx` の root を flex item のまま保つことで `z-[35]` の
 * stacking context 生成を維持し、モバイルでのドロワーとの重なり順を壊さない）。
 * `shrink-0` も必須（無いと本文側 `flex-1` に押されて設定幅より縮む）。
 * 実際の幅は CSS 側の `.thread-pane` ルール（`index.css`）が `--thread-pane-w` 変数経由で適用する。
 */
export function resolveThreadPaneShellClass(): string {
  return 'relative flex min-h-0 shrink-0 thread-pane';
}

/**
 * リサイズハンドルに付与する静的クラス文字列。
 * `panel-resize-handle` は `index.css` の `.thread-pane > :not(.panel-resize-handle)` セレクタが
 * ハンドル自身を幅 100% に膨らませてしまう事故（クリックが全てドラッグ扱いになる）を防ぐための目印。
 * `hidden md:block` でモバイル（<768px）はリサイズ無効。
 */
export function resolveResizeHandleClass(edge: PanelResizeEdge): string {
  const edgeClass = edge === 'left' ? 'left-0' : 'right-0';
  return `panel-resize-handle hidden md:block absolute inset-y-0 ${edgeClass} w-1 cursor-col-resize hover:bg-[var(--accent-blue)] hover:opacity-50 z-10`;
}

/** リサイズ中に表示する全画面オーバーレイ（テキスト選択防止）の静的クラス文字列 */
export const RESIZE_OVERLAY_CLASS = 'fixed inset-0 z-50 cursor-col-resize';
