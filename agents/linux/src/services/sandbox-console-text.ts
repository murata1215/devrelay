/**
 * Windows のコンソール出力（`icacls` 等のエラーメッセージ）をデコードする（純関数）。
 *
 * `execFileAsync` が返す stdout/stderr を `'utf-8'` 文字列として直接読むと、日本語版 Windows の
 * コンソールコードページ（既定 CP932/Shift_JIS）で出力されたバイト列を UTF-8 として誤読し
 * 文字化けする（SB-1a-1.1 B2 対応: `devrelay sandbox prep` のエラー表示が文字化けしていた）。
 *
 * 本関数は Buffer を受け取り、
 *   1. 厳格 UTF-8 として妥当ならそのまま使う（非日本語版 Windows・ASCII のみの出力はここで確定）
 *   2. 妥当でなければ Shift_JIS（`TextDecoder('shift_jis')`。Node の公式配布バイナリは full-ICU
 *      同梱のため追加パッケージ無しで使える）を試す
 *   3. それも妥当でなければ latin1（1 バイト = 1 文字。情報を欠落させず必ず成功する最後の保険）
 * の順で試す。
 */

const FATAL_UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const FATAL_SHIFT_JIS_DECODER = new TextDecoder('shift_jis', { fatal: true });

/** Buffer/Uint8Array を上記の順で試してデコードする。例外を投げない（latin1 が必ず成功する）。 */
export function decodeWindowsConsoleText(buf: Buffer | Uint8Array): string {
  if (buf.length === 0) return '';
  try {
    return FATAL_UTF8_DECODER.decode(buf);
  } catch {
    // UTF-8 として不正 → Shift_JIS を試す
  }
  try {
    return FATAL_SHIFT_JIS_DECODER.decode(buf);
  } catch {
    // Shift_JIS としても不正 → 最後の保険
  }
  return Buffer.from(buf).toString('latin1');
}
