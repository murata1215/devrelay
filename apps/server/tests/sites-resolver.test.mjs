// DevRelay Sites Phase 1-A: 突合ロジック `resolveSites()` の単体テスト。
// 外部 I/O ゼロの純粋関数（DB/Caddy/ss/ps への実アクセスは site-inventory-service.ts 側）。
// 4 ケース（dangou-card-viewer 型 / chrome-bookmark 型 / 未起動 502 型 / TS 行なし型）で
// 信頼度・directories 3 分割・warnings を固定する。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSites } from '../dist/services/sites/site-resolver.js';

const HOSTNAME = 'x220-158-18-103';

/** ResolveInput の共通デフォルト値（各テストで上書きする）。 */
function baseInput(overrides = {}) {
  return {
    caddySites: [],
    caddyReachable: true,
    ssAvailable: true,
    listens: [],
    uidUserMap: new Map([[1001, 'devrelay'], [1012, 'uso8m'], [1006, 'keisuke']]),
    listenPids: new Map(),
    processCwds: new Map(),
    processCmdlines: new Map(),
    psHintsByPort: new Map(),
    gitInfoByDir: new Map(),
    healthByHost: new Map(),
    testflightRows: [],
    projectRows: [],
    sitesDirFiles: [],
    testflightDirNames: [],
    shellDirectories: new Set(),
    hostname: HOSTNAME,
    // DevRelay Sites Phase 1-B: アクセス解析統計（healthByHost と同じ流儀。既定は空 = 未計測）
    statsByHost: new Map(),
    ...overrides,
  };
}

test('dangou-card-viewer 型: 他ユーザー稼働・殻ディレクトリ・Project は推測候補のみ', () => {
  const input = baseInput({
    caddySites: [
      {
        host: 'dangou-card-viewer.devrelay.io',
        aliases: [],
        kind: 'reverse_proxy',
        upstreamDial: 'localhost:9023',
        upstreamPort: 9023,
        staticRoot: null,
        errorsRoot: '/home/devrelay/testflight/dangou-card-viewer/placeholder',
        hasAccessLog: false,
      },
    ],
    listens: [{ port: 9023, bind: '127.0.0.1', uid: 1012, cgroup: '/user.slice/user-1012.slice/user@1012.service/app.slice/dangou-viewer.service' }],
    testflightRows: [
      {
        id: 'tf1',
        name: 'dangou-card-viewer',
        port: 9023,
        domain: 'dangou-card-viewer.devrelay.io',
        directory: '/home/devrelay/testflight/dangou-card-viewer',
        status: 'placeholder',
        template: null,
        ownerUserId: 'u1',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    projectRows: [
      {
        id: 'p1',
        name: 'dangou-card',
        displayName: null,
        path: '/home/uso8m/dangou-card',
        machineId: 'm1',
        machineName: `${HOSTNAME}/uso8m`,
        machineOnline: true,
      },
    ],
    shellDirectories: new Set(['/home/devrelay/testflight/dangou-card-viewer']),
    healthByHost: new Map([['dangou-card-viewer.devrelay.io', { state: 'up', httpStatus: 200, latencyMs: 42, checkedAt: '2026-09-22T00:00:00.000Z', error: null }]]),
  });

  const { sites } = resolveSites(input);
  const site = sites[0];

  assert.equal(site.listen.value.unixUser, 'uso8m');
  assert.equal(site.listen.value.cgroupUnit, 'dangou-viewer.service');
  assert.equal(site.process.confidence, 'unknown', '他ユーザーのプロセスなので pid は不可視');
  assert.equal(site.directories.registered.confidence, 'confirmed');
  assert.equal(site.directories.registered.value, '/home/devrelay/testflight/dangou-card-viewer');
  assert.equal(site.directories.runtime.confidence, 'unknown', 'ps args にも手がかりがないため runtime は不明');
  assert.equal(site.directories.candidates.length, 1);
  assert.equal(site.directories.candidates[0].confidence, 'inferred');
  assert.equal(site.directories.candidates[0].path, '/home/uso8m/dangou-card');
  assert.equal(site.project.confidence, 'inferred');
  assert.ok(site.warnings.some((w) => w.code === 'REGISTERED_DIR_IS_SHELL'));
  assert.ok(!site.warnings.some((w) => w.code === 'BACKEND_NOT_LISTENING'), 'LISTEN しているので backend down 警告は出ない');
});

test('chrome-bookmark 型: devrelay 所有プロセス・cwd 確定・登録ディレクトリと相違', () => {
  const input = baseInput({
    caddySites: [
      {
        host: 'chrome-bookmark.devrelay.io',
        aliases: [],
        kind: 'reverse_proxy',
        upstreamDial: 'localhost:9024',
        upstreamPort: 9024,
        staticRoot: null,
        errorsRoot: '/home/devrelay/testflight/chrome-bookmark/placeholder',
        hasAccessLog: false,
      },
    ],
    listens: [{ port: 9024, bind: '0.0.0.0', uid: 1001, cgroup: '/system.slice/pm2-devrelay.service' }],
    listenPids: new Map([[9024, 3644889]]),
    processCwds: new Map([[3644889, '/home/devrelay/testflight/chrome-bookmark/server']]),
    processCmdlines: new Map([[3644889, 'node dist/index.js']]),
    testflightRows: [
      {
        id: 'tf2',
        name: 'chrome-bookmark',
        port: 9024,
        domain: 'chrome-bookmark.devrelay.io',
        directory: '/home/devrelay/testflight/chrome-bookmark',
        status: 'active',
        template: null,
        ownerUserId: 'u1',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    projectRows: [
      {
        id: 'p2',
        name: 'chrome-bookmark',
        displayName: null,
        path: '/home/devrelay/testflight/chrome-bookmark/server',
        machineId: 'm2',
        machineName: `${HOSTNAME}/devrelay`,
        machineOnline: true,
      },
    ],
    gitInfoByDir: new Map([['/home/devrelay/testflight/chrome-bookmark/server', { branch: 'main', head: '8844c2c', remote: 'git@github.com:murata1215/chrome-bookmark.git' }]]),
    healthByHost: new Map([['chrome-bookmark.devrelay.io', { state: 'degraded', httpStatus: 404, latencyMs: 10, checkedAt: '2026-09-22T00:00:00.000Z', error: null }]]),
  });

  const { sites } = resolveSites(input);
  const site = sites[0];

  assert.equal(site.process.confidence, 'confirmed');
  assert.equal(site.process.value.pid, 3644889);
  assert.equal(site.directories.runtime.confidence, 'confirmed');
  assert.equal(site.directories.runtime.value, '/home/devrelay/testflight/chrome-bookmark/server');
  assert.equal(site.directories.candidates[0].confidence, 'confirmed');
  assert.equal(site.project.confidence, 'confirmed');
  assert.equal(site.git.confidence, 'confirmed');
  assert.equal(site.git.value.head, '8844c2c');
  assert.equal(site.listen.value.cgroupUnit, null, 'PM2 ラッパーは個別 unit として扱わない');
  assert.ok(site.warnings.some((w) => w.code === 'DIRECTORY_MISMATCH'), '登録先(chrome-bookmark) と runtime(chrome-bookmark/server) は不一致');
  assert.ok(site.warnings.some((w) => w.code === 'HTTP_4XX_ROOT'));
  assert.ok(!site.warnings.some((w) => w.code === 'BACKEND_NOT_LISTENING'));
});

test('未起動 testflight 型（502）: LISTEN なし・down health', () => {
  const input = baseInput({
    caddySites: [
      {
        host: 'test004.devrelay.io',
        aliases: [],
        kind: 'reverse_proxy',
        upstreamDial: 'localhost:9004',
        upstreamPort: 9004,
        staticRoot: null,
        errorsRoot: '/home/devrelay/testflight/test004/placeholder',
        hasAccessLog: false,
      },
    ],
    testflightRows: [
      {
        id: 'tf3',
        name: 'test004',
        port: 9004,
        domain: 'test004.devrelay.io',
        directory: '/home/devrelay/testflight/test004',
        status: 'placeholder',
        template: null,
        ownerUserId: 'u1',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    healthByHost: new Map([['test004.devrelay.io', { state: 'down', httpStatus: 502, latencyMs: 5, checkedAt: '2026-09-22T00:00:00.000Z', error: 'HTTP 502' }]]),
  });

  const { sites } = resolveSites(input);
  const site = sites[0];

  assert.equal(site.listen.confidence, 'unknown');
  assert.equal(site.process.confidence, 'unknown');
  assert.ok(site.warnings.some((w) => w.code === 'BACKEND_NOT_LISTENING' && w.severity === 'error'));
  assert.ok(site.warnings.some((w) => w.code === 'HTTP_5XX' && w.severity === 'error'));
  assert.ok(!site.warnings.some((w) => w.code === 'STATUS_STALE'), 'placeholder かつ未起動は矛盾がないので stale 警告は出ない');
});

test('TestflightService 行なし型: devrelay.io 配下だが DB 行が無い場合のみ NO_TESTFLIGHT_ROW', () => {
  const input = baseInput({
    caddySites: [
      {
        host: 'orphan.devrelay.io',
        aliases: [],
        kind: 'reverse_proxy',
        upstreamDial: 'localhost:9099',
        upstreamPort: 9099,
        staticRoot: null,
        errorsRoot: null,
        hasAccessLog: false,
      },
      {
        host: 'pixblog.net',
        aliases: [],
        kind: 'reverse_proxy',
        upstreamDial: 'localhost:3001',
        upstreamPort: 3001,
        staticRoot: null,
        errorsRoot: null,
        hasAccessLog: true,
      },
    ],
  });

  const { sites } = resolveSites(input);
  const orphan = sites.find((s) => s.host === 'orphan.devrelay.io');
  const pixblog = sites.find((s) => s.host === 'pixblog.net');

  assert.equal(orphan.testflight.confidence, 'unknown');
  assert.ok(orphan.warnings.some((w) => w.code === 'NO_TESTFLIGHT_ROW'));
  assert.ok(!pixblog.warnings.some((w) => w.code === 'NO_TESTFLIGHT_ROW'), 'devrelay.io 以外のホストには TestflightService 不在警告を出さない');
  assert.ok(!pixblog.warnings.some((w) => w.code === 'NO_ACCESS_LOG'), 'hasAccessLog=true のホストには警告を出さない');
});

test('orphans: archived でない TestflightService 行が Caddy に host を持たない場合に検出する', () => {
  const input = baseInput({
    caddySites: [],
    testflightRows: [
      {
        id: 'tf4',
        name: 'knightmare',
        port: 9050,
        domain: 'knightmare.devrelay.io',
        directory: '/home/devrelay/testflight/knightmare',
        status: 'placeholder',
        template: null,
        ownerUserId: 'u1',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'tf5',
        name: 'test001',
        port: 9051,
        domain: 'test001.devrelay.io',
        directory: '/home/devrelay/testflight/test001',
        status: 'archived',
        template: null,
        ownerUserId: 'u1',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    testflightDirNames: ['knightmare', 'test001', 'test002'],
  });

  const { orphans } = resolveSites(input);
  assert.ok(orphans.some((o) => o.kind === 'testflight-row-no-caddy' && o.name === 'knightmare'));
  assert.ok(!orphans.some((o) => o.name === 'test001'), 'archived 行は orphan として報告しない');
  assert.ok(orphans.some((o) => o.kind === 'directory-only' && o.name === 'test002'), 'DB 行も Caddy host も無い dir のみ report');
});
