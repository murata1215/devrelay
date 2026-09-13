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
  type QueueState,
  type MergeableResult,
  type PrelaunchCacheEntry,
} from './capability-rules.js';

/** adapter に渡す reconcile 用コンテキスト */
export interface CapabilityCtx {
  config: CapabilityConfig;
  /** capabilityConfig.items のうち、この adapter の provider/kind に該当するものだけ */
  items: Array<{ provider: string; kind: string; id: string }>;
}

/** 個別の provider×kind Capability を配布する adapter の最小インタフェース（指示書§14-4 準拠） */
export interface CapabilityAdapter {
  provider: string;
  kind: string;
  reconcileMachine(ctx: CapabilityCtx): Promise<CapabilityResult>;
  reconcileProject(ctx: CapabilityCtx, projectPath: string): Promise<CapabilityResult>;
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

export function setCapabilityConfig(config: CapabilityConfig | null): void {
  currentConfig = config;
}

export function getCapabilityConfig(): CapabilityConfig | null {
  return currentConfig;
}

/** `agent:capability:sync` の送信先（connection.ts から注入） */
let sendResultCallback: ((payload: CapabilitySyncOutcome) => void) | null = null;

export function setCapabilitySyncSender(fn: (payload: CapabilitySyncOutcome) => void): void {
  sendResultCallback = fn;
}

/** machine スコープの直列化キュー状態（単一 in-flight + pending 1 本） */
const queueState: QueueState = { inFlight: false, pendingTrigger: null };

/** adapter 呼び出しのタイムアウト（provider ごとの個別設定は持たず一律 3 分） */
const ADAPTER_TIMEOUT_MS = 3 * 60 * 1000;

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
 * 現在の capabilityConfig を全 adapter に対して machine レベルで reconcile する。
 * 未登録の provider/kind は throw せず failed に積んで処理を続行する（1 件の失敗が全体を止めない）。
 *
 * サイクルP1.2: `items` が空でも `providers.<provider>` が設定されていれば対象 provider の adapter を
 * 呼ぶ（`resolveReconcileTargets()` が items 由来 + registry 由来のターゲットを合成する。§8.1 は
 * items 0 件でも marketplace 登録/update までは行う設計）。
 */
async function runMachineReconcile(trigger: AgentCapabilitySyncPayload['trigger']): Promise<CapabilitySyncOutcome> {
  const startedAt = Date.now();
  const config = currentConfig;

  if (!config) {
    return { status: 'skipped', results: [], durationMs: Date.now() - startedAt, trigger };
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

  for (const target of targets) {
    const adapter = adapterRegistry.get(`${target.provider}:${target.kind}`);
    if (!adapter) continue;
    try {
      const outcome = await withTimeout(
        adapter.reconcileProject({ config: currentConfig, items: target.items }, projectPath),
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
    sendResultCallback({ status: 'done', results: merged, durationMs: 0, trigger: 'prelaunch' });
  }
}
