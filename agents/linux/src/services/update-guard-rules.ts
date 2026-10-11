/**
 * サイクル3.1: Agent 自己更新の保留判定（純粋関数、外部 import ゼロ）。
 *
 * 背景: `server:agent:update` 受信時、実行中の AI ターン（`sendPromptToAi()` が解決していない
 * セッション）を一切見ずに更新 → 再起動していたため、実行中ターンが kill される事故が実機で
 * 2 回発生した（サーバー側の busy 判定の穴が根本原因だが、Agent 側も「最後の砦」として
 * 実行中ターンを検知し更新を保留する二重防御を入れる）。
 *
 * agents/linux と agents/macos で byte-for-byte 同一内容を維持すること
 * （resume-priority.ts / devin-session-pick.ts と同じ流儀）。
 */

export type AgentUpdateAction = 'start' | 'defer' | 'wait';

/**
 * `server:agent:update` 受信時の判定。
 *
 * - `force === true` → 常に 'start'（サーバーは現状 force を Agent に伝えないため、
 *   Agent 側は常に安全側＝実行中ターンがあれば保留する。このフィールドは将来の拡張用）
 * - 実行中ターンあり ＋ まだ保留していない → 'defer'（`agent:update:status { status:'deferred' }` を送り、
 *   再確認タイマーを起動する）
 * - 実行中ターンあり ＋ すでに保留中 → 'wait'（再確認タイマーが既に動いているので何もしない）
 * - 実行中ターン無し → 'start'（従来どおり更新開始）
 */
export function decideAgentUpdateAction(input: {
  activeAiTurns: number;
  /** すでに defer 済みか（二重に 'deferred' を送らないため） */
  pendingUpdate: boolean;
  /** 予約フィールド。サーバーは現状これを送らない */
  force?: boolean;
}): AgentUpdateAction {
  if (input.force === true) return 'start';
  if (input.activeAiTurns > 0) {
    return input.pendingUpdate ? 'wait' : 'defer';
  }
  return 'start';
}

/**
 * 実行中ターンの開始時刻が TTL を超えているか（ハングしたターンで永久に更新できなくなるのを防ぐ保険）。
 */
export function isTurnStale(startedAtMs: number, nowMs: number, ttlMs: number): boolean {
  return nowMs - startedAtMs >= ttlMs;
}
