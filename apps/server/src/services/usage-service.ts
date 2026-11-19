/**
 * Usage（コスト集計）サイクル: DB から月ごとのスレッド別コスト行（`UsageThreadRow`）を組み立てる。
 *
 * - 金額は会話履歴のコスト列（`GET /api/conversations`）と同じ `resolveMessageCost()` で 1 ターンずつ出し、
 *   スレッド（Session）単位に合計する。金額不明（null）のターンは 0 として足し、件数だけ数える。
 * - 月は JST の暦月（`jstMonthRange`）。
 * - 対象ユーザーは呼び出し側が決める（組織所属なら組織全員、未所属なら本人のみ）。
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../db/client.js';
import { resolveMessageCost, jstMonthRange, type UsageThreadRow } from '@devrelay/shared';
import { usageDisplayName, usageThreadTitle, USAGE_ROWS_CACHE_MS } from './usage-rules.js';

/** 閲覧者から見た集計対象（組織所属なら組織全員）。 */
export interface UsageScope {
  organizationId: string | null;
  role: string | null;
  userIds: string[];
}

export async function resolveUsageScope(userId: string): Promise<UsageScope> {
  const membership = await prisma.organizationMember.findUnique({
    where: { userId },
    select: { organizationId: true, role: true },
  });
  if (!membership) return { organizationId: null, role: null, userIds: [userId] };
  const members = await prisma.organizationMember.findMany({
    where: { organizationId: membership.organizationId },
    select: { userId: true },
  });
  return { organizationId: membership.organizationId, role: membership.role, userIds: members.map((m) => m.userId) };
}

/** 組織全員のユーザー ID（サイネージ用）。 */
export async function orgMemberUserIds(organizationId: string): Promise<string[]> {
  const members = await prisma.organizationMember.findMany({ where: { organizationId }, select: { userId: true } });
  return members.map((m) => m.userId);
}

// ---------------------------------------------------------------------------
// キャッシュ（グループ・案件の変更時は clearUsageCache() で全部捨てる）
// ---------------------------------------------------------------------------

const rowsCache = new Map<string, { at: number; rows: UsageThreadRow[] }>();

export function clearUsageCache(): void {
  rowsCache.clear();
}

function cacheKey(userIds: string[], monthKey: string): string {
  return `${monthKey}|${[...userIds].sort().join(',')}`;
}

/** 指定ユーザー群の、JST 暦月 monthKey のスレッド別コスト行。 */
export async function loadUsageRows(userIds: string[], monthKey: string): Promise<UsageThreadRow[]> {
  if (userIds.length === 0) return [];
  const key = cacheKey(userIds, monthKey);
  const hit = rowsCache.get(key);
  if (hit && Date.now() - hit.at < USAGE_ROWS_CACHE_MS) return hit.rows;

  const rows = await buildUsageRows(userIds, monthKey);
  rowsCache.set(key, { at: Date.now(), rows });
  // 古いエントリを溜め込まない（月×組織の組み合わせなので通常は数件）
  if (rowsCache.size > 200) {
    const oldest = [...rowsCache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 100);
    for (const [k] of oldest) rowsCache.delete(k);
  }
  return rows;
}

async function buildUsageRows(userIds: string[], monthKey: string): Promise<UsageThreadRow[]> {
  const { start, end } = jstMonthRange(monthKey);

  // 1. 期間内の AI 応答（= ターン）を取得し、スレッドごとに金額を合計する
  const messages = await prisma.message.findMany({
    where: {
      role: 'ai',
      createdAt: { gte: start, lt: end },
      session: { userId: { in: userIds } },
    },
    select: { sessionId: true, createdAt: true, usageData: true },
  });
  if (messages.length === 0) return [];

  const perSession = new Map<string, { costUsd: number; turns: number; unknownTurns: number; lastAt: Date }>();
  for (const m of messages) {
    const cost = resolveMessageCost(m.usageData as any);
    let s = perSession.get(m.sessionId);
    if (!s) {
      s = { costUsd: 0, turns: 0, unknownTurns: 0, lastAt: m.createdAt };
      perSession.set(m.sessionId, s);
    }
    s.turns += 1;
    if (cost.usd === null) s.unknownTurns += 1;
    else s.costUsd += cost.usd;
    if (m.createdAt > s.lastAt) s.lastAt = m.createdAt;
  }

  const sessionIds = [...perSession.keys()];

  // 2. スレッド・利用者・グループの属性
  const [sessions, users, groups] = await Promise.all([
    prisma.session.findMany({
      where: { id: { in: sessionIds } },
      select: {
        id: true,
        userId: true,
        title: true,
        usageCase: true,
        startedAt: true,
        project: { select: { name: true, displayName: true } },
      },
    }),
    prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } }),
    prisma.userUsageGroup.findMany({ where: { userId: { in: userIds } }, select: { userId: true, groupName: true } }),
  ]);
  const userMap = new Map(users.map((u) => [u.id, u]));
  const groupMap = new Map(groups.map((g) => [g.userId, g.groupName]));

  // 3. 未命名スレッドは先頭の発言を表示名に使う（DISTINCT ON で 1 スレッド 1 行だけ取る）
  const untitledIds = sessions.filter((s) => !s.title?.trim()).map((s) => s.id);
  const firstMsgMap = new Map<string, string>();
  if (untitledIds.length > 0) {
    const firstMsgs = await prisma.$queryRaw<Array<{ sessionId: string; head: string }>>`
      SELECT DISTINCT ON ("sessionId") "sessionId", LEFT(content, 80) AS head
      FROM "Message"
      WHERE "sessionId" IN (${Prisma.join(untitledIds)}) AND role = 'user'
      ORDER BY "sessionId", "createdAt" ASC
    `;
    for (const f of firstMsgs) firstMsgMap.set(f.sessionId, f.head);
  }

  const rows: UsageThreadRow[] = [];
  for (const s of sessions) {
    const agg = perSession.get(s.id);
    if (!agg) continue;
    const user = userMap.get(s.userId);
    rows.push({
      sessionId: s.id,
      userId: s.userId,
      userName: user ? usageDisplayName(user) : s.userId,
      group: groupMap.get(s.userId) ?? null,
      projectName: s.project.displayName?.trim() || s.project.name,
      caseName: s.usageCase ?? null,
      threadTitle: usageThreadTitle(s.title, firstMsgMap.get(s.id) ?? null, s.startedAt),
      costUsd: agg.costUsd,
      turns: agg.turns,
      unknownTurns: agg.unknownTurns,
      lastAt: agg.lastAt.toISOString(),
    });
  }
  rows.sort((a, b) => b.costUsd - a.costUsd);
  return rows;
}

/** 入力候補（組織内で使われているグループ名・案件名）。 */
export async function loadUsageLabelOptions(userIds: string[]): Promise<{ groups: string[]; cases: string[] }> {
  if (userIds.length === 0) return { groups: [], cases: [] };
  const [groups, cases] = await Promise.all([
    prisma.userUsageGroup.findMany({
      where: { userId: { in: userIds } },
      distinct: ['groupName'],
      select: { groupName: true },
    }),
    prisma.session.findMany({
      where: { userId: { in: userIds }, usageCase: { not: null } },
      distinct: ['usageCase'],
      select: { usageCase: true },
    }),
  ]);
  const sortJa = (a: string, b: string) => a.localeCompare(b, 'ja');
  return {
    groups: groups.map((g) => g.groupName).sort(sortJa),
    cases: cases.map((c) => c.usageCase!).filter(Boolean).sort(sortJa),
  };
}

/** 組織メンバー一覧（グループ設定用。使用実績が無い人も含む）。 */
export async function loadUsageMembers(userIds: string[]): Promise<Array<{ userId: string; userName: string; group: string | null }>> {
  if (userIds.length === 0) return [];
  const [users, groups] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } }),
    prisma.userUsageGroup.findMany({ where: { userId: { in: userIds } }, select: { userId: true, groupName: true } }),
  ]);
  const groupMap = new Map(groups.map((g) => [g.userId, g.groupName]));
  return users
    .map((u) => ({ userId: u.id, userName: usageDisplayName(u), group: groupMap.get(u.id) ?? null }))
    .sort((a, b) => a.userName.localeCompare(b.userName, 'ja'));
}
