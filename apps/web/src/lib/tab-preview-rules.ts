/**
 * チャットタブバー（`ChatPage.tsx`）の「プレビュータブ」（VS Code 方式）ルールを決定する純関数群。
 * 外部 import ゼロ（node:test から dist-test/ を直接 import する。
 * tab-order-rules.ts / chat-scroll-rules.ts と同じ流儀）。
 *
 * 背景（Pulse（会話履歴レール）でタブが無限に増える既存バグ、2026-11-22）:
 * Pulse は全プロジェクト横断の直近20スレッドを一覧表示するため、クリックのたびに
 * 別プロジェクトのタブが新規作成され、作られた瞬間に `settingsApi.saveTabOrder()` で
 * サーバーの `UserSettings.tab_order` に永続化されていた。復元側（マウント時 useEffect）は
 * メッセージ0件の空タブも tab_order の順に全部復元するため剪定も効かず、実機で約60タブまで
 * 膨れ上がった。一括クローズ UI も無いため手作業で1つずつ閉じるしかなかった。
 *
 * 本モジュールは VS Code の「プレビュータブ」（1回クリックで開いたタブは使い回され、
 * 次に別の項目をクリックすると差し替わる。入力・送信・ピン止め等の「使う」という意思表示で
 * 通常タブへ昇格する）を構造的に実現する。プレビュータブは常にこの型を満たす限り最大1枚のみ
 * （`openPreviewTab` が不変条件として保証する）。
 */

/** プレビュー判定に必要な最小限のタブの形。 */
export interface PreviewTabLike {
  projectId: string;
  pinned: boolean;
  /** true の間は Pulse から別の会話を開くと差し替えられ、tab_order にも保存されない。 */
  preview?: boolean;
  /** タブごとの下書き入力。空でなければ「使いかけ」とみなし差し替えでは消さない。 */
  inputText: string;
  /** 実行中（非 null）のプレビューは差し替えで閉じない（出力が消える事故を防ぐ）。 */
  progress: unknown | null;
  /** クロスユーザー Team の質問専用タブはプレビュー対象外（Pulse には元々出てこないが、
   *  念のための二重の安全策として差し替え判定でも弾く）。 */
  kind?: 'own' | 'cross';
}

/**
 * このプレビュータブを「閉じて差し替えてよい」か判定する。
 * 1つでも false 条件に当てはまれば、差し替えずに通常タブへ昇格させて残す
 * （下書き・実行中の出力・ピン止め・クロスタブを誤って消さないための唯一のゲート）。
 */
export function canReplacePreview(tab: PreviewTabLike | null | undefined): boolean {
  if (!tab) return false;
  if (!tab.preview) return false;
  if (tab.pinned) return false;
  if (tab.inputText.trim() !== '') return false;
  if (tab.progress != null) return false;
  if (tab.kind === 'cross') return false;
  return true;
}

/** `openPreviewTab` の結果。 */
export interface OpenPreviewResult<T> {
  tabs: T[];
  /** 'focus': 既にタブが存在し何もしなかった / 'replaced': 既存プレビューを差し替えた / 'appended': 末尾に追加した。 */
  mode: 'focus' | 'replaced' | 'appended';
  /** 差し替えで閉じたプレビュータブの projectId（無ければ null）。 */
  replacedId: string | null;
  /** 差し替えできず通常タブへ昇格させて残したプレビュータブの projectId（無ければ null）。
   *  呼び出し側はこれが non-null のときだけ tab_order の保存が必要になる
   *  （新規プレビュー追加・差し替えだけなら保存不要＝ Pulse を何度見ても PUT が飛ばない）。 */
  promotedId: string | null;
}

/**
 * Pulse から1件開くときの新しいタブ配列を決める。
 * - 対象 projectId のタブが既に存在する（通常タブでもプレビューでも）場合は何もしない
 *   （通常タブをプレビューへ格下げしない。既存プレビューを別のものへ勝手に差し替えない）
 * - 既存プレビューが無ければ末尾に追加する
 * - 既存プレビューがあり差し替え可能なら、同じ index に差し込む（タブの位置が飛ばない）
 * - 既存プレビューがあるが差し替え不可（下書き・実行中等）なら、それを昇格させて残し、
 *   新しいプレビューは末尾に追加する
 */
export function openPreviewTab<T extends PreviewTabLike>(tabs: T[], newTab: T): OpenPreviewResult<T> {
  if (tabs.some(t => t.projectId === newTab.projectId)) {
    return { tabs, mode: 'focus', replacedId: null, promotedId: null };
  }

  const previewIndex = tabs.findIndex(t => t.preview);
  if (previewIndex === -1) {
    return { tabs: [...tabs, newTab], mode: 'appended', replacedId: null, promotedId: null };
  }

  const previewTab = tabs[previewIndex];
  if (canReplacePreview(previewTab)) {
    const next = [...tabs];
    next[previewIndex] = newTab;
    return { tabs: next, mode: 'replaced', replacedId: previewTab.projectId, promotedId: null };
  }

  // 差し替え不可: 既存プレビューを昇格させて残し、新しいプレビューは末尾に追加する
  const next = [...tabs];
  next[previewIndex] = { ...previewTab, preview: false };
  next.push(newTab);
  return { tabs: next, mode: 'appended', replacedId: null, promotedId: previewTab.projectId };
}

/**
 * プレビュータブを通常タブへ昇格させる（ユーザーが「このタブを使う」と意思表示した瞬間に呼ぶ）。
 * 対象が存在しない、またはプレビューでない場合は変化なし（同一参照を返し、呼び出し側が
 * 保存不要の no-op と判定できるようにする）。
 */
export function promoteTabById<T extends PreviewTabLike>(tabs: T[], projectId: string | null): T[] {
  if (!projectId) return tabs;
  const idx = tabs.findIndex(t => t.projectId === projectId);
  if (idx === -1 || !tabs[idx].preview) return tabs;
  const next = [...tabs];
  next[idx] = { ...next[idx], preview: false };
  return next;
}

/**
 * tab_order としてサーバーへ永続化する projectId 列を集める（プレビュータブを除外する）。
 * `saveTabOrder()` の引数源はこの関数のみを経由すること
 * （旧実装は `updated.map(t => t.projectId)` を5箇所に重複させており、新しい除外条件を
 * 1箇所書き忘れるとプレビュータブが永続化されタブ増殖が再発する構造だった）。
 */
export function collectPersistedTabIds(tabs: PreviewTabLike[]): string[] {
  return tabs.filter(t => !t.preview).map(t => t.projectId);
}
