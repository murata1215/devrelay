// =============================================================================
// プロキシのバイパス判定（NO_PROXY 相当）
// =============================================================================
// 背景: Agent の `config.yaml` に `proxy.url` を書くと、AI CLI の外向き通信だけでなく
// **DevRelay Server への WebSocket 接続もプロキシ経由になる**
// （`connection.ts` が `HttpsProxyAgent` を WS の agent に設定する）。
//
// 社内に DevRelay Server を立て、AI API だけ社内プロキシ経由で外に出す構成では、
// これが致命的になる。社内プロキシは社内アドレスへ到達できないのが通常のため、
// プロキシを設定した途端に Agent がサーバーに接続できなくなる
// （実測: 社内プロキシ経由で社内サーバーへ接続不可 / 直結で 200）。
//
// 対応: `proxy.noProxy` に curl / 各種ランタイムと同じ `NO_PROXY` 記法でバイパス対象を
// 書けるようにする。サーバー接続はこれを見て直結を選び、AI CLI には `NO_PROXY`
// 環境変数として引き渡す。
//
// 記法（curl 互換）:
//   - カンマまたは空白区切り
//   - `*` は全バイパス
//   - `example.com`   → `example.com` と `*.example.com` に一致（ドメインサフィックス）
//   - `.example.com`  → 上と同義（先頭ドットは明示表記）
//   - `host:8080`     → ポートも一致する場合のみバイパス
//   - IPv6 でポートを指定する場合は `[::1]:3000` と角括弧で囲む
//     （`::1` のように角括弧が無ければホスト全体として扱う）
//   - 大文字小文字は区別しない
//
// 注: このパッケージの tsconfig は `lib: ["ES2022"]` で DOM を含まないため、
//     `URL` は型として参照できない（`token.ts` が btoa/atob を手動宣言しているのと同じ事情）。
//     ホストとポートの取り出しは文字列処理で行う。
// =============================================================================

/** スキームごとの既定ポート。URL にポートが無い場合の比較に使う。 */
const DEFAULT_PORTS: Record<string, string> = {
  ws: '80',
  http: '80',
  wss: '443',
  https: '443',
};

/** ホストとポートの組。ポートが判明しない場合は null。 */
interface HostPort {
  host: string;
  port: string | null;
}

/**
 * `host[:port]` 形式の文字列（authority 部）を分解する。
 *
 * IPv6 リテラルは角括弧で囲まれている場合のみポートを分離する。角括弧が無く
 * コロンを 2 つ以上含む場合は IPv6 アドレスそのものとみなす（`::1` など）。
 */
function splitHostPort(authority: string): HostPort {
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(authority);
  if (bracketed) {
    return { host: bracketed[1].toLowerCase(), port: bracketed[2] ?? null };
  }
  const first = authority.indexOf(':');
  const last = authority.lastIndexOf(':');
  // コロンが 2 つ以上 → 角括弧なしの IPv6 リテラルとして扱う（ポート分離しない）
  if (first !== last) {
    return { host: authority.toLowerCase(), port: null };
  }
  if (last > 0 && /^\d+$/.test(authority.slice(last + 1))) {
    return { host: authority.slice(0, last).toLowerCase(), port: authority.slice(last + 1) };
  }
  return { host: authority.toLowerCase(), port: null };
}

/**
 * 接続先（URL または `host[:port]`）からホストとポートを取り出す。
 *
 * @param target `wss://host:443/path` のような URL、または `host:3000` / `host`
 */
function parseTarget(target: string): HostPort {
  const trimmed = target.trim();
  if (!trimmed) return { host: '', port: null };

  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(trimmed);
  if (!schemeMatch) {
    return splitHostPort(trimmed);
  }

  const scheme = schemeMatch[1].toLowerCase();
  // authority はパス・クエリ・フラグメントの手前まで
  const afterScheme = schemeMatch[2];
  const endIdx = afterScheme.search(/[/?#]/);
  let authority = endIdx === -1 ? afterScheme : afterScheme.slice(0, endIdx);
  // userinfo（user:pass@）を落とす
  const atIdx = authority.lastIndexOf('@');
  if (atIdx !== -1) authority = authority.slice(atIdx + 1);

  const { host, port } = splitHostPort(authority);
  return { host, port: port ?? DEFAULT_PORTS[scheme] ?? null };
}

/**
 * `noProxy` 設定を正規化した配列にする。
 *
 * 配列・カンマ/空白区切り文字列のどちらも受け付け、空要素と前後空白を落として小文字化する。
 *
 * @param noProxy 配列またはカンマ/空白区切り文字列
 * @returns 正規化済みのエントリ配列
 */
export function normalizeNoProxy(noProxy?: string[] | string | null): string[] {
  if (!noProxy) return [];
  const raw = Array.isArray(noProxy) ? noProxy : noProxy.split(/[,\s]+/);
  return raw.map((e) => e.trim().toLowerCase()).filter((e) => e.length > 0);
}

/**
 * 接続先がプロキシをバイパスすべきかを判定する（純粋関数）。
 *
 * @param target 接続先の URL または `host[:port]`
 * @param noProxy `NO_PROXY` 記法の設定（配列または文字列）
 * @returns バイパスすべきなら true
 */
export function shouldBypassProxy(target: string, noProxy?: string[] | string | null): boolean {
  const entries = normalizeNoProxy(noProxy);
  if (entries.length === 0) return false;
  if (entries.includes('*')) return true;

  const { host, port } = parseTarget(target);
  if (!host) return false;

  return entries.some((entry) => {
    const { host: pattern, port: entryPort } = splitHostPort(entry);
    if (entryPort !== null && entryPort !== port) return false;

    // 先頭ドットは「ドメインサフィックス」の明示表記。ドット無しでも同義に扱う（curl と同じ）
    const bare = pattern.startsWith('.') ? pattern.slice(1) : pattern;
    if (!bare) return false;
    return host === bare || host.endsWith(`.${bare}`);
  });
}

/**
 * 子プロセス（AI CLI 等）に渡す `NO_PROXY` 環境変数の値を組み立てる。
 *
 * @param noProxy `NO_PROXY` 記法の設定
 * @returns カンマ区切り文字列。設定が無ければ空文字
 */
export function toNoProxyEnvValue(noProxy?: string[] | string | null): string {
  return normalizeNoProxy(noProxy).join(',');
}
