/**
 * Agent の WebSocket 再接続に関する純関数・定数。
 *
 * 2026-11-14: 自宅PC（fwjg2507-FMVD34003）が pong タイムアウト切断後、DNS エラー
 * （EAI_AGAIN）の再接続を約13回繰り返した末に `Connecting...` を最後に3日間沈黙した
 * 事故の根治サイクルで新設。agents/{linux,macos,windows}/src/services/connection.ts の
 * 3ファイルが同じ計算を三重に持つのを避けるため shared に集約する。
 *
 * Node.js 固有 API（Buffer 等）は使わない（shared パッケージの既存方針）。
 */

/** WebSocket ハンドシェイクのタイムアウト（ws の `handshakeTimeout` に渡す） */
export const CONNECT_TIMEOUT_MS = 20000;

/**
 * 自前の接続監視タイマー（ミリ秒）。`handshakeTimeout` が効かなかった場合の保険として、
 * 必ず `CONNECT_TIMEOUT_MS` より後に発火させ、`CONNECTING` のまま止まっていたら
 * `ws.terminate()` する。
 */
export const CONNECT_WATCHDOG_MS = 25000;

export interface ReconnectDelayInput {
  /** これから行う再接続の試行回数（1 始まり） */
  attempt: number;
  baseDelay: number;
  maxDelay: number;
  jitterRange: number;
  /** テスト用の注入。省略時は `Math.random()` */
  random?: number;
}

/**
 * 再接続までの待機時間を計算する（指数バックオフ + jitter）。
 *
 * `baseDelay × 2^(attempt-1)` を `maxDelay` で clamp し、`[0, jitterRange)` のランダムな
 * jitter を加える。無期限リトライ（maxAttempts 撤廃）に対応するため、attempt が大きくなっても
 * 指数部は `2^30` 相当で clamp し、Infinity/NaN にならないようにする。
 */
export function computeReconnectDelay(input: ReconnectDelayInput): number {
  const { baseDelay, maxDelay, jitterRange } = input;
  const exponent = Math.min(Math.max(input.attempt - 1, 0), 30);
  const exponentialDelay = Math.min(baseDelay * Math.pow(2, exponent), maxDelay);
  const random = input.random ?? Math.random();
  const jitter = random * jitterRange;
  return exponentialDelay + jitter;
}
