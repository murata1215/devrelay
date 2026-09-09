/**
 * スレッド管理 cycle1: スレッドタイトルの導出・検証を行う純関数群。
 * 外部 import ゼロ（node:test から dist/ を直接 import してテストするため）。
 */

/** タイトルの最大長（コードポイント数。サロゲートペア絵文字等を1文字として数える）。 */
export const THREAD_TITLE_MAX_LENGTH = 60;

/**
 * ユーザー入力（プロンプト全文や MCP `instruction`）からスレッドの表示タイトルを導出する。
 * - 先頭行のみを使う（改行以降は捨てる）
 * - 前後の空白を trim
 * - 空文字列になった場合は null（呼び出し側で「未命名」として扱う）
 * - `THREAD_TITLE_MAX_LENGTH` を超える場合はコードポイント安全に切り詰め、末尾に `…` を付与
 *   （`String.prototype.slice` は UTF-16 コードユニット単位で絵文字等のサロゲートペアを
 *   破壊する可能性があるため、`Array.from` でコードポイント単位に分割してから切り詰める）
 */
export function deriveThreadTitle(rawInput: string | null | undefined): string | null {
  if (!rawInput) return null;
  const firstLine = rawInput.split('\n')[0]?.trim() ?? '';
  if (firstLine.length === 0) return null;
  const codePoints = Array.from(firstLine);
  if (codePoints.length <= THREAD_TITLE_MAX_LENGTH) return firstLine;
  return codePoints.slice(0, THREAD_TITLE_MAX_LENGTH).join('') + '…';
}

/** `validateThreadTitle` の判定結果。 */
export type ThreadTitleValidationResult =
  | { ok: true; title: string }
  | { ok: false; reason: 'empty' | 'too_long' };

/**
 * ユーザーが `PATCH /api/sessions/:id` 等で明示指定したタイトルを検証する。
 * `deriveThreadTitle` と異なり、こちらは「入力そのものが不正なら拒否する」用途
 * （自動導出は寛容に切り詰めるが、明示指定は長すぎる場合にユーザーへエラーを返したい）。
 * - trim 後に空文字列なら `{ ok:false, reason:'empty' }`
 * - コードポイント数が `THREAD_TITLE_MAX_LENGTH` を超えるなら `{ ok:false, reason:'too_long' }`
 * - それ以外は `{ ok:true, title: trim後の文字列 }`
 */
export function validateThreadTitle(rawTitle: string): ThreadTitleValidationResult {
  const trimmed = rawTitle.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'empty' };
  const codePoints = Array.from(trimmed);
  if (codePoints.length > THREAD_TITLE_MAX_LENGTH) return { ok: false, reason: 'too_long' };
  return { ok: true, title: trimmed };
}
