// =============================================================================
// Chat 入力ログの redaction（`login` コマンド用、#326 Phase2）
// =============================================================================
//
// `login <code#state>` はチャンネルの生ログ（受信メッセージのログ出力・web:command の
// 他クライアントへの broadcast）に平文で載る経路がある。`login` コマンド自体は
// WebUI 限定だが、Telegram/Discord にユーザーが誤って打ち込むことも防げないため、
// 受信層の全プラットフォームでこのマスク処理を通す（apps/server/src/platforms/*.ts）。
//
// 外部 import ゼロの純関数。#335/#337 と同じ流儀。

/**
 * `login <認可コード>` の形式の入力から認可コード部分をマスクする。
 * 大文字小文字を区別しない `login` に一致した場合のみ変換し、それ以外の
 * 入力（`login` 単独・`login cancel`・login を含まない通常の会話文）は無変更で返す。
 *
 * @param text チャット受信テキスト（ログ出力・broadcast 前の生値）
 * @returns マスク後のテキスト（対象外の場合は入力をそのまま返す）
 */
export function redactChatInput(text: string): string {
  const match = text.match(/^(\s*login\s+)(?!cancel\s*$)(\S.*)$/i);
  if (!match) return text;
  const [, prefix] = match;
  return `${prefix}***`;
}
