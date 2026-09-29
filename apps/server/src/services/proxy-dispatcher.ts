/**
 * 社内プロキシ経由での外向き HTTPS 通信対応（社内オンプレ移設対応）。
 *
 * 背景: Agent 側（agents/linux/src/services/connection.ts）は config.yaml の `proxy` で
 * HTTP/SOCKS プロキシに対応済みだが、Server 側は未対応だった。Node 20 の global fetch
 * （undici ベース）は `HTTPS_PROXY` 等の環境変数を自動では見ないため、社内の明示プロキシ
 * 環境では OpenAI/Anthropic/Gemini SDK や Google OAuth への発信がすべて失敗する。
 *
 * 対応方針: `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY`（大文字・小文字どちらの表記も可）を読み、
 * 設定されていれば undici の ProxyAgent を globalDispatcher として登録する。
 * 環境変数が一切無ければ何もしない（fail-soft・既存 VPS 環境の挙動を変えない）。
 */

import { ProxyAgent, setGlobalDispatcher } from 'undici';

/**
 * process.env からプロキシ URL を解決する（純粋関数・テスト容易性のため env オブジェクトを引数で受ける）。
 *
 * 優先順位: HTTPS_PROXY > https_proxy > HTTP_PROXY > http_proxy。
 * DevRelay Server は外向き通信がすべて HTTPS のため、HTTP 用プロキシ変数もフォールバックとして許容する
 * （多くの社内プロキシは HTTP/HTTPS 両対応の単一エンドポイントであるため）。
 *
 * @param env process.env 相当のオブジェクト
 * @returns プロキシ URL。未設定なら null
 */
export function resolveProxyUrl(env: NodeJS.ProcessEnv): string | null {
  const candidates = [env.HTTPS_PROXY, env.https_proxy, env.HTTP_PROXY, env.http_proxy];
  for (const candidate of candidates) {
    if (candidate && candidate.trim() !== '') {
      return candidate.trim();
    }
  }
  return null;
}

/**
 * NO_PROXY（大文字・小文字）から除外ホストのリストを解釈する（純粋関数）。
 * カンマ区切り・前後空白除去。現状は setGlobalDispatcher の性質上グローバル適用のため
 * 除外ホストの実際のバイパスまでは行わず、値の有無を利用側が判断できるように返すのみ。
 *
 * @param env process.env 相当のオブジェクト
 * @returns 除外ホスト名の配列（未設定なら空配列）
 */
export function resolveNoProxyList(env: NodeJS.ProcessEnv): string[] {
  const raw = env.NO_PROXY ?? env.no_proxy;
  if (!raw || raw.trim() === '') return [];
  return raw.split(',').map((h) => h.trim()).filter((h) => h !== '');
}

let initialized = false;

/**
 * 環境変数からプロキシ設定を読み取り、設定されていれば undici の globalDispatcher に
 * ProxyAgent を登録する。サーバー起動時に一度だけ呼び出すことを想定（冪等）。
 *
 * NO_PROXY が設定されている場合は、undici ProxyAgent 自体にホスト単位の除外機構が無いため、
 * 現時点では警告ログのみ出し、全通信をプロキシ経由にする（社内プロキシ運用では通常問題にならない）。
 */
export function initProxyDispatcher(env: NodeJS.ProcessEnv = process.env): void {
  if (initialized) return;
  initialized = true;

  const proxyUrl = resolveProxyUrl(env);
  if (!proxyUrl) {
    // 未設定時は何もしない＝現行 VPS 環境の挙動を一切変えない
    return;
  }

  const noProxy = resolveNoProxyList(env);
  if (noProxy.length > 0) {
    console.log(`⚠️  NO_PROXY が設定されていますが、現在の実装ではホスト単位の除外は行われません（全通信が ${proxyUrl} 経由になります）`);
  }

  setGlobalDispatcher(new ProxyAgent(proxyUrl));
  console.log(`🌐 プロキシ経由で外向き通信します: ${proxyUrl}`);
}
