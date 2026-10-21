/**
 * `GET /api/debug/turns`（会話履歴レール「スピナーが止まらない」調査用の管理者限定診断エンドポイント）の
 * キルスイッチ判定（外部 import ゼロの純関数。thread-activity.ts / thread-list-filter.ts と同じ流儀）。
 *
 * 既定 ON（'0' が明示されたときのみ無効）。エンドポイント自体は `requireSystemAdmin` で
 * 既にシステム管理者限定・read-only だが、既存のキルスイッチ全てが「既定 ON・0 で無効化」の
 * 流儀（`DEVRELAY_SITES` 等）に揃えるため同じ形にする。
 */
export function isDebugTurnsEnabled(raw: string | undefined): boolean {
  return raw !== '0';
}
