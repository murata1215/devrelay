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
  | 'grant_revoked';

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
}

/**
 * クロスユーザー Team の監査ログを 1 行記録する。
 * DB 書き込みが失敗しても呼び出し元の処理（ask/teamexec の応答）は止めない。
 */
export function recordCrossTeamAudit(input: RecordCrossTeamAuditInput): void {
  if (input.requesterUserId === input.executorUserId) {
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
