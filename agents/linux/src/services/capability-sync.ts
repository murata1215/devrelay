/**
 * サイクルP1: Capability 配布基盤の共通層（provider/kind 非依存の I/O 部分）。
 *
 * 責務: config 保持 / adapter レジストリ（キー `"<provider>:<kind>"`）/ 直列化 / timeout /
 * 結果集約 / `agent:capability:sync` 送信。
 *
 * **Claude CLI も `.claude/settings.json` も一切知らない**
 * （Claude 固有処理は `capabilities/claude-plugin-adapter.ts` に閉じ込める）。
 * Codex/Devin を足すときは `registerCapabilityAdapter()` で
 * `"codex:<kind>"` / `"devin:<kind>"` を登録するだけでよく、このファイルの変更は不要。
 *
 * `connection.ts` との間で循環 import になるため（`connection.ts` は machineId や WS 送信を
 * 持つ）、送信は `setCapabilitySyncSender()` で connection.ts 側から関数を注入する DI 方式にする
 * （`ai-runner.ts` が `reportClaudeAuthOkFromRuntime` を connection.ts から直接 import する
 * 既存の逆方向パターンとは違い、こちらは connection.ts が capability-sync.ts に依存されると
 * 循環度が増すため、あえて注入にしている）。
 */

import type { CapabilityConfig, CapabilityResult, AgentCapabilitySyncPayload } from '@devrelay/shared';
import {
  aiToolToCapabilityProvider,
  decideEnqueue,
  shouldAlwaysReport,
  mergeCapabilityResults,
  buildUnsupportedResult,
  buildPrelaunchCacheKey,
  decidePrelaunchAction,
  listConfiguredProviders,
  resolveReconcileTargets,
  hasReportableOutcome,
  decidePrelaunchStatus,
  resolveCleanupKeys,
  type QueueState,
  type MergeableResult,
  type PrelaunchCacheEntry,
} from './capability-rules.js';

/** adapter に渡す reconcile 用コンテキスト */
export interface CapabilityCtx {
  config: CapabilityConfig;
  /** capabilityConfig.items のうち、この adapter の provider/kind に該当するものだけ */
  items: Array<{ provider: string; kind: string; id: string }>;
  /**
   * サイクルP1.3 要件5: prelaunch 専用の machine reconcile 委譲コールバック。
   * machine 経路（`runMachineReconcile` 内で adapter に渡す ctx）では注入しない（undefined）ため、
   * 「prelaunch でしか呼べない」ことを型で表現し、adapter が machine 経路で誤って自己再帰させる
   * ことを防ぐ（呼び出しは fire-and-forget。await しない・throw しない前提）。
   */
  requestMachineReconcile?: () => void;
}

/** 個別の provider×kind Capability を配布する adapter の最小インタフェース（指示書§14-4 準拠） */
export interface CapabilityAdapter {
  provider: string;
  kind: string;
  reconcileMachine(ctx: CapabilityCtx): Promise<CapabilityResult>;
  reconcileProject(ctx: CapabilityCtx, projectPath: string): Promise<CapabilityResult>;
  /**
   * サイクルP3-A §2: optional な撤去経路サポート。true = この adapter が過去に配置した
   * 管理下の状態がこのマシンに残っている。未実装の adapter（Claude 等）は cleanup 経路に
   * 構造的に入らない。throw / timeout は false 扱い（fail-closed: 判定できないなら
   * 破壊的操作をしない）。
   */
  hasManagedState?(): Promise<boolean>;
}

/** `agent:capability:sync` 送信ペイロード（machineId は connection.ts 側で付与するため除く） */
export type CapabilitySyncOutcome = Omit<AgentCapabilitySyncPayload, 'machineId'>;

const adapterRegistry = new Map<string, CapabilityAdapter>();

/** adapter を登録する。Codex/Devin 追加時はここに 1 行足すだけでよい */
export function registerCapabilityAdapter(adapter: CapabilityAdapter): void {
  adapterRegistry.set(`${adapter.provider}:${adapter.kind}`, adapter);
}

/** テスト/再接続時にレジストリをクリアする（通常運用では未使用） */
export function clearCapabilityAdapters(): void {
  adapterRegistry.clear();
}

/** Server から配信された Capability 配布設定（null = 機能 OFF） */
let currentConfig: CapabilityConfig | null = null;

/**
 * サイクルP3-A §2: `capabilityConfig` キー自体が payload に一度でも存在したか（値が null でも true）。
 * `connection.ts` は `message.payload.capabilityConfig !== undefined` のガード内でのみ
 * `setCapabilityConfig()` を呼ぶため、この関数が呼ばれたこと自体が「キーが存在した」ことの根拠になる
 * （connection.ts 側の変更は不要）。旧 server（capabilityConfig 未配信）ではこの関数が一度も呼ばれず
 * false のままなので、`currentConfig === null` を「まだ配信されていない」と区別できる。
 */
let configDelivered = false;

export function setCapabilityConfig(config: CapabilityConfig | null): void {
  currentConfig = config;
  configDelivered = true;
}

export function getCapabilityConfig(): CapabilityConfig | null {
  return currentConfig;
}

/** テスト専用: `configDelivered` フラグをリセットする（通常運用では未使用） */
export function resetCapabilityConfigDeliveredForTests(): void {
  configDelivered = false;
  currentConfig = null;
}

/** cleanup パス専用: 「明示的に何も設定されていない」ことを表す空の config（機体撤去用） */
const EMPTY_CONFIG: CapabilityConfig = { providers: {}, items: [] };

/** `agent:capability:sync` の送信先（connection.ts から注入） */
let sendResultCallback: ((payload: CapabilitySyncOutcome) => void) | null = null;

export function setCapabilitySyncSender(fn: (payload: CapabilitySyncOutcome) => void): void {
  sendResultCallback = fn;
}

/** machine スコープの直列化キュー状態（単一 in-flight + pending 1 本） */
const queueState: QueueState = { inFlight: false, pendingTrigger: null };

/** adapter 呼び出しのタイムアウト（provider ごとの個別設定は持たず一律 3 分） */
const ADAPTER_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * `hasManagedState()` 呼び出しのタイムアウト（サイクルP3-A §2）。
 * fs 走査のみで完結する想定の軽量チェックのため、`ADAPTER_TIMEOUT_MS` より短く設定する。
 */
const HAS_MANAGED_STATE_TIMEOUT_MS = 30 * 1000;

/** timeout してもハングしない Promise ラッパー。timeout 時は 'timeout' を返す（reject しない） */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), ms);
    promise
      .then((v) => { clearTimeout(timer); resolve(v); })
      .catch(() => { clearTimeout(timer); resolve('timeout'); });
  });
}

function failedResult(provider: string, kind: string, reason: string): MergeableResult {
  return { provider, kind, runtimeVersion: null, installed: [], updated: [], present: [], failed: [{ id: `${provider}:${kind}`, reason }], notAllowed: [] };
}

/**
 * 指定 adapter の `hasManagedState()` を呼ぶ。未実装なら false、throw / timeout も false
 * （fail-closed: 判定できないなら破壊的操作をしない）。
 */
async function checkHasManagedState(adapter: CapabilityAdapter): Promise<boolean> {
  if (!adapter.hasManagedState) return false;
  try {
    const outcome = await withTimeout(adapter.hasManagedState(), HAS_MANAGED_STATE_TIMEOUT_MS);
    return outcome === true;
  } catch {
    return false;
  }
}

/**
 * サイクルP3-A §2: 撤去経路（cleanup パス）。「registry にあるが今回の reconcile ターゲットに
 * 含まれず（uncovered）、かつ管理下の状態が残っている（managed）」adapter だけを
 * `items: []` で呼び、「管理下を全部撤去せよ」を伝える。
 * `hasManagedState` 未実装の adapter（Claude 等）は構造的にここに入らない。
 */
async function runCleanupPass(coveredKeys: string[]): Promise<MergeableResult[]> {
  const registryKeys = Array.from(adapterRegistry.keys());
  const managedFlags = await Promise.all(
    registryKeys.map(async (key) => ({ key, managed: await checkHasManagedState(adapterRegistry.get(key)!) })),
  );
  const managedKeys = managedFlags.filter((f) => f.managed).map((f) => f.key);
  const cleanupKeys = resolveCleanupKeys(registryKeys, coveredKeys, managedKeys);

  const results: MergeableResult[] = [];
  for (const key of cleanupKeys) {
    const adapter = adapterRegistry.get(key)!;
    const [provider, kind] = key.split(':');
    try {
      const outcome = await withTimeout(adapter.reconcileMachine({ config: EMPTY_CONFIG, items: [] }), ADAPTER_TIMEOUT_MS);
      results.push(outcome === 'timeout' ? failedResult(provider, kind, 'timeout') : outcome);
    } catch (err) {
      results.push(failedResult(provider, kind, (err as Error)?.message || 'error'));
    }
  }
  return results;
}

/**
 * 現在の capabilityConfig を全 adapter に対して machine レベルで reconcile する。
 * 未登録の provider/kind は throw せず failed に積んで処理を続行する（1 件の失敗が全体を止めない）。
 *
 * サイクルP1.2: `items` が空でも `providers.<provider>` が設定されていれば対象 provider の adapter を
 * 呼ぶ（`resolveReconcileTargets()` が items 由来 + registry 由来のターゲットを合成する。§8.1 は
 * items 0 件でも marketplace 登録/update までは行う設計）。
 *
 * サイクルP3-A §2: `config === null` でも `configDelivered === true`（承認ノート#2 の
 * authoritative cleanup 条件）なら、cleanup パスだけを実行して managed な adapter の状態を撤去する
 * （旧 server で `capabilityConfig` キー自体が一度も配信されていない場合は `configDelivered` が
 * false のままなので、ロールバック事故を起こさず何もしない）。
 */
async function runMachineReconcile(trigger: AgentCapabilitySyncPayload['trigger']): Promise<CapabilitySyncOutcome> {
  const startedAt = Date.now();
  const config = currentConfig;

  if (!config) {
    if (!configDelivered) {
      return { status: 'skipped', results: [], durationMs: Date.now() - startedAt, trigger };
    }
    const cleanupResults = await runCleanupPass([]);
    const merged = mergeCapabilityResults(cleanupResults);
    if (merged.length === 0) {
      return { status: 'skipped', results: [], durationMs: Date.now() - startedAt, trigger };
    }
    const hasFailure = merged.some(r => r.failed.length > 0);
    return { status: hasFailure ? 'error' : 'done', results: merged, durationMs: Date.now() - startedAt, trigger };
  }

  const knownProviders = new Set(Array.from(adapterRegistry.values()).map(a => a.provider));
  const targets = resolveReconcileTargets(
    listConfiguredProviders(config.providers),
    config.items,
    Array.from(adapterRegistry.keys()),
  );
  const results: MergeableResult[] = [];

  for (const target of targets) {
    const { provider, kind, items } = target;
    const key = `${provider}:${kind}`;
    const adapter = adapterRegistry.get(key);
    if (!adapter) {
      results.push(buildUnsupportedResult(provider, kind, knownProviders.has(provider)));
      continue;
    }
    try {
      const outcome = await withTimeout(adapter.reconcileMachine({ config, items }), ADAPTER_TIMEOUT_MS);
      results.push(outcome === 'timeout' ? failedResult(provider, kind, 'timeout') : outcome);
    } catch (err) {
      results.push(failedResult(provider, kind, (err as Error)?.message || 'error'));
    }
  }

  // サイクルP3-A §2: 設定から外れた（uncovered）が管理下の状態が残っている adapter を撤去する
  const coveredKeys = targets.map((t) => `${t.provider}:${t.kind}`);
  results.push(...(await runCleanupPass(coveredKeys)));

  const merged = mergeCapabilityResults(results);
  const hasFailure = merged.some(r => r.failed.length > 0);
  return { status: hasFailure ? 'error' : 'done', results: merged, durationMs: Date.now() - startedAt, trigger };
}

/**
 * machine スコープの直列化キューに reconcile リクエストを積む（trigger: connect/config/idle/manual）。
 * prelaunch はこのキューに入らない（`reconcileForRunner()` を使う。理由は §E-5 参照:
 * Sync now の最大 3 分に毎タスクがブロックされるのを避けるため）。
 */
export async function requestReconcile(trigger: 'connect' | 'config' | 'idle' | 'manual'): Promise<void> {
  const decision = decideEnqueue(queueState, trigger);
  if (decision.action === 'keep-pending') return;
  if (decision.action === 'queue-pending') {
    queueState.pendingTrigger = decision.trigger;
    return;
  }

  // run-now
  queueState.inFlight = true;
  try {
    const result = await runMachineReconcile(trigger);
    // manual は skipped でも必ず 1 通報告する（押したのに無反応を防ぐ）
    if (result.status !== 'skipped' || shouldAlwaysReport(trigger)) {
      sendResultCallback?.(result);
    }
  } finally {
    queueState.inFlight = false;
    const pending = queueState.pendingTrigger;
    queueState.pendingTrigger = null;
    if (pending) {
      // pending 分を実行（await しない。呼び出し元をブロックしない）
      void requestReconcile(pending as 'connect' | 'config' | 'idle' | 'manual');
    }
  }
}

// -----------------------------------------------------------------------------
// prelaunch 経路（machine キューに入らない。短期キャッシュで多重実行を抑止する）
// -----------------------------------------------------------------------------

/** provider → 直近の prelaunch キャッシュ */
const prelaunchCache = new Map<string, PrelaunchCacheEntry>();
/** 同一 (provider, projectPath) の直近 reconcile から何 ms 以内なら再実行しないか */
const PRELAUNCH_TTL_MS = 5 * 60 * 1000;
/**
 * prelaunch がブロックしてよい上限（§7.3: runner 起動直前のブロック上限は 3 分。
 * サイクルP1.2 で 5 秒 → 3 分に変更: `--scope local` install が実測 20.7 秒かかり
 * 旧 5 秒予算では毎回 timeout して install が事実上機能していなかったため、
 * `ADAPTER_TIMEOUT_MS`（machine 側）と同じ 3 分に揃えた。
 * ただし adapter 側（`claude-plugin-adapter.ts`）が「差分が無ければ CLI を呼ばず即 return」する
 * ため、この 3 分は「差分があるときだけ」実際に消費される（§8.2 末尾）。
 */
export const PRELAUNCH_WAIT_MS = ADAPTER_TIMEOUT_MS;

/**
 * `ai-runner.ts` の起動直前チョークポイント（唯一の呼び出し元）から呼ばれる。
 * `aiTool` から provider が判明し、かつ `capabilityConfig` が設定されている場合のみ動く。
 * machine スコープの直列化キューには入らず、専用の TTL キャッシュで 1 ターン内の
 * 複数回再入（`connection.ts` のリトライ・`ai-runner.ts` のフォールバック）を no-op にする。
 * 失敗・timeout しても runner の起動をブロックしない（例外を投げない設計）。
 *
 * サイクルP1.2: `capabilityConfig.items` の件数に依存しない（§8.2 は project の
 * `.claude/settings.json` の `enabledPlugins` で駆動する設計であり、Machine 側 items が
 * 0 件でも動く必要がある）。`providers.<provider>` が設定されているかどうかだけで判定する。
 */
export async function reconcileForRunner(aiTool: string, projectPath: string): Promise<void> {
  const provider = aiToolToCapabilityProvider(aiTool);
  if (!provider || !currentConfig) return;
  if (!listConfiguredProviders(currentConfig.providers).includes(provider)) return; // TTL キャッシュを汚す前に return

  const cacheKey = buildPrelaunchCacheKey(provider, projectPath);
  const cached = prelaunchCache.get(provider) ?? null;
  if (decidePrelaunchAction(cached, cacheKey, Date.now(), PRELAUNCH_TTL_MS) === 'use-cache') {
    return;
  }
  prelaunchCache.set(provider, { key: cacheKey, cachedAtMs: Date.now() });

  const targets = resolveReconcileTargets(
    listConfiguredProviders(currentConfig.providers),
    currentConfig.items,
    Array.from(adapterRegistry.keys()),
    provider,
  ).filter(t => t.hasAdapter);
  const results: MergeableResult[] = [];

  // サイクルP1.3 要件5: machine キューへの委譲は「1 回だけ」（この reconcileForRunner 呼び出し内で
  // 複数 adapter が not-registered を検知しても、1回のトリガーにまとめる）。
  let machineReconcileRequested = false;
  const requestMachineReconcile = (): void => {
    if (machineReconcileRequested) return;
    machineReconcileRequested = true;
    void requestReconcile('config');
  };

  for (const target of targets) {
    const adapter = adapterRegistry.get(`${target.provider}:${target.kind}`);
    if (!adapter) continue;
    try {
      const outcome = await withTimeout(
        adapter.reconcileProject({ config: currentConfig, items: target.items, requestMachineReconcile }, projectPath),
        PRELAUNCH_WAIT_MS,
      );
      if (outcome !== 'timeout') results.push(outcome);
    } catch {
      // prelaunch は起動をブロックしない。失敗しても runner 起動を継続する
    }
  }

  // サイクルP1.2: installed/updated/failed/notAllowed のいずれも無い（present のみ・完全空）
  // 結果は送らない。毎起動ごとに `capabilitySyncStatus` を無意味な全ゼロ結果で
  // 上書きしてしまう（server 側は trigger を問わず全上書きのため）のを防ぐ。
  const merged = mergeCapabilityResults(results);
  if (hasReportableOutcome(merged) && sendResultCallback) {
    // サイクルP1.3 要件6: 従来は無条件 'done' だったが、failed の中身に応じて
    // 'error'（実失敗）/ 'skipped'（marketplace-not-registered 等の先送りのみ）を導出する。
    sendResultCallback({ status: decidePrelaunchStatus(merged), results: merged, durationMs: 0, trigger: 'prelaunch' });
  }
}
