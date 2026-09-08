/**
 * core#376（旧 core#336）: MCP `approve_implementation` の検証・claim・
 * plan セッション記録ロジックを外部 import ゼロの純関数として切り出したモジュール。
 *
 * これらの判定はすべて `apps/server/src/mcp/tools.ts` / `apps/server/src/services/agent-manager.ts`
 * にインラインで書かれていたが、Prisma（DB）に依存するため `node --test`（DB 非接続の純関数テスト）
 * で検証できなかった。`org-ai-defaults.ts` と同じ方針で「判定ロジックだけ」を切り出す
 * （呼び出し側は Prisma への実際の問い合わせ結果をこの関数に渡すだけにする）。
 *
 * 文言・挙動は tools.ts / agent-manager.ts の既存実装から一切変更しないこと
 * （このモジュールへの置き換えは純粋なリファクタであり、ユーザーに見える挙動は不変であるべき）。
 */

/** approve_implementation が拒否する場合の理由コード（ログ・テストでの分岐確認に使う） */
export type ApproveRejectCode =
  | 'notFound'
  | 'projectMismatch'
  | 'userMismatch'
  | 'planNotReady'
  | 'planAiSessionMissing';

/**
 * approve_implementation の所有検証（core#336 で新設）。
 * submissionId が本当にこの projectId / userId の Session かどうか、plan が完了しているか、
 * plan ターンの AI セッション ID が記録されているかを判定する。
 *
 * @param input.session DB から取得した Session（存在しない場合は null を渡す）
 * @param input.requestedProjectId リクエストされた projectId
 * @param input.requestedUserId リクエストされた userId
 * @param input.hasPlanMessage submissionId に紐づく role='ai' の Message が存在するか
 */
export function evaluateApproveGuard(input: {
  session: { projectId: string; userId: string; planAiSessionId: string | null } | null;
  requestedProjectId: string;
  requestedUserId: string;
  hasPlanMessage: boolean;
}): { ok: true } | { ok: false; code: ApproveRejectCode; message: string } {
  const { session, requestedProjectId, requestedUserId, hasPlanMessage } = input;

  if (!session) {
    return { ok: false, code: 'notFound', message: 'Submission not found' };
  }
  if (session.projectId !== requestedProjectId) {
    return { ok: false, code: 'projectMismatch', message: 'Submission does not belong to this project' };
  }
  if (session.userId !== requestedUserId) {
    return { ok: false, code: 'userMismatch', message: 'Submission does not belong to this user' };
  }
  if (!hasPlanMessage) {
    return { ok: false, code: 'planNotReady', message: 'Plan is not ready yet. Call get_plan first.' };
  }
  if (!session.planAiSessionId) {
    return {
      ok: false,
      code: 'planAiSessionMissing',
      message: 'plan のセッション ID が記録されていません。agent が未更新か plan が未完了です。agent 更新後に再 submit してください',
    };
  }
  return { ok: true };
}

/**
 * 二重 approve の競合防止。`prisma.session.updateMany({ where: { id, approvedAt: null }, ... })`
 * の結果件数（count）から claim の成否を判定する。DB のロー単位 UPDATE が直列化するため、
 * 同一 submission に approve が並行到着しても count === 1 になるのは 1 要求だけ。
 */
export function decideClaimResult(count: number): { claimed: boolean } {
  return { claimed: count === 1 };
}

/**
 * claim 解放（exec 起動失敗時のロールバック）用の where 句を組み立てる。
 * claim 時に設定した approvedAt（claimedAt）との一致を条件にすることで、
 * 他要求が更新した状態を巻き戻さないようにする（atomic な自要求限定解放）。
 */
export function buildClaimReleaseWhere(submissionId: string, claimedAt: Date): { id: string; approvedAt: Date } {
  return { id: submissionId, approvedAt: claimedAt };
}

/**
 * AI 完了報告を Session.planAiSessionId として保存してよいかを判定する。
 * isComplete かつ turnId・aiSessionId の両方が揃っている場合のみ true
 * （exec/retry の完了報告や、turnId 自体を送っていない対話経路では false）。
 */
export function shouldRecordPlanAiSession(input: { isComplete: boolean; turnId?: string; aiSessionId?: string }): boolean {
  return Boolean(input.isComplete && input.turnId && input.aiSessionId);
}

/**
 * plan セッション ID 保存用の where 句を組み立てる。planTurnId 一致を必須にすることで、
 * 遅延した完了報告（exec/retry 分等）による誤上書きを構造的に防ぐ。
 */
export function buildPlanAiSessionWhere(sessionId: string, turnId: string): { id: string; planTurnId: string } {
  return { id: sessionId, planTurnId: turnId };
}

/**
 * plan ターン相関 ID（turnId）を採番する。既存の requestId 採番パターン
 * （`turn-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`）に準拠。
 *
 * @param nowMs 呼び出し側の `Date.now()`
 * @param randomSuffix 呼び出し側の `Math.random().toString(36).slice(2, 9)`
 */
export function buildTurnId(nowMs: number, randomSuffix: string): string {
  return `turn-${nowMs}-${randomSuffix}`;
}
