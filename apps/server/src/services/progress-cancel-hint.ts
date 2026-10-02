/**
 * 進捗ボックス（Discord/Telegram の「⏳ 実行中...」メッセージ）に「`k` で停止できます」の
 * 案内行を出すかどうかを判定する純関数モジュール。外部 import ゼロ
 * （progress-timeout.ts / progress-markers.ts と同じ流儀。コンパイル済み dist を
 * `node --test` から直接 import して単体検証する）。
 *
 * 背景（2026-09-30 サイクル）: 「実行中の AI ターンを途中で止める機能」への改善要望を調査した結果、
 * 停止コマンド `k` / `kill`（command-handler.ts の handleKill()）は既に実装済みで実際に機能する
 * （実測で Claude SDK 経路のキャンセルを確認済み）ことが判明した。欠けていたのは「止め方の発見可能性」
 * のみだったため、本サイクルでは進捗ボックスへの案内行追加と WebUI 停止ボタンの2本立てで対応する。
 *
 * このモジュールは前者（進捗ボックス案内）の判定を担う。
 *
 * 設計判断:
 * - **web プラットフォームは対象外**: WebUI 側は進捗表示に専用の停止ボタンを追加する
 *   （ChatPage.tsx の ProgressIndicator）ため、生テキストの `<pre>` 表示（案内を足すとボタンの
 *   すぐ横に同じ文言が重複表示される）には出さない。
 * - **経過 60 秒未満では出さない**: 数十秒で終わる大半のターンに毎回出すのは純粋なノイズであり、
 *   今回の苦情は 8〜12 分かかったケース。初回フレーム（elapsed=0）では出ないため、案内追加によって
 *   Discord/Telegram に新規投稿が増えることはない（既存メッセージの編集にのみ1行増える）。
 * - **進捗テキストは `Message.content` に永続化されない**（web は WS 送信のみ、Discord/Telegram は
 *   メッセージ編集のみで、最終的に finalizeProgress() が上書きする）ため、MCP `get_answer`/`get_plan`
 *   のサニタイズ対象（progress-markers.ts）に追従する必要はない。
 */

/** 案内行を出し始める経過秒数のしきい値 */
export const CANCEL_HINT_MIN_ELAPSED_SEC = 60;

/**
 * `DEVRELAY_PROGRESS_CANCEL_HINT` 環境変数を解釈する。
 * 既定 ON（`'0'` が明示されたときのみ無効）。`DEVRELAY_PLAN_STRICT_CHAT` と同じ流儀。
 *
 * @param env 環境変数オブジェクト（通常は `process.env`）
 * @returns 案内行機能が有効なら true
 */
export function isCancelHintEnabled(env: Record<string, string | undefined>): boolean {
  return env?.DEVRELAY_PROGRESS_CANCEL_HINT !== '0';
}

export interface ShouldShowCancelHintInput {
  /** 配信先プラットフォーム */
  platform: 'discord' | 'telegram' | 'web';
  /** セッション開始からの経過秒数 */
  elapsedSeconds: number;
  /** 環境変数オブジェクト（通常は `process.env`） */
  env: Record<string, string | undefined>;
}

/**
 * 進捗ボックスに停止案内行を出すべきかどうかを判定する。
 * @returns 案内行を表示すべきなら true
 */
export function shouldShowCancelHint(input: ShouldShowCancelHintInput): boolean {
  if (!isCancelHintEnabled(input.env)) return false;
  if (input.platform === 'web') return false;
  return input.elapsedSeconds >= CANCEL_HINT_MIN_ELAPSED_SEC;
}
