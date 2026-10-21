/**
 * 会話履歴レール（右レール第3タブ）: `GET /api/threads` に乗せる「実行中（running）」判定の
 * 純ロジック集。外部 import ゼロ（node:test から dist/ を直接 import する。
 * thread-scope.ts / thread-list-filter.ts と同じ流儀）。
 *
 * 「実行中」の定義は2経路の OR:
 * - `getProgressTrackerAgeMs(sessionId)`（session-manager.ts の `progressTrackers`。チャット経路のみ）
 *   が鮮度 TTL（`RUNNING_FRESHNESS_MS`）以内
 * - `inFlightTurns.getStartedAt(machineId, sessionId)`（MCP exec / crossquery / teamexec /
 *   raw-completion も含めて一元的に記録される台帳。サイクル3.1）が表示 TTL（`RUNNING_DISPLAY_TTL_MS`）以内
 *
 * 2026-10-18 根治: 当初は `progressTracked: boolean`（tracker の有無のみ）で判定していたが、
 * `finalizeProgress()` の配信失敗や Agent 切断時の回収漏れで tracker が残ると
 * **恒久的に running=true が返る**事故があった（「返事が返ってきてもスピナーが止まらない」）。
 * `finalizeProgress`/`clearSessionsForMachine` 側の回収漏れは個別に塞いだが、万一別経路で
 * 同種の漏れが再発しても自己回復するよう、ここでも「tracker の有無」ではなく
 * 「最後に出力があってからの経過時間（鮮度）」で判定する二重の安全策を取る。
 *
 * `inFlightTurns` 自体の TTL は6時間（Agent 自己更新ガード用の安全側の値）だが、
 * UI で6時間スピナーが回り続けるのは明確なバグに見えるため、表示用には別途短い
 * TTL（`RUNNING_DISPLAY_TTL_MS`）をこのモジュール側で適用する。TTL 判定を
 * `InFlightTurnRegistry` 側に持たせない設計（`getStartedAt()` は読み出し専用）と対になる。
 */

/** 表示用「実行中」とみなす最大経過時間（ms、`inFlightTurns` 側）。台帳本体の6時間 TTL より大幅に短い（30分）。 */
export const RUNNING_DISPLAY_TTL_MS = 30 * 60 * 1000;

/**
 * 進捗トラッカー（`progressTrackers`）側の鮮度 TTL（ms）。
 * ソフトタイムアウト `PROGRESS_TIMEOUT`（既定300秒=5分）の2倍。無出力の長いツール実行
 * （ビルド等）1回分では誤って消えないが、tracker 回収漏れ（既知の事故クラス）が
 * 起きても最長この時間で自己回復する。
 */
export const RUNNING_FRESHNESS_MS = 10 * 60 * 1000;

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
 * `progressTrackerAgeMs`（チャット経路。`undefined` = tracker 無し）が `freshnessMs` 以内なら即 true。
 * そうでなければ `inFlightStartedAtMs`（MCP exec 等）が `displayTtlMs` 以内なら true。
 * どちらも該当しなければ false。
 */
export function resolveRunning(args: {
  enabled: boolean;
  progressTrackerAgeMs: number | undefined;
  inFlightStartedAtMs: number | undefined;
  nowMs: number;
  displayTtlMs?: number;
  freshnessMs?: number;
}): boolean | undefined {
  if (!args.enabled) return undefined;
  if (args.progressTrackerAgeMs !== undefined) {
    const freshness = args.freshnessMs ?? RUNNING_FRESHNESS_MS;
    if (args.progressTrackerAgeMs < freshness) return true;
  }
  if (args.inFlightStartedAtMs === undefined) return false;
  const ttl = args.displayTtlMs ?? RUNNING_DISPLAY_TTL_MS;
  return args.nowMs - args.inFlightStartedAtMs < ttl;
}
