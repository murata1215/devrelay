/**
 * サイクルP1: Capability 配布基盤の共通層で使う純粋ロジック（外部 import ゼロ）。
 * `capability-sync.ts`（共通層の I/O 部分: DB/WS/CLI 呼び出し）から呼ばれる。
 * ここには Claude/Codex/Devin いずれの provider 固有知識も置かない
 * （`running-code-stale.ts` / `claude-locator.ts` と同じ流儀で、コンパイル済み dist を
 * `node --test` から直接 import して単体検証できるようにする）。
 */

/**
 * AiTool → Capability provider の対応表。
 * v1 は claude のみ登録。Codex/Devin を足すときはここに 1 行追加するだけでよい
 * （呼び出し元の `ai-runner.ts` は provider を知らず、この表だけを介して判定する）。
 */
const AI_TOOL_TO_PROVIDER: Record<string, string> = {
  claude: 'claude',
};

/** AiTool 文字列から Capability provider を引く。未登録なら null（Capability 対象外） */
export function aiToolToCapabilityProvider(aiTool: string): string | null {
  return AI_TOOL_TO_PROVIDER[aiTool] ?? null;
}

/** trigger の優先度（数値が大きいほど優先。pending 1 本のスロットをどちらが占有するかの判定に使う） */
const TRIGGER_PRIORITY: Record<string, number> = {
  manual: 4,
  connect: 3,
  config: 2,
  idle: 1,
  prelaunch: 0,
};

/** 未知の trigger は最低優先度扱い（フェイルセーフ） */
export function triggerPriority(trigger: string): number {
  return TRIGGER_PRIORITY[trigger] ?? 0;
}

/** machine スコープの直列化キューが呼び出し側で保持する最小の状態 */
export interface QueueState {
  /** 現在 reconcile が実行中か */
  inFlight: boolean;
  /** pending スロットに積まれている trigger（無ければ null） */
  pendingTrigger: string | null;
}

export type EnqueueDecision =
  | { action: 'run-now' }
  | { action: 'queue-pending'; trigger: string }
  | { action: 'keep-pending' };

/**
 * machine スコープの直列化キュー（単一 in-flight + pending 1 本）に新しいリクエストを
 * 積むかどうかを決める（純粋関数）。実行中のものを取り消すことはせず、pending スロットの
 * 奪い合いだけを trigger の優先度で解決する。
 *
 * 注意: prelaunch はこのキューに入らない（呼び出し側でそもそもこの関数を通さない設計とする）。
 */
export function decideEnqueue(state: QueueState, trigger: string): EnqueueDecision {
  if (!state.inFlight) {
    return { action: 'run-now' };
  }
  if (state.pendingTrigger === null) {
    return { action: 'queue-pending', trigger };
  }
  if (triggerPriority(trigger) > triggerPriority(state.pendingTrigger)) {
    return { action: 'queue-pending', trigger };
  }
  return { action: 'keep-pending' };
}

/**
 * manual は「押したのに無反応」を防ぐため、結果が skipped であっても必ず 1 通
 * `agent:capability:sync` を送る必要がある。それ以外の trigger は skipped を黙って許容してよい。
 */
export function shouldAlwaysReport(trigger: string): boolean {
  return trigger === 'manual';
}

/** CapabilityResult の最小形（`@devrelay/shared` の `CapabilityResult` と構造互換） */
export interface MergeableResult {
  provider: string;
  kind: string;
  runtimeVersion: string | null;
  installed: string[];
  updated: string[];
  present: string[];
  failed: Array<{ id: string; reason: string }>;
  notAllowed: string[];
}

function dedupeStrings(arr: string[]): string[] {
  return Array.from(new Set(arr));
}

function dedupeFailed(arr: Array<{ id: string; reason: string }>): Array<{ id: string; reason: string }> {
  const map = new Map<string, { id: string; reason: string }>();
  for (const f of arr) map.set(`${f.id}\u0000${f.reason}`, f);
  return Array.from(map.values());
}

/**
 * 同一 provider×kind の複数結果（machine reconcile + project reconcile 等の複数呼び出し）を
 * 1 件にマージする（純粋関数）。配列は結合 + 重複除去、runtimeVersion は null でない値を優先する。
 * provider×kind が異なる結果はマージせずそれぞれ独立したエントリのまま返す。
 */
export function mergeCapabilityResults(results: MergeableResult[]): MergeableResult[] {
  const order: string[] = [];
  const map = new Map<string, MergeableResult>();

  for (const r of results) {
    const key = `${r.provider}\u0000${r.kind}`;
    const existing = map.get(key);
    if (!existing) {
      order.push(key);
      map.set(key, {
        provider: r.provider,
        kind: r.kind,
        runtimeVersion: r.runtimeVersion,
        installed: [...r.installed],
        updated: [...r.updated],
        present: [...r.present],
        failed: [...r.failed],
        notAllowed: [...r.notAllowed],
      });
      continue;
    }
    map.set(key, {
      ...existing,
      runtimeVersion: r.runtimeVersion ?? existing.runtimeVersion,
      installed: dedupeStrings([...existing.installed, ...r.installed]),
      updated: dedupeStrings([...existing.updated, ...r.updated]),
      present: dedupeStrings([...existing.present, ...r.present]),
      notAllowed: dedupeStrings([...existing.notAllowed, ...r.notAllowed]),
      failed: dedupeFailed([...existing.failed, ...r.failed]),
    });
  }

  return order.map(key => map.get(key)!);
}

/** 未知の provider/kind に対して積む failed エントリの理由文字列 */
export const UNSUPPORTED_PROVIDER_REASON = 'unsupported-provider';
export const UNSUPPORTED_KIND_REASON = 'unsupported-kind';

/**
 * adapter レジストリに該当する provider/kind の adapter が見つからないときに積む結果を作る。
 * throw せず、この結果を `failed` として積んで処理を継続する（他の provider/kind の処理を止めない）。
 *
 * @param providerKnown その provider 自体は既知だが、この kind の adapter が無い場合は true
 *   （この場合 reason は `unsupported-kind`。provider 自体が未知なら `unsupported-provider`）
 */
export function buildUnsupportedResult(provider: string, kind: string, providerKnown: boolean): MergeableResult {
  const reason = providerKnown ? UNSUPPORTED_KIND_REASON : UNSUPPORTED_PROVIDER_REASON;
  return {
    provider,
    kind,
    runtimeVersion: null,
    installed: [],
    updated: [],
    present: [],
    failed: [{ id: `${provider}:${kind}`, reason }],
    notAllowed: [],
  };
}

/**
 * `capabilityConfig.providers` のうち実際に設定が入っているキー（provider 名）一覧を返す（純粋関数）。
 * サイクルP1.2: `items` が空でも「provider が設定されていれば reconcile 対象にする」判定の基礎。
 * 値が非 null オブジェクト（配列でない）のキーのみ「設定あり」とみなす。
 */
export function listConfiguredProviders(providers: Record<string, unknown> | null | undefined): string[] {
  if (!providers || typeof providers !== 'object') return [];
  return Object.keys(providers).filter((key) => {
    const value = (providers as Record<string, unknown>)[key];
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  });
}

/** `resolveReconcileTargets` が返す 1 ターゲット分の情報 */
export interface ReconcileTarget {
  provider: string;
  kind: string;
  items: Array<{ provider: string; kind: string; id: string }>;
  /** adapter レジストリに `provider:kind` が登録されているか（登録済みキー由来のターゲットは常に true） */
  hasAdapter: boolean;
}

/**
 * machine reconcile と prelaunch の両方が使う「どの provider×kind を reconcile 対象にするか」の
 * 判定ロジック（純粋関数、サイクルP1.2 の中核）。
 *
 * 順序が重要: **items 由来のターゲットを先に積み、registry 由来（設定はあるが items 0 件）のキーは
 * 「まだ無いときだけ」追加する**。逆にすると items のあるターゲットが `items: []` で上書きされ、
 * 全 plugin が無言スキップされる（P1.1 で実際に起きたバグ）ため、この順序をテストで固定する。
 *
 * @param configuredProviders `listConfiguredProviders()` の結果
 * @param items `capabilityConfig.items`（配列以外が渡っても安全に空扱いする）
 * @param registryKeys adapter レジストリの登録済みキー（`"<provider>:<kind>"`）一覧
 * @param providerFilter 指定時はこの provider のみを対象にする（prelaunch 用。null なら全 provider）
 */
export function resolveReconcileTargets(
  configuredProviders: string[],
  items: Array<{ provider: string; kind: string; id: string }>,
  registryKeys: string[],
  providerFilter: string | null = null,
): ReconcileTarget[] {
  const registryKeySet = new Set(registryKeys);
  const order: string[] = [];
  const map = new Map<string, ReconcileTarget>();

  const safeItems = Array.isArray(items) ? items : [];
  for (const item of safeItems) {
    if (providerFilter !== null && item.provider !== providerFilter) continue;
    const key = `${item.provider}:${item.kind}`;
    if (!map.has(key)) {
      order.push(key);
      map.set(key, { provider: item.provider, kind: item.kind, items: [], hasAdapter: registryKeySet.has(key) });
    }
    map.get(key)!.items.push(item);
  }

  for (const key of registryKeys) {
    const [provider, kind] = key.split(':');
    if (providerFilter !== null && provider !== providerFilter) continue;
    if (!configuredProviders.includes(provider)) continue;
    if (map.has(key)) continue; // items 由来で既に存在するなら追加しない
    order.push(key);
    map.set(key, { provider, kind, items: [], hasAdapter: true });
  }

  return order.map((key) => map.get(key)!);
}

/**
 * reconcile 結果が「報告する価値があるか」を判定する（純粋関数）。
 * `installed`/`updated`/`failed`/`notAllowed` のいずれかが 1 件でもあれば true。
 * `present` のみ（変化なし）や完全に空の結果は false とし、prelaunch の無意味な送信
 * （= サーバー側 `capabilitySyncStatus` の無意味な上書き）を抑止するために使う。
 */
export function hasReportableOutcome(results: MergeableResult[]): boolean {
  return results.some(
    (r) => r.installed.length > 0 || r.updated.length > 0 || r.failed.length > 0 || r.notAllowed.length > 0,
  );
}

/** prelaunch キャッシュのキー = provider と projectPath の組（同一プロジェクトでも provider が違えば別キャッシュ） */
export function buildPrelaunchCacheKey(provider: string, projectPath: string): string {
  return `${provider}\u0000${projectPath}`;
}

export interface PrelaunchCacheEntry {
  key: string;
  cachedAtMs: number;
}

/**
 * prelaunch 実行の要否を判定する（純粋関数）。
 * 同一キーの直近実行が TTL 内であればキャッシュを使い、CLI を呼ばない（no-op）。
 * これにより 1 ターン内で複数回再入しても（`connection.ts` のリトライ・`ai-runner.ts` の
 * フォールバック等）2 回目以降は no-op になる。
 */
export function decidePrelaunchAction(
  cache: PrelaunchCacheEntry | null,
  key: string,
  nowMs: number,
  ttlMs: number,
): 'use-cache' | 'run' {
  if (!cache || cache.key !== key) return 'run';
  return (nowMs - cache.cachedAtMs) < ttlMs ? 'use-cache' : 'run';
}
