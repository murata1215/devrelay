/**
 * 再起動耐性サイクル（2026-11-25）: `POST /api/services/restart/server` の会話中ガードの
 * キルスイッチ判定（外部 import ゼロの純関数、`update-busy-rules.ts` と同じ流儀）。
 *
 * busy 判定そのもの（優先順位・文言）は `update-busy-rules.ts` の `decideManualUpdate()` /
 * `buildBusyHoldApiMessage()` をそのまま再利用する（`POST /api/machines/:id/restart` と同じ
 * パターン）。ここに置くのはキルスイッチの解釈だけ。
 */

/**
 * `DEVRELAY_RESTART_GATE` の解釈。既定 ON（'0' のときだけ無効化）。
 * OFF のときは `POST /api/services/restart/server` が従来どおり busy 判定をせず即時再起動する。
 */
export function isRestartGateEnabled(raw: string | undefined): boolean {
  return raw !== '0';
}

/**
 * 追補（2026-11-28）: `DEVRELAY_RESTART_IDLE_COOLDOWN_MS` の解決。
 *
 * 会話中ガードの3段目（①実行中ターン台帳②進捗トラッカーの鮮度のどちらにも該当しないが、
 * 直近に AI 応答があっただけの冷却期間）の長さ。既定 10000ms（10秒）、clamp 0〜600000。
 * `0` はこの段の判定自体を行わない（①②のみで busy を判定する）ことを意味する。
 *
 * `u`（Agent 自己更新）側の 10 分判定（`update-busy-rules.ts` の `RECENT_ACTIVITY_MS` 相当、
 * `auto-updater.ts` の `getMachineBusyState()` が使う）とは完全に独立しており、本変数は
 * `getGlobalBusyState()`（= サーバー再起動ガード専用）にしか効かない。あちらの 10 分は
 * 「Agent プロセスを応答直後に触らない」ための安全マージンとして妥当な長さのため変更しない。
 * こちらを短くする理由は、チャットで再起動を頼むと、その応答自体が再起動を 10 分間
 * 止め続けてしまう使用感の悪さを解消するため（実機で発覚）。
 */
export function resolveRestartIdleCooldownMs(raw: string | undefined): number {
  const parsed = raw !== undefined ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(parsed)) return 10_000;
  return Math.min(600_000, Math.max(0, parsed));
}
