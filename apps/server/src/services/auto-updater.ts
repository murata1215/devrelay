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
import { decideReconcileOutcome } from './auto-update-reconcile.js';
import { inFlightTurns } from './in-flight-turns.js';
import { isUpdateBusyGuardEnabled, resolveBusyReason, resolveCooldownMs } from './update-busy-rules.js';

/** 同一コミットへの試行上限（超えたらそのマシンの自動更新を停止する） */
const MAX_ATTEMPTS_PER_COMMIT = 2;
/** 直近の自動更新からこの時間内は再試行しない（再起動 → 再接続 → 再チェックのループ防止） */
const COOLDOWN_MS = 30 * 60 * 1000;
/**
 * サイクル3.1: 直前の試行が `deferred`（Agent 側が実行中 AI ターンを検知して保留）だった場合の
 * クールダウン短縮値。通常の 30 分だと「ターンが 5 分で終わっても次スイープまで気づけない」ため、
 * 次回スイープ（既定 30 分間隔）で早めに再評価できるよう短くする。
 */
const DEFERRED_COOLDOWN_MS = 10 * 60 * 1000;
/** 同時に更新するマシン数の上限（32 台が一斉に再起動するのを防ぐ） */
const MAX_CONCURRENT_UPDATES = 3;
/** リモートコミットがこの時間以上前でなければ配らない（bake time。壊れたコミットを配る前に直せる猶予） */
const DEFAULT_BAKE_MIN = 120;
/**
 * スイープ間隔
 *
 * #297: 以前は 360 分だったが、bake time（120分）より長いと
 * 「デプロイ直後の再接続バーストは bake で全部 skip → bake 明けにはトリガーが無い」
 * という穴が空き、ロールアウトが最大 6 時間止まっていた。bake より十分短くする。
 */
const DEFAULT_SWEEP_MIN = 30;
/** サーバー起動から初回スイープまでの遅延（起動直後はセッション復元などで混むため少し待つ） */
const DEFAULT_INITIAL_SWEEP_MIN = 5;
/** 直近このミリ秒以内にメッセージがあるセッションを持つマシンは「作業中」とみなす */
const RECENT_ACTIVITY_MS = 10 * 60 * 1000;
/** pending のままこの時間を超えたら timeout として記録する（WebUI から滞留を見えるようにするため） */
const PENDING_TIMEOUT_MS = 2 * 60 * 60 * 1000;

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
  /** 直近の自動更新試行結果（サイクル3.1: cooldown 短縮判定に使う。'deferred' のときだけ短縮） */
  lastAttemptStatus?: string | null;
  /** リモートの最新コミット */
  remoteCommit: string;
  /** 同一コミットへの試行回数 */
  attempts: number;
  /** そのマシンで AI が動いている / 直近に作業があるか */
  busy: boolean;
  /**
   * サイクル3.1: busy の理由（`busy (in-flight turn: N)` / `busy (session running)` /
   * `busy (recent activity)`）。skip ログで原因を区別できるようにするため、`busy: boolean` と
   * 併せて渡す（省略時は従来どおり固定文言にフォールバック、既存シグネチャ非破壊）。
   */
  busyReason?: string | null;
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

  // サイクル3.1: 直前が deferred なら短縮クールダウンで早めに再評価する
  const cooldownMs = resolveCooldownMs(input.lastAttemptStatus, { normalMs: COOLDOWN_MS, deferredMs: DEFERRED_COOLDOWN_MS });
  if (input.lastAttemptAt && input.now.getTime() - input.lastAttemptAt.getTime() < cooldownMs) {
    return { action: 'skip', reason: 'cooldown' };
  }

  const remoteMs = Date.parse(input.remoteDate);
  if (Number.isFinite(remoteMs)) {
    const ageMin = (input.now.getTime() - remoteMs) / 60000;
    if (ageMin < input.bakeMinutes) {
      return { action: 'skip', reason: `bake time (${Math.round(ageMin)}min < ${input.bakeMinutes}min)` };
    }
  }

  // サイクル3.1: busyReason があれば原因を区別できる文言を使う（省略時は従来の固定文言）
  if (input.busy) return { action: 'skip', reason: input.busyReason ?? 'busy (session running)' };
  if (input.concurrent >= MAX_CONCURRENT_UPDATES) return { action: 'skip', reason: 'concurrency limit' };

  return { action: 'update', reason: `${input.remoteCommit.slice(0, 7)}` };
}

/**
 * マシンが作業中か判定し、理由文字列を返す（busy でなければ null）。
 *
 * サイクル3.1: 判定の優先順位を 3 段に拡張した。
 * 1. 実行中ターン台帳（`InFlightTurnRegistry`）— 経路を問わず AI プロンプト送信〜完了検知までを
 *    捕捉する（根本原因の修正。MCP exec / crossquery・teamexec / raw-completion は従来 2〜3 では
 *    捕捉できなかった）
 * 2. 既存: active セッションで `progressTracker` が張られている（対話経路・`ag`・MCP submit/ask）
 * 3. 既存: 直近 10 分以内にそのマシンの active セッションへの Message があるか
 *
 * `DEVRELAY_UPDATE_BUSY_GUARD=0` のときは 1 を無効化し、2〜3 のみ（従来挙動）に戻す。
 */
export async function isMachineBusyWithReason(machineId: string): Promise<string | null> {
  if (isUpdateBusyGuardEnabled(process.env.DEVRELAY_UPDATE_BUSY_GUARD)) {
    const inFlightTurnCount = inFlightTurns.count(machineId, Date.now());
    if (inFlightTurnCount > 0) {
      return resolveBusyReason({ inFlightTurnCount, sessionRunning: false, recentActivity: false });
    }
  }

  const sessions = await prisma.session.findMany({
    where: { machineId, status: 'active' },
    select: { id: true },
  });
  if (sessions.some(s => isSessionRunning(s.id))) {
    return resolveBusyReason({ inFlightTurnCount: 0, sessionRunning: true, recentActivity: false });
  }

  if (sessions.length === 0) return null;
  const recent = await prisma.message.findFirst({
    where: {
      sessionId: { in: sessions.map(s => s.id) },
      createdAt: { gte: new Date(Date.now() - RECENT_ACTIVITY_MS) },
    },
    select: { id: true },
  });
  if (recent !== null) {
    return resolveBusyReason({ inFlightTurnCount: 0, sessionRunning: false, recentActivity: true });
  }
  return null;
}

/**
 * マシンが作業中か判定する（boolean 版）。
 *
 * サイクルP1: capability-sweep.ts からも busy ゲートとして再利用するため export する
 * （bake/cooldown/試行上限は自動更新固有なので流用しない。busy 判定だけを共有する）。
 * 実装は `isMachineBusyWithReason()` に委譲する薄いラッパ（既存呼び出し元 0 行変更で済ませるため）。
 */
export async function isMachineBusy(machineId: string): Promise<boolean> {
  return (await isMachineBusyWithReason(machineId)) !== null;
}

/**
 * 更新後の結果を照合する（#256 の stale dist 検出）
 * 直前に狙ったコミットに到達していれば success、到達していなければ試行回数を維持したまま次サイクルへ
 *
 * #351: 判定そのものは `decideReconcileOutcome()`（外部 import ゼロの純関数）に集約した。
 * 従来は `status === 'pending'` のときにしか照合していなかったため、一度 `timeout:...` に
 * 落ちると健全な状態に戻っても `lastAutoUpdateStatus` が永久に残ってしまっていた
 * （DESKTOP-1JR1NLL/c-shiraki で実際に発生）。`decideReconcileOutcome()` は
 * `status` を条件にせず「成功の証拠が揃っているか」だけで success を確定できるようにする。
 *
 * @param lastAttemptAt 直近の試行日時（pending の滞留判定に使う）
 */
async function reconcileLastAttempt(
  machineId: string,
  localCommit: string,
  lastAttemptCommit: string | null,
  lastAttemptAt: Date | null,
  status: string | null,
  runningCodeStale: boolean | undefined
): Promise<void> {
  const outcome = decideReconcileOutcome({
    localCommit,
    lastAttemptCommit,
    status,
    runningCodeStale,
    lastAttemptAt,
    nowMs: Date.now(),
    pendingTimeoutMs: PENDING_TIMEOUT_MS,
  });

  if (outcome.action === 'none') return;

  if (outcome.action === 'success') {
    await prisma.machine.update({
      where: { id: machineId },
      data: { lastAutoUpdateStatus: 'success', autoUpdateAttempts: 0 },
    });
    console.log(`✅ Auto-update verified for ${machineId}: now at ${localCommit.slice(0, 7)}`);
    return;
  }

  if (outcome.action === 'success:unverified') {
    // 旧 Agent: commit は進んだがビルド鮮度を自己申告できない。「成功」と確定はさせず、
    // unverified として記録する（WebUI で旧 Agent と分かるよう可視化。#302）
    await prisma.machine.update({
      where: { id: machineId },
      data: { lastAutoUpdateStatus: 'success:unverified', autoUpdateAttempts: 0 },
    });
    console.log(`✅ Auto-update commit advanced for ${machineId} but unverified (old agent: build freshness unknown): now at ${localCommit.slice(0, 7)}`);
    return;
  }

  // outcome.action === 'timeout'
  // #297: 長時間 pending のままだと WebUI 上は「更新中」に見えたまま滞留する。timeout として可視化する
  // （試行回数は変えない。MAX_ATTEMPTS_PER_COMMIT による暴走抑止はそのまま効かせる）
  console.log(`⚠️ Auto-update did not take effect for ${machineId}: ${outcome.detail}`);
  await prisma.machine.update({
    where: { id: machineId },
    data: { lastAutoUpdateStatus: `timeout:${outcome.detail}`.slice(0, 200) },
  });
  console.warn(`⏱️ Auto-update pending timed out for ${machineId} (${outcome.detail})`);
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
    machineId, version.localCommit, machine.lastAutoUpdateCommit, machine.lastAutoUpdateAt,
    machine.lastAutoUpdateStatus, version.runningCodeStale
  );

  let busyReason = version.hasUpdate ? await isMachineBusyWithReason(machineId) : null;
  // サイクル3.1 (D2 連携): version-check 応答に Agent 自己申告の実行中ターン数があれば、
  // サーバー側台帳が見落とした場合の追加の安全網として busy 判定に加える（新 Agent のみ。
  // 省略時 undefined は無視＝旧 Agent で非退行）
  if (busyReason === null && version.hasUpdate && (version.activeAiTurns ?? 0) > 0) {
    busyReason = `busy (agent-reported turn: ${version.activeAiTurns})`;
  }
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
    lastAttemptStatus: machine.lastAutoUpdateStatus,
    remoteCommit: version.remoteCommit,
    attempts: machine.autoUpdateAttempts,
    busy: busyReason !== null,
    busyReason,
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
 *
 * #297: 起動直後にも 1 回走らせる。以前は setInterval の登録だけだったため、
 * 「再起動 → 全 Agent 再接続（bake 内なので全 skip）→ 次のスイープまで無反応」で
 * ロールアウトがスイープ間隔ぶん丸ごと止まっていた。
 */
export function startAutoUpdateSweep(): void {
  const sweepMin = envInt('DEVRELAY_AUTO_UPDATE_SWEEP_MIN', DEFAULT_SWEEP_MIN);
  const initialMin = envInt('DEVRELAY_AUTO_UPDATE_INITIAL_SWEEP_MIN', DEFAULT_INITIAL_SWEEP_MIN);

  const run = async () => {
    // サイクル3.1: 取りこぼし経路（kill・切断検知漏れ等）で残り続ける台帳エントリを TTL で掃除する
    inFlightTurns.sweepStale(Date.now());

    const machineIds = Array.from(getConnectedAgents().keys());
    if (machineIds.length === 0) return;
    console.log(`🔁 [auto-update:sweep] checking ${machineIds.length} online agent(s)`);

    // skip 理由ごとの内訳を集計する（個別行はノイズに埋もれるため、1 行のサマリで追えるようにする）
    const skipReasons = new Map<string, number>();
    let updated = 0;
    let disabled = 0;

    for (const machineId of machineIds) {
      try {
        const decision = await maybeAutoUpdate(machineId, 'sweep');
        if (decision.action === 'update') updated++;
        else if (decision.action === 'disable') disabled++;
        else skipReasons.set(decision.reason, (skipReasons.get(decision.reason) ?? 0) + 1);
      } catch (err) {
        console.error(`❌ [auto-update:sweep] ${machineId}:`, (err as Error).message);
        skipReasons.set('exception', (skipReasons.get('exception') ?? 0) + 1);
      }
    }

    const breakdown = Array.from(skipReasons.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => `${reason}=${count}`)
      .join(', ');
    console.log(
      `🔁 [auto-update:sweep] done: update=${updated}, disable=${disabled}, skip=${machineIds.length - updated - disabled}` +
      (breakdown ? ` (${breakdown})` : '')
    );
  };

  setTimeout(() => { void run(); }, initialMin * 60 * 1000);
  setInterval(() => { void run(); }, sweepMin * 60 * 1000);
  console.log(`🔁 Auto-update sweep started (first in ${initialMin}min, then every ${sweepMin}min, bake ${envInt('DEVRELAY_AUTO_UPDATE_BAKE_MIN', DEFAULT_BAKE_MIN)}min${isDryRun() ? ', DRY RUN' : ''})`);
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

/**
 * サイクル3.1 (C3): Agent から `'deferred'`（実行中 AI ターンのため更新を保留した）の通知を
 * 受けた際に記録する（自動更新起点のときのみ。手動 `u`/`u force` 起点は `autoUpdateAttempts` を
 * 一切触っていないため呼ばない。呼び出し元の `agent-manager.ts` が `pendingUpdateNotify` の有無で
 * 振り分ける）。
 *
 * - `autoUpdateAttempts` を 1 戻す（`maybeAutoUpdate` が送信直前に +1 済みのため。D3 が目的とする
 *   「deferred は試行回数に数えない」を実現する。0 未満にはしない）
 * - `lastAutoUpdateStatus` を `'deferred'` に。`lastAutoUpdateAt` は変えない
 *   （`resolveCooldownMs()` の短縮クールダウンはこの時刻を起点にする）
 * - `inProgress` から即座に外す（既定 `COOLDOWN_MS`=30分保持だと次スイープが `already updating` で
 *   skip されてしまい、短縮クールダウンが効かない）
 */
export async function recordAutoUpdateDeferred(machineId: string, activeAiTurns: number | undefined): Promise<void> {
  inProgress.delete(machineId);

  const machine = await prisma.machine.findUnique({
    where: { id: machineId },
    select: { autoUpdateAttempts: true },
  });
  if (!machine) return;

  await prisma.machine.update({
    where: { id: machineId },
    data: {
      lastAutoUpdateStatus: 'deferred',
      autoUpdateAttempts: Math.max(0, machine.autoUpdateAttempts - 1),
    },
  });
  console.log(`⏸️ [auto-update] deferred for ${machineId} (activeAiTurns=${activeAiTurns ?? 'unknown'})`);
}
