/**
 * AI 回答契約サイクル（2026-11-23 第3版）: AI 応答が境界行（`<!-- devrelay:detail -->`）を
 * 書かなかった場合の保険として、サーバー側で AI に要約させるための純関数モジュール。
 * 外部 import ゼロ（`content-truncate.ts` / `usage-rules.ts` と同じ流儀）。
 *
 * 背景: AI への「人間向け本文と詳細を分けて書く」契約（`brief-reply-rules.ts`）は
 * お願いに過ぎず、長い会話・Claude 以外のツール（Codex/Gemini/Devin）では遵守されないことが
 * 実機で確認された。境界行が無い場合でも同じ体験（短い本文＋詳細リンク）を得るため、
 * DevRelay 自身が受け取った返事を要約 AI に渡して人間向け本文を作り直す。
 *
 * 判断基準は契約と同じ: 短くすること自体が目的ではなく、人間が余計な情報を読まずに
 * 仕事を進められることが目的。失敗・未設定・短い返事では何もしない（情報を落とさない）。
 */

/** キルスイッチ（既定 ON）。`'0'` のときだけ無効。`DEVRELAY_REPLY_SUMMARY`。 */
export function isReplySummaryEnabled(raw: string | undefined): boolean {
  return raw !== '0';
}

/** 要約を試みる本文長の既定下限（文字）。これ未満は要約を呼ばずそのまま返す。 */
export const DEFAULT_SUMMARY_MIN_CHARS = 800;
export const MIN_SUMMARY_MIN_CHARS = 100;
export const MAX_SUMMARY_MIN_CHARS = 20000;

/** 下限文字数を `[MIN_SUMMARY_MIN_CHARS, MAX_SUMMARY_MIN_CHARS]` にクランプする。不正値は既定値。 */
export function clampSummaryMinChars(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_SUMMARY_MIN_CHARS;
  return Math.min(MAX_SUMMARY_MIN_CHARS, Math.max(MIN_SUMMARY_MIN_CHARS, Math.round(raw)));
}

/** `DEVRELAY_REPLY_SUMMARY_MIN_CHARS` を解決する（未設定・不正値は既定 800）。 */
export function resolveSummaryMinChars(envRaw: string | undefined): number {
  const n = envRaw ? Number.parseInt(envRaw, 10) : NaN;
  if (Number.isFinite(n) && n > 0) return clampSummaryMinChars(n);
  return DEFAULT_SUMMARY_MIN_CHARS;
}

/**
 * 要約 AI を呼ぶべきかどうかを判定する。
 * @param input.length 本文（進捗ノイズ除去済み・境界行での分割後の summary 部分）の文字数
 * @param input.minChars `resolveSummaryMinChars()` の結果
 */
export function shouldSummarize(input: { length: number; minChars: number }): boolean {
  return input.length >= input.minChars;
}

/** 要約 AI への指示文（システムプロンプト）。 */
export const REPLY_SUMMARY_SYSTEM_PROMPT = `あなたは開発者向けチャットの「人間向け要約」を作る担当です。
与えられた AI の返事から、人間が次に判断・実行するために必要なことだけを書き出してください。

必ず含めるもの:
- 結論（何がどうなったか）
- 判断してほしいこと（選択肢があれば選択肢も）
- 人間が実行する必要がある手順・コマンド（原文のまま、省略も要約もせずコードブロックで全文）
- 人間の判断に影響する注意点・リスク

含めないもの:
- 調査の過程、技術的な背景説明、変更したファイルの内訳、テスト結果の内訳

書き方:
- 専門用語を避け、前提知識が無くても読める簡潔な日本語
- 元の文に無いことを足さない（推測しない）
- 見出しは使ってよいが、表は使わない（Discord/Telegram で崩れるため）
- 人間が実行する手順・コマンドが無ければ、その項目ごと省略してよい`;

/** 要約 AI に渡すユーザーメッセージを組み立てる。 */
export function buildReplySummaryUserPrompt(content: string): string {
  return `次の AI の返事を、上記の方針で要約してください。\n\n---\n${content}`;
}

/**
 * 要約 AI の出力を検証し、使ってよいものだけを返す。
 * - 空・空白のみ → null（フォールバック対象）
 * - 元の文より短くなっていない（要約になっていない）→ null
 */
export function normalizeSummary(raw: string | null | undefined, original: string): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length >= original.trim().length) return null;
  return trimmed;
}
