/**
 * manager.devrelay.io へのログイン後リダイレクト用の純粋関数群。
 *
 * オープンリダイレクト防止のため、遷移先は「'manager' という固定文字列かどうか」の
 * 判定のみに使い、URL 文字列そのものをユーザー入力から組み立てることはしない。
 * トークンは URL フラグメント（#token=）にのみ載せる — フラグメントはサーバーへ
 * 送信されずアクセスログにも残らないため、クエリ文字列（?token=）は使わない。
 *
 * 外部 import ゼロ（apps/web・apps/server の両方から安全に使えるようにするため）。
 */

/** ログイン後の遷移先として許容する値。オープンリダイレクト防止のため 'manager' の 1 つだけ */
export type ManagerRedirectTarget = 'manager';

/**
 * クエリ `?next=` の値を検証する。
 * 許容値は 'manager' 完全一致のみで、それ以外（任意 URL・相対パス・大文字違い・
 * 前後空白付き等）はすべて null を返す。
 */
export function resolveNextTarget(raw: string | null | undefined): ManagerRedirectTarget | null {
  return raw === 'manager' ? 'manager' : null;
}

/**
 * manager へトークンを渡す遷移 URL を組み立てる。
 * baseUrl が空・http(s) 以外のスキーム、または token が空のときは null を返す。
 * 末尾のスラッシュは正規化して1つの `/#token=` になるようにする。
 */
export function buildManagerTokenUrl(baseUrl: string, token: string): string | null {
  if (typeof baseUrl !== 'string' || typeof token !== 'string') return null;
  const base = baseUrl.trim();
  const tok = token.trim();
  if (!base || !tok) return null;
  if (!/^https?:\/\//.test(base)) return null;
  return `${base.replace(/\/+$/, '')}/#token=${encodeURIComponent(tok)}`;
}

/** `managerRedirect` 設定（UserSettings には文字列で保存される）が ON かどうか */
export function isManagerRedirectEnabled(value: string | null | undefined): boolean {
  return value === 'true';
}
