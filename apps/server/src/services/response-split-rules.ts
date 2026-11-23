/**
 * AI 回答契約サイクル（2026-11-23 改訂）: AI 応答を「人間がすぐ使う部分」と「詳細」に
 * 分ける純関数モジュール。外部 import は `progress-markers.ts`（同じく外部 import ゼロ）のみ。
 *
 * 背景: 当初「長文を折りたたむ UI」として実装したが、それはユーザーの意図ではなかった。
 * 本当にやりたいことは「AI 自身が、人間が判断・行動するために必要な情報と、技術的な詳細を
 * 分けて書く」こと（表示の仕方ではなく回答の作り方の問題）。行数・書式では振り分けない。
 *
 * AI には境界行 `DETAIL_BOUNDARY_MARKER` を単独の1行として書かせる契約にする
 * （`brief-reply-rules.ts` が前置するプロンプトで指示する）。境界行より前が人間向けの本文、
 * 後が詳細。境界行が無ければ「全文が人間向け本文」として扱う（退行しない）。
 */

import { stripAiProgressNoise } from './progress-markers.js';

/** AI が「ここから詳細」の境界として書く行（単独で1行・前後の空白は許容）。 */
export const DETAIL_BOUNDARY_MARKER = '<!-- devrelay:detail -->';

export interface SplitAiResponseResult {
  /** チャット上にそのまま表示する本文（結論・判断事項・人間が実行する手順等）。 */
  summary: string;
  /** 詳細ページに置く本文。境界行が無い、または境界後が空白のみの場合は null。 */
  detail: string | null;
}

/** 行全体が境界マーカーと一致するか（前後の空白は許容）。 */
function isBoundaryLine(line: string): boolean {
  return line.trim() === DETAIL_BOUNDARY_MARKER;
}

/**
 * AI 応答を人間向け本文と詳細に分割する。
 *
 * - 進捗ノイズ行（🔧 使用中... / 📊 Rate Limit 等）は分割前に除去する（`stripAiProgressNoise`）。
 * - 境界行は **コードフェンス（```）の外** にあるものだけを対象にする。説明や例として
 *   コードブロック内に書かれた境界行は分割に使わない（AI が構文を例示しても誤爆しない）。
 * - 複数の境界行がある場合は最初の1つだけを使う（2つ目以降は detail の一部として扱われる）。
 * - 境界後が空白のみなら detail は null（分割なしと同じ扱いにする）。
 */
export function splitAiResponse(raw: string): SplitAiResponseResult {
  const cleaned = stripAiProgressNoise(typeof raw === 'string' ? raw : '');
  const lines = cleaned.split('\n');

  let inFence = false;
  let boundaryIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && isBoundaryLine(lines[i])) {
      boundaryIndex = i;
      break;
    }
  }

  if (boundaryIndex === -1) {
    return { summary: cleaned.trim(), detail: null };
  }

  const summary = lines.slice(0, boundaryIndex).join('\n').trim();
  const detailRaw = lines.slice(boundaryIndex + 1).join('\n').trim();
  return { summary, detail: detailRaw.length > 0 ? detailRaw : null };
}

/** 詳細セクションを持つか。 */
export function hasDetailSection(result: SplitAiResponseResult): boolean {
  return result.detail !== null;
}

/**
 * 詳細ページへのリンクが作れない場合のフォールバック本文（情報を一切落とさない）。
 * summary と detail を素直に連結するだけ（見出しや区切り線は呼び出し側の用途で変える）。
 */
export function joinWithoutLink(result: SplitAiResponseResult): string {
  if (result.detail === null) return result.summary;
  if (result.summary === '') return result.detail;
  return `${result.summary}\n\n${result.detail}`;
}
