/**
 * 再起動耐性サイクル 追補（2026-11-28）: busy 判定の「どのセッション・どのマシンか」を
 * 解決する I/O 層。判定ロジック（busy かどうか自体）は一切変えない
 * （`getGlobalBusyState()` は無改造）。表示専用の追加情報だけをここで作る。
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../db/client.js';
import { inFlightTurns } from './in-flight-turns.js';
import { listProgressTrackers } from './session-manager.js';
import { RUNNING_FRESHNESS_MS } from './thread-activity.js';
import { isUpdateBusyGuardEnabled } from './update-busy-rules.js';
import { resolveRestartIdleCooldownMs } from './restart-gate-rules.js';
import type { InflightSessionEntry } from './inflight-detail-rules.js';

/** 表示する最大件数（会話が同時多発していても画面を埋め尽くさないための上限） */
const MAX_ENTRIES = 5;

interface SessionLabelInfo {
  machineName: string;
  projectName: string;
  /** `title` ?? `autoTitle` ?? 直近メッセージの先頭部分。解決できなければ null。 */
  label: string | null;
}

/**
 * セッション ID の集合から「マシン名・プロジェクト名・スレッド見出し」を解決する。
 * 見出しは `title` ?? `autoTitle` を優先し、どちらも無ければ直近メッセージ（どの role でもよい。
 * Pulse 画面の見出し表示と同じ考え方）の先頭部分を使う（`DISTINCT ON` で 1 セッション 1 行に絞る、
 * 既存の会話履歴レール実装と同じ Postgres 固有クエリの使い方）。
 */
async function resolveSessionLabels(sessionIds: string[]): Promise<Map<string, SessionLabelInfo>> {
  const uniqueIds = [...new Set(sessionIds)];
  if (uniqueIds.length === 0) return new Map();

  const rows = await prisma.session.findMany({
    where: { id: { in: uniqueIds } },
    select: {
      id: true,
      title: true,
      autoTitle: true,
      project: { select: { name: true, displayName: true } },
      machine: { select: { name: true, displayName: true } },
    },
  });

  const result = new Map<string, SessionLabelInfo>();
  const needsFallbackLabel: string[] = [];
  for (const r of rows) {
    const label = (r.title && r.title.trim()) || (r.autoTitle && r.autoTitle.trim()) || null;
    result.set(r.id, {
      machineName: r.machine.displayName ?? r.machine.name,
      projectName: r.project.displayName ?? r.project.name,
      label,
    });
    if (!label) needsFallbackLabel.push(r.id);
  }

  if (needsFallbackLabel.length > 0) {
    type LatestRow = { sessionId: string; content: string };
    const latestRows = await prisma.$queryRaw<LatestRow[]>`
      SELECT DISTINCT ON ("sessionId") "sessionId", "content"
      FROM "Message"
      WHERE "sessionId" IN (${Prisma.join(needsFallbackLabel)})
      ORDER BY "sessionId", "createdAt" DESC
    `;
    for (const row of latestRows) {
      const existing = result.get(row.sessionId);
      if (existing) existing.label = (row.content ?? '').trim() || null;
    }
  }

  return result;
}

/** マシン ID の集合から表示名を解決する（セッションに紐づかないエントリ用のフォールバック）。 */
async function resolveMachineNames(machineIds: string[]): Promise<Map<string, string>> {
  const uniqueIds = [...new Set(machineIds)];
  if (uniqueIds.length === 0) return new Map();
  const rows = await prisma.machine.findMany({
    where: { id: { in: uniqueIds } },
    select: { id: true, name: true, displayName: true },
  });
  return new Map(rows.map(r => [r.id, r.displayName ?? r.name]));
}

/**
 * `getGlobalBusyState()` と同じ優先順位（① 実行中ターン台帳 → ② 進捗トラッカー →
 * ③ 直近の AI 出力）で「いま busy と判定された根拠」のセッション・マシン一覧を集める。
 * 判定そのものは複製せず、busy 状態のときだけ呼び出される前提（呼び出し側 = `inflight-state-file.ts`）。
 */
export async function getGlobalBusyDetails(): Promise<InflightSessionEntry[]> {
  const now = Date.now();
  const raw: Array<{ sessionId: string | null; machineId: string | null; ageMs: number | null }> = [];

  if (isUpdateBusyGuardEnabled(process.env.DEVRELAY_UPDATE_BUSY_GUARD)) {
    for (const t of inFlightTurns.listAll(now)) {
      // `key` は sessionId の場合と raw-completion の requestId の場合がある（後者はセッション解決に失敗するだけで安全）。
      raw.push({ sessionId: t.key, machineId: t.machineId, ageMs: t.ageMs });
    }
  }

  if (raw.length === 0) {
    for (const t of listProgressTrackers(now)) {
      if (t.ageMs < RUNNING_FRESHNESS_MS) {
        raw.push({ sessionId: t.sessionId, machineId: t.machineId, ageMs: t.ageMs });
      }
    }
  }

  if (raw.length === 0) {
    const idleCooldownMs = resolveRestartIdleCooldownMs(process.env.DEVRELAY_RESTART_IDLE_COOLDOWN_MS);
    if (idleCooldownMs > 0) {
      const recentRows = await prisma.message.findMany({
        where: { role: 'ai', createdAt: { gte: new Date(now - idleCooldownMs) }, session: { status: 'active' } },
        select: { sessionId: true, createdAt: true },
        distinct: ['sessionId'],
        orderBy: { createdAt: 'desc' },
        take: MAX_ENTRIES,
      });
      for (const row of recentRows) {
        raw.push({ sessionId: row.sessionId, machineId: null, ageMs: now - row.createdAt.getTime() });
      }
    }
  }

  if (raw.length === 0) return [];

  // sessionId がある場合はそれで重複排除（同じスレッドが台帳とトラッカー両方に出うるため）。
  const seenSessionIds = new Set<string>();
  const deduped = raw.filter(e => {
    if (!e.sessionId) return true;
    if (seenSessionIds.has(e.sessionId)) return false;
    seenSessionIds.add(e.sessionId);
    return true;
  }).slice(0, MAX_ENTRIES);

  const sessionIds = deduped.map(e => e.sessionId).filter((v): v is string => !!v);
  const labels = await resolveSessionLabels(sessionIds);

  // セッション解決に失敗した（raw-completion 等）エントリ向けに、持っている machineId だけでも名前を出す。
  const unresolvedMachineIds = deduped
    .filter(e => !e.sessionId || !labels.has(e.sessionId))
    .map(e => e.machineId)
    .filter((v): v is string => !!v);
  const machineNames = await resolveMachineNames(unresolvedMachineIds);

  return deduped.map((e): InflightSessionEntry => {
    const info = e.sessionId ? labels.get(e.sessionId) : undefined;
    if (info) {
      return { machineName: info.machineName, projectName: info.projectName, ageMs: e.ageMs, label: info.label };
    }
    return {
      machineName: e.machineId ? (machineNames.get(e.machineId) ?? null) : null,
      projectName: null,
      ageMs: e.ageMs,
      label: null,
    };
  });
}
