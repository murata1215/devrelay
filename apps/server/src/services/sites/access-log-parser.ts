/**
 * DevRelay Sites Phase 1-B — Caddy JSON access log 1 行のパース（純粋関数）。
 *
 * `format filter { wrap json; ... delete }` 適用後の実フォーマットを前提にする
 * （`request.headers.Cookie` 等は既に削除済み。`request.remote_ip` のみ UU 計算のため残す）。
 * 行判定は `"msg":"handled request"` の高速前置判定 → 通過分だけ `JSON.parse`。
 */

import type { ParsedAccessLine } from './sites-rules.js';

export type { ParsedAccessLine };

/** Caddy access log の header 値は `string[]` で来る（複数値対応）。先頭の 1 つだけを使う。 */
function firstHeaderValue(value: unknown): string | null {
  if (Array.isArray(value) && typeof value[0] === 'string' && value[0].length > 0) return value[0];
  if (typeof value === 'string' && value.length > 0) return value;
  return null;
}

/** `uri`（`/path?query` 形式）を path と query に分割する。 */
function splitPathQuery(uri: string): { path: string; query: string | null } {
  const idx = uri.indexOf('?');
  if (idx === -1) return { path: uri, query: null };
  return { path: uri.slice(0, idx), query: uri.slice(idx + 1) };
}

/** Caddy `ts`（epoch seconds, float 可）を ISO 8601 文字列に変換する。 */
function tsToIso(ts: unknown): string | null {
  if (typeof ts === 'number' && Number.isFinite(ts)) {
    return new Date(ts * 1000).toISOString();
  }
  if (typeof ts === 'string' && ts.length > 0) {
    const parsed = Date.parse(ts);
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
  }
  return null;
}

/**
 * Caddy JSON access log 1 行を `ParsedAccessLine` に変換する。
 * `"msg":"handled request"` を含まない行（Caddy 自身のログ等）や、パース不能・必須項目欠落は null。
 * 呼び出し側（`access-log-reader.ts`）は行単位に呼ぶ前提のため、ここでは 1 行分の同期処理のみ行う。
 */
export function parseAccessLogLine(raw: string): ParsedAccessLine | null {
  if (!raw.includes('"msg":"handled request"')) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (obj.msg !== 'handled request') return null;

  const req = (obj.request as Record<string, unknown> | undefined) ?? {};
  const host = typeof req.host === 'string' ? req.host : null;
  const uri = typeof req.uri === 'string' ? req.uri : '/';
  const status = typeof obj.status === 'number' ? obj.status : null;
  const ts = tsToIso(obj.ts);

  if (!host || status === null || !ts) return null;

  const { path, query } = splitPathQuery(uri);
  const headers = (req.headers as Record<string, unknown> | undefined) ?? {};
  const userAgent = firstHeaderValue(headers['User-Agent']);
  const referer = firstHeaderValue(headers['Referer']);
  const remoteIp = typeof req.remote_ip === 'string' ? req.remote_ip : null;
  const method = typeof req.method === 'string' ? req.method : 'GET';

  return { ts, host, method, path, query, status, userAgent, referer, remoteIp };
}
