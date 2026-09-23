/**
 * DevRelay Sites Phase 1-B — アクセス解析の判定ロジック（純粋関数のみ）。
 *
 * bot UA 判定 / page view 判定 / Referer・UTM 抽出 / UU ハッシュ / window（today/7d/30d）判定。
 * 外部 I/O ゼロ。ログ行のパース結果（`ParsedAccessLine`）を入力に取り、
 * 集計方針（何を PV とみなすか等）だけをここに集約する（`access-aggregator.ts` から呼ばれる）。
 */

import { createHash } from 'crypto';
import { HEALTH_CHECK_UA } from './site-log-rules.js';

/** Caddy JSON access log 1 行をパースした結果（`access-log-reader.ts` が生成）。 */
export interface ParsedAccessLine {
  /** ISO 8601（例 '2026-09-22T10:00:00.000Z'） */
  ts: string;
  host: string;
  method: string;
  /** query を含まない path */
  path: string;
  query: string | null;
  status: number;
  userAgent: string | null;
  referer: string | null;
  remoteIp: string | null;
}

// ---------------------------------------------------------------------------
// bot 判定
// ---------------------------------------------------------------------------

/**
 * DevRelay 自身のヘルスチェック UA。完全除外の対象。
 * 単一の真実は `site-log-rules.ts` の `HEALTH_CHECK_UA`（`health-checker.ts` の UA・
 * Caddy `log_skip` matcher の 3 箇所が同一値であることをテストで固定する。pre-W2 修正 F）。
 */
export const OWN_HEALTH_CHECK_UA = HEALTH_CHECK_UA;

const BOT_UA_PATTERNS: RegExp[] = [
  /bot/i,
  /spider/i,
  /crawl/i,
  /slurp/i,
  /facebookexternalhit/i,
  /mediapartners-google/i,
  /googlebot/i,
  /bingbot/i,
  /ahrefs/i,
  /semrush/i,
  /uptimerobot/i,
  /pingdom/i,
  /monitor/i,
  /headlesschrome/i,
  /curl\//i,
  /wget\//i,
  /python-requests/i,
  /go-http-client/i,
  /okhttp/i,
];

/**
 * User-Agent が bot 相当かどうかを判定する。
 * UA が空文字/null（=なし）は bot 扱いとする（正規のブラウザは必ず UA を送る）。
 */
export function isBotUserAgent(userAgent: string | null): boolean {
  if (!userAgent || userAgent.trim().length === 0) return true;
  return BOT_UA_PATTERNS.some((re) => re.test(userAgent));
}

/** DevRelay 自身のヘルスチェック request かどうか（PV/UU/bot 比率いずれからも完全除外する）。 */
export function isOwnHealthCheck(userAgent: string | null): boolean {
  return userAgent === OWN_HEALTH_CHECK_UA;
}

// ---------------------------------------------------------------------------
// page view 判定
// ---------------------------------------------------------------------------

const NON_PAGE_VIEW_PATH_PATTERNS: RegExp[] = [/^\/api(\/|$)/, /^\/assets(\/|$)/, /^\/favicon\.ico$/, /^\/health$/];

/**
 * 1 request が「PV（page view）」として計上すべきものかどうかを判定する。
 * GET 以外・`/api/*`・`/assets/*`・`/favicon.ico`・`/health` は PV に数えない。
 * B2-0 修正2: `status` が 200/304 以外（404 等）も PV に数えない
 * （計測値が歪むため。4xx/5xx カウンタは呼び出し側で PV 判定と独立に加算する）。
 * bot / DevRelay 自身のヘルスチェックは呼び出し側（aggregator）で先に弾く前提（このシグネチャには含めない）。
 */
export function isPageView(method: string, path: string, status: number): boolean {
  if (method !== 'GET') return false;
  if (status !== 200 && status !== 304) return false;
  return !NON_PAGE_VIEW_PATH_PATTERNS.some((re) => re.test(path));
}

// ---------------------------------------------------------------------------
// UTM 抽出
// ---------------------------------------------------------------------------

export interface UtmParams {
  source: string | null;
  medium: string | null;
  campaign: string | null;
}

/** query 文字列（先頭 `?` の有無どちらでも可、null 可）から UTM パラメータを抽出する。 */
export function extractUtm(query: string | null): UtmParams {
  if (!query) return { source: null, medium: null, campaign: null };
  const normalized = query.startsWith('?') ? query.slice(1) : query;
  const params = new URLSearchParams(normalized);
  return {
    source: params.get('utm_source'),
    medium: params.get('utm_medium'),
    campaign: params.get('utm_campaign'),
  };
}

// ---------------------------------------------------------------------------
// Referer 分類
// ---------------------------------------------------------------------------

/**
 * Referer ヘッダを hostname 単位に正規化する。
 * 空・パース不能・自ホスト（`ownHost` と一致）は 'direct' として扱う。
 */
export function classifyReferer(referer: string | null, ownHost: string): string {
  if (!referer) return 'direct';
  let url: URL;
  try {
    url = new URL(referer);
  } catch {
    return 'direct';
  }
  if (url.hostname === ownHost) return 'direct';
  return url.hostname;
}

// ---------------------------------------------------------------------------
// UU ハッシュ（決定3・修正3: host を含めることで site 間の合算を構造的に不可能にする）
// ---------------------------------------------------------------------------

/**
 * UU（ユニークユーザー）判定用のハッシュを計算する。
 * `sha256(secret + '|' + date + '|' + host + '|' + ip)` の先頭 16 hex。
 * **host を含めるのは意図的**: site をまたいで同一ハッシュになることがなく、
 * 「global UU」を合算しようとしても構造的に一致しない（修正3 の実装レベルの保証）。
 */
export function hashUu(secret: string, date: string, host: string, ip: string): string {
  return createHash('sha256').update(`${secret}|${date}|${host}|${ip}`).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// window 判定（today / 7d / 30d）
// ---------------------------------------------------------------------------

/**
 * DevRelay Sites の day bucket 集計基準タイムゾーン。
 * B2-0 修正3: UI 表記が「今日 PV / Today UU」である以上、0:00 JST で切り替わるべきという人間指示による。
 */
export const SITES_TIME_ZONE = 'Asia/Tokyo' as const;

/** 'YYYY-MM-DD' 形式（10 文字・日付のみ）かどうか。 */
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * ISO ts（または 'YYYY-MM-DD'）から `SITES_TIME_ZONE`（Asia/Tokyo）基準の 'YYYY-MM-DD' を取り出す。
 *
 * 実装は固定オフセット方式（`+9h` してから UTC の日付部分を取る）。
 * 日本標準時は DST が無く恒久的に UTC+9 のため、この方式は常に正しく、
 * かつサーバー OS の TZ 設定に一切依存しない（Node 標準 API のみで完結）。
 *
 * - 入力が既に 'YYYY-MM-DD'（10 文字・日付のみ）の場合はそのまま返す（date key の再正規化を壊さない）。
 * - パース不能な入力は従来どおり `slice(0, 10)` にフォールバックする。
 */
export function toDateKey(ts: string): string {
  if (DATE_ONLY_PATTERN.test(ts)) return ts;
  const parsed = Date.parse(ts);
  if (Number.isNaN(parsed)) return ts.slice(0, 10);
  return new Date(parsed + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * 'YYYY-MM-DD' 同士の日数差（date - today、todayより未来なら負値）。閏年・月境界は Date 経由で正しく計算する。
 * 引数はどちらも `toDateKey()` が返す date key（= JST 基準の日付ラベル）を想定する。
 * ラベル同士の暦日差を UTC 正午基準で計算するだけなので、基準タイムゾーンが JST でもロジック変更は不要。
 */
export function daysSince(date: string, today: string): number {
  const a = Date.parse(`${date}T00:00:00.000Z`);
  const b = Date.parse(`${today}T00:00:00.000Z`);
  return Math.round((b - a) / 86_400_000);
}

/** 指定日付が `today` を基準にした直近 `windowDays` 日以内（today を含む）かどうか。 */
export function isWithinWindow(date: string, today: string, windowDays: number): boolean {
  const diff = daysSince(date, today);
  return diff >= 0 && diff < windowDays;
}
