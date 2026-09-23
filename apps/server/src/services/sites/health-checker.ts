/**
 * DevRelay Sites Phase 1-A — 公開サイトへの HTTP ヘルスチェック（読み取り専用）。
 *
 * 60 秒周期・並列 5・timeout 5s で `GET https://<host>/` を叩き、結果をメモリ上の
 * Map に保持するだけ（永続化しない。プロセス再起動で消える＝Phase 1-A では許容）。
 * `DEVRELAY_SITES_HEALTH=0` で無効化できる（既定 ON）。
 */

import { fetchCaddyInventory } from './caddy-inventory.js';
import { HEALTH_CHECK_UA } from './site-log-rules.js';
import type { HealthResult, HealthState } from './types.js';

const HEALTH_TIMEOUT_MS = 5000;
const HEALTH_INTERVAL_MS = 60_000;
const HEALTH_INITIAL_DELAY_MS = 10_000;
const CONCURRENCY = 5;
// 単一の真実は site-log-rules.ts（Caddy log_skip の UA 完全一致 matcher と同一値であることを
// テストで固定する。pre-W2 修正 F）。
const USER_AGENT = HEALTH_CHECK_UA;

const healthMap = new Map<string, HealthResult>();
let started = false;

/** `DEVRELAY_SITES_HEALTH` 環境変数を解釈する。既定 ON（'0' が明示されたときのみ無効。#340 と同じ流儀）。 */
export function isSitesHealthEnabled(raw: string | undefined): boolean {
  return raw !== '0';
}

/** HTTP status / error からヘルス状態を判定する（純粋関数）。 */
export function classifyHealth(status: number | null, error: string | null): HealthState {
  if (error) return 'down';
  if (status === null) return 'unknown';
  if (status >= 200 && status < 400) return 'up';
  if (status === 401 || status === 403) return 'up';
  if (status === 404) return 'degraded';
  if (status >= 500) return status >= 502 && status <= 504 ? 'down' : 'degraded';
  return 'degraded';
}

/** 指定ホストに 1 回だけヘルスチェックを行う。 */
async function checkHostOnce(host: string): Promise<HealthResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const res = await fetch(`https://${host}/`, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT },
    });
    const latencyMs = Date.now() - startedAt;
    // レスポンスボディは読み捨てる（health 判定に本文は不要）
    void res.body?.cancel?.();
    return {
      state: classifyHealth(res.status, null),
      httpStatus: res.status,
      latencyMs,
      checkedAt: new Date().toISOString(),
      error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      state: classifyHealth(null, message),
      httpStatus: null,
      latencyMs: Date.now() - startedAt,
      checkedAt: new Date().toISOString(),
      error: message,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 配列を固定サイズのチャンクに分割する小ヘルパー。 */
function chunk<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) result.push(arr.slice(i, i + size));
  return result;
}

/** 現在 Caddy が公開している全ホストに対して並列度 5 でヘルスチェックを実行し、Map を更新する。 */
export async function runHealthCheckSweep(): Promise<void> {
  const inventory = await fetchCaddyInventory();
  if (!inventory.reachable) return;
  const hosts = inventory.sites.map((s) => s.host);
  for (const batch of chunk(hosts, CONCURRENCY)) {
    const results = await Promise.all(batch.map((host) => checkHostOnce(host)));
    batch.forEach((host, i) => healthMap.set(host, results[i]));
  }
}

/** 指定ホストのみ即座にヘルスチェックし、Map を更新して結果を返す（`POST /api/sites/:host/health-check` 用）。 */
export async function checkNow(host: string): Promise<HealthResult> {
  const result = await checkHostOnce(host);
  healthMap.set(host, result);
  return result;
}

/** 現在のヘルス結果のスナップショットを返す（呼び出し側で変更してもキャッシュに影響しないようコピーを返す）。 */
export function getHealthResult(): Map<string, HealthResult> {
  return new Map(healthMap);
}

/**
 * 定期ヘルスチェックを開始する（起動 10s 後 → 以後 60s 周期）。
 * `DEVRELAY_SITES_HEALTH=0` のときは何もしない。二重起動防止のため 1 プロセスにつき 1 回のみ有効。
 */
export function startSiteHealthChecker(): void {
  if (started) return;
  if (!isSitesHealthEnabled(process.env.DEVRELAY_SITES_HEALTH)) {
    console.log('⏸️  DevRelay Sites: health checker disabled (DEVRELAY_SITES_HEALTH=0)');
    return;
  }
  started = true;
  const initialTimer = setTimeout(() => {
    void runHealthCheckSweep();
    const interval = setInterval(() => void runHealthCheckSweep(), HEALTH_INTERVAL_MS);
    interval.unref();
  }, HEALTH_INITIAL_DELAY_MS);
  initialTimer.unref();
  console.log('🩺 DevRelay Sites: health checker started');
}
