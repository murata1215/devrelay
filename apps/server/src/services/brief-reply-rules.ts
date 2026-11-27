/**
 * AI 回答契約サイクル（2026-11-27 改訂）: AI の回答を要約前の元文として残すための契約を、
 * サーバーがプロンプト先頭に前置する（暫定・
 * 外部 import ゼロの純関数モジュール。`backlog.ts` の `buildBacklogPromptLine` と同じ場所・
 * 同じ作法でプロンプト先頭に差し込む）。
 *
 * 背景（設計の訂正）: AI 自身に本文と詳細を振り分けさせると、詳細ページにも短い本文が
 * 再掲され、要約前の回答を読めなかった。元文は丸ごと保存し、本文用要約はサーバー側で
 * 生成する。人間が実行する手順・コマンドは、どれだけ長くても元文に省略せず残す。
 *
 * 本モジュールは、AI に元文を作らせるための指示文だけを持つ。
 *
 * 恒久的な配置は Agent 側 Agreement テンプレート（`output-collector.ts`）への統合だが、
 * 3 OS の byte-for-byte 同期・Agreement バージョン更新を伴うため、本サイクルでは
 * ロールアウトの速さを優先してサーバー側の前置のみ実装する（Agent 更新 `u` を待たずに
 * 全マシンへ即時反映できる。Agreement 統合は別サイクルの follow-up）。
 */

/** キルスイッチ（既定 ON）。`'0'` のときだけ無効。`DEVRELAY_BRIEF_REPLY`。 */
export function isBriefReplyEnabled(raw: string | undefined): boolean {
  return raw !== '0';
}

/**
 * サーバーがプロンプト先頭に前置する、AI 回答契約の指示文。
 *
 * 要点:
 * - 回答全体を要約前の元文として残す（本文と詳細に二分しない）
 * - 人間が実行する手順・コマンドは、どれだけ長くても省略せず元文に書く
 * - 本文表示用の短い要約はサーバー側で生成する
 * - 専門用語を避け、前提知識が無くても読める言葉で書く
 */
export const BRIEF_REPLY_PROMPT_LINE = `【回答の書き方】この回答は要約前の元文として保存されます。結論だけに縮めず、判断の根拠、調査内容、変更したファイル、テスト結果など、後から詳細を読む人に必要な内容を省略しないで書いてください。人間が実行する必要がある手順・コマンドは、長くても全文を書きます。チャット本文用の短い要約はサーバー側で別に作るため、本文用に要約したり、\`<!-- devrelay:detail -->\` で回答を二分したりしないでください。前提知識がなくても読める言葉を使ってください。`;

/**
 * この前置を差し込んでよいターンか判定する。
 * - `terminalMode`（PTY 直打ち）: 書式指示がそのまま端末に打ち込まれてしまうため対象外
 * - `hasStatePolicy`（クロスユーザー ask の隔離/resume ターン）: 既存の前置ロジックと競合させない
 * - `handoverTurn`（引継ぎ書生成）: 書式が厳密に決まっているため対象外
 */
export function shouldPrependBriefReplyLine(input: {
  terminalMode?: boolean;
  hasStatePolicy?: boolean;
  handoverTurn?: boolean;
}): boolean {
  return !input.terminalMode && !input.hasStatePolicy && !input.handoverTurn;
}
