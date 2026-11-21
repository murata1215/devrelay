/**
 * サイクルC3a-1: クロス ask の記憶リセット本体。`POST /api/cross-team/projects/:projectId/reset`
 * （REST、WebUI 用。C3a-2 で配線）と `askreset <project>` コマンド（チャット用）の共用ロジック。
 *
 * 行う内容:
 * 1. `CrossAskReset`（state の持ち場。`cross-ask-resume-rules.ts` の `decideCrossAskResetRequested()`
 *    が参照する）を upsert する。
 * 2. 現存する全世代の scope id を `Session.agentScopeId` から列挙し、`purgeCrossAskScopes()`
 *    （best-effort）で中身を消去する（fire-and-forget: reset 自体の応答を待たせない）。
 * 3. 監査ログ（`action: 'cross_ask_reset'`）を記録する。
 *
 * `cross-ask-runner.ts` からは呼ばない（逆方向の import は無い。runner は
 * `CrossAskReset.resetAt` を自前で読むだけで、この書き込み系モジュールには依存しない。
 * 循環 import を避けるための意図的な設計）。
 */

import crypto from 'crypto';
import { prisma } from '../db/client.js';
import { buildCrossAskScopeIdBase } from './cross-ask-resume-rules.js';
import { purgeCrossAskScopes, type PurgeCrossAskScopesTrigger } from './cross-ask-scope-cleanup.js';
import { recordCrossTeamAudit } from './cross-team-audit.js';

/** `resetCrossAskMemory` が必要とする宛先プロジェクトの最小形。 */
export interface CrossAskResetTargetProject {
  id: string;
  path: string;
  machine: { id: string; userId: string };
  /** 同一ユーザー宛（クロスユーザーでない）は記憶機構そのものが無いため undefined で渡す */
  crossTeam?: { teamId: string; grantId: string };
}

export type ResetCrossAskMemoryResult =
  | { ok: true; hadMemory: boolean; purgedGenerations: number }
  | { ok: false; reason: 'notCrossUser' };

/**
 * (requesterUserId, projectId) ペアの現存する全世代の scope id を `Session.agentScopeId` から
 * 列挙する（削除はされない Session 行の仕様を利用する。`resetCrossAskMemory` と
 * `purgeCrossAskScopesForRevokedGrant` の共通部分）。
 */
async function enumerateCrossAskScopeIds(requesterUserId: string, projectId: string): Promise<string[]> {
  const scopeIdBase = buildCrossAskScopeIdBase(
    crypto.createHash('sha256').update(`${requesterUserId}\0${projectId}`).digest('hex'),
  );
  const rows = await prisma.session.findMany({
    where: { projectId, agentScopeId: { startsWith: `${scopeIdBase}-g` } },
    select: { agentScopeId: true },
  });
  return [...new Set(rows.map((r) => r.agentScopeId).filter((x): x is string => !!x))];
}

/**
 * (requesterUserId, targetProject) ペアのクロス ask 記憶をリセットする。
 * 同一ユーザー宛（`targetProject.crossTeam` が無い）は no-op で `{ ok: false, reason: 'notCrossUser' }`
 * を返す（記憶機構自体が無いため、呼び出し元は「リセット不要」のメッセージを返せる）。
 */
export async function resetCrossAskMemory(
  requesterUserId: string,
  targetProject: CrossAskResetTargetProject,
): Promise<ResetCrossAskMemoryResult> {
  if (!targetProject.crossTeam) {
    return { ok: false, reason: 'notCrossUser' };
  }
  const executorUserId = targetProject.machine.userId;

  const scopeIds = await enumerateCrossAskScopeIds(requesterUserId, targetProject.id);

  await prisma.crossAskReset.upsert({
    where: { requesterUserId_projectId: { requesterUserId, projectId: targetProject.id } },
    create: { requesterUserId, projectId: targetProject.id, resetAt: new Date(), resetCount: 1 },
    update: { resetAt: new Date(), resetCount: { increment: 1 } },
  });

  recordCrossTeamAudit({
    requesterUserId,
    executorUserId,
    teamId: targetProject.crossTeam.teamId,
    projectId: targetProject.id,
    grantId: targetProject.crossTeam.grantId,
    mode: 'ask',
    action: 'cross_ask_reset',
    allowSelfAudit: true,
  });

  // best-effort 後片付け。reset 自体（上の upsert）の応答は待たせない。
  purgeCrossAskScopes({
    machineId: targetProject.machine.id,
    projectPath: targetProject.path,
    scopeIds,
    trigger: 'manual',
    requesterUserId,
    executorUserId,
    teamId: targetProject.crossTeam.teamId,
    projectId: targetProject.id,
    grantId: targetProject.crossTeam.grantId,
  }).catch((err: unknown) => {
    console.error('🧹 purgeCrossAskScopes (reset) failed:', err instanceof Error ? err.message : err);
  });

  return { ok: true, hadMemory: scopeIds.length > 0, purgedGenerations: scopeIds.length };
}

/** `purgeCrossAskScopesForRevokedGrant` の入力（grant 取消・購読解除の 3 箇所で共用）。 */
export interface PurgeCrossAskScopesForRevokedGrantInput {
  requesterUserId: string;
  executorUserId: string;
  projectId: string;
  projectPath: string;
  machineId: string;
  organizationId?: string | null;
  teamId?: string | null;
  grantId?: string | null;
  trigger: PurgeCrossAskScopesTrigger;
}

/**
 * grant 取消 / 購読解除 / 購読の強制取消の 3 箇所から呼ぶ後片付けヘルパー。
 * `CrossAskReset` の upsert は行わない（取消したのは認可であって記憶ではない。認可が無くなった
 * 時点で再度その宛先に ask することは構造的にできないため、resetRequested の対象にする必要が無い）。
 *
 * 呼び出し元は await/catch せずに呼んでよい（内部で全エラーを catch して返す、決して reject しない）。
 */
export async function purgeCrossAskScopesForRevokedGrant(input: PurgeCrossAskScopesForRevokedGrantInput): Promise<void> {
  try {
    const scopeIds = await enumerateCrossAskScopeIds(input.requesterUserId, input.projectId);
    await purgeCrossAskScopes({
      machineId: input.machineId,
      projectPath: input.projectPath,
      scopeIds,
      trigger: input.trigger,
      requesterUserId: input.requesterUserId,
      executorUserId: input.executorUserId,
      organizationId: input.organizationId,
      teamId: input.teamId,
      projectId: input.projectId,
      grantId: input.grantId,
    });
  } catch (err: unknown) {
    console.error('🧹 purgeCrossAskScopesForRevokedGrant failed:', err instanceof Error ? err.message : err);
  }
}
