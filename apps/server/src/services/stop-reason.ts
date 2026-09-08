/**
 * #377: Agent から送られてくる `stopReason`（AI 実行の終了理由）を正規化・判定するための
 * 純関数モジュール。外部 import ゼロ（agents 側の sdk-loop-guard.ts / running-code-stale.ts /
 * sdk-stop-reason.ts と同じ流儀。ただしこちらはサーバー専用でありエージェント側との
 * byte-for-byte 同一の対象ではない）。
 *
 * 背景: `AiOutputPayload.stopReason` は Claude SDK 経路の Agent（linux/macos）のみが実値
 * （'success' | 'max_turns' | 'error' | 'aborted'）を送る。旧 Agent・Windows・Claude SDK 以外の
 * AI ツール経路では未指定（undefined）のままであり、これは「正常完了」として扱う必要がある
 * （後方互換のため）。例外は一切投げない。
 */

/** 打ち切りなしの正常完了を表す stopReason 値 */
export const STOP_REASON_SUCCESS = 'success';

/**
 * Agent から受け取った stopReason（未指定・空文字を含む）を正規化する。
 * 未指定・空文字は 'success' 扱い（旧 Agent / Windows / 非 Claude ツールとの後方互換）。
 */
export function normalizeStopReason(raw?: string): string {
  if (raw === undefined || raw === null || raw === '') return STOP_REASON_SUCCESS;
  return raw;
}

/**
 * 正規化済みの stopReason が「途中終了」を表すかどうかを判定する。
 * 'success' 以外はすべて途中終了扱い（'max_turns' | 'error' | 'aborted' | 将来追加される未知の値）。
 */
export function isStopReasonTruncated(stopReason: string): boolean {
  return stopReason !== STOP_REASON_SUCCESS;
}

/**
 * summary 等のテキスト先頭に打ち切りマークを付与する。mark は呼び出し側で
 * tChat() 等によりローカライズ済みの文字列を渡すこと（本関数自体は i18n に関与しない＝純度維持）。
 * mark が空文字の場合（success 時など）は text をそのまま返す。
 */
export function applyStopReasonMark(text: string, mark: string): string {
  if (!mark) return text;
  return mark + text;
}
