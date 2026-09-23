/**
 * DevRelay Sites Phase 1-B — day bucket 集計・coverage 算出・定期スケジューラ。
 *
 * `access-log-reader.ts`（cold scan / tail）が返す `ParsedAccessLine` を受け取り、
 * host × date の day bucket（PV/UU/Referer/UTM/bot/4xx5xx）に集計する。
 * `health-checker.ts` と同じスケジューラの雛形（初期ディレイ → `setInterval` + `.unref()` +
 * module-level `started` ガード）を踏襲する。
 *
 * Phase 1-B では永続 cursor を持たない（DB 変更なし）。すべてプロセスメモリ上の状態であり、
 * 再起動時は必ず cold scan で再構築する（冪等）。
 */

import { closeState, coldScan, createInitialState, tailTick, type ReaderState } from './access-log-reader.js';
import type { ParsedAccessLine } from './access-log-parser.js';
import { hasSkipRules } from './site-log-rules.js';
import { classifyReferer, daysSince, extractUtm, hashUu, isBotUserAgent, isOwnHealthCheck, isPageView, SITES_TIME_ZONE, toDateKey } from './sites-rules.js';
import { getOrCreateUuSecret } from './uu-secret.js';
import type { DailyPv, SiteStats, StatsCountEntry, StatsCoverage } from './types.js';

const ACCESS_LOG_DIR = '/var/log/caddy/sites';
const CURRENT_FILE_NAME = 'sites.access.log';
const WINDOW_DAYS = 30;
const TICK_INTERVAL_MS = 30_000;
const INITIAL_DELAY_MS = 15_000;
const DEFAULT_BYTE_BUDGET = 1.5 * 1024 * 1024 * 1024; // 1.5 GiB（展開後バイト。修正1・修正2に定める既定値）
/** `topPaths` / `referers` / `utm.*` の集計カーディナリティ上限（超過分は `(other)` に畳む）。 */
export const CARDINALITY_LIMIT = 5000;
/** UU（ユニークユーザー）Set の host × 日ごとの上限（超過時は `uuTruncated: true`）。 */
export const UU_SET_LIMIT = 200_000;
const CACHE_TTL_MS = 60_000;
const TOP_N_RETURNED = 20;

/** `SITES_LOG_SCAN_BYTES_MAX` 環境変数（未指定・不正値は既定 1.5GiB）。 */
function getByteBudget(): number {
  const raw = process.env.SITES_LOG_SCAN_BYTES_MAX;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_BYTE_BUDGET;
}

/** `DEVRELAY_SITES_ACCESS_LOG` 環境変数を解釈する（既定 ON。'0' が明示されたときのみ無効）。 */
export function isAccessLogAggregatorEnabled(raw: string | undefined): boolean {
  return raw !== '0';
}

export interface DayBucket {
  pv: number;
  uu: Set<string>;
  uuTruncated: boolean;
  status4xx: number;
  status5xx: number;
  paths: Map<string, number>;
  referers: Map<string, number>;
  utmSource: Map<string, number>;
  utmMedium: Map<string, number>;
  utmCampaign: Map<string, number>;
  botCount: number;
  totalCount: number;
}

function newDayBucket(): DayBucket {
  return {
    pv: 0,
    uu: new Set(),
    uuTruncated: false,
    status4xx: 0,
    status5xx: 0,
    paths: new Map(),
    referers: new Map(),
    utmSource: new Map(),
    utmMedium: new Map(),
    utmCampaign: new Map(),
    botCount: 0,
    totalCount: 0,
  };
}

/** カーディナリティ上限付きで加算する（上限超過分は `(other)` に畳む）。 */
function addCapped(map: Map<string, number>, key: string, limit: number): void {
  if (map.has(key)) {
    map.set(key, (map.get(key) ?? 0) + 1);
    return;
  }
  if (map.size >= limit) {
    map.set('(other)', (map.get('(other)') ?? 0) + 1);
    return;
  }
  map.set(key, 1);
}

/**
 * date key（`toDateKey()` が返す JST 基準ラベル）に暦日を加減する。
 * ラベル文字列同士の暦日シフトであり UTC 正午基準で計算するだけなので、
 * 基準タイムゾーンが JST でもロジック変更は不要（`daysSince()` と同じ理由）。
 */
function shiftDate(date: string, deltaDays: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// module state（永続化しない。プロセスメモリ上のみ）
// ---------------------------------------------------------------------------

let readerState: ReaderState = createInitialState();
/** host → date('YYYY-MM-DD') → DayBucket。 */
let buckets = new Map<string, Map<string, DayBucket>>();
let coverage: StatsCoverage = {
  requestedDays: 30,
  oldestCoveredDate: null,
  coveredDays: 0,
  complete: false,
  truncated: false,
  truncatedReason: null,
  measuredSince: null,
  timeZone: SITES_TIME_ZONE,
};
/**
 * B2-0 修正1: cold scan / tail（self-heal 含む）で観測した最古日の単一 source of truth。
 * self-heal で初めて行が入った場合でも、この値の変化を tick 後にチェックして
 * `coverage.measuredSince` 等を追従させる（`rebuild()` では cold scan 前に必ず null へリセットする）。
 */
let observedOldestDate: string | null = null;
let uuSecret: string | null = null;
let ready = false;
let started = false;
const computedCache = new Map<string, { expiresAt: number; value: SiteStats }>();

/**
 * 1 行分を該当 host × date の day bucket に反映する（純粋関数。渡された `targetBuckets` を変更する）。
 * DevRelay 自身のヘルスチェックは完全除外。`uuSecret` が null なら UU は集計しない（PV 等は継続）。
 * module state（`buckets`）と単体テスト用の一時 Map の両方から呼べるよう、対象 Map を引数で受け取る。
 */
export function applyLineToBuckets(targetBuckets: Map<string, Map<string, DayBucket>>, parsed: ParsedAccessLine, uuSecretForLine: string | null): void {
  if (isOwnHealthCheck(parsed.userAgent)) return;

  const date = toDateKey(parsed.ts);
  let hostBuckets = targetBuckets.get(parsed.host);
  if (!hostBuckets) {
    hostBuckets = new Map();
    targetBuckets.set(parsed.host, hostBuckets);
  }
  let bucket = hostBuckets.get(date);
  if (!bucket) {
    bucket = newDayBucket();
    hostBuckets.set(date, bucket);
  }

  const bot = isBotUserAgent(parsed.userAgent);
  bucket.totalCount += 1;
  if (bot) bucket.botCount += 1;

  if (parsed.status >= 400 && parsed.status < 500) bucket.status4xx += 1;
  else if (parsed.status >= 500) bucket.status5xx += 1;

  if (bot || !isPageView(parsed.method, parsed.path, parsed.status)) return;

  bucket.pv += 1;
  addCapped(bucket.paths, parsed.path, CARDINALITY_LIMIT);
  addCapped(bucket.referers, classifyReferer(parsed.referer, parsed.host), CARDINALITY_LIMIT);
  const utm = extractUtm(parsed.query);
  if (utm.source) addCapped(bucket.utmSource, utm.source, CARDINALITY_LIMIT);
  if (utm.medium) addCapped(bucket.utmMedium, utm.medium, CARDINALITY_LIMIT);
  if (utm.campaign) addCapped(bucket.utmCampaign, utm.campaign, CARDINALITY_LIMIT);

  if (uuSecretForLine && parsed.remoteIp) {
    if (bucket.uu.size < UU_SET_LIMIT) {
      bucket.uu.add(hashUu(uuSecretForLine, date, parsed.host, parsed.remoteIp));
    } else {
      bucket.uuTruncated = true;
    }
  }
}

/**
 * module state（`buckets`）向けの薄いラッパー。cold scan / tail からはこちらを使う。
 * B2-0 修正1: `observedOldestDate`（cold scan / tail 共通の単一 source of truth）も同時に更新する。
 */
function handleLine(parsed: ParsedAccessLine): void {
  applyLineToBuckets(buckets, parsed, uuSecret);
  const date = toDateKey(parsed.ts);
  if (observedOldestDate === null || date < observedOldestDate) observedOldestDate = date;
}

// ---------------------------------------------------------------------------
// coverage / cold scan / tail
// ---------------------------------------------------------------------------

/** cold scan / rebuild を実行し、module state を再構築する。 */
async function rebuild(): Promise<void> {
  await closeState(readerState);
  buckets = new Map();
  computedCache.clear();
  // cold scan の結果と一致させるため、cold scan 前に必ずリセットする（`outcome.oldestDateSeen` と同じ値になる）。
  observedOldestDate = null;

  const secretResult = await getOrCreateUuSecret();
  uuSecret = secretResult.ok ? secretResult.secret : null;

  const today = toDateKey(new Date().toISOString());
  const { state, outcome } = await coldScan(ACCESS_LOG_DIR, CURRENT_FILE_NAME, (parsed) => handleLine(parsed), {
    windowDays: WINDOW_DAYS,
    byteBudget: getByteBudget(),
    today,
  });
  readerState = state;

  const coveredDays = outcome.oldestDateSeen ? daysSince(outcome.oldestDateSeen, today) + 1 : 0;
  coverage = {
    requestedDays: 30,
    oldestCoveredDate: outcome.oldestDateSeen,
    coveredDays,
    complete: coveredDays >= WINDOW_DAYS && !outcome.truncated,
    truncated: outcome.truncated,
    truncatedReason: outcome.truncatedReason,
    measuredSince: outcome.oldestDateSeen,
    timeZone: SITES_TIME_ZONE,
  };
  ready = true;
}

/**
 * `observedOldestDate`（cold scan / tail で観測した最古日）の変化を `coverage` に反映する（純粋関数）。
 * B2-0 修正1: self-heal で初めて行が入った直後（`measuredSince` が null のまま）に呼ぶことで、
 * `computeStatsFromBuckets()` が `last30d.daily` を全 null にしてしまう不整合を防ぐ。
 * `truncated` / `truncatedReason` はここでは変更しない（gap 検出等の既存判定を保持する）。
 * `observedOldestDate` が null、または既存の `measuredSince` と同じ場合は同じ参照をそのまま返す
 * （単体テストから module state を介さず直接呼べるよう、`coverage` を引数で受け取る）。
 */
export function syncCoverageWithObservedOldestDate(coverageInput: StatsCoverage, observedOldestDateInput: string | null, today: string): StatsCoverage {
  if (observedOldestDateInput === null || observedOldestDateInput === coverageInput.measuredSince) return coverageInput;
  const coveredDays = daysSince(observedOldestDateInput, today) + 1;
  return {
    ...coverageInput,
    oldestCoveredDate: observedOldestDateInput,
    coveredDays,
    complete: coveredDays >= WINDOW_DAYS && !coverageInput.truncated,
    measuredSince: observedOldestDateInput,
  };
}

/** 30 秒 tick。gap 検出時は即座にフル cold rebuild する。 */
async function tick(): Promise<void> {
  const outcome = await tailTick(ACCESS_LOG_DIR, CURRENT_FILE_NAME, readerState, (parsed) => handleLine(parsed));
  computedCache.clear();
  if (outcome.gapDetected) {
    await rebuild();
    return;
  }
  if (readerState.gapDetected && coverage.truncatedReason !== 'gap_detected') {
    coverage = { ...coverage, truncated: true, truncatedReason: 'gap_detected' };
  }
  coverage = syncCoverageWithObservedOldestDate(coverage, observedOldestDate, toDateKey(new Date().toISOString()));
}

/**
 * 定期集計を開始する（起動 15s 後 → 以後 30s 周期の tail tick。初回は cold scan）。
 * `DEVRELAY_SITES_ACCESS_LOG=0` のときは何もしない（stats は常に null に縮退）。
 */
export function startAccessLogAggregator(): void {
  if (started) return;
  if (!isAccessLogAggregatorEnabled(process.env.DEVRELAY_SITES_ACCESS_LOG)) {
    console.log('⏸️  DevRelay Sites: access log aggregator disabled (DEVRELAY_SITES_ACCESS_LOG=0)');
    return;
  }
  started = true;
  const initialTimer = setTimeout(() => {
    void rebuild().then(() => {
      const interval = setInterval(() => void tick(), TICK_INTERVAL_MS);
      interval.unref();
    });
  }, INITIAL_DELAY_MS);
  initialTimer.unref();
  console.log('📊 DevRelay Sites: access log aggregator started');
}

/** 初回 cold scan が完了したか（false の間、`/api/sites` は全 site `stats: null` を返す）。 */
export function isStatsReady(): boolean {
  return ready;
}

// ---------------------------------------------------------------------------
// 集計結果の組み立て
// ---------------------------------------------------------------------------

function sumPvWindow(hostBuckets: Map<string, DayBucket>, today: string, days: number): number {
  let total = 0;
  for (let i = 0; i < days; i++) {
    total += hostBuckets.get(shiftDate(today, -i))?.pv ?? 0;
  }
  return total;
}

function mergeCounts(hostBuckets: Map<string, DayBucket>, today: string, days: number, pick: (b: DayBucket) => Map<string, number>): Map<string, number> {
  const merged = new Map<string, number>();
  for (let i = 0; i < days; i++) {
    const bucket = hostBuckets.get(shiftDate(today, -i));
    if (!bucket) continue;
    for (const [k, v] of pick(bucket)) merged.set(k, (merged.get(k) ?? 0) + v);
  }
  return merged;
}

function topEntries(map: Map<string, number>, limit = TOP_N_RETURNED): StatsCountEntry[] {
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }));
}

/**
 * 指定 host の `SiteStats` を組み立てる（純粋計算。I/O なし。`coverage`/`uuSecretForHost` を
 * 引数で受け取ることで、module state（`buckets`/`coverage`/`uuSecret`）と単体テストの両方から
 * 同じロジックを再利用できる）。
 */
export function computeStatsFromBuckets(
  hostBucketsInput: Map<string, DayBucket> | undefined,
  host: string,
  today: string,
  coverageForHost: StatsCoverage,
  uuSecretForHost: string | null
): SiteStats {
  const hostBuckets = hostBucketsInput ?? new Map<string, DayBucket>();
  const todayBucket = hostBuckets.get(today);

  const daily: DailyPv[] = [];
  for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
    const date = shiftDate(today, -i);
    const measured = coverageForHost.measuredSince !== null && date >= coverageForHost.measuredSince;
    daily.push({ date, count: measured ? hostBuckets.get(date)?.pv ?? 0 : null });
  }
  const last30dPv = daily.reduce((acc, d) => acc + (d.count ?? 0), 0);

  const pathsMerged = mergeCounts(hostBuckets, today, WINDOW_DAYS, (b) => b.paths);
  const referersMerged = mergeCounts(hostBuckets, today, WINDOW_DAYS, (b) => b.referers);
  const utmSourceMerged = mergeCounts(hostBuckets, today, WINDOW_DAYS, (b) => b.utmSource);
  const utmMediumMerged = mergeCounts(hostBuckets, today, WINDOW_DAYS, (b) => b.utmMedium);
  const utmCampaignMerged = mergeCounts(hostBuckets, today, WINDOW_DAYS, (b) => b.utmCampaign);
  const detailTruncated =
    pathsMerged.has('(other)') || referersMerged.has('(other)') || utmSourceMerged.has('(other)') || utmMediumMerged.has('(other)') || utmCampaignMerged.has('(other)');

  let totalCount = 0;
  let botCount = 0;
  let status4xx = 0;
  let status5xx = 0;
  for (let i = 0; i < WINDOW_DAYS; i++) {
    const bucket = hostBuckets.get(shiftDate(today, -i));
    if (!bucket) continue;
    totalCount += bucket.totalCount;
    botCount += bucket.botCount;
    status4xx += bucket.status4xx;
    status5xx += bucket.status5xx;
  }

  return {
    today: {
      pv: todayBucket?.pv ?? 0,
      uu: uuSecretForHost ? todayBucket?.uu.size ?? 0 : null,
      uuTruncated: todayBucket?.uuTruncated ?? false,
    },
    last7d: { pv: sumPvWindow(hostBuckets, today, 7) },
    last30d: { pv: last30dPv, daily },
    topPaths: topEntries(pathsMerged),
    referers: topEntries(referersMerged),
    utm: {
      source: topEntries(utmSourceMerged),
      medium: topEntries(utmMediumMerged),
      campaign: topEntries(utmCampaignMerged),
    },
    botRatio: totalCount > 0 ? botCount / totalCount : null,
    status4xx,
    status5xx,
    detailTruncated,
    coverage: coverageForHost,
    excludedByRules: hasSkipRules(host),
  };
}

/** module state（`buckets`/`coverage`/`uuSecret`）向けの薄いラッパー。 */
function computeStats(host: string, today: string): SiteStats {
  return computeStatsFromBuckets(buckets.get(host), host, today, coverage, uuSecret);
}

/**
 * 指定 host の `SiteStats` を返す（60 秒キャッシュ）。
 * 集計未完了（`isStatsReady() === false`）、またはこの host のログを 1 行も観測していない
 * 場合は null（＝ B1 のように access log 自体が未導入の環境では常に null に縮退する）。
 */
export function getSiteStats(host: string): SiteStats | null {
  if (!ready) return null;
  if (!buckets.has(host)) return null;

  const now = Date.now();
  const cached = computedCache.get(host);
  if (cached && cached.expiresAt > now) return cached.value;

  const today = toDateKey(new Date().toISOString());
  const stats = computeStats(host, today);
  computedCache.set(host, { expiresAt: now + CACHE_TTL_MS, value: stats });
  return stats;
}

/** 指定 host 一覧について `getSiteStats()` をまとめて呼び、非 null のものだけの Map を返す（`site-resolver.ts` の `statsByHost` 用）。 */
export function getSiteStatsMap(hosts: string[]): Map<string, SiteStats> {
  const map = new Map<string, SiteStats>();
  for (const host of hosts) {
    const stats = getSiteStats(host);
    if (stats) map.set(host, stats);
  }
  return map;
}
