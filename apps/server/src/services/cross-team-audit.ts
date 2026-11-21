/**
 * クロスユーザー Team の監査ログ記録（append-only、fire-and-forget）。
 *
 * `SupervisionAuditLog`（org-control.ts の `recordSupervisionAudit`）とは意図的に分離している
 * — あちらは「viewer が target の履歴を閲覧した」セマンティクスで、`action` に実行系を混ぜると
 * 既存の組織統制画面（routes/organization.ts）の意味が崩れるため。
 *
 * 同一ユーザー経路（requesterUserId === executorUserId）では何も書かない
 * （既存の同一ユーザー ask/teamexec は 1 行も増えない = 挙動不変の検証ポイント）。
 */

import { prisma } from '../db/client.js';

export type CrossTeamAuditMode = 'ask' | 'exec';

export type CrossTeamAuditAction =
  | 'request'
  | 'denied'
  | 'completed'
  | 'failed'
  | 'invite_sent'
  | 'invite_accepted'
  | 'invite_declined'
  | 'grant_revoked'
  // 公開型 Team（Phase A）: いずれも本人の単独操作（requesterUserId === executorUserId）が
  // 正規のケースのため、記録には `allowSelfAudit: true` の指定が必要（下記参照）
  | 'team_published'
  | 'team_unpublished'
  | 'subscribed'
  | 'unsubscribed'
  | 'subscription_revoked'
  // サイクルC3a-1: クロス ask の記憶リセット・後片付け（いずれも requesterUserId（操作者）
  // === executorUserId（宛先所有者）になりうる本人操作のため allowSelfAudit を渡す）
  | 'cross_ask_reset'
  | 'cross_ask_cleanup';

export interface RecordCrossTeamAuditInput {
  requesterUserId: string;
  executorUserId: string;
  /** 'denied' の一部（組織不一致・組織未所属）では共通の組織が無いため null を許容する */
  organizationId?: string | null;
  teamId?: string | null;
  /** 'invite_sent' の時点では受入側がまだプロジェクトを選んでいないため省略可 */
  projectId?: string | null;
  sessionId?: string | null;
  mode: CrossTeamAuditMode;
  action: CrossTeamAuditAction;
  grantId?: string | null;
  /** JSON.stringify して保存する（denyReason, 所要 ms 等） */
  detail?: Record<string, unknown> | null;
  /**
   * 公開型 Team（Phase A）向け: 公開/非公開・購読/購読解除は本人の単独操作であり
   * `requesterUserId === executorUserId` が正規のケースになる。既定の自己操作スキップ
   * （招待型の「同一ユーザー経路は 1 行も増えない」不変性）を崩さないよう、これらの
   * action を記録したいときだけ明示的に `true` を渡す（既存呼び出しは引数を足さないので
   * 挙動不変）。
   */
  allowSelfAudit?: boolean;
}

/**
 * クロスユーザー Team の監査ログを 1 行記録する。
 * DB 書き込みが失敗しても呼び出し元の処理（ask/teamexec の応答）は止めない。
 */
export function recordCrossTeamAudit(input: RecordCrossTeamAuditInput): void {
  if (input.requesterUserId === input.executorUserId && !input.allowSelfAudit) {
    return;
  }
  prisma.crossTeamAuditLog
    .create({
      data: {
        organizationId: input.organizationId ?? null,
        requesterUserId: input.requesterUserId,
        executorUserId: input.executorUserId,
        teamId: input.teamId ?? null,
        projectId: input.projectId ?? null,
        sessionId: input.sessionId ?? null,
        mode: input.mode,
        action: input.action,
        grantId: input.grantId ?? null,
        detail: input.detail ? JSON.stringify(input.detail) : null,
      },
    })
    .catch((err: unknown) => {
      console.error('🔗 recordCrossTeamAudit failed:', err instanceof Error ? err.message : err);
    });
}
