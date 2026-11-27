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
