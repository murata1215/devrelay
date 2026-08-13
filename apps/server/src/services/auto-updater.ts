/**
 * #296: Agent 自動更新（サーバー主導）
 *
 * 手動 `u` → `u` と同じ経路（`server:agent:version-check` → `server:agent:update`）を
 * サーバー側から自動で叩く。**Agent 側の実装変更は不要**（今動いている Agent がそのまま応答できる）ため、
 * サーバー再起動だけで全マシンが自動更新の対象になる。
 *
 * トリガーは 2 系統:
 * - Agent 接続時（ランダム遅延つき。オフラインだったマシンも次に繋がった時点で最新化される）
 * - 6 時間ごとのスイープ（オンラインのマシンを走査）
 *
 * 安全側の設計:
 * - 更新を送るのはゲートを全て通過したときだけ（各ゲートは必ず skip 理由をログに出す）
 * - 同一コミットへの試行は 2 回まで。2 回失敗したらそのマシンの autoUpdate を false に落として人手を促す
 *   （#256 の stale dist デッドロックで「更新できないのに再起動し続ける」暴走を防ぐ）
 */

import { prisma } from '../db/client.js';
import { checkAgentVersion, updateAgentAuto, isAgentConnected, getConnectedAgents } from './agent-manager.js';
import { isSessionRunning } from './session-manager.js';
import { getUserSetting, SettingKeys } from './user-settings.js';

/** 同一コミットへの試行上限（超えたらそのマシンの自動更新を停止する） */
const MAX_ATTEMPTS_PER_COMMIT = 2;
/** 直近の自動更新からこの時間内は再試行しない（再起動 → 再接続 → 再チェックのループ防止） */
const COOLDOWN_MS = 30 * 60 * 1000;
/** 同時に更新するマシン数の上限（32 台が一斉に再起動するのを防ぐ） */
const MAX_CONCURRENT_UPDATES = 3;
/** リモートコミットがこの時間以上前でなければ配らない（bake time。壊れたコミットを配る前に直せる猶予） */
const DEFAULT_BAKE_MIN = 120;
/** スイープ間隔 */
const DEFAULT_SWEEP_MIN = 360;
/** 直近このミリ秒以内にメッセージがあるセッションを持つマシンは「作業中」とみなす */
const RECENT_ACTIVITY_MS = 10 * 60 * 1000;

/** 更新送信中のマシン（同時実行数の制御用） */
const inProgress = new Set<string>();

const envInt = (name: string, fallback: number): number => {
  const raw = process.env[name];
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const isDryRun = () => process.env.DEVRELAY_AUTO_UPDATE_DRY_RUN === '1';
const onlyMachineId = () => process.env.DEVRELAY_AUTO_UPDATE_ONLY || null;
const isGloballyDisabled = () => process.env.DEVRELAY_AUTO_UPDATE_DISABLED === '1';

/** ゲート評価の入力（I/O を含まない純粋なデータ。単体検証しやすくするため分離） */
export interface AutoUpdateGateInput {
  /** グローバル kill switch（UserSettings）が有効か */
  globallyEnabled: boolean;
  /** マシン単位の autoUpdate */
  machineEnabled: boolean;
  /** 開発リポジトリから実行中か（version-check の isDevRepo） */
  isDevRepo: boolean;
  /** 更新があるか */
  hasUpdate: boolean;
  /** リモートコミットの日時（ISO / git 形式） */
  remoteDate: string;
  /** 直近の自動更新試行日時 */
  lastAttemptAt: Date | null;
  /** 直近に狙ったコミット */
  lastAttemptCommit: string | null;
  /** リモートの最新コミット */
  remoteCommit: string;
  /** 同一コミットへの試行回数 */
  attempts: number;
  /** そのマシンで AI が動いている / 直近に作業があるか */
  busy: boolean;
  /** 現在進行中の自動更新数 */
  concurrent: number;
  /** 判定基準時刻 */
  now: Date;
  /** bake time（分） */
  bakeMinutes: number;
}

export type AutoUpdateDecision =
  | { action: 'update'; reason: string }
  | { action: 'skip'; reason: string }
  | { action: 'disable'; reason: string };

/**
 * 自動更新のゲート評価（純粋関数）
 * I/O を持たないので、各ケースをそのまま検証できる
 */
export function evaluateAutoUpdateGates(input: AutoUpdateGateInput): AutoUpdateDecision {
  if (!input.globallyEnabled) return { action: 'skip', reason: 'global kill switch off' };
  if (!input.machineEnabled) return { action: 'skip', reason: 'machine autoUpdate off' };
  if (input.isDevRepo) return { action: 'skip', reason: 'dev repo' };
  if (!input.hasUpdate) return { action: 'skip', reason: 'up to date' };

  // 同一コミットで試行上限に達している = 更新が効いていない（stale dist 等）。自動更新を止めて人手に委ねる
  if (input.lastAttemptCommit === input.remoteCommit && input.attempts >= MAX_ATTEMPTS_PER_COMMIT) {
    return { action: 'disable', reason: `failed ${input.attempts} times for ${input.remoteCommit.slice(0, 7)}` };
  }

  if (input.lastAttemptAt && input.now.getTime() - input.lastAttemptAt.getTime() < COOLDOWN_MS) {
    return { action: 'skip', reason: 'cooldown' };
  }

  const remoteMs = Date.parse(input.remoteDate);
  if (Number.isFinite(remoteMs)) {
    const ageMin = (input.now.getTime() - remoteMs) / 60000;
    if (ageMin < input.bakeMinutes) {
      return { action: 'skip', reason: `bake time (${Math.round(ageMin)}min < ${input.bakeMinutes}min)` };
    }
  }

  if (input.busy) return { action: 'skip', reason: 'busy (session running)' };
  if (input.concurrent >= MAX_CONCURRENT_UPDATES) return { action: 'skip', reason: 'concurrency limit' };

  return { action: 'update', reason: `${input.remoteCommit.slice(0, 7)}` };
}

/**
 * マシンが作業中か判定する
 * active セッションで AI 応答が進行中、または直近 10 分にメッセージがあれば作業中とみなす
 */
async function isMachineBusy(machineId: string): Promise<boolean> {
  const sessions = await prisma.session.findMany({
    where: { machineId, status: 'active' },
    select: { id: true },
  });
  if (sessions.some(s => isSessionRunning(s.id))) return true;

  if (sessions.length === 0) return false;
  const recent = await prisma.message.findFirst({
    where: {
      sessionId: { in: sessions.map(s => s.id) },
      createdAt: { gte: new Date(Date.now() - RECENT_ACTIVITY_MS) },
    },
    select: { id: true },
  });
  return recent !== null;
}

/**
 * 更新後の結果を照合する（#256 の stale dist 検出）
 * 直前に狙ったコミットに到達していれば success、到達していなければ試行回数を維持したまま次サイクルへ
 */
async function reconcileLastAttempt(
  machineId: string,
  localCommit: string,
  lastAttemptCommit: string | null,
  status: string | null,
  runningCodeStale: boolean | undefined
): Promise<void> {
  if (!lastAttemptCommit || status !== 'pending') return;

  if (localCommit === lastAttemptCommit && !runningCodeStale) {
    await prisma.machine.update({
      where: { id: machineId },
      data: { lastAutoUpdateStatus: 'success', autoUpdateAttempts: 0 },
    });
    console.log(`✅ Auto-update verified for ${machineId}: now at ${localCommit.slice(0, 7)}`);
  } else {
    const detail = runningCodeStale ? 'running code is stale (rebuild did not take effect)' : 'commit unchanged';
    console.log(`⚠️ Auto-update did not take effect for ${machineId}: ${detail}`);
  }
}

/**
 * 1 台に対して自動更新を試みる
 * ゲートを通過した場合のみ `server:agent:update` を送る
 *
 * @param machineId 対象マシン
 * @param trigger ログ用のトリガー種別（connect / sweep）
 */
export async function maybeAutoUpdate(machineId: string, trigger: 'connect' | 'sweep'): Promise<AutoUpdateDecision> {
  const log = (msg: string) => console.log(`🔁 [auto-update:${trigger}] ${machineId}: ${msg}`);

  if (isGloballyDisabled()) return { action: 'skip', reason: 'disabled by env' };
  const only = onlyMachineId();
  if (only && only !== machineId) return { action: 'skip', reason: 'filtered by DEVRELAY_AUTO_UPDATE_ONLY' };

  if (!isAgentConnected(machineId)) return { action: 'skip', reason: 'offline' };
  if (inProgress.has(machineId)) return { action: 'skip', reason: 'already updating' };

  const machine = await prisma.machine.findUnique({
    where: { id: machineId },
    select: {
      id: true, name: true, userId: true, autoUpdate: true, deletedAt: true,
      lastAutoUpdateAt: true, lastAutoUpdateCommit: true, lastAutoUpdateStatus: true, autoUpdateAttempts: true,
    },
  });
  if (!machine || machine.deletedAt) return { action: 'skip', reason: 'machine not found' };

  // グローバル kill switch（未設定なら有効）
  const globalSetting = await getUserSetting(machine.userId, SettingKeys.AUTO_UPDATE_ENABLED);
  const globallyEnabled = globalSetting !== 'false';

  // 早期 skip（version-check は git fetch を伴うので、無駄に叩かない）
  if (!globallyEnabled || !machine.autoUpdate) {
    const reason = !globallyEnabled ? 'global kill switch off' : 'machine autoUpdate off';
    log(`⏭ skip: ${reason}`);
    return { action: 'skip', reason };
  }

  let version;
  try {
    version = await checkAgentVersion(machineId);
  } catch (err) {
    log(`⏭ skip: version check failed (${(err as Error).message})`);
    return { action: 'skip', reason: 'version check failed' };
  }
  if (version.error) {
    log(`⏭ skip: version check error (${version.error})`);
    return { action: 'skip', reason: 'version check error' };
  }

  // 前回の試行結果を照合（成功していれば success として確定させる）
  await reconcileLastAttempt(
    machineId, version.localCommit, machine.lastAutoUpdateCommit, machine.lastAutoUpdateStatus, version.runningCodeStale
  );

  const busy = version.hasUpdate ? await isMachineBusy(machineId) : false;
  const decision = evaluateAutoUpdateGates({
    globallyEnabled,
    machineEnabled: machine.autoUpdate,
    // isDevRepo は任意フィールド。省略する古い Agent は判別できないため「開発リポ扱い＝更新しない」に倒す
    // （誤って開発機を更新するより、手動 `u` に委ねる方が安全）
    isDevRepo: version.isDevRepo ?? true,
    hasUpdate: version.hasUpdate,
    remoteDate: version.remoteDate,
    lastAttemptAt: machine.lastAutoUpdateAt,
    lastAttemptCommit: machine.lastAutoUpdateCommit,
    remoteCommit: version.remoteCommit,
    attempts: machine.autoUpdateAttempts,
    busy,
    concurrent: inProgress.size,
    now: new Date(),
    bakeMinutes: envInt('DEVRELAY_AUTO_UPDATE_BAKE_MIN', DEFAULT_BAKE_MIN),
  });

  if (decision.action === 'disable') {
    await prisma.machine.update({
      where: { id: machineId },
      data: { autoUpdate: false, lastAutoUpdateStatus: 'failed:stale-dist' },
    });
    console.error(`🛑 [auto-update] disabled for ${machine.name}: ${decision.reason} — 手動 \`u\` かビルド確認が必要です`);
    return decision;
  }

  if (decision.action === 'skip') {
    log(`⏭ skip: ${decision.reason}`);
    return decision;
  }

  if (isDryRun()) {
    log(`🧪 dry-run: would update to ${decision.reason} (local ${version.localCommit.slice(0, 7)})`);
    return { action: 'skip', reason: `dry-run (would update to ${decision.reason})` };
  }

  // 同一コミットなら試行回数を +1、別コミットなら 1 にリセット
  const sameCommit = machine.lastAutoUpdateCommit === version.remoteCommit;
  await prisma.machine.update({
    where: { id: machineId },
    data: {
      lastAutoUpdateAt: new Date(),
      lastAutoUpdateCommit: version.remoteCommit,
      lastAutoUpdateStatus: 'pending',
      autoUpdateAttempts: sameCommit ? machine.autoUpdateAttempts + 1 : 1,
    },
  });

  inProgress.add(machineId);
  // Agent は更新後に再起動して再接続するため、一定時間後に進行中フラグを解除する
  setTimeout(() => inProgress.delete(machineId), COOLDOWN_MS);

  console.log(`🚀 [auto-update] ${machine.name}: ${version.localCommit.slice(0, 7)} → ${version.remoteCommit.slice(0, 7)}`);
  updateAgentAuto(machineId);
  return decision;
}

/**
 * Agent 接続時のトリガー
 * 接続直後は復元処理などで混み合うため、30〜120 秒のランダム遅延を入れて分散させる
 */
export function scheduleAutoUpdateOnConnect(machineId: string): void {
  const delayMs = (30 + Math.floor(Math.random() * 90)) * 1000;
  setTimeout(() => {
    maybeAutoUpdate(machineId, 'connect').catch(err =>
      console.error(`❌ [auto-update:connect] ${machineId}:`, (err as Error).message)
    );
  }, delayMs);
}

/**
 * 定期スイープを開始する（サーバー起動時に 1 回呼ぶ）
 * オンラインのマシンを順に評価する。同時実行数はゲート側で制限される
 */
export function startAutoUpdateSweep(): void {
  const sweepMin = envInt('DEVRELAY_AUTO_UPDATE_SWEEP_MIN', DEFAULT_SWEEP_MIN);
  const run = async () => {
    const machineIds = Array.from(getConnectedAgents().keys());
    if (machineIds.length === 0) return;
    console.log(`🔁 [auto-update:sweep] checking ${machineIds.length} online agent(s)`);
    for (const machineId of machineIds) {
      try {
        await maybeAutoUpdate(machineId, 'sweep');
      } catch (err) {
        console.error(`❌ [auto-update:sweep] ${machineId}:`, (err as Error).message);
      }
    }
  };

  setInterval(() => { void run(); }, sweepMin * 60 * 1000);
  console.log(`🔁 Auto-update sweep started (every ${sweepMin}min, bake ${envInt('DEVRELAY_AUTO_UPDATE_BAKE_MIN', DEFAULT_BAKE_MIN)}min${isDryRun() ? ', DRY RUN' : ''})`);
}

/** Agent から更新失敗の通知を受けた際に記録する（自動更新起点のときのみ） */
export async function recordAutoUpdateError(machineId: string, error: string): Promise<void> {
  const machine = await prisma.machine.findUnique({
    where: { id: machineId },
    select: { lastAutoUpdateStatus: true },
  });
  if (machine?.lastAutoUpdateStatus !== 'pending') return;
  await prisma.machine.update({
    where: { id: machineId },
    data: { lastAutoUpdateStatus: `error:${error.slice(0, 200)}` },
  });
}
