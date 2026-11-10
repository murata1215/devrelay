// 外部 import ゼロの純粋関数（apps/server/src/services/cross-team-guard.ts）を
// コンパイル済み dist から直接 import する（既存 cross-query-guard.test.mjs と同じ流儀）。
// クロスユーザー Team（Phase 1: ask のみ）の認可判定ロジック

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  isCrossTeamEnabled,
  isCrossTeamExecEnabled,
  isCrossAskIsolationEnabled,
  decideCrossTeamAccess,
  buildCrossTeamDenyLog,
  CROSS_USER_ASK_TARGET_LIMIT,
  CROSS_USER_ASK_EXECUTOR_LIMIT,
  CROSS_USER_EXEC_TARGET_LIMIT,
  CROSS_USER_EXEC_CONCURRENCY,
} from '../dist/services/cross-team-guard.js';

const baseCandidate = {
  teamId: 'team-1',
  grantId: 'grant-1',
  granteeUserId: 'owner-b',
  askAllowed: true,
  execAllowed: false,
  revoked: false,
  callerQualified: true,
};

function baseInput(overrides = {}) {
  return {
    mode: 'ask',
    crossTeamEnabled: true,
    crossTeamExecEnabled: false,
    callerOrganizationId: 'org-1',
    targetOwnerOrganizationId: 'org-1',
    targetOwnerUserId: 'owner-b',
    candidates: [baseCandidate],
    ...overrides,
  };
}

// ---- キルスイッチ ----

describe('isCrossTeamEnabled / isCrossTeamExecEnabled: 既定 OFF（既存キルスイッチと逆方向）', () => {
  test('isCrossTeamEnabled: 未設定は false', () => {
    assert.equal(isCrossTeamEnabled(undefined), false);
  });
  test("isCrossTeamEnabled: '1' のときだけ true", () => {
    assert.equal(isCrossTeamEnabled('1'), true);
    assert.equal(isCrossTeamEnabled('0'), false);
    assert.equal(isCrossTeamEnabled('true'), false);
  });
  test('isCrossTeamExecEnabled: 未設定は false', () => {
    assert.equal(isCrossTeamExecEnabled(undefined), false);
  });
  test("isCrossTeamExecEnabled: '1' のときだけ true", () => {
    assert.equal(isCrossTeamExecEnabled('1'), true);
  });
});

describe('isCrossAskIsolationEnabled（サイクルG）: 既定 ON（既存キルスイッチの多数派と同方向）', () => {
  test('未設定は true（既定 ON）', () => {
    assert.equal(isCrossAskIsolationEnabled(undefined), true);
  });
  test("'0' のときだけ false", () => {
    assert.equal(isCrossAskIsolationEnabled('0'), false);
  });
  test("'0' 以外の値は true のまま", () => {
    assert.equal(isCrossAskIsolationEnabled('1'), true);
    assert.equal(isCrossAskIsolationEnabled(''), true);
    assert.equal(isCrossAskIsolationEnabled('false'), true);
  });
});

// ---- decideCrossTeamAccess ----

describe('decideCrossTeamAccess: キルスイッチ', () => {
  test('crossTeamEnabled=false → killSwitchOff', () => {
    const r = decideCrossTeamAccess(baseInput({ crossTeamEnabled: false }));
    assert.equal(r.allowed, false);
    assert.equal(r.denyReason, 'killSwitchOff');
  });

  test('exec モードで crossTeamExecEnabled=false → execKillSwitchOff（crossTeamEnabled が true でも）', () => {
    const r = decideCrossTeamAccess(baseInput({
      mode: 'exec',
      candidates: [{ ...baseCandidate, execAllowed: true }],
    }));
    assert.equal(r.allowed, false);
    assert.equal(r.denyReason, 'execKillSwitchOff');
  });

  test('ask モードは crossTeamExecEnabled を見ない', () => {
    const r = decideCrossTeamAccess(baseInput({ crossTeamExecEnabled: false }));
    assert.equal(r.allowed, true);
  });
});

describe('decideCrossTeamAccess: 組織境界', () => {
  test('callerOrganizationId が null → noOrganization', () => {
    const r = decideCrossTeamAccess(baseInput({ callerOrganizationId: null }));
    assert.equal(r.denyReason, 'noOrganization');
  });

  test('targetOwnerOrganizationId が null → noOrganization', () => {
    const r = decideCrossTeamAccess(baseInput({ targetOwnerOrganizationId: null }));
    assert.equal(r.denyReason, 'noOrganization');
  });

  test('組織が不一致 → orgMismatch', () => {
    const r = decideCrossTeamAccess(baseInput({ targetOwnerOrganizationId: 'org-2' }));
    assert.equal(r.denyReason, 'orgMismatch');
  });

  test('両者組織未所属（null, null）でも noOrganization（「組織なしなら構造的に不可」）', () => {
    const r = decideCrossTeamAccess(baseInput({ callerOrganizationId: null, targetOwnerOrganizationId: null }));
    assert.equal(r.denyReason, 'noOrganization');
  });
});

describe('decideCrossTeamAccess: 候補が無い', () => {
  test('candidates が空 → noGrant', () => {
    const r = decideCrossTeamAccess(baseInput({ candidates: [] }));
    assert.equal(r.allowed, false);
    assert.equal(r.denyReason, 'noGrant');
  });
});

describe('decideCrossTeamAccess: 正常系（ask）', () => {
  test('全条件を満たす候補があれば allowed=true、grantId/teamId を返す', () => {
    const r = decideCrossTeamAccess(baseInput());
    assert.equal(r.allowed, true);
    assert.equal(r.grantId, 'grant-1');
    assert.equal(r.teamId, 'team-1');
  });
});

describe('decideCrossTeamAccess: 宛先所有者スナップショットの不一致', () => {
  test('granteeUserId が現在の所有者と食い違う → granteeOwnerMismatch', () => {
    const r = decideCrossTeamAccess(baseInput({
      candidates: [{ ...baseCandidate, granteeUserId: 'someone-else' }],
    }));
    assert.equal(r.denyReason, 'granteeOwnerMismatch');
  });
});

describe('decideCrossTeamAccess: revoked', () => {
  test('revoked=true の grant は無効（grantRevoked）', () => {
    const r = decideCrossTeamAccess(baseInput({
      candidates: [{ ...baseCandidate, revoked: true }],
    }));
    assert.equal(r.denyReason, 'grantRevoked');
  });
});

describe('decideCrossTeamAccess: 第三者ブリッジ禁止', () => {
  test('callerQualified=false（発信者がその Team に資格を持たない）→ callerNotQualified', () => {
    const r = decideCrossTeamAccess(baseInput({
      candidates: [{ ...baseCandidate, callerQualified: false }],
    }));
    assert.equal(r.denyReason, 'callerNotQualified');
  });

  test('A のチームに B・C が個別同意 → B から C への到達は拒否される（callerQualified=false を期待）', () => {
    // B がオーナーでも grantee でもない Team 経由で C（grantee）にアクセスしようとするケースの表現
    const r = decideCrossTeamAccess(baseInput({
      targetOwnerUserId: 'owner-c',
      candidates: [{ ...baseCandidate, granteeUserId: 'owner-c', callerQualified: false }],
    }));
    assert.equal(r.allowed, false);
    assert.equal(r.denyReason, 'callerNotQualified');
  });
});

describe('decideCrossTeamAccess: ask は許可だが exec は未許可', () => {
  test('askAllowed=true, execAllowed=false の grant で exec を要求 → execNotGranted', () => {
    const r = decideCrossTeamAccess(baseInput({
      mode: 'exec',
      crossTeamExecEnabled: true,
      candidates: [{ ...baseCandidate, askAllowed: true, execAllowed: false }],
    }));
    assert.equal(r.denyReason, 'execNotGranted');
  });

  test('execAllowed=true かつ exec キルスイッチ ON なら exec 許可', () => {
    const r = decideCrossTeamAccess(baseInput({
      mode: 'exec',
      crossTeamExecEnabled: true,
      candidates: [{ ...baseCandidate, execAllowed: true }],
    }));
    assert.equal(r.allowed, true);
  });
});

describe('decideCrossTeamAccess: 複数候補（1件目は無効、2件目で許可）', () => {
  test('1件目 revoked、2件目が有効 → 2件目の grantId で許可', () => {
    const r = decideCrossTeamAccess(baseInput({
      candidates: [
        { ...baseCandidate, grantId: 'grant-revoked', revoked: true },
        { ...baseCandidate, grantId: 'grant-valid' },
      ],
    }));
    assert.equal(r.allowed, true);
    assert.equal(r.grantId, 'grant-valid');
  });

  test('denyReason の優先順位: execNotGranted > grantRevoked > callerNotQualified > granteeOwnerMismatch', () => {
    const r = decideCrossTeamAccess(baseInput({
      mode: 'exec',
      crossTeamExecEnabled: true,
      candidates: [
        { ...baseCandidate, granteeUserId: 'wrong-owner' }, // granteeOwnerMismatch
        { ...baseCandidate, callerQualified: false },        // callerNotQualified
        { ...baseCandidate, revoked: true },                 // grantRevoked
        { ...baseCandidate, execAllowed: false },             // execNotGranted
      ],
    }));
    assert.equal(r.denyReason, 'execNotGranted');
  });
});

// ---- buildCrossTeamDenyLog ----

test('buildCrossTeamDenyLog: ログ 1 行を組み立てる（denyReason を含む）', () => {
  const line = buildCrossTeamDenyLog({
    callerMachineId: 'machine-1',
    targetProjectName: 'my-project',
    mode: 'ask',
    denyReason: 'noGrant',
  });
  assert.match(line, /machine-1/);
  assert.match(line, /my-project/);
  assert.match(line, /noGrant/);
});

// ---- レート閾値定数（固定値として検証。変更時は意図的な判断を要求する） ----

test('クロスユーザー専用レート閾値は仕様どおりの値', () => {
  assert.equal(CROSS_USER_ASK_TARGET_LIMIT, 4);
  assert.equal(CROSS_USER_ASK_EXECUTOR_LIMIT, 6);
  assert.equal(CROSS_USER_EXEC_TARGET_LIMIT, 2);
  assert.equal(CROSS_USER_EXEC_CONCURRENCY, 1);
});
