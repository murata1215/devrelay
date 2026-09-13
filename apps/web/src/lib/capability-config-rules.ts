/**
 * サイクルP1: Capability 配布基盤の Web UI ↔ `CapabilityConfig` 変換ロジック（外部 import ゼロの純関数）。
 * `MachinesPage.tsx`（フォーム状態の保持・保存ボタン等の I/O）から呼ばれる。
 *
 * v1 で UI が編集できるのは `providers.claude`（Marketplace name/source + plugin id タグ入力）だけ。
 * Provider 選択 UI（Claude/Codex/Devin）は置かない。将来 provider が増えたときはこのファイルに
 * 変換関数を追加するだけで済む構造にする（Server/DB/WS には手を入れない）。
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
  };
  items: Array<{ provider: string; kind: string; id: string }>;
}

/** 空文字列を trim して除外した非空文字列だけを残す */
function nonEmptyTrimmed(values: string[]): string[] {
  return values.map(v => v.trim()).filter(v => v.length > 0);
}

/**
 * サーバー保存済みの `capabilityConfig`（null = 未設定）を UI フォーム初期値に変換する。
 * v1 で扱うのは provider=claude/kind=plugin の item のみ（他 provider の item があっても無視する）。
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
      providers: { claude: { marketplaceName, marketplaceSource } },
      items: pluginIds.map(id => ({ provider: 'claude', kind: 'plugin', id })),
    },
  };
}

/** タグ表示用に bare 名へ marketplace 修飾子を補完する（例: 'unity' → 'unity@devrelay'） */
export function formatPluginTag(id: string, marketplaceName: string): string {
  return marketplaceName ? `${id}@${marketplaceName}` : id;
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
    failedCount: number;
    notAllowedCount: number;
    trigger: string;
  };
  /** kind==='error' のときだけ埋まる failed 明細（最大 MAX_FAILURE_DETAILS 件。総数は summary.failedCount） */
  failures?: Array<{ id: string; reason: string }>;
  /** kind==='synced' かつ results が空（配布対象ゼロ）のときだけ true。他の場合はキー自体を生やさない */
  emptyTargets?: true;
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
  const failedCount = status.results.reduce((sum, r) => sum + r.failed.length, 0);
  const notAllowedCount = status.results.reduce((sum, r) => sum + r.notAllowed.length, 0);
  const summary = { receivedAt: status.receivedAt, installedCount, updatedCount, failedCount, notAllowedCount, trigger: status.trigger };

  if (status.status === 'skipped') {
    return { kind: savedConfigPresent === false ? 'skipped-no-config' : 'skipped-agent-stale', summary };
  }
  if (status.status === 'error') {
    const failures = status.results.flatMap(r => r.failed);
    return { kind: 'error', summary, failures: failures.slice(0, MAX_FAILURE_DETAILS) };
  }
  return {
    kind: 'synced',
    summary,
    ...(status.results.length === 0 ? { emptyTargets: true as const } : {}),
  };
}
