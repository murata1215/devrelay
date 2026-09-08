/**
 * #380: メッセージ本文を行境界で安全に切り詰めるための純関数モジュール。外部 import ゼロ
 * （`stop-reason.ts` / `human-text-fence.ts` と同じ流儀）。コンパイル済み dist を
 * `node --test` から直接 import して単体検証できるようにするため。
 *
 * 背景: `get_conversation_history` はメッセージ本文を先頭 2000 文字で切り詰めていたため、
 * exec 完了報告の末尾（commit hash / push 結果）が MCP 経由で読めなかった（#378/#379）。
 * 本モジュールは「先頭を残す」「末尾を残す」のどちらの方向にも対応した行境界カットを提供する。
 *
 * サロゲート範囲判定（isHighSurrogate/isLowSurrogate）は `packages/shared/src/text.ts` の
 * 同名ヘルパーと意図的に同一実装。外部 import ゼロを維持するために複製しており、
 * サロゲート範囲は Unicode 規格で固定でありドリフトしない（#297/#318 系の教訓とは無関係の
 * 独立した安全複製）。
 *
 * 【意図的な非対応】本文「内部」の孤立サロゲートは修復しない。修復には O(n) の全文再構築が
 * 必要になる一方、境界修復は O(1) で足りる。DB の Message.content は Prisma が孤立サロゲートを
 * 含む書き込みを拒否する（`unexpected end of hex escape`）ため、既存行に孤立サロゲートが
 * 混入することは構造的にない。
 */

/** 上位サロゲート（サロゲートペアの1文字目）か */
function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** 下位サロゲート（サロゲートペアの2文字目）か */
function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** 切り詰めでどちら側を「捨てた」かを表す（`keep` の逆）。 */
export type TruncatedSide = 'head' | 'tail';

export interface TruncateResult {
  /** 切り詰め後の本文。必ず入力の連続部分文字列（head なら prefix、tail なら suffix） */
  content: string;
  /** 長さが削られたか（= text.length > maxLength と等価） */
  truncated: boolean;
  /**
   * どちら側を「捨てた」か。truncated が false のときはキー自体を含めない（呼び出し側で
   * オブジェクトへスプレッドする際に省略できるようにするため undefined を返す）。
   */
  truncatedSide?: TruncatedSide;
}

/** `get_conversation_history` の 1 メッセージあたりの最大本文長 */
export const CONVERSATION_MAX_CONTENT_LENGTH = 2000;

/** `get_build_status` の tail フィールドの最大長 */
export const BUILD_STATUS_TAIL_LENGTH = 1500;

/**
 * `keep` の逆側（= 捨てた側）を返す。
 */
function invertSide(keep: 'head' | 'tail'): TruncatedSide {
  return keep === 'head' ? 'tail' : 'head';
}

/**
 * 文字列を行境界で安全に切り詰める。
 *
 * `keep` は「残す側」を指定する（`truncatedSide` は逆に「捨てた側」を表すことに注意）。
 * - `keep: 'head'`（既定）: 先頭から `maxLength` 文字以内を残し、末尾を捨てる
 *   （`truncatedSide: 'tail'`）。行境界が見つかればそこで切り、見つからなければ
 *   ハードカットする（＝改行なし本文でも空文字にはならない）。
 * - `keep: 'tail'`: 末尾から `maxLength` 文字以内を残し、先頭を捨てる
 *   （`truncatedSide: 'head'`）。同様に行境界優先・見つからなければハードカット。
 *
 * 保証する不変条件:
 * - `content` は常に `text` の連続部分文字列（head なら `text.startsWith(content)`、
 *   tail なら `text.endsWith(content)`）
 * - `maxLength > 0` なら `content.length <= maxLength`
 * - `text !== ''` かつ `maxLength > 0` なら `content !== ''`（空文字を返さない）
 * - `truncated === (text.length > maxLength)`
 *
 * @param text 対象文字列
 * @param maxLength 残す最大文字数
 * @param keep 残す側（既定 'head'）
 */
export function truncateOnLineBoundary(
  text: string,
  maxLength: number,
  keep: 'head' | 'tail' = 'head'
): TruncateResult {
  const n = text.length;

  // ガード1: maxLength が 0 以下（NaN も含めて安全側に倒す）
  if (!(maxLength > 0)) {
    return n > 0
      ? { content: '', truncated: true, truncatedSide: invertSide(keep) }
      : { content: '', truncated: false };
  }

  // ガード2: 切り詰め不要
  if (n <= maxLength) {
    return { content: text, truncated: false };
  }

  if (keep === 'head') {
    let end = maxLength;
    const nl = text.lastIndexOf('\n', maxLength - 1);
    if (nl > 0) {
      // nl === 0 の場合（窓内の改行が index 0 のみ）は空文字になってしまうため
      // ハードカットへフォールスルーする（下の end = maxLength のまま）
      let e = nl;
      // CRLF: 改行の直前が \r なら孤立 \r を残さないよう 1 文字戻す
      if (text.charCodeAt(e - 1) === 0x0d) e--;
      if (e > 0) end = e;
    }
    // ハードカット位置がサロゲートペアの間なら 1 文字戻す
    if (end > 0 && isHighSurrogate(text.charCodeAt(end - 1))) end--;
    return { content: text.slice(0, end), truncated: true, truncatedSide: 'tail' };
  }

  // keep === 'tail'
  const start = n - maxLength; // n > maxLength なので start >= 1
  let begin = start;
  const nl = text.indexOf('\n', start - 1);
  if (nl >= 0 && nl + 1 < n) {
    // 改行の直後（= 行頭）から残す。start - 1 から探すことで、窓の直前が
    // 既に改行だった場合に余計な 1 行を捨てないようにしている。
    begin = nl + 1;
  } else {
    // 行境界が見つからない（改行なし、または改行が本文の最終文字のみ）→ ハードカット
    if (isLowSurrogate(text.charCodeAt(begin))) begin++;
  }
  return { content: text.slice(begin), truncated: true, truncatedSide: 'head' };
}
