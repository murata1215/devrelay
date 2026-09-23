/**
 * DevRelay Sites Phase 1-A — Caddy / ss・ps / DB（TestflightService, Project, Machine）を
 * 突合して `SiteRecord[]` を組み立てる中核ロジック。
 *
 * このファイルは外部 I/O ゼロの純粋関数のみを置く（`resolveSites()` はすべての入力を
 * 呼び出し側で取得済みのものとして受け取る）。DB/Prisma/fs/child_process への実アクセスは
 * `site-inventory-service.ts` に閉じ込め、そちらから本ファイルの `resolveSites()` を呼び出す
 * （#332 permission-policy.ts / #348 cross-query-guard.ts と同じ「ロジックと I/O の分離」流儀。
 * これにより `node --test` から `dist/services/sites/site-resolver.js` を直接 import しても
 * DATABASE_URL 等の環境変数なしでテストできる）。
 *
 * 突合ルールの根拠は `/home/devrelay/.claude/plans/floating-wandering-melody.md` の
 * 「Phase 1-A #突合ルール」節を参照。
 */

import { parseCgroupHint } from './process-probe.js';
import type {
  CaddySiteEntry,
  Confidence,
  Evidence,
  GitInfo,
  HealthResult,
  ListenInfo,
  MachineInfo,
  ProcessHint,
  ProjectCandidate,
  ProjectInfo,
  SiteRecord,
  SitesMeta,
  SiteStats,
  SiteWarning,
  TestflightInfo,
} from './types.js';
import { unknownEvidence } from './types.js';

const TESTFLIGHT_BASE_DIR = '/home/devrelay/testflight';

export interface ResolveTestflightRow {
  id: string;
  name: string;
  port: number;
  domain: string;
  directory: string;
  status: string;
  template: string | null;
  ownerUserId: string;
  createdAt: string;
}

export interface ResolveProjectRow {
  id: string;
  name: string;
  displayName: string | null;
  path: string;
  machineId: string;
  machineName: string;
  machineOnline: boolean;
}

export interface ResolveInput {
  caddySites: CaddySiteEntry[];
  caddyReachable: boolean;
  ssAvailable: boolean;
  listens: ListenInfo[];
  uidUserMap: Map<number, string>;
  listenPids: Map<number, number>;
  processCwds: Map<number, string | null>;
  processCmdlines: Map<number, string | null>;
  psHintsByPort: Map<number, ProcessHint[]>;
  gitInfoByDir: Map<string, GitInfo>;
  healthByHost: Map<string, HealthResult>;
  testflightRows: ResolveTestflightRow[];
  projectRows: ResolveProjectRow[];
  sitesDirFiles: string[];
  testflightDirNames: string[];
  shellDirectories: Set<string>;
  hostname: string;
  /**
   * Phase 1-B: `access-aggregator.ts` が計算した host ごとの `SiteStats`。
   * この host のログを一度も観測していない場合（B1 のように access log 自体が未導入等）は
   * エントリが存在しない（`healthByHost` と完全に同じ流儀）。
   */
  statsByHost: Map<string, SiteStats>;
}

export interface ResolveOutput {
  sites: SiteRecord[];
  orphans: SitesMeta['orphans'];
}

const EMPTY_HEALTH: HealthResult = { state: 'unknown', httpStatus: null, latencyMs: null, checkedAt: null, error: null };

/** devrelay.io サブドメインから testflight 名らしきラベルを取り出す（'dangou-card-viewer.devrelay.io' → 'dangou-card-viewer'）。 */
function extractHostLabel(host: string): string {
  const idx = host.indexOf('.');
  return idx === -1 ? host : host.slice(0, idx);
}

/** 2 つの名前が「包含関係」にあるかどうか（ハイフン区切りの部分一致想定）。 */
function isNameRelated(a: string, b: string): boolean {
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a);
}

function findListenForPort(listens: ListenInfo[], port: number | null): ListenInfo | null {
  if (port === null) return null;
  return listens.find((l) => l.port === port) ?? null;
}

function buildListenEvidence(
  listen: ListenInfo | null,
  uidUserMap: Map<number, string>
): Evidence<{ bind: string; uid: number; unixUser: string | null; cgroupUnit: string | null }> {
  if (!listen) {
    return unknownEvidence('ss', 'LISTEN しているソケットが見つからない（backend 未起動の可能性）');
  }
  const cgroupHint = parseCgroupHint(listen.cgroup);
  return {
    value: {
      bind: listen.bind,
      uid: listen.uid,
      unixUser: uidUserMap.get(listen.uid) ?? null,
      cgroupUnit: cgroupHint?.isPm2Wrapper ? null : cgroupHint?.lastSegment ?? null,
    },
    confidence: 'confirmed',
    source: 'ss+passwd',
    note: cgroupHint?.isPm2Wrapper
      ? `cgroup は PM2 共通ラッパー（${cgroupHint.lastSegment}）のため個別 site の systemd unit ではない`
      : undefined,
  };
}

function buildProcessEvidence(
  port: number | null,
  listenPids: Map<number, number>,
  processCwds: Map<number, string | null>,
  processCmdlines: Map<number, string | null>
): Evidence<{ pid: number; cwd: string | null; cmdline: string }> {
  if (port === null) return unknownEvidence('proc-cwd');
  const pid = listenPids.get(port);
  if (pid === undefined) {
    return unknownEvidence('proc-cwd', '他ユーザーのプロセスのため pid が不可視');
  }
  return {
    value: {
      pid,
      cwd: processCwds.get(pid) ?? null,
      cmdline: processCmdlines.get(pid) ?? '',
    },
    confidence: 'confirmed',
    source: 'proc-cwd',
  };
}

/** 他ユーザー分の ps args ヒントから、それらしいディレクトリパスを 1 つ推測する。 */
function guessRuntimeDirFromPsHints(hints: ProcessHint[]): { dir: string; hint: ProcessHint } | null {
  for (const hint of hints) {
    const match = hint.args.match(/\/home\/[a-z0-9_-]+\/[^\s]*/i);
    if (match) {
      // 末尾のファイル名っぽい部分（拡張子あり）は directory とは言えないので、簡易的にそのまま採用する
      return { dir: match[0], hint };
    }
  }
  return null;
}

/** 1 site 分の SiteRecord を組み立てる。 */
function buildSiteRecord(entry: CaddySiteEntry, input: ResolveInput, registeredDirToShell: Set<string>): SiteRecord {
  const { host, aliases, kind, upstreamDial, upstreamPort, staticRoot, errorsRoot, hasAccessLog } = entry;

  const configSourceFile = input.sitesDirFiles.find((f) => f === host);
  const configSource = configSourceFile ? `sites.d/${configSourceFile}` : input.caddyReachable ? 'caddyfile' : null;

  const upstream: Evidence<{ dial: string; port: number | null }> = upstreamDial
    ? { value: { dial: upstreamDial, port: upstreamPort }, confidence: 'confirmed', source: 'caddy-admin' }
    : unknownEvidence('caddy-admin', 'reverse_proxy の upstream が見つからない');

  const staticRootValue = staticRoot ?? errorsRoot;
  const staticRootEvidence: Evidence<string> = staticRootValue
    ? {
        value: staticRootValue,
        confidence: 'confirmed',
        source: 'caddy-admin',
        note: !staticRoot && errorsRoot ? 'handle_errors（backend 死亡時）の placeholder root' : undefined,
      }
    : unknownEvidence('caddy-admin');

  const listen = findListenForPort(input.listens, upstreamPort);
  const listenEvidence = buildListenEvidence(listen, input.uidUserMap);
  const processEvidence = buildProcessEvidence(upstreamPort, input.listenPids, input.processCwds, input.processCmdlines);

  // --- TestflightService 突合 ---
  let tfRow = input.testflightRows.find((r) => r.domain === host);
  if (!tfRow && errorsRoot) {
    const nameFromRoot = errorsRoot.replace(`${TESTFLIGHT_BASE_DIR}/`, '').split('/')[0];
    tfRow = input.testflightRows.find((r) => r.name === nameFromRoot);
  }
  const testflightEvidence: Evidence<TestflightInfo> = tfRow
    ? {
        value: {
          id: tfRow.id,
          name: tfRow.name,
          port: tfRow.port,
          directory: tfRow.directory,
          status: tfRow.status,
          template: tfRow.template,
          ownerUserId: tfRow.ownerUserId,
          createdAt: tfRow.createdAt,
        },
        confidence: 'confirmed',
        source: 'db:TestflightService',
        note: 'status は作成時点の値。稼働状態と自動同期されていないため stale の可能性あり',
      }
    : unknownEvidence('db:TestflightService', 'devrelay.io 配下だが TestflightService 行が見つからない');

  // --- directories ---
  const registeredEvidence: Evidence<string> = tfRow
    ? {
        value: tfRow.directory,
        confidence: 'confirmed',
        source: 'db:TestflightService',
        note: registeredDirToShell.has(tfRow.directory)
          ? 'placeholder/CLAUDE.md 等のみで実体が無い「殻」ディレクトリ'
          : undefined,
      }
    : unknownEvidence('db:TestflightService');

  let runtimeEvidence: Evidence<string>;
  const psHints = upstreamPort !== null ? input.psHintsByPort.get(upstreamPort) ?? [] : [];
  if (processEvidence.value?.cwd) {
    runtimeEvidence = { value: processEvidence.value.cwd, confidence: 'confirmed', source: 'proc-cwd' };
  } else {
    const guessed = guessRuntimeDirFromPsHints(psHints);
    runtimeEvidence = guessed
      ? {
          value: guessed.dir,
          confidence: 'inferred',
          source: 'ps-args',
          note: `ps args からの推測（pid ${guessed.hint.pid}, user ${guessed.hint.user}）`,
        }
      : unknownEvidence('ps-args', '他ユーザーのため directory を推測する手がかりがない');
  }

  // --- Project 候補 ---
  const candidates: ProjectCandidate[] = [];
  const seenIds = new Set<string>();
  const pushCandidate = (p: ResolveProjectRow, confidence: Confidence, reason: string) => {
    if (seenIds.has(p.id)) return;
    seenIds.add(p.id);
    candidates.push({
      id: p.id,
      name: p.name,
      displayName: p.displayName,
      path: p.path,
      machineName: p.machineName,
      confidence,
      reason,
    });
  };

  if (runtimeEvidence.value && runtimeEvidence.confidence === 'confirmed') {
    for (const p of input.projectRows) {
      if (p.path === runtimeEvidence.value) pushCandidate(p, 'confirmed', 'Project.path がプロセスの cwd と一致');
    }
  }
  if (registeredEvidence.value) {
    for (const p of input.projectRows) {
      if (p.path === registeredEvidence.value) pushCandidate(p, 'conditional', 'Project.path が登録上の directory と一致（規約突合）');
    }
  }
  const expectedMachineName = listenEvidence.value?.unixUser ? `${input.hostname}/${listenEvidence.value.unixUser}` : null;
  if (expectedMachineName) {
    const label = extractHostLabel(host);
    for (const p of input.projectRows) {
      if (p.machineName !== expectedMachineName) continue;
      if (isNameRelated(label, p.name)) {
        pushCandidate(p, 'inferred', `同じマシン(${expectedMachineName})の Project 名 "${p.name}" が host ラベル "${label}" と部分一致`);
      }
    }
  }

  const projectEvidence: Evidence<ProjectInfo> =
    candidates.length > 0
      ? {
          value: {
            id: candidates[0].id,
            name: candidates[0].name,
            displayName: candidates[0].displayName,
            path: candidates[0].path,
            machineName: candidates[0].machineName,
          },
          confidence: candidates[0].confidence,
          source: 'db:Project',
          note: candidates[0].reason,
        }
      : unknownEvidence('db:Project', 'Project 候補が見つからない');

  // --- Machine ---
  const machineRow = expectedMachineName ? input.projectRows.find((p) => p.machineName === expectedMachineName) : undefined;
  const machineEvidence: Evidence<MachineInfo> = machineRow
    ? {
        value: { id: machineRow.machineId, name: machineRow.machineName, online: machineRow.machineOnline },
        confidence: 'conditional',
        source: 'db:Machine',
        note: 'hostname/unixUser の規約突合（DB リンクなし）',
      }
    : unknownEvidence('db:Machine');

  // --- Git ---
  const gitDir = runtimeEvidence.confidence === 'confirmed' && runtimeEvidence.value ? runtimeEvidence.value : registeredEvidence.value;
  const gitInfo = gitDir ? input.gitInfoByDir.get(gitDir) : undefined;
  const gitEvidence: Evidence<GitInfo> =
    gitInfo && gitInfo.head
      ? {
          value: gitInfo,
          confidence: gitDir === runtimeEvidence.value ? 'confirmed' : 'conditional',
          source: 'git',
        }
      : unknownEvidence('git', gitDir ? '.git が無い、または読み取り不可' : 'directory 不明');

  const health = input.healthByHost.get(host) ?? EMPTY_HEALTH;
  const stats = input.statsByHost.get(host) ?? null;

  // --- warnings ---
  const warnings: SiteWarning[] = [];
  const listening = listen !== null;
  if (upstreamPort !== null && !listening) {
    warnings.push({ code: 'BACKEND_NOT_LISTENING', severity: 'error', message: `port ${upstreamPort} を LISTEN しているプロセスがない` });
  }
  if (health.state === 'down') {
    warnings.push({ code: 'HTTP_5XX', severity: 'error', message: health.error ?? 'health check が down' });
  } else if (health.state === 'degraded') {
    warnings.push({ code: 'HTTP_4XX_ROOT', severity: 'warn', message: `HTTP ${health.httpStatus ?? '?'}（backend は生存）` });
  }
  if (!tfRow && host.endsWith('.devrelay.io')) {
    warnings.push({ code: 'NO_TESTFLIGHT_ROW', severity: 'warn', message: 'devrelay.io 配下だが TestflightService 行がない' });
  }
  if (candidates.length === 0) {
    warnings.push({ code: 'NO_PROJECT', severity: 'warn', message: 'Project 候補が見つからない' });
  }
  if (
    registeredEvidence.value &&
    runtimeEvidence.value &&
    runtimeEvidence.confidence !== 'unknown' &&
    registeredEvidence.value !== runtimeEvidence.value
  ) {
    warnings.push({
      code: 'DIRECTORY_MISMATCH',
      severity: 'warn',
      message: `登録上の directory (${registeredEvidence.value}) と runtime 推定 (${runtimeEvidence.value}) が異なる`,
    });
  }
  if (tfRow && registeredDirToShell.has(tfRow.directory)) {
    warnings.push({ code: 'REGISTERED_DIR_IS_SHELL', severity: 'info', message: '登録先ディレクトリは placeholder のみ（実体なし）' });
  }
  if (tfRow) {
    if (tfRow.status === 'placeholder' && listening) {
      warnings.push({ code: 'STATUS_STALE', severity: 'info', message: 'DB status は placeholder だが LISTEN している（稼働開始後に未更新）' });
    } else if (tfRow.status === 'active' && !listening) {
      warnings.push({ code: 'STATUS_STALE', severity: 'info', message: 'DB status は active だが LISTEN していない' });
    }
  }
  if (!hasAccessLog) {
    warnings.push({ code: 'NO_ACCESS_LOG', severity: 'info', message: 'アクセスログ未設定（Phase 1-B で対応予定）' });
  }
  if (machineEvidence.value && !machineEvidence.value.online) {
    warnings.push({ code: 'MACHINE_OFFLINE', severity: 'info', message: `Machine ${machineEvidence.value.name} はオフライン` });
  }

  return {
    host,
    aliases,
    kind,
    configSource: configSource ?? null,
    upstream,
    staticRoot: staticRootEvidence,
    hasAccessLog,
    listen: listenEvidence,
    process: processEvidence,
    testflight: testflightEvidence,
    directories: { registered: registeredEvidence, runtime: runtimeEvidence, candidates },
    project: projectEvidence,
    machine: machineEvidence,
    git: gitEvidence,
    health,
    warnings,
    stats,
  };
}

/** Phase 1-A の中核: すべての入力から SiteRecord[] と orphan 一覧を組み立てる（純粋関数）。 */
export function resolveSites(input: ResolveInput): ResolveOutput {
  const registeredDirToShell = input.shellDirectories;
  const sites = input.caddySites.map((entry) => buildSiteRecord(entry, input, registeredDirToShell));

  const caddyHosts = new Set(input.caddySites.map((s) => s.host));
  const orphans: SitesMeta['orphans'] = [];
  for (const row of input.testflightRows) {
    if (row.status !== 'archived' && !caddyHosts.has(row.domain)) {
      orphans.push({ kind: 'testflight-row-no-caddy', name: row.name, path: row.directory, status: row.status });
    }
  }
  const knownNames = new Set(input.testflightRows.map((r) => r.name));
  for (const dirName of input.testflightDirNames) {
    if (knownNames.has(dirName)) continue;
    const expectedHost = `${dirName}.devrelay.io`;
    if (caddyHosts.has(expectedHost)) continue;
    orphans.push({ kind: 'directory-only', name: dirName, path: `${TESTFLIGHT_BASE_DIR}/${dirName}` });
  }

  return { sites, orphans };
}
