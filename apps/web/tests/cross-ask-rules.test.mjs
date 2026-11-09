// クロスユーザー Team Phase C（apps/web/src/lib/cross-ask-rules.ts）の単体テスト。
// 外部 import ゼロの純粋関数をコンパイル済み dist-test から直接 import する
// （cross-team-publish-rules.test.mjs と同じ流儀）。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  isCrossTab,
  shouldSendConnect,
  decideComposerCapabilities,
  buildCrossTabBanner,
  buildCrossTabBadge,
  resolveCrossHistorySource,
  flattenCrossAskGroups,
} from '../dist-test/lib/cross-ask-rules.js';

describe('isCrossTab / shouldSendConnect: 既存タブとの互換境界', () => {
  test('kind 未定義（既存タブ）は isCrossTab=false, shouldSendConnect=true', () => {
    assert.equal(isCrossTab(undefined), false);
    assert.equal(isCrossTab(null), false);
    assert.equal(isCrossTab({}), false);
    assert.equal(shouldSendConnect(undefined), true);
    assert.equal(shouldSendConnect({}), true);
  });

  test("kind: 'own' は isCrossTab=false, shouldSendConnect=true", () => {
    assert.equal(isCrossTab({ kind: 'own' }), false);
    assert.equal(shouldSendConnect({ kind: 'own' }), true);
  });

  test("kind: 'cross' のみ isCrossTab=true, shouldSendConnect=false", () => {
    assert.equal(isCrossTab({ kind: 'cross' }), true);
    assert.equal(shouldSendConnect({ kind: 'cross' }), false);
  });
});

describe('decideComposerCapabilities', () => {
  test('own タブは全て許可', () => {
    const caps = decideComposerCapabilities({ kind: 'own' });
    assert.deepEqual(caps, { allowFiles: true, allowCancel: true, allowExec: true, allowThreadList: true });
  });

  test('未定義（既存タブ互換）も全て許可', () => {
    const caps = decideComposerCapabilities(undefined);
    assert.deepEqual(caps, { allowFiles: true, allowCancel: true, allowExec: true, allowThreadList: true });
  });

  test('cross タブは全て禁止', () => {
    const caps = decideComposerCapabilities({ kind: 'cross' });
    assert.deepEqual(caps, { allowFiles: false, allowCancel: false, allowExec: false, allowThreadList: false });
  });
});

describe('buildCrossTabBanner', () => {
  test('オーナー名を含むバナー文言を組み立てる', () => {
    const banner = buildCrossTabBanner('gmail');
    assert.match(banner, /gmail/);
    assert.match(banner, /質問のみ/);
    assert.match(banner, /相手の契約/);
  });
});

describe('buildCrossTabBadge', () => {
  test("origin: 'subscription' は「購読」", () => {
    assert.equal(buildCrossTabBadge('subscription'), '購読');
  });
  test("origin: 'invite' は「借用」", () => {
    assert.equal(buildCrossTabBadge('invite'), '借用');
  });
});

describe('resolveCrossHistorySource', () => {
  test('常に kind: cross を返す', () => {
    const source = resolveCrossHistorySource({ projectId: 'proj1' });
    assert.deepEqual(source, { kind: 'cross', projectId: 'proj1' });
  });
});

describe('flattenCrossAskGroups', () => {
  test('owner → machine → project の 3 段を平坦な行リストに変換する', () => {
    const groups = [
      {
        ownerLabel: 'gmail',
        machines: [
          {
            machineId: 'm1',
            machineName: 'x220',
            status: 'online',
            projects: [
              { projectId: 'p1', label: 'pixterm-server', teamId: 't1', teamName: 'pixterm', origin: 'subscription', execAllowed: false },
              { projectId: 'p2', label: 'term-flutter', teamId: 't1', teamName: 'pixterm', origin: 'subscription', execAllowed: false },
            ],
          },
        ],
      },
    ];
    const rows = flattenCrossAskGroups(groups);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], {
      projectId: 'p1',
      label: 'pixterm-server',
      ownerLabel: 'gmail',
      machineName: 'x220',
      teamName: 'pixterm',
      origin: 'subscription',
      online: true,
    });
  });

  test('0 件のグループは空配列を返す', () => {
    assert.deepEqual(flattenCrossAskGroups([]), []);
  });

  test('offline マシンは online: false になる', () => {
    const rows = flattenCrossAskGroups([
      {
        ownerLabel: 'gmail',
        machines: [{ machineId: 'm1', machineName: 'x', status: 'offline', projects: [
          { projectId: 'p1', label: 'x', teamId: 't', teamName: 'team', origin: 'invite', execAllowed: false },
        ] }],
      },
    ]);
    assert.equal(rows[0].online, false);
  });
});
