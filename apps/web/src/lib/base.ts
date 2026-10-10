/**
 * サブパス配信に対応するための URL 基点ユーティリティ。
 *
 * `apps/web` はルート（`/`）配信を前提に `'/api/...'` のようなホストルート絶対パスを
 * 直接埋め込んでいたため、`https://example.com/foo/devrelay/` のようなサブパスに
 * 置くと API・WebSocket・静的アセットのすべてが配信元の外（ホストのルート）を
 * 指してしまい動作しなかった。ここを唯一の基点にまとめることで、ビルド時の
 * `base` 設定だけでルート配信／サブパス配信を切り替えられるようにする。
 *
 * `import.meta.env.BASE_URL` は Vite が `vite.config.ts` の `base` から埋め込む値で、
 * 必ず末尾に `/` が付く。既定は `'/'` なので、**ルート配信時は従来と完全に同じ
 * 文字列**になり既存環境の挙動は一切変わらない。
 *
 * サブパスで配信する場合はビルド時に `DEVRELAY_WEB_BASE` を与える:
 *
 * ```sh
 * DEVRELAY_WEB_BASE=/foo/devrelay/ pnpm --filter web build
 * ```
 */

/**
 * `base` を前置した絶対パスを返す。
 *
 * `path` は `/` 始まり・無しのどちらでも可（重複スラッシュは潰す）。
 * `BASE_URL` が末尾 `/` を持つ前提で連結するため、戻り値は常に `/` 始まりになる。
 */
export function withBase(path = ''): string {
  return import.meta.env.BASE_URL + path.replace(/^\/+/, '');
}

/**
 * API エンドポイントの URL を返す。
 *
 * `path` はリソース部分のみを `/machines` のように渡す（`/api` は含めない）。
 * 引数なしなら API のベース（`<base>api`）を返す。
 */
export function apiUrl(path = ''): string {
  return withBase(`api${path}`);
}

/**
 * WebSocket の接続先 URL を返す。
 *
 * `path` は `/ws/web` のようにパス部分を渡す。スキームは現在のページが
 * HTTPS なら `wss:`、そうでなければ `ws:` を選ぶ（リバースプロキシで TLS を
 * 終端している構成でも、ブラウザから見たスキームが基準で正しい）。
 */
export function wsUrl(path: string): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}${withBase(path)}`;
}
