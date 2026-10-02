/**
 * WebUI 進捗表示の「停止」ボタンの操作状態を判定する純関数（外部 import ゼロ。
 * node:test から dist-test/ を直接 import する、thread-switch-rules.ts と同じ流儀）。
 *
 * 背景（2026-09-30 サイクル）: 「実行中の AI ターンを途中で止める機能」への改善要望を調査した結果、
 * 停止コマンド `k` / `kill`（サーバー側 command-handler.ts の handleKill()）は既に実装済みで
 * 実際に機能することが判明した。欠けていたのは WebUI に停止手段が「見える」形で無かったこと。
 * 本モジュールはその停止ボタンの UI 状態遷移（誤クリック防止の2段階確認、再出現時の状態維持）を担う。
 *
 * 設計上の前提（調査で確定・変更しないこと）:
 * - `k` 送信直後、サーバーの `progressTracker` は即座には消えない。クライアントは `cancel.done` を
 *   含む `web:response` 受信時に必ず `tab.progress = null` にするため進捗表示は一度消えるが、
 *   Agent の kill ラダー（term→10s→force→20s強制確定）により最大 30 秒後に進捗表示が再出現しうる。
 *   → 「停止要求中」の状態を `ProgressIndicator` のコンポーネントローカル state に置いてはいけない
 *   （アンマウント/再マウントで消える）。呼び出し側（ChatPage.tsx）の `Tab.cancel` に持たせ、
 *   本モジュールの関数で `sessionId` 照合により無効化する。
 * - サーバー側の `k` 自体は2段階確認にしない（Discord/Telegram では `k` が唯一の停止手段であり、
 *   緊急停止を遅くする退行になるため）。確認 UX はこのモジュール＝クライアント側だけに閉じる。
 */

/** 武装状態の自動解除までの猶予（誤クリック救済） */
export const CANCEL_CONFIRM_WINDOW_MS = 6_000;
/** 送信後、応答が来ないとみなして再試行を許可するまでの猶予（Agent kill ラダー計30s + 余裕） */
export const CANCEL_REQUEST_TIMEOUT_MS = 45_000;

/** 停止ボタンの操作状態。null = 未操作（アイドル） */
export type CancelUiState =
  | { phase: 'armed'; sessionId: string; atMs: number }
  | { phase: 'requested'; sessionId: string; atMs: number }
  | null;

/** UI に表示する論理フェーズ */
export type CancelPhase = 'idle' | 'confirm' | 'requesting' | 'stalled';

export interface ResolveCancelPhaseInput {
  state: CancelUiState;
  /** 現在表示中スレッドの sessionId */
  sessionId: string | null;
  nowMs: number;
}

/**
 * 現在の `CancelUiState` から UI に表示すべきフェーズを判定する。
 * `sessionId` が state と一致しない場合は常に 'idle'（スレッド切替で必ず解除される）。
 */
export function resolveCancelPhase(input: ResolveCancelPhaseInput): CancelPhase {
  const { state, sessionId, nowMs } = input;
  if (state === null) return 'idle';
  if (state.sessionId !== sessionId) return 'idle';

  if (state.phase === 'armed') {
    if (nowMs - state.atMs >= CANCEL_CONFIRM_WINDOW_MS) return 'idle';
    return 'confirm';
  }

  // state.phase === 'requested'
  if (nowMs - state.atMs >= CANCEL_REQUEST_TIMEOUT_MS) return 'stalled';
  return 'requesting';
}

export interface DecideCancelClickInput {
  state: CancelUiState;
  sessionId: string | null;
  nowMs: number;
  connected: boolean;
}

export interface DecideCancelClickResult {
  /** true なら `k` コマンドを送信する */
  send: boolean;
  /** クリック後に Tab.cancel へ適用すべき新しい state */
  next: CancelUiState;
  reason: 'disconnected' | 'noSession' | 'armed' | 'fire' | 'alreadyRequested' | 'retry';
}

/**
 * 停止ボタンのクリックを解釈し、送信すべきか・次の state はどうなるかを返す。
 * idle → armed（送らない、1回目のクリックは確認のみ）
 * confirm（armed かつ猶予内） → requested（送る、2回目のクリックで実行）
 * requesting（requested かつ猶予内） → 何もしない（二重送信防止）
 * stalled（requested かつ猶予超過） → requested に張り直して送る（再試行）
 */
export function decideCancelClick(input: DecideCancelClickInput): DecideCancelClickResult {
  const { state, sessionId, nowMs, connected } = input;

  if (!connected) {
    return { send: false, next: state, reason: 'disconnected' };
  }
  if (!sessionId) {
    return { send: false, next: state, reason: 'noSession' };
  }

  const phase = resolveCancelPhase({ state, sessionId, nowMs });

  switch (phase) {
    case 'idle':
      return { send: false, next: { phase: 'armed', sessionId, atMs: nowMs }, reason: 'armed' };
    case 'confirm':
      return { send: true, next: { phase: 'requested', sessionId, atMs: nowMs }, reason: 'fire' };
    case 'requesting':
      return { send: false, next: state, reason: 'alreadyRequested' };
    case 'stalled':
      return { send: true, next: { phase: 'requested', sessionId, atMs: nowMs }, reason: 'retry' };
  }
}
