/**
 * Content-Disposition ヘッダー生成（日本語ファイル名対応）
 *
 * Node.js の HTTP ヘッダーには Latin-1 範囲外の文字（日本語等）を入れられず、
 * `filename="社内….docx"` をそのまま setHeader すると ERR_INVALID_CHAR で 500 になる
 * （2026-10-31: WebUI で日本語名 docx がダウンロードできなかった原因）。
 *
 * RFC 6266 / RFC 5987 に従い、ASCII フォールバックの `filename` と
 * UTF-8 パーセントエンコードの `filename*` を併記する。
 */
export function contentDisposition(type: 'inline' | 'attachment', filename: string): string {
  // フォールバック: 非 ASCII・制御文字・" \ を _ に置換
  const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, '_') || 'download';
  // RFC 5987 の attr-char 以外をエンコード（encodeURIComponent が残す ' ( ) * も対象）
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
