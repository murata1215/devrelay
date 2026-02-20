// =============================================================================
// DevRelay Token Utilities
// =============================================================================
// トークンにサーバーURLを埋め込むことで、セルフホスト環境でも
// トークンを貼るだけで正しいサーバーに自動接続できるようにする。
//
// フォーマット:
//   新形式: drl_<serverUrl_base64url>_<random64hex>
//   旧形式: machine_<random64hex>（後方互換のためサポート継続）
//
// 注: btoa/atob はNode.js 16+ とブラウザ両方で利用可能。
//     URL は ASCII のみなので Latin1 制約の問題なし。
// =============================================================================

// Node.js 16+ のグローバル btoa/atob の型宣言
// （tsconfig の lib に "DOM" を含めずに済むようにする）
declare function btoa(data: string): string;
declare function atob(data: string): string;

/** トークンの新プレフィックス */
const TOKEN_PREFIX = 'drl_';

/** トークンの旧プレフィックス（後方互換用） */
const LEGACY_PREFIX = 'machine_';

/**
 * サーバーURLを埋め込んだトークンを生成する
 *
 * @param serverUrl WebSocket URL（例: wss://devrelay.io/ws/agent）
 * @param randomHex 32バイトのランダム16進数文字列（64文字）
 * @returns 新形式トークン（例: drl_d3NzOi8vZGV2cmVsYXkuaW8vd3MvYWdlbnQ_a1b2c3d4...）
 */
export function encodeToken(serverUrl: string, randomHex: string): string {
  // Base64URL エンコード（+ → -, / → _, パディング = を除去）
  const urlEncoded = btoa(serverUrl)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${TOKEN_PREFIX}${urlEncoded}_${randomHex}`;
}

/**
 * トークンからサーバーURLを抽出する
 *
 * 新形式トークン（drl_...）の場合、埋め込まれたURLを返す。
 * 旧形式トークン（machine_...）やその他の場合は null を返す。
 *
 * @param token 接続トークン
 * @returns サーバーURL、または抽出できない場合は null
 */
export function decodeTokenUrl(token: string): string | null {
  if (!token.startsWith(TOKEN_PREFIX)) {
    return null;
  }

  // drl_ を除去
  const rest = token.slice(TOKEN_PREFIX.length);

  // 最後の _ でランダム部分を分離
  const lastUnderscore = rest.lastIndexOf('_');
  if (lastUnderscore === -1) {
    return null;
  }

  const urlEncoded = rest.slice(0, lastUnderscore);

  try {
    // Base64URL デコード（- → +, _ → /）
    const base64 = urlEncoded.replace(/-/g, '+').replace(/_/g, '/');
    const url = atob(base64);

    // 基本的なURL形式チェック
    if (url.startsWith('ws://') || url.startsWith('wss://')) {
      return url;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * トークンが新形式かどうかを判定する
 *
 * @param token 接続トークン
 * @returns 新形式（drl_...）の場合 true
 */
export function isNewFormatToken(token: string): boolean {
  return token.startsWith(TOKEN_PREFIX);
}

/**
 * トークンが旧形式かどうかを判定する
 *
 * @param token 接続トークン
 * @returns 旧形式（machine_...）の場合 true
 */
export function isLegacyToken(token: string): boolean {
  return token.startsWith(LEGACY_PREFIX);
}
