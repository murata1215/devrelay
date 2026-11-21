/**
 * 公開型 Team（Team を公開し、同一組織内の利用者が選んで購読する機能）の純関数群。
 *
 * 外部 import ゼロの純関数のみで構成する（`cross-team-guard.ts` / `cross-query-guard.ts` /
 * `permission-policy.ts` と同じ流儀。DB・env は一切見ない。呼び出し側の DB ラッパ
 * （`cross-team-authz.ts`）が購読行・公開チーム行を集めてここに渡す）。
 *
 * 2026-11-08: 招待型（Phase 1）に続く公開型（Phase A: サーバー + 認可のみ。WebUI は Phase B）。
 * `decideCrossTeamAccess()`（`cross-team-guard.ts`）は 1 バイトも変更しない。
 * 本モジュールの役割は「購読から `CrossTeamCandidateGrant[]` を合成する」ことだけで、
 * 合成した候補をそのまま既存の純関数に渡せば公開型の認可が成立する設計
 * （既存の「単一の拡張点」設計にそのまま乗る）。
 *
 * 設計の芯（詳細は rules/project.md のクロスユーザー Team セクション参照）:
 * - 又貸し禁止（最重要の安全要件）: `Team` は招待型で受け入れた他人のプロジェクトも
 *   同じ `TeamMember` として保持する。素朴に「チームを公開」すると、招待で借りている
 *   プロジェクトが所有者の同意なく組織全体に再公開され、所有者の契約で課金が走る事故になる。
 *   `selectPublishableMembers()` で「チームオーナー自身が所有するプロジェクト」に限定し、
 *   `buildSubscriptionCandidates()` でもオーナー不一致の行を捨てて二重に防ぐ。
 * - 購読は実行時に合成するだけで `CrossTeamGrant` 行を一切作らない（`CrossTeamGrant` の
 *   スキーマは変更しない。`teamMemberId @unique` も維持。購読者数 × チーム規模の行の
 *   増殖やチーム編集のたびの同期処理を避けるため）。
 * - `execAllowed` は常に false（Phase 2 で検討。公開型はまず ask のみ）。
 */

/** `DEVRELAY_CROSS_TEAM_PUBLISH` の既定値解決（既定 OFF。`DEVRELAY_CROSS_TEAM` と同じ逆方向）。 */
export function isCrossTeamPublishEnabled(raw: string | undefined): boolean {
  return raw === '1';
}

export const TEAM_VISIBILITY_PRIVATE = 'private';
export const TEAM_VISIBILITY_ORGANIZATION = 'organization';

/** `Team.visibility` が「公開」を表す値かどうか（既定値 'private' 以外を安全側に倒さず、明示的に一致を見る） */
export function isPublishedVisibility(v: string | null | undefined): boolean {
  return v === TEAM_VISIBILITY_ORGANIZATION;
}

/** `decideCrossTeamAccess` が受け取る候補行の形（`cross-team-guard.ts` の `CrossTeamCandidateGrant` と同じ構造） */
export interface CrossTeamCandidateGrantLike {
  teamId: string;
  grantId: string;
  granteeUserId: string;
  askAllowed: boolean;
  execAllowed: boolean;
  revoked: boolean;
  callerQualified: boolean;
}

/**
 * 公開可否を判定する対象のチームメンバー 1 件が満たすべき最小の形。
 * `teamOwnerUserId` を行ごとに持たせる（1 プロジェクトが複数の公開チームのメンバーに
 * なっているケースで、チームごとにオーナーが異なり得るため、呼び出し側で単一の
 * チームに絞り込まず一括で安全に判定できるようにする）。
 */
export interface PublishableMemberLike {
  teamId: string;
  /** そのメンバー行が属するチームのオーナー（= team.userId） */
  teamOwnerUserId: string;
  projectId: string;
  /** そのプロジェクトを実際に所有するユーザー（= project.machine.userId） */
  ownerUserId: string;
}

/**
 * 公開してよいメンバーだけに絞る（= チームオーナー自身が所有するプロジェクト）。
 * 又貸し防止の核心: 招待型で受け入れた他人のプロジェクト（ownerUserId !== teamOwnerUserId）は
 * 無条件で除外する。
 */
export function selectPublishableMembers<T extends PublishableMemberLike>(members: T[]): T[] {
  return members.filter((m) => m.ownerUserId === m.teamOwnerUserId);
}

/** `TeamSubscription` 行が満たすべき最小の形（`revokedAt` は Date | null のまま渡してよい） */
export interface SubscriptionLike {
  id: string;
  teamId: string;
  subscriberUserId: string;
  askAllowed: boolean;
  revokedAt: unknown;
}

/** 公開チーム 1 件が満たすべき最小の形（オーナー不一致チェック用） */
export interface PublishedTeamLike {
  teamId: string;
  teamOwnerUserId: string;
}

export interface BuildSubscriptionCandidatesParams {
  /** 呼び出し元（= 宛先に ask/exec しようとしている発信者） */
  callerUserId: string;
  /** 宛先プロジェクトの現在の所有者（grant のスナップショットではなく実データ） */
  targetOwnerUserId: string;
  /** 呼び出し元の購読行（他ユーザーの購読が混ざっていても安全なように、ここでフィルタする） */
  subscriptions: SubscriptionLike[];
  /** 購読先チームの一覧（オーナー不一致チェック用） */
  publishedTeams: PublishedTeamLike[];
}

/**
 * 購読から `CrossTeamCandidateGrant[]`（`cross-team-guard.ts` にそのまま渡せる形）を合成する。
 *
 * 不変条件（テストで固定する）:
 * - `subscription.subscriberUserId !== callerUserId` の行は捨てる（`callerQualified` を
 *   クエリの書き方に暗黙依存させず、ここで必ず検証する）
 * - `publishedTeams` に対応するチームが無い、またはそのチームの `teamOwnerUserId` が
 *   `targetOwnerUserId` と一致しない行は捨てる（又貸し防止の二重化）
 * - `grantId` は `sub:${subscription.id}`（実 grant（`CrossTeamGrant.id`）と監査ログ上で
 *   区別できるようにする接頭辞）
 * - `granteeUserId = teamOwnerUserId`、`callerQualified = true`、`execAllowed` は常に false
 * - `revoked` は `subscription.revokedAt !== null` をそのまま boolean 化したもの
 */
export function buildSubscriptionCandidates(
  params: BuildSubscriptionCandidatesParams,
): CrossTeamCandidateGrantLike[] {
  const teamOwnerByTeamId = new Map(
    params.publishedTeams.map((t) => [t.teamId, t.teamOwnerUserId]),
  );

  const result: CrossTeamCandidateGrantLike[] = [];
  for (const sub of params.subscriptions) {
    if (sub.subscriberUserId !== params.callerUserId) continue;
    const teamOwnerUserId = teamOwnerByTeamId.get(sub.teamId);
    if (!teamOwnerUserId) continue;
    if (teamOwnerUserId !== params.targetOwnerUserId) continue;

    result.push({
      teamId: sub.teamId,
      grantId: `sub:${sub.id}`,
      granteeUserId: teamOwnerUserId,
      askAllowed: sub.askAllowed,
      execAllowed: false,
      revoked: sub.revokedAt !== null,
      callerQualified: true,
    });
  }
  return result;
}
