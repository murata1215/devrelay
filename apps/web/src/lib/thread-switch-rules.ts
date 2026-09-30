/**
 * スレッド切替（ThreadList の switch/create 成功後）で `Tab` state に適用すべきパッチを
 * 返す純関数（外部 import ゼロ。node:test から dist-test/ を直接 import する、
 * uninstall-command-rules.ts / machine-display-rules.ts と同じ流儀）。
 *
 * 背景（2026-09-30 バグ修正）: `switchTabToThread`（ChatPage.tsx）はスレッド切替時に
 * `messages` は空にするが、`progress`（AI 実行中の「処理中...(NNNs)」表示）と `completed` を
 * クリアしていなかった。`Tab.progress` はスレッド単位ではなくタブ（projectId）単位で 1 つしか
 * 持たない state のため、切替後も前スレッドの進捗オブジェクトが残り、かつ `ProgressIndicator`
 * 側のローカル経過タイマー（1秒ごとに自走）によって秒数が増え続けるように見えてしまう。
 * さらに前スレッドの完了通知（`web:response`）は sessionId 不一致で drop されるため、
 * 一度残った進捗表示は自然には消えない（タブのスピナーも回り続ける）。
 *
 * 新規タブ生成時（ChatPage.tsx の初期化処理）は `progress: null, completed: false` を
 * 明示していたが、スレッド切替経路だけこれが漏れていた。本関数はその漏れを塞ぐための
 * 単一の真実（両経路から呼ぶことで再発を防ぐ）。
 */

/** `buildThreadSwitchPatch` が返す、Tab state に spread で適用するパッチ。 */
export interface ThreadSwitchPatch {
  sessionId: string;
  title: string | null;
  messages: never[];
  historyLoaded: false;
  hasMoreHistory: false;
  /** 前スレッドの進捗表示を必ず消す（本バグ修正の本体） */
  progress: null;
  /** 前スレッドの完了フラグも引き継がない */
  completed: false;
}

/**
 * スレッド切替時に Tab へ適用するパッチを構築する。
 *
 * @param sessionId 切替先スレッドの sessionId
 * @param title 切替先スレッドのタイトル（未設定なら null）
 * @returns Tab state に spread で適用するパッチオブジェクト
 */
export function buildThreadSwitchPatch(sessionId: string, title: string | null): ThreadSwitchPatch {
  return {
    sessionId,
    title,
    messages: [],
    historyLoaded: false,
    hasMoreHistory: false,
    progress: null,
    completed: false,
  };
}
