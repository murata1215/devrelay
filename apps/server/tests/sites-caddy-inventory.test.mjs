// DevRelay Sites Phase 1-A: Caddy Admin API JSON からの抽出ロジックの単体テスト。
// 外部 import ゼロ（fetch は行わない）の純粋関数 `extractSitesFromCaddyConfig` を
// コンパイル済み dist から直接 import する（#308 系と同じ流儀）。
// フィクスチャは実機の `curl localhost:2019/config/` で確認した構造を縮約したもの。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractSitesFromCaddyConfig } from '../dist/services/sites/caddy-inventory.js';

/** testflight サイト（reverse_proxy + handle_errors の placeholder）の縮約フィクスチャ。 */
function buildFixtureConfig() {
  return {
    apps: {
      http: {
        servers: {
          srv0: {
            logs: {
              default_logger_name: 'log2',
              logger_names: { 'pixblog.net': ['log0'], 'ribbon-re.jp': ['log1'], 'www.ribbon-re.jp': ['log1'] },
              skip_hosts: ['dangou-card-viewer.devrelay.io'],
            },
            errors: {
              routes: [
                {
                  match: [{ host: ['dangou-card-viewer.devrelay.io'] }],
                  handle: [
                    {
                      handler: 'subroute',
                      routes: [
                        {
                          handle: [
                            {
                              handler: 'subroute',
                              routes: [
                                { handle: [{ handler: 'vars', root: '/home/devrelay/testflight/dangou-card-viewer/placeholder' }] },
                                { handle: [{ handler: 'file_server' }] },
                              ],
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
            routes: [
              // testflight サイト（reverse_proxy のみ、専用ログなし）
              {
                match: [{ host: ['dangou-card-viewer.devrelay.io'] }],
                handle: [
                  {
                    handler: 'subroute',
                    routes: [{ handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: 'localhost:9023' }] }] }],
                  },
                ],
                terminal: true,
              },
              // reverse_proxy + file_server 混在（devrelay.io ランディング。専用ログなし＝skip_hosts にも logger_names にも無い）
              {
                match: [{ host: ['devrelay.io'] }],
                handle: [
                  {
                    handler: 'subroute',
                    routes: [
                      {
                        match: [{ path: ['/api/*'] }],
                        handle: [{ handler: 'subroute', routes: [{ handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: 'localhost:3005' }] }] }] }],
                      },
                      {
                        handle: [
                          {
                            handler: 'subroute',
                            routes: [
                              { handle: [{ handler: 'vars', root: '/opt/devrelay/apps/landing' }] },
                              { handle: [{ handler: 'file_server' }] },
                            ],
                          },
                        ],
                      },
                    ],
                  },
                ],
                terminal: true,
              },
              // unix socket（php_fastcgi 相当）
              {
                match: [{ host: ['ribbon-re.jp', 'www.ribbon-re.jp'] }],
                handle: [
                  {
                    handler: 'subroute',
                    routes: [
                      { handle: [{ handler: 'vars', root: '/home/ribbon/sites/ribbon-re.jp/public' }] },
                      { handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: 'unix//run/php/ribbon.sock' }] }] },
                    ],
                  },
                ],
                terminal: true,
              },
              // catch-all（host なし）は Sites の対象外
              {
                handle: [{ handler: 'subroute', routes: [{ handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: 'localhost:3002' }] }] }] }],
                terminal: true,
              },
            ],
          },
        },
      },
    },
  };
}

test('extractSitesFromCaddyConfig: testflight サイト（reverse_proxy）を抽出できる', () => {
  const sites = extractSitesFromCaddyConfig(buildFixtureConfig());
  const dangou = sites.find((s) => s.host === 'dangou-card-viewer.devrelay.io');
  assert.ok(dangou, 'dangou-card-viewer.devrelay.io が抽出されること');
  assert.equal(dangou.kind, 'reverse_proxy');
  assert.equal(dangou.upstreamDial, 'localhost:9023');
  assert.equal(dangou.upstreamPort, 9023);
  assert.equal(dangou.errorsRoot, '/home/devrelay/testflight/dangou-card-viewer/placeholder');
  assert.equal(dangou.hasAccessLog, false, 'logger_names に含まれないので専用ログなし扱い');
  assert.deepEqual(dangou.aliases, []);
});

test('extractSitesFromCaddyConfig: reverse_proxy + file_server 混在サイトの root も拾える', () => {
  const sites = extractSitesFromCaddyConfig(buildFixtureConfig());
  const root = sites.find((s) => s.host === 'devrelay.io');
  assert.ok(root);
  assert.equal(root.kind, 'reverse_proxy', 'upstream がある場合は reverse_proxy を優先する');
  assert.equal(root.upstreamPort, 3005);
  assert.equal(root.staticRoot, '/opt/devrelay/apps/landing');
});

test('extractSitesFromCaddyConfig: unix socket は php・alias host も拾える', () => {
  const sites = extractSitesFromCaddyConfig(buildFixtureConfig());
  const ribbon = sites.find((s) => s.host === 'ribbon-re.jp');
  assert.ok(ribbon);
  assert.equal(ribbon.kind, 'php');
  assert.equal(ribbon.upstreamPort, null, 'unix socket dial にはポート番号がない');
  assert.deepEqual(ribbon.aliases, ['www.ribbon-re.jp']);
  assert.equal(ribbon.hasAccessLog, true, 'logger_names["ribbon-re.jp"] があるので専用ログあり扱い');
});

test('extractSitesFromCaddyConfig: catch-all（host なし）ルートは除外する', () => {
  const sites = extractSitesFromCaddyConfig(buildFixtureConfig());
  assert.equal(sites.length, 3, 'catch-all を除いた 3 件のみ抽出される');
});

test('extractSitesFromCaddyConfig: 不正な入力（null / 空オブジェクト）は空配列を返す', () => {
  assert.deepEqual(extractSitesFromCaddyConfig(null), []);
  assert.deepEqual(extractSitesFromCaddyConfig({}), []);
  assert.deepEqual(extractSitesFromCaddyConfig({ apps: {} }), []);
});
