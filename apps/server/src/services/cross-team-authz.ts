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
import {
  isCrossTeamPublishEnabled,
  selectPublishableMembers,
  buildSubscriptionCandidates,
} from './cross-team-publish.js';

/**
 * 宛先プロジェクトに紐づく `CrossTeamGrant` 候補をすべて取得し、各候補について
 * 発信側の資格（callerQualified）を判定する。
 *
 * revoked・宛先所有者不一致の行も除外せずそのまま返す
 * （`decideCrossTeamAccess` 側で denyReason を区別できるようにするため）。
 */
async function loadInviteGrantCandidates(input: {
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

/**
 * 公開型 Team（Phase A）: 宛先プロジェクトを公開可能メンバーとして持つチームの購読から
 * 候補を合成する。キルスイッチ（`DEVRELAY_CROSS_TEAM_PUBLISH`）OFF 時は DB を一切読まない。
 *
 * 又貸し防止: `selectPublishableMembers()` で「チームオーナー自身が所有するプロジェクト」に
 * 限定した上で、`buildSubscriptionCandidates()` でもオーナー不一致を二重にチェックする。
 */
async function loadSubscriptionCandidates(input: {
  callerUserId: string;
  targetProjectId: string;
  targetOwnerUserId: string;
}): Promise<CrossTeamCandidateGrant[]> {
  if (!isCrossTeamPublishEnabled(process.env.DEVRELAY_CROSS_TEAM_PUBLISH)) return [];

  const members = await prisma.teamMember.findMany({
    where: { projectId: input.targetProjectId, team: { visibility: 'organization' } },
    select: {
      team: { select: { id: true, userId: true } },
      project: { select: { machine: { select: { userId: true } } } },
    },
  });
  if (members.length === 0) return [];

  const publishable = selectPublishableMembers(
    members.map((m) => ({
      teamId: m.team.id,
      teamOwnerUserId: m.team.userId,
      projectId: input.targetProjectId,
      ownerUserId: m.project.machine.userId,
    })),
  );
  if (publishable.length === 0) return [];

  const teamIds = publishable.map((m) => m.teamId);
  const subscriptions = await prisma.teamSubscription.findMany({
    where: { teamId: { in: teamIds }, subscriberUserId: input.callerUserId },
    select: { id: true, teamId: true, subscriberUserId: true, askAllowed: true, revokedAt: true },
  });
  if (subscriptions.length === 0) return [];

  return buildSubscriptionCandidates({
    callerUserId: input.callerUserId,
    targetOwnerUserId: input.targetOwnerUserId,
    subscriptions,
    publishedTeams: publishable.map((m) => ({ teamId: m.teamId, teamOwnerUserId: m.teamOwnerUserId })),
  });
}

/**
 * 宛先プロジェクトへの候補を全て集める（招待型の実 grant + 公開型の購読合成）。
 * `decideCrossTeamAccess()` はどちらの由来かを区別しない（`CrossTeamCandidateGrant` という
 * 共通の形に揃えて渡すだけ）。
 */
export async function loadCrossTeamCandidates(input: {
  callerMachineId: string;
  callerUserId: string;
  targetProjectId: string;
  targetOwnerUserId: string;
}): Promise<CrossTeamCandidateGrant[]> {
  const [inviteCandidates, subscriptionCandidates] = await Promise.all([
    loadInviteGrantCandidates(input),
    loadSubscriptionCandidates(input),
  ]);
  return [...inviteCandidates, ...subscriptionCandidates];
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
      targetOwnerUserId: input.targetOwnerUserId,
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
 * 公開型 Team（Phase A）: チャット経路向けに、自分の有効な購読から公開可能なプロジェクトを
 * `projectId → { id, teamId, projectId, granteeUserId }` の Map で返す（招待型の
 * `grantByProjectId` と同じ形に揃え、呼び出し側で同じ dedup ロジックに合流させる）。
 * キルスイッチ OFF 時は DB を一切読まない。
 */
async function loadSubscriptionAskCandidateEntries(
  callerUserId: string,
  callerOrganizationId: string,
): Promise<Map<string, { id: string; teamId: string; projectId: string; granteeUserId: string }>> {
  const empty = new Map<string, { id: string; teamId: string; projectId: string; granteeUserId: string }>();
  if (!isCrossTeamPublishEnabled(process.env.DEVRELAY_CROSS_TEAM_PUBLISH)) return empty;

  const subscriptions = await prisma.teamSubscription.findMany({
    where: { subscriberUserId: callerUserId, askAllowed: true, revokedAt: null },
    select: { id: true, teamId: true },
  });
  if (subscriptions.length === 0) return empty;

  const teams = await prisma.team.findMany({
    where: { id: { in: subscriptions.map((s) => s.teamId) }, visibility: 'organization' },
    select: {
      id: true,
      userId: true,
      members: { select: { projectId: true, project: { select: { machine: { select: { userId: true } } } } } },
    },
  });
  if (teams.length === 0) return empty;

  // 組織境界の実行時再検証: 公開者（team.userId）が caller と同じ組織か確認
  const ownerMemberships = await prisma.organizationMember.findMany({
    where: { userId: { in: [...new Set(teams.map((t) => t.userId))] } },
    select: { userId: true, organizationId: true },
  });
  const sameOrgOwnerIds = new Set(
    ownerMemberships.filter((m) => m.organizationId === callerOrganizationId).map((m) => m.userId),
  );

  const subscriptionByTeamId = new Map(subscriptions.map((s) => [s.teamId, s]));
  const result = empty;
  for (const team of teams) {
    if (!sameOrgOwnerIds.has(team.userId)) continue;
    const sub = subscriptionByTeamId.get(team.id);
    if (!sub) continue;
    const publishable = selectPublishableMembers(
      team.members.map((m) => ({
        teamId: team.id,
        teamOwnerUserId: team.userId,
        projectId: m.projectId,
        ownerUserId: m.project.machine.userId,
      })),
    );
    for (const m of publishable) {
      if (!result.has(m.projectId)) {
        result.set(m.projectId, { id: `sub:${sub.id}`, teamId: team.id, projectId: m.projectId, granteeUserId: team.userId });
      }
    }
  }
  return result;
}

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

  // 公開型 Team（Phase A）: 招待型の grant が 0 件でも購読があれば候補が存在し得るため、
  // 下の早期 return は publishEnabled との AND にする。OFF 時は従来どおり無条件の早期
  // return（挙動・クエリ数とも完全に不変）。
  // 2026-11-09 実機バグの修正: この早期 return が無条件だったため、招待の grant を一切
  // 持たない「純粋な購読者」の候補が常に空配列になっていた（loadSubscriptionAskCandidateEntries
  // が呼ばれる手前で return していた）。招待型の Team オーナーで試すと grant が 4 件あり
  // 早期 return されないため再現しなかった。
  const publishEnabled = isCrossTeamPublishEnabled(process.env.DEVRELAY_CROSS_TEAM_PUBLISH);

  // requesterUserId は grant 作成時点の Team オーナーのスナップショット（= この関数の呼び出し元の
  // 文脈では「自分がオーナーとして発行した grant」を絞り込む条件として十分。Team に直接の
  // relation を張っていない CrossTeamGrant.teamId の代わりにこちらを使う）
  const grants = await prisma.crossTeamGrant.findMany({
    where: { askAllowed: true, revokedAt: null, requesterUserId: callerUserId },
    select: { id: true, teamId: true, projectId: true, granteeUserId: true },
  });
  if (grants.length === 0 && !publishEnabled) return [];

  // 組織境界の実行時再検証（grant の organizationId スナップショットではなく現在の
  // OrganizationMember を見る。どちらかが組織を抜けた直後に即座に候補から外れる）。
  // 招待型・公開型のどちらの経路でも callerMembership が無ければ候補は無いため、
  // この早期 return は無条件のままでよい。
  const callerMembership = await prisma.organizationMember.findUnique({
    where: { userId: callerUserId },
    select: { organizationId: true },
  });
  if (!callerMembership) return [];

  const granteeUserIds = [...new Set(grants.map((g) => g.granteeUserId))];
  const granteeMemberships = granteeUserIds.length > 0
    ? await prisma.organizationMember.findMany({
        where: { userId: { in: granteeUserIds } },
        select: { userId: true, organizationId: true },
      })
    : [];
  const sameOrgGranteeIds = new Set(
    granteeMemberships.filter((m) => m.organizationId === callerMembership.organizationId).map((m) => m.userId),
  );

  const grantByProjectId = new Map(
    grants.filter((g) => sameOrgGranteeIds.has(g.granteeUserId)).map((g) => [g.projectId, g]),
  );

  // 公開型 Team（Phase A）: 自分の有効な購読から公開可能なプロジェクトを同じ Map に合流させる
  // （既に招待型の grant がある projectId は上書きしない＝招待型を優先）
  const subscriptionCandidates = await loadSubscriptionAskCandidateEntries(
    callerUserId,
    callerMembership.organizationId,
  );
  for (const [projectId, cand] of subscriptionCandidates) {
    if (!grantByProjectId.has(projectId)) grantByProjectId.set(projectId, cand);
  }

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

/**
 * Phase C（WebUI チャット経路）: projectId を直接指定してクロス ask の宛先を解決する。
 *
 * `resolveCrossTeamAccess()` は `callerMachineId` を要求するためチャット経路では使えない
 * （チャットには「発信に使ったマシン」という概念が無い、`listCrossTeamAskCandidateProjects`
 * の docstring と同じ理由）。新しい認可クエリを書かず、**既に ask 候補として認可済みの集合**
 * （`listCrossTeamAskCandidateProjects`）から該当 1 件を探すだけにすることで、
 * 「ツリーに出る集合」と「ask できる集合」が将来ずれないようにする。
 */
export async function findCrossTeamAskProjectById(
  callerUserId: string,
  projectId: string,
): Promise<CrossTeamAskCandidateProject | null> {
  const candidates = await listCrossTeamAskCandidateProjects(callerUserId);
  return candidates.find((p) => p.id === projectId) ?? null;
}
