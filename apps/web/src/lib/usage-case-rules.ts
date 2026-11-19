/**
 * Usage 案件必須サイクル（2026-11-19）: チャット送信前の「案件が空なら AI プロンプトを止める」判定（純関数）。
 *
 * - 止めるのは AI へのプロンプトだけ。コマンド（`e` `x` `h` `n make` `u` 数字選択 等）と
 *   内部コマンド（`//connect` 等）は通す。コマンド判定はサーバーと同じ `isTraditionalCommand()`
 *   （@devrelay/shared）を呼び出し側から渡す（このファイルは import ゼロでテストする）。
 * - 必須モードが OFF（`DEVRELAY_USAGE_CASE_REQUIRED` 未設定）なら常に通す。
 * - 案件の状態がまだ読めていない（sessionId 未確定・取得中）ときは、取りこぼしより確実さを優先して止める。
 */

export type CaseGuardResult = 'ok' | 'need-case' | 'not-ready';

export function decideCaseGuard(input: {
  required: boolean;
  /** 案件の状態を読み終えたか（sessionId 未確定・取得中は false） */
  loaded: boolean;
  caseName: string | null;
  text: string;
  hasFiles: boolean;
  isCommand: (text: string) => boolean;
}): CaseGuardResult {
  if (!input.required) return 'ok';
  const text = input.text.trim();
  if (!input.hasFiles) {
    if (!text) return 'ok';
    if (text.startsWith('//')) return 'ok';
    if (input.isCommand(text)) return 'ok';
  }
  if (!input.loaded) return 'not-ready';
  if (input.caseName && input.caseName.trim()) return 'ok';
  return 'need-case';
}
