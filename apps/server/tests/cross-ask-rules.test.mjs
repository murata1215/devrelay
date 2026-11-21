// クロスユーザー Team Phase C（apps/server/src/services/cross-ask-rules.ts）の純粋関数テスト。
// 外部 import ゼロの純粋関数をコンパイル済み dist から直接 import する
// （cross-team-publish.test.mjs と同じ流儀）。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCrossAskTargetGroups,
  resolveCrossAskOrigin,
  decideCrossAskInput,
  buildCrossAskContextPrefix,
  CROSS_ASK_CONTEXT_PREFIX_MAX_CHARS,
  CROSS_ASK_CONTEXT_PREFIX_TURNS,
} from '../dist/services/cross-ask-rules.js';
import { isCrossTeamChatEnabled, isCrossTeamChatContextEnabled } from '../dist/services/cross-team-guard.js';

describe('isCrossTeamChatEnabled / isCrossTeamChatContextEnabled: 既定 ON（DEVRELAY_CROSS_TEAM_CHAT 系の境界値）', () => {
  test('未設定は true（既定 ON）', () => {
    assert.equal(isCrossTeamChatEnabled(undefined), true);
    assert.equal(isCrossTeamChatContextEnabled(undefined), true);
  });
  test("'0' のときだけ false（'false'/'1' は true）", () => {
    assert.equal(isCrossTeamChatEnabled('0'), false);
    assert.equal(isCrossTeamChatEnabled('false'), true);
    assert.equal(isCrossTeamChatEnabled('1'), true);
    assert.equal(isCrossTeamChatContextEnabled('0'), false);
  });
});

describe('resolveCrossAskOrigin', () => {
  test("grantId が 'sub:' 始まりなら subscription", () => {
    assert.equal(resolveCrossAskOrigin('sub:abc123'), 'subscription');
  });
  test('それ以外（招待型の cuid）は invite', () => {
    assert.equal(resolveCrossAskOrigin('cuid_abcdefg'), 'invite');
  });
});

describe('decideCrossAskInput', () => {
  test('空文字は拒否', () => {
    assert.deepEqual(decideCrossAskInput({ text: '' }), { ok: false, error: 'empty' });
  });
  test('空白のみは拒否', () => {
    assert.deepEqual(decideCrossAskInput({ text: '   \n\t' }), { ok: false, error: 'empty' });
  });
  test('非空文字は許可', () => {
    assert.deepEqual(decideCrossAskInput({ text: 'こんにちは' }), { ok: true });
  });
});

describe('buildCrossAskTargetGroups: owner → machine → project のグループ化', () => {
  const rows = [
    { ownerLabel: 'gmail', machineId: 'm2', machineName: 'mac', status: 'offline', projectId: 'p3', label: 'z-proj', teamId: 't2', teamName: 'team2', origin: 'invite' },
    { ownerLabel: 'gmail', machineId: 'm1', machineName: 'x220', status: 'online', projectId: 'p2', label: 'term-flutter', teamId: 't1', teamName: 'pixterm', origin: 'subscription' },
    { ownerLabel: 'gmail', machineId: 'm1', machineName: 'x220', status: 'online', projectId: 'p1', label: 'pixterm-server', teamId: 't1', teamName: 'pixterm', origin: 'subscription' },
    { ownerLabel: 'bravo', machineId: 'm3', machineName: 'win', status: 'online', projectId: 'p4', label: 'a-proj', teamId: 't3', teamName: 'team3', origin: 'invite' },
  ];

  test('owner は名前の昇順（bravo < gmail）', () => {
    const groups = buildCrossAskTargetGroups(rows);
    assert.deepEqual(groups.map(g => g.ownerLabel), ['bravo', 'gmail']);
  });

  test('machine は online 優先、同条件なら名前昇順', () => {
    const groups = buildCrossAskTargetGroups(rows);
    const gmail = groups.find(g => g.ownerLabel === 'gmail');
    assert.deepEqual(gmail.machines.map(m => m.machineId), ['m1', 'm2']);
    assert.equal(gmail.machines[0].status, 'online');
    assert.equal(gmail.machines[1].status, 'offline');
  });

  test('project は label の昇順', () => {
    const groups = buildCrossAskTargetGroups(rows);
    const gmail = groups.find(g => g.ownerLabel === 'gmail');
    const m1 = gmail.machines.find(m => m.machineId === 'm1');
    assert.deepEqual(m1.projects.map(p => p.label), ['pixterm-server', 'term-flutter']);
  });

  test('execAllowed は常に false（Phase 2 まで型レベルで固定）', () => {
    const groups = buildCrossAskTargetGroups(rows);
    for (const g of groups) {
      for (const m of g.machines) {
        for (const p of m.projects) {
          assert.equal(p.execAllowed, false);
        }
      }
    }
  });

  test('0 件は空配列', () => {
    assert.deepEqual(buildCrossAskTargetGroups([]), []);
  });
});

describe('buildCrossAskContextPrefix: 案 B（文脈前置）', () => {
  test('メッセージ 0 件は空文字（前置なし）', () => {
    assert.equal(buildCrossAskContextPrefix([]), '');
  });

  test('直近 N 往復（既定 3）だけを使う（古い方は無視）', () => {
    const messages = [];
    for (let i = 0; i < 10; i++) {
      messages.push({ role: 'user', content: `質問${i}` });
      messages.push({ role: 'ai', content: `回答${i}` });
    }
    const prefix = buildCrossAskContextPrefix(messages);
    // 直近 3 往復 = 直近 6 件 = 質問7〜質問9・回答7〜回答9
    assert.ok(prefix.includes('質問7'));
    assert.ok(prefix.includes('回答9'));
    assert.ok(!prefix.includes('質問6'));
    assert.ok(!prefix.includes('質問0'));
  });

  test('前置文の既定上限は 6000 文字・直近 3 往復（定数のドキュメント化）', () => {
    assert.equal(CROSS_ASK_CONTEXT_PREFIX_MAX_CHARS, 6000);
    assert.equal(CROSS_ASK_CONTEXT_PREFIX_TURNS, 3);
  });

  test('maxChars を超える場合は truncate される（先頭側を切り捨てる）', () => {
    const longContent = 'あ'.repeat(10000);
    const messages = [
      { role: 'user', content: longContent },
      { role: 'ai', content: '短い回答' },
    ];
    const prefix = buildCrossAskContextPrefix(messages, 100);
    // ヘッダ/フッタの固定文言を除いた本文部分が 100 文字以内に収まっている
    assert.ok(prefix.includes('短い回答'));
    assert.ok(prefix.length < longContent.length);
  });

  test('「これまでのやりとり（参考）」であることを明示する', () => {
    const prefix = buildCrossAskContextPrefix([{ role: 'user', content: 'hi' }, { role: 'ai', content: 'hello' }]);
    assert.match(prefix, /これまでのやりとり/);
    assert.match(prefix, /参考/);
  });
});
