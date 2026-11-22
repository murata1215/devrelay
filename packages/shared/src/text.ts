/**
 * 文字列ユーティリティ
 *
 * Node.js 固有 API は使わない（shared は WebUI からも読まれるため）
 */

/** 上位サロゲート（サロゲートペアの1文字目）か */
const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;

/** 下位サロゲート（サロゲートペアの2文字目）か */
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

/**
 * 孤立したサロゲートを取り除く
 *
 * JS の文字列は UTF-16 なので、絵文字などの文字は上位＋下位のサロゲートペアで表現される。
 * 片割れだけが残った文字列は不正な UTF-16 となり、Prisma（JSON シリアライズ）に渡すと
 * `unexpected end of hex escape` で拒否される。DB へ書く前に必ず通すこと。
 *
 * @param text 対象文字列
 * @returns 孤立サロゲートを除去した文字列
 */
export function stripLoneSurrogates(text: string): string {
  let result = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);

    if (isHighSurrogate(code)) {
      // 次が下位サロゲートならペアとして成立するので 2 文字まとめて残す
      if (i + 1 < text.length && isLowSurrogate(text.charCodeAt(i + 1))) {
        result += text[i] + text[i + 1];
        i++;
      }
      // 片割れだけなら捨てる
      continue;
    }

    // ペアを伴わない下位サロゲートも捨てる
    if (isLowSurrogate(code)) continue;

    result += text[i];
  }
  return result;
}

/**
 * 文字列を安全に切り詰める（サロゲートペアを分断しない）
 *
 * `slice(0, n)` は絵文字の途中で切れてしまい、壊れた UTF-16 を生む。
 * 通知本文など DB に保存する文字列は必ずこの関数を通すこと。
 *
 * @param text 対象文字列
 * @param maxLength 最大文字数（サフィックスを含まない本体の長さ）
 * @param suffix 切り詰めた場合に末尾へ付ける文字列（デフォルト '...'）
 * @returns 切り詰め済み文字列。maxLength 以下ならそのまま返す
 */
export function truncateSafe(text: string, maxLength: number, suffix: string = '...'): string {
  const cleaned = stripLoneSurrogates(text);
  if (cleaned.length <= maxLength) return cleaned;

  let cut = maxLength;
  // 切断位置の直前が上位サロゲートなら、ペアを割らないよう 1 文字戻す
  if (cut > 0 && isHighSurrogate(cleaned.charCodeAt(cut - 1))) {
    cut--;
  }
  return cleaned.slice(0, cut) + suffix;
}

/**
 * `MessageFile.filename` の basename を取り出す。
 *
 * 2026-11-22: 出力ファイル（.devrelay-output 配下のターン専用フォルダのサブフォルダ再帰収集）に伴い、
 * filename は `/` 区切りの相対パス（例: `report/best.mp4`）を持つようになった。
 * WebUI のファイルリンクは `MessageFile.id` ベースの URL なので影響しないが、
 * filename をファイルシステムパス・アーカイブエントリ名として使う下流
 * （Discord/Telegram の添付名、dev-report の画像 src、ZIP エントリ名、
 * WebUI の `download` 属性）はそのまま使うとフォルダ階層が意図せず露出したり
 * 相対パスとして解釈され得るため、必ずこの関数で basename 化してから使うこと。
 *
 * @param filename `MessageFile.filename`（相対パスの場合も単純なファイル名の場合もある）
 * @returns 最後の `/` より後ろの部分。空になった場合は `'file'`
 */
export function outputFileBaseName(filename: string): string {
  if (typeof filename !== 'string' || filename.length === 0) return 'file';
  const parts = filename.split('/');
  const base = parts[parts.length - 1];
  return base.length > 0 ? base : 'file';
}
