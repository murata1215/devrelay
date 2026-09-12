/**
 * サイクルP1: Capability 配布基盤の定期スイープ（Server 主導）。
 *
 * `doc/devrelay_capability_spec_v2.md` §7.3 はアイドル時の Agent 内相乗りを想定するが、
 * Agent には「いまアイドルか」を判定する手段が無い（`ai-runner.ts` の `startAiSession()` は
 * プロセスを spawn しないため `activeSessions.size` はセッション生存期間の指標にしかならない）。
 * そのため `auto-updater.ts` の `startAutoUpdateSweep()` と同じ「スケジュール + busy ゲート」の
 * 様式だけを複製し、Server がオンライン Agent を巡回して `server:capability:sync` を送る。
 *
 * このファイルはどの AI ベンダー（provider）固有知識も一切持たない
 * （何を配布するかは Agent 側の adapter が `capabilityConfig` を見て判断する）。
 * bake time / cooldown / 試行回数上限は自動更新固有の概念のため、ここには持ち込まない。
 */

import { prisma } from '../db/client.js';
import { getConnectedAgents, sendToAgent } from './agent-manager.js';
import { isMachineBusy } from './auto-updater.js';
import { decideSweepAction } from './capability-config-rules.js';

/** スイープ間隔（分）。auto-update の bake time に相殺されないよう独立した env 変数にする */
const DEFAULT_SWEEP_MIN = 30;
/** サーバー起動から初回スイープまでの遅延（分） */
const DEFAULT_INITIAL_SWEEP_MIN = 5;

const envInt = (name: string, fallback: number): number => {
  const raw = process.env[name];
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/**
 * 1 回分のスイープを実行する。
 * オンラインの Agent を巡回し、`capabilityConfig` が設定済み・非 busy な Agent にだけ
 * `server:capability:sync`（trigger='idle'）を送る。
 */
async function runSweep(): Promise<void> {
  const machineIds = Array.from(getConnectedAgents().keys());
  if (machineIds.length === 0) return;

  // prisma generate 未実行（人間側作業）のため capabilityConfig は select 型に未反映。any 経由で読む
  const machines = await prisma.machine.findMany({
    where: { id: { in: machineIds }, deletedAt: null },
  }) as any[];

  let synced = 0;
  let skipped = 0;

  for (const machine of machines) {
    const busy = await isMachineBusy(machine.id);
    const decision = decideSweepAction({ capabilityConfig: machine.capabilityConfig ?? null, busy });
    if (decision.action === 'sync') {
      sendToAgent(machine.id, { type: 'server:capability:sync', payload: { trigger: 'idle' } });
      synced++;
    } else {
      skipped++;
    }
  }

  if (synced > 0 || skipped > 0) {
    console.log(`🔁 [capability-sweep] done: sync=${synced}, skip=${skipped} (of ${machineIds.length} online)`);
  }
}

/**
 * 定期スイープを開始する（サーバー起動時に 1 回呼ぶ）。
 * `auto-updater.ts` の `startAutoUpdateSweep()` と同じ「初回 N 分後 → 以後 M 分ごと」の様式。
 */
export function startCapabilitySweep(): void {
  const sweepMin = envInt('DEVRELAY_CAPABILITY_SWEEP_MIN', DEFAULT_SWEEP_MIN);
  const initialMin = envInt('DEVRELAY_CAPABILITY_SWEEP_INITIAL_MIN', DEFAULT_INITIAL_SWEEP_MIN);

  setTimeout(() => { void runSweep(); }, initialMin * 60 * 1000);
  setInterval(() => { void runSweep(); }, sweepMin * 60 * 1000);
  console.log(`🔁 Capability sweep started (first in ${initialMin}min, then every ${sweepMin}min)`);
}
