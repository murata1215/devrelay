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

/** `resolveBusyState` の入力（優先順位: in-flight turn → session running → recent AI output） */
export interface BusyReasonInput {
  /** `InFlightTurnRegistry.count()` の値（経路を問わず送信中〜完了未検知のターン数） */
  inFlightTurnCount: number;
  /** 進捗トラッカー（session-manager.ts）の鮮度判定結果（tracker の有無ではなく「最近動いたか」） */
  sessionRunning: boolean;
  /** 直近 10 分に `role='ai'` の Message があるか（2026-10-24: role 非限定だと `u` 自身の
   * 入力/応答行を踏んで自家中毒するため、AI 出力のみに限定した判定） */
  recentActivity: boolean;
}

/**
 * busy の理由の種別（2026-10-24: 文字列 1 本に押し込めず、件数を「数えた値だけ」持たせるための構造）。
 * - `'in-flight-turn'` / `'agent-reported-turn'`: count は実際に数えた値
 * - `'session-running'` / `'recent-ai-output'`: 件数という概念が無いため count は常に null
 *   （従来 `extractBusyCount()` がここを一律「1」に丸めていたが、数えていない値を件数として
 *   ユーザーに見せるのは誤誘導のため廃止した）
 */
export type BusyKind = 'in-flight-turn' | 'session-running' | 'recent-ai-output' | 'agent-reported-turn';

/** busy 状態（busy でなければ呼び出し側は null を扱う。この型自体は「busy である」ことが前提） */
export interface BusyState {
  kind: BusyKind;
  count: number | null;
}

/**
 * busy 状態を判定する（優先順位: in-flight turn → session running → recent AI output）。
 * busy でなければ null。
 */
export function resolveBusyState(input: BusyReasonInput): BusyState | null {
  if (input.inFlightTurnCount > 0) return { kind: 'in-flight-turn', count: input.inFlightTurnCount };
  if (input.sessionRunning) return { kind: 'session-running', count: null };
  if (input.recentActivity) return { kind: 'recent-ai-output', count: null };
  return null;
}

/**
 * busy 状態をログ用の理由文字列に整形する（自動更新スイープのログで
 * 「新設の台帳由来」と「既存の判定由来」を区別できるようにするため）。
 */
export function formatBusyReason(state: BusyState | null): string | null {
  if (state === null) return null;
  switch (state.kind) {
    case 'in-flight-turn': return `busy (in-flight turn: ${state.count})`;
    case 'agent-reported-turn': return `busy (agent-reported turn: ${state.count})`;
    case 'session-running': return 'busy (session running)';
    case 'recent-ai-output': return 'busy (recent ai output)';
  }
}

/**
 * `resolveBusyState()` + `formatBusyReason()` を合成した薄いラッパ（既存シグネチャ非破壊。
 * auto-updater.ts の既存呼び出し元を 0 行変更で済ませるため）。
 */
export function resolveBusyReason(input: BusyReasonInput): string | null {
  return formatBusyReason(resolveBusyState(input));
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
 * 手動 `u` の保留応答（チャット向け）に使う i18n キーと差し込みパラメータを決める。
 * 2026-10-24: 理由ごとに文言を分け、数えていない値（session-running / recent-ai-output）は
 * `count` を渡さない（`update.deferredBusy*` 側のテンプレートも件数プレースホルダを持たない）。
 */
export function resolveDeferredBusyMessage(state: BusyState | null): { key: string; params: Record<string, string | number> } {
  if (state === null) return { key: 'update.deferredBusy', params: { count: 1 } };
  switch (state.kind) {
    case 'in-flight-turn':
      return { key: 'update.deferredBusyTurn', params: { count: state.count ?? 0 } };
    case 'agent-reported-turn':
      // チャット文言としては in-flight turn と同じ扱い（件数つき「AI 実行中」）でよい
      return { key: 'update.deferredBusyTurn', params: { count: state.count ?? 0 } };
    case 'session-running':
      return { key: 'update.deferredBusySessionRunning', params: {} };
    case 'recent-ai-output':
      return { key: 'update.deferredBusyRecentAi', params: {} };
  }
}

/**
 * `POST /api/machines/:id/restart` の 409 応答本文（英語固定、WebUI の alert 表示用）。
 * `{ "force": true }` での再試行案内は維持する。
 */
export function buildBusyHoldApiMessage(state: BusyState | null): string {
  if (state === null) return 'AI turn in progress. Wait for it to finish, or retry with { "force": true }.';
  switch (state.kind) {
    case 'in-flight-turn':
    case 'agent-reported-turn':
      return `AI turn in progress (${state.count}). Wait for it to finish, or retry with { "force": true }.`;
    case 'session-running':
      return 'A process is currently running. Wait for it to finish, or retry with { "force": true }.';
    case 'recent-ai-output':
      return 'AI output was produced in the last 10 minutes. Wait a bit, or retry with { "force": true }.';
  }
}

/**
 * 「直近 N ms 以内に `role='ai'` の Message があるか」を判定する prisma `where`。
 * 2026-10-24: 自家中毒の根治（`u` 自身の入力/応答行を踏んで busy と誤判定していた）の核心部分。
 * role を `'ai'` に限定することをここに固定し、呼び出し側（auto-updater.ts）が
 * role 指定を書き忘れたり外したりしても、ここさえ通していれば安全になるようにする。
 */
export function buildRecentAiActivityWhere(sessionIds: string[], since: Date): {
  sessionId: { in: string[] };
  role: 'ai';
  createdAt: { gte: Date };
} {
  return { sessionId: { in: sessionIds }, role: 'ai', createdAt: { gte: since } };
}
