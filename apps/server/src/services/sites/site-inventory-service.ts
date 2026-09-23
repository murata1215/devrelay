/**
 * DevRelay Sites Phase 1-A — I/O 層。
 *
 * Caddy Admin API・ss/ps・`/etc/passwd`・`readdir`・Prisma への実アクセスをここに閉じ込め、
 * 集めた入力を `site-resolver.ts` の純粋関数 `resolveSites()` に渡す。
 * 60 秒メモリキャッシュ + in-flight 共有により、`/api/sites` への短時間の連続アクセスで
 * ログ全走査・Caddy fetch・DB クエリが何度も発生しないようにする。
 *
 * sudo は使わない。書き込み系の Caddy Admin API・ファイル変更は一切行わない（read-only）。
 */

import { readdir } from 'fs/promises';
import { hostname as osHostname } from 'os';
import { prisma } from '../../db/client.js';
import { fetchCaddyInventory } from './caddy-inventory.js';
import { getGitInfo } from './git-probe.js';
import {
  getListenInfo,
  getListenPids,
  getProcessCmdline,
  getProcessCwd,
  getPsArgsText,
  getUidUserMap,
  parsePsArgsForPort,
} from './process-probe.js';
import { getHealthResult } from './health-checker.js';
import { getSiteStatsMap, isStatsReady } from './access-aggregator.js';
import { resolveSites, type ResolveProjectRow, type ResolveTestflightRow } from './site-resolver.js';
import { SITES_TIME_ZONE } from './sites-rules.js';
import type { GitInfo, SiteRecord, SitesMeta } from './types.js';

const TESTFLIGHT_BASE_DIR = '/home/devrelay/testflight';
const CADDY_SITES_DIR = '/etc/caddy/sites.d';
/** testflight ディレクトリ直下がこれらだけなら「殻」（実体なし・placeholder のみ）と判定する */
const SHELL_ONLY_ENTRIES = new Set(['placeholder', 'CLAUDE.md', 'rules', 'doc', '.env', '.git']);
const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  expiresAt: number;
  value: { sites: SiteRecord[]; meta: SitesMeta };
}

let cache: CacheEntry | null = null;
let inflight: Promise<{ sites: SiteRecord[]; meta: SitesMeta }> | null = null;

/** メモリキャッシュを破棄する（`POST /api/sites/:host/health-check` 直後に、次の一覧取得で最新の health を反映させるため）。 */
export function invalidateSiteInventoryCache(): void {
  cache = null;
}

/** 指定ディレクトリ配下が「殻」（placeholder 等のみで実体アプリが無い）かどうかを判定する。 */
async function isShellDirectory(dir: string): Promise<boolean> {
  try {
    const entries = await readdir(dir);
    if (entries.length === 0) return true;
    return entries.every((e) => SHELL_ONLY_ENTRIES.has(e));
  } catch {
    return false;
  }
}

/**
 * 実際に I/O を行って `SiteRecord[]` と meta を組み立てる。60 秒メモリキャッシュ + in-flight 共有。
 * @param forceRefresh true のときキャッシュを無視して再取得する（`?refresh=1`）
 */
export async function getSiteInventory(forceRefresh = false): Promise<{ sites: SiteRecord[]; meta: SitesMeta }> {
  const now = Date.now();
  if (!forceRefresh && cache && cache.expiresAt > now) {
    return cache.value;
  }
  if (!forceRefresh && inflight) {
    return inflight;
  }

  const run = async (): Promise<{ sites: SiteRecord[]; meta: SitesMeta }> => {
    const [caddyInventory, listenResult, listenPids, uidUserMap, psArgsText, testflightRowsRaw, projectRowsRaw, sitesDirFiles, testflightDirNames] =
      await Promise.all([
        fetchCaddyInventory(),
        getListenInfo(),
        getListenPids(),
        getUidUserMap(),
        getPsArgsText(),
        prisma.testflightService.findMany(),
        prisma.project.findMany({ where: { deletedAt: null }, include: { machine: true } }),
        readdir(CADDY_SITES_DIR).catch(() => [] as string[]),
        readdir(TESTFLIGHT_BASE_DIR).catch(() => [] as string[]),
      ]);

    const testflightRows: ResolveTestflightRow[] = testflightRowsRaw.map((r) => ({
      id: r.id,
      name: r.name,
      port: r.port,
      domain: r.domain,
      directory: r.directory,
      status: r.status,
      template: r.template,
      ownerUserId: r.userId,
      createdAt: r.createdAt.toISOString(),
    }));

    const projectRows: ResolveProjectRow[] = projectRowsRaw.map((p) => ({
      id: p.id,
      name: p.name,
      displayName: p.displayName,
      path: p.path,
      machineId: p.machineId,
      machineName: p.machine.name,
      machineOnline: p.machine.status === 'online',
    }));

    // devrelay 所有プロセスの cwd/cmdline（listenPids の値のみ）
    const processCwds = new Map<number, string | null>();
    const processCmdlines = new Map<number, string | null>();
    await Promise.all(
      Array.from(new Set(listenPids.values())).map(async (pid) => {
        const [cwd, cmdline] = await Promise.all([getProcessCwd(pid), getProcessCmdline(pid)]);
        processCwds.set(pid, cwd);
        processCmdlines.set(pid, cmdline);
      })
    );

    // 他ユーザー分の ps args ヒント（upstream port ごと）
    const psHintsByPort = new Map<number, ReturnType<typeof parsePsArgsForPort>>();
    for (const entry of caddyInventory.sites) {
      if (entry.upstreamPort !== null && !listenPids.has(entry.upstreamPort)) {
        psHintsByPort.set(entry.upstreamPort, parsePsArgsForPort(psArgsText, entry.upstreamPort));
      }
    }

    // 「殻」ディレクトリ判定（TestflightService.directory のみ対象。件数が少ないので全部調べる）
    const shellDirectories = new Set<string>();
    await Promise.all(
      testflightRows.map(async (r) => {
        if (await isShellDirectory(r.directory)) shellDirectories.add(r.directory);
      })
    );

    // Git 情報: 「registered directory」と「runtime cwd（devrelay 所有プロセスのみ）」の両方について取得
    const gitCandidateDirs = new Set<string>();
    for (const r of testflightRows) gitCandidateDirs.add(r.directory);
    for (const cwd of processCwds.values()) if (cwd) gitCandidateDirs.add(cwd);
    const gitInfoByDir = new Map<string, GitInfo>();
    await Promise.all(
      Array.from(gitCandidateDirs).map(async (dir) => {
        gitInfoByDir.set(dir, await getGitInfo(dir));
      })
    );

    const healthByHost = getHealthResult();
    // DevRelay Sites Phase 1-B: 現在 Caddy が公開している全ホストぶんの統計を取得
    // （access log 未導入 host や集計未完了時はエントリが存在せず SiteRecord.stats が null になる）
    const statsByHost = getSiteStatsMap(caddyInventory.sites.map((s) => s.host));

    const { sites, orphans } = resolveSites({
      caddySites: caddyInventory.sites,
      caddyReachable: caddyInventory.reachable,
      ssAvailable: listenResult.available,
      listens: listenResult.listens,
      uidUserMap,
      listenPids,
      processCwds,
      processCmdlines,
      psHintsByPort,
      gitInfoByDir,
      healthByHost,
      testflightRows,
      projectRows,
      sitesDirFiles,
      testflightDirNames,
      shellDirectories,
      hostname: osHostname(),
      statsByHost,
    });

    const counts = { up: 0, degraded: 0, down: 0, unknown: 0, withoutAccessLog: 0 };
    for (const s of sites) {
      counts[s.health.state] += 1;
      if (!s.hasAccessLog) counts.withoutAccessLog += 1;
    }

    const meta: SitesMeta = {
      caddyAdminReachable: caddyInventory.reachable,
      ssAvailable: listenResult.available,
      hostname: osHostname(),
      healthEnabled: healthByHost.size > 0 || sites.some((s) => s.health.checkedAt !== null),
      lastHealthRunAt: sites.reduce<string | null>((acc, s) => {
        if (!s.health.checkedAt) return acc;
        return !acc || s.health.checkedAt > acc ? s.health.checkedAt : acc;
      }, null),
      counts,
      orphans,
      unmeasuredCount: counts.withoutAccessLog,
      statsReady: isStatsReady(),
      timeZone: SITES_TIME_ZONE,
    };

    return { sites, meta };
  };

  inflight = run();
  try {
    const value = await inflight;
    cache = { expiresAt: Date.now() + CACHE_TTL_MS, value };
    return value;
  } finally {
    inflight = null;
  }
}
