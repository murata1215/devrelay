/**
 * クロスユーザー Team の認可判定（DB ラッパ）。
 *
 * 判定ロジック自体（`decideCrossTeamAccess`）は `cross-team-guard.ts` の純関数に委ねる。
 * このファイルの役割は「候補行を DB から集めて渡す」だけ。
 *
 * 第三者ブリッジ禁止の実装方針（callerQualified の決め方）:
 * 「Team オーナー本人であり、かつ発信に使ったマシンの自分のプロジェクトがその Team の
 * メンバーである」場合のみ資格ありとする。Team 内の他の招待メンバー（grantee）同士は
 * 互いに資格を持たない（A のチームに B・C が個別に同意しても、B から C へは到達できない）。
 * これは既存の同一ユーザー経路（`document-api.ts` の `team: { members: { some: { project: { machineId } } } }`）
 * と同形の「発信マシンがその Team のメンバーである」条件に、オーナー本人限定を重ねたもの。
 */

import type { Project } from '@prisma/client';
import { prisma } from '../db/client.js';
import {
  decideCrossTeamAccess,
  isCrossTeamEnabled,
  isCrossTeamExecEnabled,
  type CrossTeamCandidateGrant,
  type CrossTeamDecision,
} from './cross-team-guard.js';

/**
 * 宛先プロジェクトに紐づく `CrossTeamGrant` 候補をすべて取得し、各候補について
 * 発信側の資格（callerQualified）を判定する。
 *
 * revoked・宛先所有者不一致の行も除外せずそのまま返す
 * （`decideCrossTeamAccess` 側で denyReason を区別できるようにするため）。
 */
export async function loadCrossTeamCandidates(input: {
  callerMachineId: string;
  callerUserId: string;
  targetProjectId: string;
}): Promise<CrossTeamCandidateGrant[]> {
  const grants = await prisma.crossTeamGrant.findMany({
    where: { projectId: input.targetProjectId },
    select: {
      id: true,
      teamId: true,
      granteeUserId: true,
      askAllowed: true,
      execAllowed: true,
      revokedAt: true,
    },
  });
  if (grants.length === 0) return [];

  const teamIds = [...new Set(grants.map((g) => g.teamId))];
  const teams = await prisma.team.findMany({
    where: { id: { in: teamIds } },
    select: {
      id: true,
      userId: true,
      members: { select: { project: { select: { machineId: true } } } },
    },
  });
  const qualifiedTeamIds = new Set(
    teams
      .filter(
        (t) =>
          t.userId === input.callerUserId &&
          t.members.some((m) => m.project.machineId === input.callerMachineId),
      )
      .map((t) => t.id),
  );

  return grants.map((g) => ({
    teamId: g.teamId,
    grantId: g.id,
    granteeUserId: g.granteeUserId,
    askAllowed: g.askAllowed,
    execAllowed: g.execAllowed,
    revoked: g.revokedAt !== null,
    callerQualified: qualifiedTeamIds.has(g.teamId),
  }));
}

export interface ResolveCrossTeamAccessInput {
  callerMachineId: string;
  callerUserId: string;
  targetProjectId: string;
  /** 宛先マシンの現在の所有者（grant のスナップショットではなく実データ） */
  targetOwnerUserId: string;
  mode: 'ask' | 'exec';
}

/**
 * クロスユーザーの ask/exec を許可するかを判定する（DB 読み取り + 純関数判定）。
 * キルスイッチが OFF の場合は DB を一切読まずに即座に拒否する（本番の既定状態での負荷ゼロ）。
 */
export async function resolveCrossTeamAccess(input: ResolveCrossTeamAccessInput): Promise<CrossTeamDecision> {
  const crossTeamEnabled = isCrossTeamEnabled(process.env.DEVRELAY_CROSS_TEAM);
  const crossTeamExecEnabled = isCrossTeamExecEnabled(process.env.DEVRELAY_CROSS_TEAM_EXEC);

  if (!crossTeamEnabled) {
    return { allowed: false, denyReason: 'killSwitchOff' };
  }
  if (input.mode === 'exec' && !crossTeamExecEnabled) {
    return { allowed: false, denyReason: 'execKillSwitchOff' };
  }

  const [candidates, callerMembership, targetMembership] = await Promise.all([
    loadCrossTeamCandidates({
      callerMachineId: input.callerMachineId,
      callerUserId: input.callerUserId,
      targetProjectId: input.targetProjectId,
    }),
    prisma.organizationMember.findUnique({
      where: { userId: input.callerUserId },
      select: { organizationId: true },
    }),
    prisma.organizationMember.findUnique({
      where: { userId: input.targetOwnerUserId },
      select: { organizationId: true },
    }),
  ]);

  return decideCrossTeamAccess({
    mode: input.mode,
    crossTeamEnabled,
    crossTeamExecEnabled,
    callerOrganizationId: callerMembership?.organizationId ?? null,
    targetOwnerOrganizationId: targetMembership?.organizationId ?? null,
    targetOwnerUserId: input.targetOwnerUserId,
    candidates,
  });
}

/** `listCrossTeamAskCandidateProjects` が返す候補 1 件。 */
export type CrossTeamAskCandidateProject = Project & {
  machine: { id: string; name: string; displayName: string | null; status: string; userId: string };
  crossTeam: { teamId: string; grantId: string };
};

/**
 * チャット経路（ask コマンド、`command-handler.ts` の `resolveCrossTargetByName`）向け:
 * 発信者（dbUserId）が Team オーナーとして持つ、有効な ask grant の宛先プロジェクト一覧を返す。
 *
 * チャットには「発信に使ったマシン」という概念が無い（#295 の既存コメント通り、同名複数が
 * あれば宛先を特定できず中止する設計で解決している）。そのため `document-api.ts` の
 * Agent REST 経路のような machineId ベースの callerQualified 判定は行わず、
 * 「dbUserId がその Team のオーナー本人であること」だけを資格とする
 * （チャットから teamexec を転送できるのは自分の Team だけ、という既存の設計方針と対称）。
 *
 * teamexec（exec）はここでは扱わない。Phase 2 で別途解禁する。
 */
export async function listCrossTeamAskCandidateProjects(callerUserId: string): Promise<CrossTeamAskCandidateProject[]> {
  if (!isCrossTeamEnabled(process.env.DEVRELAY_CROSS_TEAM)) {
    return [];
  }

  // requesterUserId は grant 作成時点の Team オーナーのスナップショット（= この関数の呼び出し元の
  // 文脈では「自分がオーナーとして発行した grant」を絞り込む条件として十分。Team に直接の
  // relation を張っていない CrossTeamGrant.teamId の代わりにこちらを使う）
  const grants = await prisma.crossTeamGrant.findMany({
    where: { askAllowed: true, revokedAt: null, requesterUserId: callerUserId },
    select: { id: true, teamId: true, projectId: true, granteeUserId: true },
  });
  if (grants.length === 0) return [];

  // 組織境界の実行時再検証（grant の organizationId スナップショットではなく現在の
  // OrganizationMember を見る。どちらかが組織を抜けた直後に即座に候補から外れる）
  const callerMembership = await prisma.organizationMember.findUnique({
    where: { userId: callerUserId },
    select: { organizationId: true },
  });
  if (!callerMembership) return [];

  const granteeUserIds = [...new Set(grants.map((g) => g.granteeUserId))];
  const granteeMemberships = await prisma.organizationMember.findMany({
    where: { userId: { in: granteeUserIds } },
    select: { userId: true, organizationId: true },
  });
  const sameOrgGranteeIds = new Set(
    granteeMemberships.filter((m) => m.organizationId === callerMembership.organizationId).map((m) => m.userId),
  );

  const grantByProjectId = new Map(
    grants.filter((g) => sameOrgGranteeIds.has(g.granteeUserId)).map((g) => [g.projectId, g]),
  );
  if (grantByProjectId.size === 0) return [];

  const projects = await prisma.project.findMany({
    where: { id: { in: [...grantByProjectId.keys()] }, deletedAt: null, machine: { deletedAt: null } },
    include: { machine: { select: { id: true, name: true, displayName: true, status: true, userId: true } } },
  });

  // 宛先所有者の現在値が grant 作成時のスナップショット（granteeUserId）と食い違えば除外
  // （プロジェクトの譲渡・マシン付け替え後に古い grant が残っているケースの保険）
  return projects
    .filter((p) => grantByProjectId.get(p.id)?.granteeUserId === p.machine.userId)
    .map((p) => {
      const g = grantByProjectId.get(p.id)!;
      return { ...p, crossTeam: { teamId: g.teamId, grantId: g.id } };
    });
}
