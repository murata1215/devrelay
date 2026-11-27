/**
 * 再起動耐性サイクル 追補（2026-11-28）: `restart-when-idle` CLI が待機中・`--status` で
 * 表示する「誰の会話が実行中か」情報の整形ルール（外部 import ゼロの純関数）。
 *
 * 背景: 会話中ガード自体は正しく動いていたが、「誰が」「どのスレッドで」会話しているのかが
 * 件数表示（`busy (in-flight turn: 1)` 等）だけでは分からず、実機で「誰も会話していないはず
 * では」という誤解が起きた（Pulse 画面と見比べて初めて正体が分かった）。
 */

/** `DEVRELAY_INFLIGHT_DETAIL` の解釈。既定 'label'。不正な値も安全側の 'label' として扱う。 */
export type InflightDetailLevel = 'off' | 'id' | 'label';

export function resolveInflightDetailLevel(raw: string | undefined): InflightDetailLevel {
  if (raw === 'off' || raw === 'id') return raw;
  return 'label';
}

/** 1 件分の表示材料。`label` が null なら見出し行を出さない（'id' レベル・解決失敗の両方を兼ねる）。 */
export interface InflightSessionEntry {
  machineName: string | null;
  projectName: string | null;
  ageMs: number | null;
  label: string | null;
}

/** 経過時間（ms）を「N分M秒」/「M秒」の短い日本語に整形する。不明・負値は「経過不明」。 */
export function formatElapsed(ageMs: number | null): string {
  if (ageMs === null || !Number.isFinite(ageMs) || ageMs < 0) return '経過不明';
  const totalSec = Math.floor(ageMs / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return min === 0 ? `${sec}秒` : `${min}分${sec}秒`;
}

/** スレッド見出しを指定長（既定60字）で切り詰める。null はそのまま null。 */
export function truncateLabel(label: string | null, maxLen = 60): string | null {
  if (label === null) return null;
  const trimmed = label.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length <= maxLen ? trimmed : `${trimmed.slice(0, maxLen)}…`;
}

/**
 * 1 件分の CLI 表示行を組み立てる（「マシン名 / プロジェクト名   実行中 N分M秒」＋
 * あれば次の行にスレッド見出し）。`entry.label` が null（'id' レベル・解決失敗のいずれか）なら
 * 1 行目だけを返す。
 */
export function formatInflightEntryLine(entry: InflightSessionEntry): string {
  const who = entry.machineName
    ? (entry.projectName ? `${entry.machineName} / ${entry.projectName}` : entry.machineName)
    : '(マシン不明)';
  const head = `${who}   実行中 ${formatElapsed(entry.ageMs)}`;
  const label = truncateLabel(entry.label);
  return label === null ? head : `${head}\n      ${label}`;
}
