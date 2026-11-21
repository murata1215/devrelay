/**
 * クロスユーザー Team（Phase 1: ask のみ）の招待候補を導出する純粋関数（外部 import ゼロ）。
 *
 * 2026-11-08 に見つかったバグの修正: 旧実装（`TeamPage.tsx` に直接書かれていた
 * `getInvitableCandidates()`）は、既にそのチームへプロジェクトを公開済みのユーザー
 * （`crossMemberOwnerIds`）を候補から**完全に除外**していた。
 * これは「1 招待 = 1 プロジェクト」だった旧モデルでは正しかった
 * （一度プロジェクトを出してもらったら再招待する意味が無かったため）。
 *
 * しかし同日の別サイクルで「再招待 = プロジェクト追加の唯一の導線」にサーバー側を変更した
 * （`POST /api/teams/:teamId/invites` から `status === 'accepted'` 時の 409 ガードを削除）。
 * そのため `crossMemberOwnerIds` による除外が、サーバー側で開けた道を UI が塞ぐ形になり、
 * 「公開済みの唯一の組織メンバーを追加招待できない」という行き止まりを再発させていた。
 *
 * 本関数では `crossMemberOwnerIds` では除外せず、`alreadyContributing: true` を付けて
 * 候補に残す。`pendingInviteeIds`（承認待ちの宛先）による除外は維持する
 * （同じ行を pending のまま上書きするだけで意味が無く、UI 上も紛らわしいため）。
 */

/** `GET /api/teams/org-candidates` の候補 1 件が満たすべき最小の形 */
export interface InviteCandidateLike {
  userId: string;
  name: string;
  email: string | null;
}

/** 招待ピッカーに表示する候補（`alreadyContributing` の注釈付き） */
export type AnnotatedInviteCandidate<T extends InviteCandidateLike> = T & {
  /** true = 既にこのチームへ自分のプロジェクトを公開済み（＝今回は「追加依頼」になる） */
  alreadyContributing: boolean;
};

export interface SelectInvitableCandidatesParams<T extends InviteCandidateLike> {
  /** 同一組織の全候補（`orgCandidates` のレスポンス。自分以外の組織メンバー全員） */
  orgCandidates: T[];
  /** そのチームの既存クロスユーザーメンバー（`crossUser: true`）の所有者 userId */
  crossMemberOwnerIds: string[];
  /** そのチームで status='pending' の招待の宛先 userId */
  pendingInviteeIds: string[];
}

/**
 * 招待ピッカーに表示する候補一覧を導出する。
 * 並び順は `orgCandidates` の入力順をそのまま保つ（サーバー側の `createdAt` 昇順）。
 */
export function selectInvitableCandidates<T extends InviteCandidateLike>(
  params: SelectInvitableCandidatesParams<T>
): AnnotatedInviteCandidate<T>[] {
  const { orgCandidates, crossMemberOwnerIds, pendingInviteeIds } = params;
  const ownerIds = new Set(crossMemberOwnerIds);
  const pendingIds = new Set(pendingInviteeIds);

  return orgCandidates
    .filter((c) => !pendingIds.has(c.userId))
    .map((c) => ({ ...c, alreadyContributing: ownerIds.has(c.userId) }));
}
