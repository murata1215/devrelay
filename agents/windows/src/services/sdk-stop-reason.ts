/**
 * #377: Claude Agent SDK の result メッセージ subtype から「打ち切り理由」を判定する
 * 外部 import ゼロの純関数モジュール（sdk-loop-guard.ts / running-code-stale.ts と同じ流儀）。
 *
 * 背景: SDK の maxTurns 到達（error_max_turns）は result メッセージの is_error: true として
 * 返ってくるが、これは「正常な result メッセージの一種」であり例外ではない
 * （sdk.d.ts の SDKResultError 型定義で確認済み）。ai-runner.ts の result ハンドラは従来
 * subtype を一切見ておらず、maxTurns 到達も通常完了として isComplete=true を送っていた。
 * さらに `is_error && options.resumeSessionId` を「resume 失敗」とみなす既存ロジックが
 * error_max_turns も誤って resume 失敗と判定し、プロンプト全体を再実行していた
 * （connection.ts の composeFullPrompt(true) 再送経路）。本モジュールの判定結果を使って
 * ai-runner.ts 側でこの誤判定を除外する。
 *
 * parseEnvInt() は sdk-loop-guard.ts と同一実装をここに複製している（export して import する
 * のではなく複製する）。理由: sdk-loop-guard.ts / running-code-stale.ts は「外部 import ゼロ」
 * 「linux/macos で byte-for-byte 同一」を不変条件として運用している（#350〜#355）。
 * import で結合すると更新のたびに両ファイルの整合を気にする必要が生まれるため、
 * 数行程度の複製コストの方が安いと判断した。
 *
 * 例外を一切投げない（不正な env 値・想定外の subtype は既定値へフォールバックする）。
 */

/** `process.env` 相当の最小型（Node 型定義への依存を避けるため独自定義） */
type EnvLike = Record<string, string | undefined>;

/** SDK maxTurns の既定値。env DEVRELAY_SDK_MAX_TURNS で上書き可能 */
export const DEFAULT_SDK_MAX_TURNS = 400;

/** AI 実行の終了理由。未指定（旧 agent）はサーバー側で 'success' として扱う */
export type SdkStopReason = 'success' | 'max_turns' | 'error' | 'aborted';

/**
 * env 文字列を正の整数として解釈する。未設定・空文字・非数値・0以下は fallback を返す
 * （例外は投げない）。sdk-loop-guard.ts の parseEnvInt と同一実装（意図的な複製。理由はファイル冒頭コメント参照）。
 */
function parseEnvInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  if (n <= 0) return fallback;
  return Math.floor(n);
}

/**
 * env から SDK maxTurns を解決する。未設定・不正値（0以下・非数値）なら DEFAULT_SDK_MAX_TURNS を返す。
 */
export function resolveSdkMaxTurns(env: EnvLike): number {
  return parseEnvInt(env.DEVRELAY_SDK_MAX_TURNS, DEFAULT_SDK_MAX_TURNS);
}

/** mapResultSubtypeToStopReason の戻り値 */
export interface StopReasonResult {
  stopReason: SdkStopReason;
  /** SDK が返した subtype が既知の値でなかった場合 true（フェイルセーフで判定した旨のログ用フラグ） */
  unknownSubtype: boolean;
}

/**
 * SDK result メッセージの subtype / is_error から stopReason を判定する。
 * 既知の subtype（sdk.d.ts 実測、@anthropic-ai/claude-agent-sdk@0.2.77）:
 *   'success' | 'error_during_execution' | 'error_max_turns' |
 *   'error_max_budget_usd' | 'error_max_structured_output_retries'
 * 未知の subtype が来た場合（将来の SDK 更新等）は is_error でフェイルセーフ判定しつつ
 * unknownSubtype: true を返す（呼び出し側でログに subtype 文字列を出す）。
 */
export function mapResultSubtypeToStopReason(
  subtype: string | undefined,
  isError: boolean
): StopReasonResult {
  if (subtype === 'success') {
    return { stopReason: isError ? 'error' : 'success', unknownSubtype: false };
  }
  if (subtype === 'error_max_turns') {
    return { stopReason: 'max_turns', unknownSubtype: false };
  }
  if (
    subtype === 'error_during_execution' ||
    subtype === 'error_max_budget_usd' ||
    subtype === 'error_max_structured_output_retries'
  ) {
    return { stopReason: 'error', unknownSubtype: false };
  }
  // 未知の subtype。フェイルセーフとして is_error に従い判定する。
  return { stopReason: isError ? 'error' : 'success', unknownSubtype: true };
}
