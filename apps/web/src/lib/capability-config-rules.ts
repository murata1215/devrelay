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

/**
 * UI フォーム状態を保存用の `CapabilityConfig` に変換する。
 * marketplaceName / marketplaceSource / pluginIds のいずれかが空なら「未設定」= `null`（機能 OFF）を返す
 * （中途半端な設定を DB に保存しないため。3 つ全部揃って初めて有効な設定になる）。
 */
export function formStateToCapabilityConfig(state: CapabilityConfigFormState): CapabilityConfigLike | null {
  const marketplaceName = state.marketplaceName.trim();
  const marketplaceSource = state.marketplaceSource.trim();
  const pluginIds = nonEmptyTrimmed(state.pluginIds);

  if (!marketplaceName || !marketplaceSource || pluginIds.length === 0) {
    return null;
  }

  return {
    providers: { claude: { marketplaceName, marketplaceSource } },
    items: pluginIds.map(id => ({ provider: 'claude', kind: 'plugin', id })),
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

export type SyncStatusDisplayKind = 'unsynced-unsupported' | 'unsynced' | 'synced';

export interface SyncStatusDisplay {
  kind: SyncStatusDisplayKind;
  /** kind==='synced' のときだけ埋まる集計値 */
  summary?: {
    receivedAt: string;
    installedCount: number;
    updatedCount: number;
    failedCount: number;
    notAllowedCount: number;
    trigger: string;
  };
}

/**
 * `capabilitySyncStatus` の表示区分を決める（純関数）。
 * - `capabilitySyncStatus` が null かつ Agent が capability-sync 未対応 → 「未同期（Agent 更新が必要）」
 * - null だが対応済み（まだ 1 回も reconcile していないだけ）→ 「未同期」
 * - 値があれば結果を集計して表示する
 * @param capabilitySyncSupported Agent が 'capability-sync' capability を申告しているか（null = 判定不能。offline 等）
 */
export function decideSyncStatusDisplay(
  status: CapabilitySyncStatusLike | null,
  capabilitySyncSupported: boolean | null,
): SyncStatusDisplay {
  if (!status) {
    return { kind: capabilitySyncSupported === false ? 'unsynced-unsupported' : 'unsynced' };
  }
  const installedCount = status.results.reduce((sum, r) => sum + r.installed.length, 0);
  const updatedCount = status.results.reduce((sum, r) => sum + r.updated.length, 0);
  const failedCount = status.results.reduce((sum, r) => sum + r.failed.length, 0);
  const notAllowedCount = status.results.reduce((sum, r) => sum + r.notAllowed.length, 0);
  return {
    kind: 'synced',
    summary: { receivedAt: status.receivedAt, installedCount, updatedCount, failedCount, notAllowedCount, trigger: status.trigger },
  };
}
