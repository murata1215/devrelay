/**
 * ask / teamexec の宛先名解決における照合ロジック（純関数）。
 *
 * 外部 import ゼロの純関数のみで構成する（`cross-query-guard.ts` / `cross-team-guard.ts` と
 * 同じ流儀）。`command-handler.ts` の `resolveCrossTargetByName()` が使う。
 *
 * 【2026-11-08 実機テストで発見したバグの修正】
 * 以前は `label(p) === needle || p.name === needle` という OR 条件で完全一致を判定しており、
 * `name`（ディレクトリ名、不変）を `displayName`（表示名、変更可）の副次キーとして混ぜていた。
 * そのため、同名衝突時のエラーメッセージが案内する「プロジェクトの表示名を変えて一意にする」
 * という解決策が機能しなかった（displayName を変えても name 側で一致し続けるため）。
 *
 * ここでは照合キーを「表示名（displayName ?? name）」ひとつに統一する。
 * displayName が未設定のプロジェクトは label === name なので、この修正で挙動は変わらない。
 */

export interface CrossTargetCandidateLike {
  name: string;
  displayName: string | null;
}

/**
 * 候補の照合キー（= 表示名、小文字化済み）を返す。
 * displayName が無ければ name を使う（`label(p) = p.displayName ?? p.name` と同じ規則）。
 */
export function crossTargetMatchKey(candidate: CrossTargetCandidateLike): string {
  return (candidate.displayName ?? candidate.name).toLowerCase();
}

/**
 * needle に一致する候補を選ぶ。
 *
 * - まず表示名の完全一致を試みる
 * - 1 件も無ければ表示名の部分一致にフォールバックする
 * - どちらの判定も「表示名」だけを見る（`name` を副次キーとして見ない。上記バグの再発防止）
 *
 * @param candidates 候補一覧
 * @param rawNeedle ユーザーが指定した宛先名（前後空白・大文字小文字を無視する）
 */
export function matchCrossTargetCandidates<T extends CrossTargetCandidateLike>(
  candidates: T[],
  rawNeedle: string,
): T[] {
  const needle = rawNeedle.trim().toLowerCase();
  const exact = candidates.filter((c) => crossTargetMatchKey(c) === needle);
  if (exact.length > 0) return exact;
  return candidates.filter((c) => crossTargetMatchKey(c).includes(needle));
}
