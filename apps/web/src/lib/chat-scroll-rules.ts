/**
 * チャット画面（`ChatPage.tsx`）のスクロール保持ルールを決定する純関数群。
 * 外部 import ゼロ（node:test から dist-test/ を直接 import する。
 * conversation-rail-rules.ts / lite-shell-rules.ts と同じ流儀）。
 *
 * 背景（alt+tab 復帰で読んでいた過去メッセージが消え、最下部へスナップする既存バグ）:
 * `visibilitychange`/WS 再接続のたびに `loadHistory('refresh')`（最新10件のみ取得）を無条件に
 * 呼び、かつ完了後に無条件で最下部へ強制スクロールしていたのが真因。WS が生きている限り
 * hidden 中の新着は WS 経由で既に state に入っているため、「visible かつ WS 生存」なら
 * refresh 自体が不要（= 何もしない）。WS が切れていた場合のみ refresh が必要だが、
 * その場合もユーザーが上を読んでいたなら最下部への強制スクロールはせず位置を復元する。
 */

/** 下端判定のしきい値（px）。ChatPage の既存マジックナンバー 50 を集約。 */
export const CHAT_AT_BOTTOM_THRESHOLD_PX = 50;

/** スクロール位置判定に必要な最小限の数値（DOM 要素そのものには依存しない）。 */
export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/**
 * コンテナが下端（しきい値以内）にいるかを判定する。
 * `scrollHeight <= clientHeight`（スクロール不要なほど短い）の場合も下端とみなす
 * （fail-safe: 新着を待つべき状態で誤って「上にいる」と判定しないため）。
 */
export function isAtBottom(m: ScrollMetrics, threshold: number = CHAT_AT_BOTTOM_THRESHOLD_PX): boolean {
  if (m.scrollHeight <= m.clientHeight) return true;
  return m.scrollHeight - m.scrollTop - m.clientHeight < threshold;
}

/** 履歴 refresh を走らせるかどうかの判定結果。 */
export type HistoryRefreshDecision =
  | { kind: 'refresh'; scroll: 'stick-bottom' | 'keep-position' }
  | { kind: 'skip' };

/**
 * タブ復帰（`visibilitychange`）/ WS 再接続時に履歴 refresh を走らせるか、
 * 走らせるなら位置をどう扱うかを決める。
 *
 * 判定順:
 * 1. アクティブタブが無い → skip（対象が無い）
 * 2. `atBottom` が `null`（計測不能。DOM 未マウント等）または `true` → refresh + 'stick-bottom'
 *    （従来どおり最新へ追従する、安全側の既定動作）
 * 3. `trigger === 'reconnect'`（WS が切れていた = hidden 中の新着を取りこぼした可能性がある）
 *    → refresh は必須だが、上を読んでいたなら位置は保持する（'keep-position'）
 * 4. `trigger === 'visible'` かつ WS が生存中 → **skip**
 *    （hidden 中の新着は WS 経由で既に state に入っている。再取得する理由が無く、
 *    何もしなければ再描画自体が起きないため DOM のスクロール位置が完全に保持される）
 * 5. `trigger === 'visible'` かつ WS が切断中 → refresh + 'keep-position'
 *    （fail-safe: 鮮度を優先して取り直すが、位置は奪わない）
 */
export function decideHistoryRefresh(input: {
  trigger: 'visible' | 'reconnect';
  hasActiveTab: boolean;
  atBottom: boolean | null;
  wsConnected: boolean;
}): HistoryRefreshDecision {
  if (!input.hasActiveTab) return { kind: 'skip' };
  if (input.atBottom === null || input.atBottom === true) {
    return { kind: 'refresh', scroll: 'stick-bottom' };
  }
  if (input.trigger === 'reconnect') return { kind: 'refresh', scroll: 'keep-position' };
  // trigger === 'visible'
  if (input.wsConnected) return { kind: 'skip' };
  return { kind: 'refresh', scroll: 'keep-position' };
}

/**
 * `'keep-position'` で refresh したあとの復元 scrollTop を求める。
 * 上側の内容量が変化した分（`prevScrollHeight` → `nextScrollHeight` の差）を `prevScrollTop` から
 * 引き、ユーザーが見ていた内容をその場に留める（`loadOlderMessages` の既存手法と同じ発想）。
 * 結果が負になる場合は 0 にクランプする。
 */
export function resolveRestoredScrollTop(input: {
  prevScrollTop: number;
  prevScrollHeight: number;
  nextScrollHeight: number;
}): number {
  const delta = input.nextScrollHeight - input.prevScrollHeight;
  const restored = input.prevScrollTop + delta;
  return restored < 0 ? 0 : restored;
}
