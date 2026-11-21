/**
 * クロスプロジェクトセッション（`crossquery_` / `teamexec_`）の集計 DB ラッパ。
 *
 * `document-api.ts`（Agent REST 経路）の private 関数だった `countRecentCrossSessions()` を
 * 抽出し、`cross-ask-runner.ts`（Phase C: WebUI チャット経路）と共用する
 * （`services/cross-ask-rules.ts` 等の純関数モジュールとは異なり、本ファイルは DB アクセスを
 * 持つラッパであるため `services/` 配下でも外部 import ゼロの規約は適用しない）。
 */

import { prisma } from '../db/client.js';

/** #294: 直近 5 分のクロスプロジェクトセッション数を数える（マシン横断の backstop）の窓。 */
export const CROSS_RATE_WINDOW_MS = 5 * 60 * 1000;

/**
 * 直近 `CROSS_RATE_WINDOW_MS` 以内のクロスプロジェクトセッション数を数える。
 *
 * @param prefix セッション ID プレフィックス（'teamexec_' / 'crossquery_'）
 * @param requesterUserId 集計対象ユーザー（依頼者基準。`requestedByUserId` が null の既存行は
 *   `userId` 一致で代替する。クロスユーザー Team（Phase 1）導入前の既存行との互換のため）
 * @param targetProjectId 指定時はそのプロジェクト宛のみ集計
 */
export async function countRecentCrossSessions(
  prefix: string,
  requesterUserId: string,
  targetProjectId?: string,
): Promise<number> {
  return prisma.session.count({
    where: {
      OR: [
        { requestedByUserId: requesterUserId },
        { requestedByUserId: null, userId: requesterUserId },
      ],
      id: { startsWith: prefix },
      startedAt: { gte: new Date(Date.now() - CROSS_RATE_WINDOW_MS) },
      ...(targetProjectId ? { projectId: targetProjectId } : {}),
    },
  });
}

/**
 * 宛先プロジェクトに `status: 'active'` の `crossquery_` セッションが存在するかを調べ、
 * `pickInflightCrossSession()` にそのまま渡せる行を返す。
 */
export async function findInflightCrossQueryRows(
  targetProjectId: string,
): Promise<Array<{ id: string; startedAt: Date }>> {
  return prisma.session.findMany({
    where: { projectId: targetProjectId, id: { startsWith: 'crossquery_' }, status: 'active' },
    select: { id: true, startedAt: true },
  });
}
