/**
 * DevRelay Sites Phase 1-A — Caddy Admin API からの読み取り専用インベントリ抽出。
 *
 * `http://127.0.0.1:2019/config/` は認証なし・ローカルからのみ到達可能で、GET のみ使う
 * （書き込み系エンドポイントには一切触れない）。実機の JSON を確認した結果、Caddy は
 * `sites.d/*.devrelay.io {...}` のような単純な Caddyfile ブロックも、`match.host` +
 * `subroute` の入れ子（複数 path ごとに同じ upstream を繰り返す等）にコンパイルするため、
 * `extractSitesFromCaddyConfig()` は handle 配列を再帰的に歩いて情報を集約する。
 *
 * 外部 I/O（fetch）は `fetchCaddyInventory()` のみに閉じ込め、JSON からの抽出ロジック
 * （`extractSitesFromCaddyConfig`）は純粋関数としてテスト可能にする（#308 系の流儀）。
 */

import type { CaddyInventory, CaddySiteEntry, SiteKind } from './types.js';

const CADDY_ADMIN_URL = 'http://127.0.0.1:2019/config/';
const FETCH_TIMEOUT_MS = 3000;

/** handle 配列の再帰走査中に集める中間集計。 */
interface WalkAccumulator {
  upstreamDials: string[];
  roots: string[];
  hasFileServer: boolean;
}

/**
 * Caddy の `handle` 配列（`subroute` で入れ子になりうる）を再帰的に歩き、
 * reverse_proxy の upstream dial・vars.root・file_server の有無を集める。
 * 未知の handler は無視する（将来 Caddy が新しい handler を追加しても壊れないように）。
 */
function walkHandlers(handlers: unknown, acc: WalkAccumulator): void {
  if (!Array.isArray(handlers)) return;
  for (const h of handlers) {
    if (!h || typeof h !== 'object') continue;
    const handler = h as Record<string, unknown>;
    switch (handler.handler) {
      case 'reverse_proxy': {
        const upstreams = handler.upstreams;
        if (Array.isArray(upstreams)) {
          for (const u of upstreams) {
            const dial = (u as Record<string, unknown> | null)?.dial;
            if (typeof dial === 'string') acc.upstreamDials.push(dial);
          }
        }
        break;
      }
      case 'vars': {
        const root = handler.root;
        if (typeof root === 'string') acc.roots.push(root);
        break;
      }
      case 'file_server': {
        acc.hasFileServer = true;
        break;
      }
      case 'subroute': {
        const routes = handler.routes;
        if (Array.isArray(routes)) {
          for (const r of routes) {
            const route = r as Record<string, unknown> | null;
            walkHandlers(route?.handle, acc);
          }
        }
        break;
      }
      default:
        // static_response / rewrite / encode 等は Sites の観測に不要なので無視する
        break;
    }
  }
}

/** dial 文字列（'localhost:9023' / '127.0.0.1:9025' / 'unix//run/php/x.sock'）からポート番号を取り出す。 */
function extractPort(dial: string): number | null {
  if (dial.startsWith('unix/')) return null;
  const idx = dial.lastIndexOf(':');
  if (idx === -1) return null;
  const portStr = dial.slice(idx + 1);
  const port = Number(portStr);
  return Number.isInteger(port) && port > 0 ? port : null;
}

/** 集めた upstream dial の中から最頻出のものを 1 つ選ぶ（同数なら最初に現れたもの）。 */
function pickPrimaryDial(dials: string[]): string | null {
  if (dials.length === 0) return null;
  const counts = new Map<string, number>();
  for (const d of dials) counts.set(d, (counts.get(d) ?? 0) + 1);
  let best = dials[0];
  let bestCount = 0;
  for (const [dial, count] of counts) {
    if (count > bestCount) {
      best = dial;
      bestCount = count;
    }
  }
  return best;
}

/** 1 つの top-level route（match.host を持つ）を CaddySiteEntry の材料へ変換する。 */
function extractRouteInfo(route: unknown): { hosts: string[]; acc: WalkAccumulator } | null {
  if (!route || typeof route !== 'object') return null;
  const r = route as Record<string, unknown>;
  const matches = r.match;
  let hosts: string[] = [];
  if (Array.isArray(matches)) {
    for (const m of matches) {
      const h = (m as Record<string, unknown> | null)?.host;
      if (Array.isArray(h) && h.length > 0) {
        hosts = h.filter((x): x is string => typeof x === 'string');
        break;
      }
    }
  }
  if (hosts.length === 0) return null; // catch-all（host なし）は Sites の対象外
  const acc: WalkAccumulator = { upstreamDials: [], roots: [], hasFileServer: false };
  walkHandlers(r.handle, acc);
  return { hosts, acc };
}

/**
 * Caddy Admin API の `/config/` レスポンス JSON から site 一覧を抽出する（純粋関数）。
 * サーバー名は決め打ちせず、`apps.http.servers` 配下すべてを走査する
 * （実機では `srv0` の 1 つのみだが、将来複数サーバー構成になっても壊れないように）。
 */
export function extractSitesFromCaddyConfig(config: unknown): CaddySiteEntry[] {
  if (!config || typeof config !== 'object') return [];
  const cfg = config as Record<string, unknown>;
  const apps = cfg.apps as Record<string, unknown> | undefined;
  const http = apps?.http as Record<string, unknown> | undefined;
  const servers = http?.servers as Record<string, unknown> | undefined;
  if (!servers) return [];

  const result: CaddySiteEntry[] = [];

  for (const serverName of Object.keys(servers)) {
    const server = servers[serverName] as Record<string, unknown> | undefined;
    if (!server) continue;

    // handle_errors（testflight の placeholder）: errors.routes を host → root でマップ
    const errorsRootByHost = new Map<string, string>();
    const errorsRoutes = (server.errors as Record<string, unknown> | undefined)?.routes;
    if (Array.isArray(errorsRoutes)) {
      for (const route of errorsRoutes) {
        const info = extractRouteInfo(route);
        if (!info) continue;
        const root = info.acc.roots[0];
        if (root) {
          for (const host of info.hosts) errorsRootByHost.set(host, root);
        }
      }
    }

    // 専用アクセスログが付いているホスト一覧（`log { }` で明示的に named logger を持つもの）
    const logs = server.logs as Record<string, unknown> | undefined;
    const loggerNames = (logs?.logger_names as Record<string, unknown> | undefined) ?? {};
    const hostsWithNamedLogger = new Set(Object.keys(loggerNames));

    const routes = server.routes;
    if (!Array.isArray(routes)) continue;
    for (const route of routes) {
      const info = extractRouteInfo(route);
      if (!info) continue;
      const { hosts, acc } = info;
      const primaryHost = hosts[0];
      const aliases = hosts.slice(1);

      const primaryDial = pickPrimaryDial(acc.upstreamDials);
      const isUnixSocket = primaryDial?.startsWith('unix/') ?? false;

      let kind: SiteKind;
      if (isUnixSocket) kind = 'php';
      else if (primaryDial) kind = 'reverse_proxy';
      else if (acc.hasFileServer || acc.roots.length > 0) kind = 'file_server';
      else kind = 'other';

      result.push({
        host: primaryHost,
        aliases,
        kind,
        upstreamDial: primaryDial,
        upstreamPort: primaryDial ? extractPort(primaryDial) : null,
        staticRoot: acc.roots[0] ?? null,
        errorsRoot: errorsRootByHost.get(primaryHost) ?? null,
        hasAccessLog: hostsWithNamedLogger.has(primaryHost),
      });
    }
  }

  return result;
}

/**
 * Caddy Admin API から現在の設定 JSON を取得し、site 一覧を抽出する。
 * GET のみ・timeout 3s・到達不可時は `reachable:false` で縮退する（500 にしない）。
 */
export async function fetchCaddyInventory(): Promise<CaddyInventory> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    // 実機で確認済みの注意点: Node の組み込み fetch（undici）は既定で空の `Origin: ` ヘッダを
    // 送るため、Caddy Admin API の origin チェックに `client is not allowed to access from
    // origin ''` として 403 で弾かれる（`curl`/`http.get` は Origin を送らないため通る）。
    // Admin API 自身のオリジンを明示すれば通過する。
    const res = await fetch(CADDY_ADMIN_URL, {
      method: 'GET',
      signal: controller.signal,
      headers: { Origin: 'http://127.0.0.1:2019' },
    });
    if (!res.ok) {
      return { reachable: false, sites: [], error: `HTTP ${res.status}` };
    }
    const json = await res.json();
    return { reachable: true, sites: extractSitesFromCaddyConfig(json) };
  } catch (err) {
    return { reachable: false, sites: [], error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}
