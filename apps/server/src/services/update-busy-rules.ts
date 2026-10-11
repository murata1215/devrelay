/**
 * サイクル3.1: Agent 自己更新の busy 判定・クールダウン・手動 `u` の保留判定（純粋関数のみ、外部 import ゼロ）。
 *
 * `auto-updater.ts` / `command-handler.ts` / `routes/api.ts` から呼ばれる決定ロジックをここに集約し、
 * ユニットテストで I/O なしに全分岐を検証できるようにする（`auto-update-reconcile.ts` と同じ流儀）。
 */

/**
 * キルスイッチの判定。既定（未設定）は有効。`'0'` のときだけ無効化する
 * （既存の env キルスイッチの流儀: `DEVRELAY_THREADS_HIDE_EMPTY_ENDED` 等と同じ「0 で無効」方式）。
 */
export function isUpdateBusyGuardEnabled(raw: string | undefined): boolean {
  return raw !== '0';
}

/** `resolveBusyReason` の入力（優先順位: in-flight turn → session running → recent activity） */
export interface BusyReasonInput {
  /** `InFlightTurnRegistry.count()` の値（経路を問わず送信中〜完了未検知のターン数） */
  inFlightTurnCount: number;
  /** 既存の `isSessionRunning()`（progressTrackers）判定 */
  sessionRunning: boolean;
  /** 既存の「直近 10 分に Message があるか」判定 */
  recentActivity: boolean;
}

/**
 * busy の理由文字列を返す（busy でなければ null）。
 * 自動更新スイープのログで「新設の台帳由来」と「既存の 2 判定由来」を区別できるようにするため、
 * 単純な boolean ではなく理由を返す。
 */
export function resolveBusyReason(input: BusyReasonInput): string | null {
  if (input.inFlightTurnCount > 0) return `busy (in-flight turn: ${input.inFlightTurnCount})`;
  if (input.sessionRunning) return 'busy (session running)';
  if (input.recentActivity) return 'busy (recent activity)';
  return null;
}

/** クールダウン時間（ms）の解決。直前の自動更新が `deferred` だった場合だけ短縮する */
export function resolveCooldownMs(
  lastStatus: string | null | undefined,
  cooldowns: { normalMs: number; deferredMs: number }
): number {
  return lastStatus === 'deferred' ? cooldowns.deferredMs : cooldowns.normalMs;
}

/** 手動 `u` / `server:agent:restart` の保留判定 */
export function decideManualUpdate(input: { busy: boolean; force: boolean }): 'proceed' | 'hold' {
  if (input.force) return 'proceed';
  if (input.busy) return 'hold';
  return 'proceed';
}

/**
 * busy 理由文字列（`resolveBusyReason()` の戻り値）からユーザー向け表示用の件数を取り出す。
 * `busy (in-flight turn: N)` からは N を、`busy (session running)` 等（数値を含まない理由）は
 * 1 件として扱う（「正確な件数は分からないが busy である」ことをユーザーに伝えるため、0 にはしない）。
 */
export function extractBusyCount(reason: string | null): number {
  if (reason === null) return 0;
  const m = reason.match(/(\d+)/);
  return m ? Number.parseInt(m[1], 10) : 1;
}
