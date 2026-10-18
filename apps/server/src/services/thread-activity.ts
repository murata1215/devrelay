/**
 * 会話履歴レール（右レール第3タブ）: `GET /api/threads` に乗せる「実行中（running）」判定の
 * 純ロジック集。外部 import ゼロ（node:test から dist/ を直接 import する。
 * thread-scope.ts / thread-list-filter.ts と同じ流儀）。
 *
 * 「実行中」の定義は2経路の OR:
 * - `isSessionRunning(sessionId)`（session-manager.ts の `progressTrackers`。チャット経路のみ）
 * - `inFlightTurns.getStartedAt(machineId, sessionId)`（MCP exec / crossquery / teamexec /
 *   raw-completion も含めて一元的に記録される台帳。サイクル3.1）
 *
 * `inFlightTurns` 自体の TTL は6時間（Agent 自己更新ガード用の安全側の値）だが、
 * UI で6時間スピナーが回り続けるのは明確なバグに見えるため、表示用には別途短い
 * TTL（`RUNNING_DISPLAY_TTL_MS`）をこのモジュール側で適用する。TTL 判定を
 * `InFlightTurnRegistry` 側に持たせない設計（`getStartedAt()` は読み出し専用）と対になる。
 */

/** 表示用「実行中」とみなす最大経過時間（ms）。台帳本体の6時間 TTL より大幅に短い（30分）。 */
export const RUNNING_DISPLAY_TTL_MS = 30 * 60 * 1000;

/**
 * `DEVRELAY_CONVERSATION_RAIL` 環境変数を解釈する。
 * 既定 ON（'0' が明示されたときのみ無効）。`DEVRELAY_THREADS_HIDE_EMPTY_ENDED` と同じ流儀。
 */
export function isConversationRailEnabled(raw: string | undefined): boolean {
  return raw !== '0';
}

/**
 * スレッドが「実行中」かどうかを判定する。
 *
 * `enabled=false`（キルスイッチ OFF）のときは `undefined` を返す（＝フィールド自体を
 * レスポンスに出さない設計と対になる。`GET /api/threads` 側で `running: resolveRunning(...)`
 * としたときに `undefined` が JSON シリアライズでキーごと消えるため、OFF 時のレスポンスが
 * 旧実装と構造的に同一になる。`buildEmptyEndedThreadExclusion()` が `{}` を返すのと同じ主張の仕方）。
 *
 * `progressTracked`（チャット経路）が true なら即 true。
 * そうでなければ `inFlightStartedAtMs`（MCP exec 等）が `displayTtlMs` 以内なら true。
 * どちらも該当しなければ false。
 */
export function resolveRunning(args: {
  enabled: boolean;
  progressTracked: boolean;
  inFlightStartedAtMs: number | undefined;
  nowMs: number;
  displayTtlMs?: number;
}): boolean | undefined {
  if (!args.enabled) return undefined;
  if (args.progressTracked) return true;
  if (args.inFlightStartedAtMs === undefined) return false;
  const ttl = args.displayTtlMs ?? RUNNING_DISPLAY_TTL_MS;
  return args.nowMs - args.inFlightStartedAtMs < ttl;
}
