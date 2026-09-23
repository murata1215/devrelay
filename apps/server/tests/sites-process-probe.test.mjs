// DevRelay Sites Phase 1-A: `ss` / `ps` / `/etc/passwd` パーサの単体テスト。
// I/O（execFile/readFile）を伴わない純粋関数のみを対象とする。
// フィクスチャは実機の `ss -Hltne` / `ps -eo user,pid,args` 出力を元にした縮約版。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSsListen,
  parseCgroupHint,
  parsePasswd,
  parseSsWithPid,
  parsePsArgsForPort,
} from '../dist/services/sites/process-probe.js';

const SS_LISTEN_FIXTURE = `
LISTEN 0      511        127.0.0.1:9025 0.0.0.0:* uid:1001 ino:20330255 sk:30c0 cgroup:/system.slice/pm2-devrelay.service <->
LISTEN 0      2048       127.0.0.1:9023 0.0.0.0:* uid:1012 ino:8555363 sk:100e cgroup:/user.slice/user-1012.slice/user@1012.service/app.slice/dangou-viewer.service <->
LISTEN 0      4096   127.0.0.53%lo:53   0.0.0.0:* uid:991 ino:20328218 sk:30c1 cgroup:/system.slice/systemd-resolved.service <->
LISTEN 0      511          0.0.0.0:9010 0.0.0.0:* uid:1001 ino:20329248 sk:30c2 cgroup:/system.slice/pm2-devrelay.service <->
LISTEN 0      511             [::]:9026 [::]:*    uid:1006 ino:20330001 sk:30c3 cgroup:/user.slice/user-1006.slice <->
`;

test('parseSsListen: LISTEN 行から port/bind/uid/cgroup を抽出する', () => {
  const results = parseSsListen(SS_LISTEN_FIXTURE);
  assert.equal(results.length, 5);
  const dangou = results.find((r) => r.port === 9023);
  assert.ok(dangou);
  assert.equal(dangou.bind, '127.0.0.1');
  assert.equal(dangou.uid, 1012);
  assert.equal(dangou.cgroup, '/user.slice/user-1012.slice/user@1012.service/app.slice/dangou-viewer.service');
});

test('parseSsListen: %interface サフィックス付きアドレスでもポートを取れる', () => {
  const results = parseSsListen(SS_LISTEN_FIXTURE);
  const resolved = results.find((r) => r.port === 53);
  assert.ok(resolved);
  assert.equal(resolved.bind, '127.0.0.53%lo');
});

test('parseSsListen: IPv6 [::]:port 形式でもポートを取れる', () => {
  const results = parseSsListen(SS_LISTEN_FIXTURE);
  const manager = results.find((r) => r.port === 9026);
  assert.ok(manager);
  assert.equal(manager.uid, 1006);
});

test('parseCgroupHint: PM2 共通ラッパーを検出する', () => {
  const hint = parseCgroupHint('/system.slice/pm2-devrelay.service');
  assert.ok(hint);
  assert.equal(hint.lastSegment, 'pm2-devrelay.service');
  assert.equal(hint.isPm2Wrapper, true);
});

test('parseCgroupHint: systemd --user unit は個別 unit として検出する', () => {
  const hint = parseCgroupHint('/user.slice/user-1012.slice/user@1012.service/app.slice/dangou-viewer.service');
  assert.ok(hint);
  assert.equal(hint.lastSegment, 'dangou-viewer.service');
  assert.equal(hint.isPm2Wrapper, false);
});

test('parseCgroupHint: null 入力は null を返す', () => {
  assert.equal(parseCgroupHint(null), null);
});

test('parsePasswd: uid→username の Map を作る', () => {
  const text = [
    'root:x:0:0:root:/root:/bin/bash',
    'devrelay:x:1001:1001:,,,:/home/devrelay:/bin/bash',
    'uso8m:x:1012:1012:,,,:/home/uso8m:/bin/bash',
  ].join('\n');
  const map = parsePasswd(text);
  assert.equal(map.get(1001), 'devrelay');
  assert.equal(map.get(1012), 'uso8m');
  assert.equal(map.get(9999), undefined);
});

test('parseSsWithPid: pid= を含む行のみ port→pid を拾う', () => {
  const text = [
    'LISTEN 0 511 0.0.0.0:9010 0.0.0.0:* users:(("node",pid=3644996,fd=21))',
    'LISTEN 0 511 127.0.0.1:9023 0.0.0.0:*', // 他ユーザー所有なので pid なし
  ].join('\n');
  const map = parseSsWithPid(text);
  assert.equal(map.get(9010), 3644996);
  assert.equal(map.get(9023), undefined);
});

test('parsePsArgsForPort: --port N を含む行をヒントとして返す', () => {
  const text = [
    'devrelay 3644996 node /home/devrelay/testflight/tetris/node_modules/.bin/vite --port 9010 --host 0.0.0.0',
    'uso8m 4000001 python -c from viewer.server import main',
  ].join('\n');
  const hints = parsePsArgsForPort(text, 9010);
  assert.equal(hints.length, 1);
  assert.equal(hints[0].pid, 3644996);
  assert.equal(hints[0].user, 'devrelay');
});

test('parsePsArgsForPort: 該当なしの場合は空配列', () => {
  const hints = parsePsArgsForPort('uso8m 4000001 python -c from viewer.server import main', 9023);
  assert.deepEqual(hints, []);
});
