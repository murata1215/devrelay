// 外部 import ゼロの純粋関数（apps/server/src/services/cross-team-publish.ts）を
// コンパイル済み dist から直接 import する（cross-team-guard.test.mjs と同じ流儀）。
// 公開型クロスユーザー Team（Phase A: サーバー + 認可のみ）の純関数群。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { decideCrossTeamAccess } from '../dist/services/cross-team-guard.js';
import {
  isCrossTeamPublishEnabled,
  isPublishedVisibility,
  TEAM_VISIBILITY_PRIVATE,
  TEAM_VISIBILITY_ORGANIZATION,
  selectPublishableMembers,
  buildSubscriptionCandidates,
} from '../dist/services/cross-team-publish.js';

// ---- キルスイッチ ----

describe('isCrossTeamPublishEnabled: 既定 OFF（DEVRELAY_CROSS_TEAM と同じ逆方向）', () => {
  test('未設定は false', () => {
    assert.equal(isCrossTeamPublishEnabled(undefined), false);
  });
  test("'1' のときだけ true（'true'/'0' は false）", () => {
    assert.equal(isCrossTeamPublishEnabled('1'), true);
    assert.equal(isCrossTeamPublishEnabled('0'), false);
    assert.equal(isCrossTeamPublishEnabled('true'), false);
  });
});

describe('isPublishedVisibility', () => {
  test("'organization' のみ true", () => {
    assert.equal(isPublishedVisibility(TEAM_VISIBILITY_ORGANIZATION), true);
    assert.equal(isPublishedVisibility(TEAM_VISIBILITY_PRIVATE), false);
  });
  test('null/undefined/未知の値は false（安全側）', () => {
    assert.equal(isPublishedVisibility(null), false);
    assert.equal(isPublishedVisibility(undefined), false);
    assert.equal(isPublishedVisibility('public'), false);
  });
});

// ---- selectPublishableMembers（又貸し防止の核心） ----

describe('selectPublishableMembers: 又貸し防止（チームオーナー自身が所有するプロジェクトだけを残す）', () => {
  test('招待で受け入れた他人のプロジェクトは除外される', () => {
    const members = [
      { teamId: 't1', teamOwnerUserId: 'owner', projectId: 'p-own', ownerUserId: 'owner' },
      { teamId: 't1', teamOwnerUserId: 'owner', projectId: 'p-borrowed', ownerUserId: 'someone-else' },
    ];
    const result = selectPublishableMembers(members);
    assert.deepEqual(result.map((m) => m.projectId), ['p-own']);
  });

  test('全てオーナー自身のプロジェクトなら全件残る', () => {
    const members = [
      { teamId: 't1', teamOwnerUserId: 'owner', projectId: 'p1', ownerUserId: 'owner' },
      { teamId: 't1', teamOwnerUserId: 'owner', projectId: 'p2', ownerUserId: 'owner' },
    ];
    assert.equal(selectPublishableMembers(members).length, 2);
  });

  test('複数チーム（オーナーが異なる）が混在していても行ごとに正しく判定する', () => {
    const members = [
      { teamId: 't1', teamOwnerUserId: 'alice', projectId: 'p1', ownerUserId: 'alice' }, // alice 自身 → 残る
      { teamId: 't2', teamOwnerUserId: 'bob', projectId: 'p1', ownerUserId: 'alice' },   // bob のチームに alice のプロジェクト → 又貸し、除外
    ];
    const result = selectPublishableMembers(members);
    assert.equal(result.length, 1);
    assert.equal(result[0].teamId, 't1');
  });

  test('空配列は空配列を返す', () => {
    assert.deepEqual(selectPublishableMembers([]), []);
  });
});

// ---- buildSubscriptionCandidates ----

function baseSubscription(overrides = {}) {
  return {
    id: 'sub-1',
    teamId: 'team-1',
    subscriberUserId: 'caller',
    askAllowed: true,
    revokedAt: null,
    ...overrides,
  };
}

function baseParams(overrides = {}) {
  return {
    callerUserId: 'caller',
    targetOwnerUserId: 'owner',
    subscriptions: [baseSubscription()],
    publishedTeams: [{ teamId: 'team-1', teamOwnerUserId: 'owner' }],
    ...overrides,
  };
}

describe('buildSubscriptionCandidates: 不変条件', () => {
  test('正常系: 1 件の候補が合成される', () => {
    const result = buildSubscriptionCandidates(baseParams());
    assert.equal(result.length, 1);
    assert.deepEqual(result[0], {
      teamId: 'team-1',
      grantId: 'sub:sub-1',
      granteeUserId: 'owner',
      askAllowed: true,
      execAllowed: false,
      revoked: false,
      callerQualified: true,
    });
  });

  test('他人の購読（subscriberUserId !== callerUserId）は捨てる', () => {
    const result = buildSubscriptionCandidates(
      baseParams({ subscriptions: [baseSubscription({ subscriberUserId: 'someone-else' })] }),
    );
    assert.equal(result.length, 0);
  });

  test('又貸し防止の二重化: publishedTeams に対応するチームの所有者が targetOwnerUserId と不一致なら捨てる', () => {
    const result = buildSubscriptionCandidates(
      baseParams({ publishedTeams: [{ teamId: 'team-1', teamOwnerUserId: 'not-the-target-owner' }] }),
    );
    assert.equal(result.length, 0);
  });

  test('publishedTeams に対応するチームが無い（既に非公開化された等）場合は捨てる', () => {
    const result = buildSubscriptionCandidates(baseParams({ publishedTeams: [] }));
    assert.equal(result.length, 0);
  });

  test('execAllowed は常に false（購読元の askAllowed の値に関わらず）', () => {
    const result = buildSubscriptionCandidates(baseParams());
    assert.equal(result[0].execAllowed, false);
  });

  test('revokedAt が非 null なら revoked: true になる', () => {
    const result = buildSubscriptionCandidates(
      baseParams({ subscriptions: [baseSubscription({ revokedAt: new Date('2026-11-08T00:00:00Z') })] }),
    );
    assert.equal(result[0].revoked, true);
  });

  test('grantId は sub: 接頭辞で実 grant と区別できる', () => {
    const result = buildSubscriptionCandidates(baseParams({ subscriptions: [baseSubscription({ id: 'xyz' })] }));
    assert.equal(result[0].grantId, 'sub:xyz');
  });

  test('複数の購読をまとめて正しく処理する', () => {
    const result = buildSubscriptionCandidates(
      baseParams({
        subscriptions: [
          baseSubscription({ id: 's1', teamId: 'team-1' }),
          baseSubscription({ id: 's2', teamId: 'team-2' }),
        ],
        publishedTeams: [
          { teamId: 'team-1', teamOwnerUserId: 'owner' },
          { teamId: 'team-2', teamOwnerUserId: 'owner' },
        ],
      }),
    );
    assert.equal(result.length, 2);
    assert.deepEqual(result.map((r) => r.grantId).sort(), ['sub:s1', 'sub:s2']);
  });
});

// ---- 合成した候補を decideCrossTeamAccess にそのまま渡せることの証明（純関数が無改造で公開型を扱える） ----

describe('合成した CrossTeamCandidateGrant を decideCrossTeamAccess にそのまま渡せる', () => {
  test('正常系: 購読があれば allowed になる（decideCrossTeamAccess は無改造）', () => {
    const candidates = buildSubscriptionCandidates(baseParams());
    const r = decideCrossTeamAccess({
      mode: 'ask',
      crossTeamEnabled: true,
      crossTeamExecEnabled: false,
      callerOrganizationId: 'org-1',
      targetOwnerOrganizationId: 'org-1',
      targetOwnerUserId: 'owner',
      candidates,
    });
    assert.equal(r.allowed, true);
    assert.equal(r.grantId, 'sub:sub-1');
    assert.equal(r.teamId, 'team-1');
  });

  test('又貸し防止: selectPublishableMembers で除外された行は候補に残らず、decideCrossTeamAccess も denyReason: noGrant になる', () => {
    // 招待で借りたプロジェクトを含むチームを公開しても、borrowed 行は公開可能メンバーに残らない
    const members = [
      { teamId: 'team-1', teamOwnerUserId: 'owner', projectId: 'p-borrowed', ownerUserId: 'someone-else' },
    ];
    const publishable = selectPublishableMembers(members);
    assert.equal(publishable.length, 0, '又貸しの行は公開可能メンバーに残らない');

    // publishable が空なので、購読があっても candidates は合成されない
    const candidates = buildSubscriptionCandidates(
      baseParams({ publishedTeams: publishable.map((m) => ({ teamId: m.teamId, teamOwnerUserId: m.teamOwnerUserId })) }),
    );
    assert.equal(candidates.length, 0);

    const r = decideCrossTeamAccess({
      mode: 'ask',
      crossTeamEnabled: true,
      crossTeamExecEnabled: false,
      callerOrganizationId: 'org-1',
      targetOwnerOrganizationId: 'org-1',
      targetOwnerUserId: 'owner',
      candidates,
    });
    assert.equal(r.allowed, false);
    assert.equal(r.denyReason, 'noGrant');
  });

  test('exec は常に拒否される（execAllowed が常に false のため execKillSwitchOff ではなく execNotGranted）', () => {
    const candidates = buildSubscriptionCandidates(baseParams());
    const r = decideCrossTeamAccess({
      mode: 'exec',
      crossTeamEnabled: true,
      crossTeamExecEnabled: true, // exec キルスイッチが ON でも
      callerOrganizationId: 'org-1',
      targetOwnerOrganizationId: 'org-1',
      targetOwnerUserId: 'owner',
      candidates,
    });
    assert.equal(r.allowed, false);
    assert.equal(r.denyReason, 'execNotGranted');
  });
});
