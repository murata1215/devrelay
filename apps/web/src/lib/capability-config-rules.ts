/**
 * サイクルP1: Capability 配布基盤の Web UI ↔ `CapabilityConfig` 変換ロジック（外部 import ゼロの純関数）。
 * `MachinesPage.tsx`（フォーム状態の保持・保存ボタン等の I/O）から呼ばれる。
 *
 * v1 で UI が編集できるのは `providers.claude`（Marketplace name/source + plugin id タグ入力）だけ。
 * Provider 選択 UI（Claude/Codex/Devin）は置かない。将来 provider が増えたときはこのファイルに
 * 変換関数を追加するだけで済む構造にする（Server/DB/WS には手を入れない）。
 *
 * サイクルP3-B §5-1/§5-7: `devin:skill` provider opt-in（チェックボックス）は廃止した。
 * 索引宣言（`providers.claude`）を単一情報源として流用し、plugin id を 1 つ登録すれば
 * `claude:plugin`（Claude Code には plugin として）と `agent-skills:standard`
 * （Devin/Codex 等には Agent Skills 標準として）の items を**常に両方**生成する。
 * ツール別の opt-in チェックボックスという UI 概念自体が無くなったため、
 * `CapabilityConfigFormState.distributeToDevin` は削除した（型ごと廃止。@deprecated 経由の
 * 後方互換は shared 側の `providers.devin` 型にのみ残す）。
 */

/** UI フォームが保持する編集対象の状態（Claude セクションのみ） */
export interface CapabilityConfigFormState {
  marketplaceName: string;
  marketplaceSource: string;
  /** bare 名（例: 'unity'）の配列。表示時は `${id}@${marketplaceName}` に補完する */
  pluginIds: string[];
}

/** `capabilityConfig`（Server 保存形）の最小形（`@devrelay/shared` の `CapabilityConfig` と構造互換） */
export interface CapabilityConfigLike {
  providers: {
    claude?: { marketplaceName: string; marketplaceSource: string };
    /**
     * @deprecated サイクルP3-B §5-7: ツール別 opt-in の概念自体を廃止した。
     * 新規保存では二度と生成しない。旧 DB 値の読み取り互換のためだけに型を残す
     * （`capabilityConfigToFormState` はこのキーを一切参照しない）。
     */
    devin?: { marketplaceName: string; marketplaceSource: string };
  };
  items: Array<{ provider: string; kind: string; id: string }>;
}

/** 空文字列を trim して除外した非空文字列だけを残す */
function nonEmptyTrimmed(values: string[]): string[] {
  return values.map(v => v.trim()).filter(v => v.length > 0);
}

/**
 * サーバー保存済みの `capabilityConfig`（null = 未設定）を UI フォーム初期値に変換する。
 * pluginIds の抽出元は `{provider:'claude',kind:'plugin'}` の item のみ（`agent-skills:standard` 側は
 * 同じ id が並行して入っているだけなので二重カウントしない。旧 `devin:skill` item も無視する）。
 */
export function capabilityConfigToFormState(config: CapabilityConfigLike | null): CapabilityConfigFormState {
  if (!config) {
    return { marketplaceName: '', marketplaceSource: '', pluginIds: [] };
  }
  const claude = config.providers.claude;
  const pluginIds = config.items
    .filter(item => item.provider === 'claude' && item.kind === 'plugin')
    .map(item => item.id);
  return {
    marketplaceName: claude?.marketplaceName ?? '',
    marketplaceSource: claude?.marketplaceSource ?? '',
    pluginIds,
  };
}

/** `validateCapabilityForm` が保存を拒否した理由（UI 文言はここに持たず MachinesPage.tsx 側で JSX にマップする） */
export type CapabilityFormErrorCode =
  | 'marketplace-name-required'
  | 'marketplace-source-required'
  | 'marketplace-required-for-plugins';

export type CapabilityFormValidation =
  | { ok: true; config: CapabilityConfigLike | null }
  | { ok: false; error: CapabilityFormErrorCode };

/**
 * UI フォーム状態を保存用の `CapabilityConfig` に変換する（検証つき）。
 * P1.1: marketplaceName/marketplaceSource が両方揃っていれば pluginIds が空でも有効な設定として保存する
 * （marketplace の登録だけ先に済ませ、plugin は後から追加する運用を想定）。
 * marketplaceName/marketplaceSource の片方だけが入力されている状態、または
 * pluginIds はあるのに marketplace が両方とも空の状態は、中途半端な設定として保存せず invalid を返す。
 * 3 つとも空なら「未設定」= `null`（機能 OFF、既存設定のクリア）として有効に扱う。
 *
 * サイクルP3-B §5-1/§5-7: `pluginIds` から `claude:plugin` と `agent-skills:standard` の items を
 * **常に両方**生成する（ツール別 opt-in は廃止）。`providers` に生成するのは `claude` のみ
 * （索引宣言は `providers.claude` を単一情報源として流用し、`providers.devin`/`providers['agent-skills']`
 * のような provider 別チェックボックスは復活させない＝ server 側 `capability-config-rules.ts` の
 * 「provider ごとに marketplaceName/marketplaceSource を必須にする」検証を一切変更せずに済む）。
 */
export function validateCapabilityForm(state: CapabilityConfigFormState): CapabilityFormValidation {
  const marketplaceName = state.marketplaceName.trim();
  const marketplaceSource = state.marketplaceSource.trim();
  const pluginIds = nonEmptyTrimmed(state.pluginIds);

  if (!marketplaceName && !marketplaceSource && pluginIds.length === 0) {
    return { ok: true, config: null };
  }
  if (marketplaceName && !marketplaceSource) {
    return { ok: false, error: 'marketplace-source-required' };
  }
  if (!marketplaceName && marketplaceSource) {
    return { ok: false, error: 'marketplace-name-required' };
  }
  if (!marketplaceName && !marketplaceSource) {
    // pluginIds.length > 0 はここまでの分岐で確定（上の全空チェックで弾かれているため）
    return { ok: false, error: 'marketplace-required-for-plugins' };
  }

  return {
    ok: true,
    config: {
      providers: {
        claude: { marketplaceName, marketplaceSource },
      },
      items: [
        ...pluginIds.map(id => ({ provider: 'claude', kind: 'plugin', id })),
        ...pluginIds.map(id => ({ provider: 'agent-skills', kind: 'standard', id })),
      ],
    },
  };
}

/** タグ表示用に bare 名へ marketplace 修飾子を補完する（例: 'unity' → 'unity@devrelay'） */
export function formatPluginTag(id: string, marketplaceName: string): string {
  if (!marketplaceName) return id;
  const suffix = `@${marketplaceName}`;
  // サイクルP3-B §5-9(b): 既に `@<marketplaceName>` で終わっていれば二重に付与しない
  return id.endsWith(suffix) ? id : `${id}${suffix}`;
}

/** `normalizePluginIdInput` の結果（`ok:false` の reason で UI の警告文言を出し分ける） */
export type NormalizePluginIdResult =
  | { ok: true; id: string }
  | { ok: false; reason: 'empty' | 'duplicate' };

/**
 * サイクルP3-B §5-9(a): plugin id 追加欄からの生入力を正規化する（web 入力時の多重防御・第1段）。
 * 1. trim
 * 2. 末尾が `@<marketplaceName>` なら 1 回だけ剥がして bare id 化する（`context7@devrelay` → `context7`）
 * 3. 剥がした結果が空なら `reason:'empty'` で reject
 * 4. `existingIds`（現在のタグ一覧）に既に同じ bare id があれば `reason:'duplicate'` で reject（追加しない）
 *
 * 既に DB に入ってしまっている二重サフィックス値（`foo@mp@mp`）はここでは救わない（末尾一致は1回だけ剥がす
 * ため素通りする）。それは表示側 `formatPluginTag` と Agent 側 `buildQualifiedPluginId` の多重防御で吸収する。
 */
export function normalizePluginIdInput(
  raw: string,
  marketplaceName: string,
  existingIds: string[] = [],
): NormalizePluginIdResult {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, reason: 'empty' };

  const suffix = marketplaceName.trim() ? `@${marketplaceName.trim()}` : '';
  const stripped = suffix && trimmed.endsWith(suffix) ? trimmed.slice(0, -suffix.length).trim() : trimmed;
  if (!stripped) return { ok: false, reason: 'empty' };

  if (existingIds.includes(stripped)) return { ok: false, reason: 'duplicate' };
  return { ok: true, id: stripped };
}

// -----------------------------------------------------------------------------
// 同期ステータス表示（Auto Update の「最終自動更新」行と同じ流儀）
// -----------------------------------------------------------------------------

/** provider×kind 1 組ぶんの reconcile 結果（`@devrelay/shared` の `CapabilityResult` と構造互換） */
export interface CapabilityResultLike {
  provider: string;
  kind: string;
  runtimeVersion: string | null;
  installed: string[];
  updated: string[];
  present: string[];
  failed: Array<{ id: string; reason: string }>;
  notAllowed: string[];
  /**
   * 撤去した管理下 ID（純加算・非空のときだけ存在）。
   * サイクルP3-B §5-4/§4: `agent-skills:standard` の legacy 回収分は `legacy:<pluginId>/<skillName>` の
   * prefix 付きで載る（新配布先からの削除と区別できるようにする。集計上は removedCount に合算する）。
   */
  removed?: string[];
}

/** `Machine.capabilitySyncStatus`（保存形）の最小形 */
export interface CapabilitySyncStatusLike {
  status: 'done' | 'error' | 'skipped';
  results: CapabilityResultLike[];
  durationMs: number;
  trigger: string;
  receivedAt: string;
}

/**
 * P1.1: `status.status` が 'skipped'/'error' の場合も 0 件表示と区別できるよう種別を分ける。
 * - 'skipped-no-config': capabilityConfig 自体が未保存（Web 側で保存前と判定できる場合）
 * - 'skipped-agent-stale': 設定は保存済みだが Agent にまだ届いていない（Sync now 待ち・再接続待ち）
 * - 'error': reconcile 中にいずれかの provider が failed を出した
 */
export type SyncStatusDisplayKind =
  | 'unsynced-unsupported'
  | 'unsynced'
  | 'skipped-no-config'
  | 'skipped-agent-stale'
  | 'error'
  | 'synced';

/** error 表示時に列挙する failed 明細の上限件数（超過分は summary.failedCount との差分で「ほか n 件」表示） */
export const MAX_FAILURE_DETAILS = 5;

export interface SyncStatusDisplay {
  kind: SyncStatusDisplayKind;
  /** kind==='skipped-*'|'error'|'synced' のときだけ埋まる集計値 */
  summary?: {
    receivedAt: string;
    installedCount: number;
    updatedCount: number;
    /** サイクルP3-B §5-10: 「配布されたのか present（既に配布済みで無変更）なのか」を区別できるようにする */
    presentCount: number;
    failedCount: number;
    notAllowedCount: number;
    /** サイクルP3-B §5-10: legacy 回収分も含めた撤去件数（prefix 付きの詳細は perProvider/results 側で見る） */
    removedCount: number;
    trigger: string;
  };
  /** kind==='error' のときだけ埋まる failed 明細（最大 MAX_FAILURE_DETAILS 件。総数は summary.failedCount） */
  failures?: Array<{ id: string; reason: string }>;
  /**
   * kind==='synced' かつ results が空（配布対象ゼロ）のときだけ true。他の場合はキー自体を生やさない。
   * サイクルP1.2以降: Agent 側は `providers.<provider>` が設定されていれば items が 0 件でも
   * marketplace 登録/update までは行い `results.length` が 1 以上になるため、`emptyTargets` が立つのは
   * 「有効な provider 設定自体が無い（配布設定が実質空）」場合のみになる。P1.1 時点の意味
   * （＝「Plugin 未指定」）とは異なる点に注意（MachinesPage.tsx の文言もこれに合わせて更新済み）。
   */
  emptyTargets?: true;
  /**
   * `results.length >= 1` のときに生やす provider 別の内訳。
   * サイクルP3-B §5-10: 従来は `results.length > 1` のときだけだったが、provider が
   * 常に 2 つ（`claude:plugin` + `agent-skills:standard`）になったため 1 件でも出すよう条件を撤去した
   * （cleanup-only 等で results が 1 件だけになる応答でも breakdown を隠さない）。
   */
  perProvider?: Array<{
    provider: string;
    kind: string;
    installedCount: number;
    updatedCount: number;
    presentCount: number;
    failedCount: number;
    notAllowedCount: number;
    removedCount: number;
    /**
     * サイクルP3-B §5-6/§5-10: 配布判断には一切影響しない診断専用の文字列（例:
     * `"Devin 3000.6.7 検出 / Codex 設定なし"`）。`runtimeVersion` が null の provider は undefined。
     */
    runtimeDiagnostics?: string;
  }>;
}

/**
 * provider 別の内訳配列を作る（純関数）。`results` が 0 件のときだけ undefined。
 */
function buildPerProviderBreakdown(results: CapabilityResultLike[]): SyncStatusDisplay['perProvider'] {
  if (results.length === 0) return undefined;
  return results.map(r => ({
    provider: r.provider,
    kind: r.kind,
    installedCount: r.installed.length,
    updatedCount: r.updated.length,
    presentCount: r.present.length,
    failedCount: r.failed.length,
    notAllowedCount: r.notAllowed.length,
    removedCount: r.removed?.length ?? 0,
    ...(r.runtimeVersion ? { runtimeDiagnostics: r.runtimeVersion } : {}),
  }));
}

/**
 * `capabilitySyncStatus` の表示区分を決める（純関数）。
 * - `capabilitySyncStatus` が null かつ Agent が capability-sync 未対応 → 「未同期（Agent 更新が必要）」
 * - null だが対応済み（まだ 1 回も reconcile していないだけ）→ 「未同期」
 * - status.status==='skipped' → savedConfigPresent で「未保存」か「Agent 未反映」かを分ける
 *   （savedConfigPresent が null＝判定不能なときは fail-open で 'skipped-agent-stale' 扱いにする）
 * - status.status==='error' → 集計値 + failed 明細（最大 MAX_FAILURE_DETAILS 件）を返す
 * - それ以外（'done'）→ 集計して 'synced'。results が空なら emptyTargets を立てる
 * @param capabilitySyncSupported Agent が 'capability-sync' capability を申告しているか（null = 判定不能。offline 等）
 * @param savedConfigPresent capabilityConfig が現在 DB に保存されているか（省略・null は判定不能）
 */
export function decideSyncStatusDisplay(
  status: CapabilitySyncStatusLike | null,
  capabilitySyncSupported: boolean | null,
  savedConfigPresent: boolean | null = null,
): SyncStatusDisplay {
  if (!status) {
    return { kind: capabilitySyncSupported === false ? 'unsynced-unsupported' : 'unsynced' };
  }
  const installedCount = status.results.reduce((sum, r) => sum + r.installed.length, 0);
  const updatedCount = status.results.reduce((sum, r) => sum + r.updated.length, 0);
  const presentCount = status.results.reduce((sum, r) => sum + r.present.length, 0);
  const failedCount = status.results.reduce((sum, r) => sum + r.failed.length, 0);
  const notAllowedCount = status.results.reduce((sum, r) => sum + r.notAllowed.length, 0);
  const removedCount = status.results.reduce((sum, r) => sum + (r.removed?.length ?? 0), 0);
  const summary = {
    receivedAt: status.receivedAt,
    installedCount,
    updatedCount,
    presentCount,
    failedCount,
    notAllowedCount,
    removedCount,
    trigger: status.trigger,
  };
  const perProvider = buildPerProviderBreakdown(status.results);

  if (status.status === 'skipped') {
    return {
      kind: savedConfigPresent === false ? 'skipped-no-config' : 'skipped-agent-stale',
      summary,
      ...(perProvider ? { perProvider } : {}),
    };
  }
  if (status.status === 'error') {
    const failures = status.results.flatMap(r => r.failed);
    return {
      kind: 'error',
      summary,
      failures: failures.slice(0, MAX_FAILURE_DETAILS),
      ...(perProvider ? { perProvider } : {}),
    };
  }
  return {
    kind: 'synced',
    summary,
    ...(status.results.length === 0 ? { emptyTargets: true as const } : {}),
    ...(perProvider ? { perProvider } : {}),
  };
}
