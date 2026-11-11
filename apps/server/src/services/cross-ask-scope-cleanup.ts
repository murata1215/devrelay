/**
 * サイクルC3a-1: クロス ask の旧世代 scope dir の後片付け（best-effort）。
 *
 * 中身は既存 `clearConversation(machineId, sessionId, projectPath, agentScopeId)`
 * （`agent-manager.ts:2162`）を scope id ごとに 1 回送るだけ。送信条件は
 * `isAgentConnected(machineId)` かつ `agentHasCapability(machineId, 'scoped-clear')`
 * （`command-handler.ts` の `x` コマンドと同じゲート、`thread-clear-guard.ts` 参照）。
 *
 * 【限界（C3a-1 時点で明記）】Agent 側 `handleConversationClear()`（`connection.ts:1122`）は
 * (i) 先に `archiveConversation()` して scope dir 内に写しを残し、(ii) 7 ファイルを空にするだけで
 * **dir 自体は消さない**。したがって本モジュールの「後片付け」は中身の消去までで、
 * dir ごとの削除・`.devrelay/` をプロジェクト外へ出す対策（案 B）は C3b で行う。
 *
 * 結果（送った scope id 群・未送信理由）は `CrossTeamAuditLog.detail`（既存列・スキーマ変更なし）
 * に記録する。DB 書き込みが失敗しても呼び出し元の処理は止めない
 * （`recordCrossTeamAudit` 自体が fire-and-forget）。
 */

import { isAgentConnected, agentHasCapability, clearConversation } from './agent-manager.js';
import { recordCrossTeamAudit } from './cross-team-audit.js';

export type PurgeCrossAskScopesTrigger = 'ttl' | 'maxTurns' | 'manual' | 'grantRevoked' | 'unsubscribed' | 'subscriptionRevoked';

export interface PurgeCrossAskScopesInput {
  machineId: string;
  projectPath: string;
  /** 対象の完全な scope id 群（`crossask-<base>-g<N>`）。空配列なら何もしない（監査も書かない）。 */
  scopeIds: string[];
  trigger: PurgeCrossAskScopesTrigger;
  /** 監査ログ用コンテキスト（`CrossTeamAuditLog` の既存カラムにそのまま載せる） */
  requesterUserId: string;
  executorUserId: string;
  organizationId?: string | null;
  teamId?: string | null;
  projectId?: string | null;
  grantId?: string | null;
}

/**
 * `scopeIds` の各 scope dir の中身を Agent に消させる（best-effort、同期応答を待たない）。
 * オフライン・capability 未申告のときは送信せず、理由を監査ログの `detail.skipped` に残す
 * （再送キューは作らない＝ DB を増やさない既存方針。次回 TTL/上限ターンで世代が変わった際に
 * 改めて後片付けの機会がある）。
 */
export async function purgeCrossAskScopes(input: PurgeCrossAskScopesInput): Promise<void> {
  const { machineId, projectPath, scopeIds, trigger } = input;
  if (scopeIds.length === 0) return;

  const auditBase = {
    requesterUserId: input.requesterUserId,
    executorUserId: input.executorUserId,
    organizationId: input.organizationId ?? null,
    teamId: input.teamId ?? null,
    projectId: input.projectId ?? null,
    grantId: input.grantId ?? null,
    mode: 'ask' as const,
    action: 'cross_ask_cleanup' as const,
    // クロスユーザー ask は requesterUserId !== executorUserId が前提だが、将来の呼び出し元の
    // 取り違えで同一になった場合でも後片付けの実行結果は必ず記録する（team_published 等と同じ扱い）。
    allowSelfAudit: true,
  };

  if (!isAgentConnected(machineId)) {
    recordCrossTeamAudit({ ...auditBase, detail: { trigger, skipped: 'offline', scopeIds } });
    return;
  }
  if (!agentHasCapability(machineId, 'scoped-clear')) {
    recordCrossTeamAudit({ ...auditBase, detail: { trigger, skipped: 'noCapability', scopeIds } });
    return;
  }

  for (const scopeId of scopeIds) {
    // sessionId はログ・sessionInfoMap 参照用のダミー値（未知の id なら Agent 側は no-op で
    // 無害にスキップする。実際にクリアする対象は agentScopeId で決まる）。
    await clearConversation(machineId, `crossaskcleanup_${scopeId}`, projectPath, scopeId);
  }

  recordCrossTeamAudit({ ...auditBase, detail: { trigger, sentScopeIds: scopeIds } });
}
