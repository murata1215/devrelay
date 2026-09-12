/**
 * classic チャット画面の右レール（Servers/Agents + Approvals/Docs/Issues/Plan の縦積み）に関する
 * 純ロジック集。外部 import ゼロ（node:test から dist-test/ を直接 import する。
 * apps/server の thread-routing.ts / apps/web の thread-list-rules.ts と同じ流儀）。
 *
 * 設計判断は `temporal-leaping-otter.md` プランに準拠する:
 * - 右レールは縦2段（上段 Servers/Agents・下段 DocPanel）。タブ統合はしない
 * - 幅・折りたたみの所有者は RightRail（DocPanel から移設）
 * - 折りたたみ中は「気付き」のためのバッジのみ表示（自動展開はしない）
 * - `devrelay-panel-width` は既存キーを流用（保存済みユーザー幅を破棄しない）
 */

/** 右レールの折りたたみ状態を保存する localStorage キー */
export const RAIL_COLLAPSED_STORAGE_KEY = 'devrelay-right-rail-collapsed';

/** 右レールの幅を保存する localStorage キー（旧 DocPanel 幅キーを流用） */
export const RAIL_WIDTH_STORAGE_KEY = 'devrelay-panel-width';

/** 右レールの既定幅（px） */
export const RAIL_WIDTH_DEFAULT = 208;
/** 右レールの最小幅（px） */
export const RAIL_WIDTH_MIN = 160;
/** 右レールの最大幅（px） */
export const RAIL_WIDTH_MAX = 600;

/**
 * localStorage の生の文字列から折りたたみ状態を復元する。
 * `'1'` のときのみ折りたたみ。`null`（未保存）・その他の値は既定の展開状態（`false`）にフォールバックする。
 */
export function readRailCollapsed(raw: string | null): boolean {
  return raw === '1';
}

/** 折りたたみ状態を localStorage 保存用の文字列に変換する */
export function serializeRailCollapsed(collapsed: boolean): '1' | '0' {
  return collapsed ? '1' : '0';
}

/**
 * 幅の clamp/read ロジックは `panel-resize-rules.ts`（`clampWidth`/`readWidth`）に一本化した
 * （本モジュールが持っていた旧・幅専用の2関数は削除済み。本モジュールは `^import` ゼロの規約があるため
 * 委譲もできず、`RightRail.tsx` 側が `RAIL_WIDTH_MIN`/`RAIL_WIDTH_MAX`/`RAIL_WIDTH_DEFAULT` を
 * 汎用関数に渡す形にした。定数はこのファイルに残す）。
 */

/** 承認待ち（`status === 'pending'`）件数を数える */
export function countPendingApprovals(list: { status: string }[]): number {
  return list.filter((entry) => entry.status === 'pending').length;
}

/** 折りたたみ中バッジの表示可否とラベルを決定する結果 */
export interface RailBadgeResult {
  /** バッジを表示するか */
  show: boolean;
  /** バッジの表示文字列（非表示時は空文字） */
  label: string;
}

/**
 * 折りたたみ中バッジの表示を決定する。
 * - 展開中（`collapsed === false`）は常に非表示（バッジは「気付き」専用で、展開中は本文が見えているため不要）
 * - `pendingCount <= 0` も非表示
 * - `pendingCount` は 9 件を超えると `'9+'` に打ち切る
 */
export function resolveRailBadge(args: { collapsed: boolean; pendingCount: number }): RailBadgeResult {
  if (!args.collapsed || args.pendingCount <= 0) {
    return { show: false, label: '' };
  }
  return { show: true, label: args.pendingCount > 9 ? '9+' : String(args.pendingCount) };
}

/** 右レールのセクション表示方針 */
export interface RailSectionsResult {
  /** Servers/Agents セクション（常に表示。ユーザーがオフにできる設定と結合しない） */
  showServers: true;
  /** DocPanel セクション（有効タブが1つも無い場合は非表示） */
  showDocPanel: boolean;
  /** レイアウト種別（テスト・デバッグ用のラベル） */
  layout: 'servers-only' | 'split';
}

/**
 * 右レールのセクション表示方針を決定する。
 * Servers は `docPanelSettings`（ユーザーが OFF にできる設定）に結合しないため、常に `showServers: true`。
 */
export function resolveRailSections(args: { docPanelEnabled: boolean }): RailSectionsResult {
  return {
    showServers: true,
    showDocPanel: args.docPanelEnabled,
    layout: args.docPanelEnabled ? 'split' : 'servers-only',
  };
}

/**
 * Sidebar（Servers/Agents パネル）の `<aside>` に付与する静的クラス文字列を決定する。
 * これがレイアウトの唯一の防波堤（Sidebar 内部のコードはこの関数の戻り値をそのまま className に使う）。
 *
 * - `'drawer'`（モバイル専用・左端固定・ハンバーガーで開閉）:
 *   `fixed` + `md:hidden`（768px 以上では常に非表示。Servers への到達は右レールが担う） + `w-56`
 * - `'rail'`（右レール内・幅とスクロールは親（RightRail の各セクション wrapper）が管理）:
 *   `flex flex-col min-h-0 h-full`（`fixed`/`translate`/`w-56` を含まない。`min-h-0` は
 *   ネストした flex column を有界にするための連鎖の一部）
 *
 * 折りたたみ時の `-translate-x-full` ⇔ `translate-x-0` の切り替えは、この関数の外
 * （Sidebar コンポーネント側、`variant === 'drawer'` のときのみ）で `collapsed` prop から動的に付与する。
 */
export function resolveSidebarShellClass(variant: 'drawer' | 'rail'): string {
  if (variant === 'drawer') {
    return 'fixed md:hidden z-30 w-56 h-full bg-[var(--bg-secondary)] border-r border-[var(--border-color)] flex flex-col transition-transform duration-200 ease-in-out shrink-0';
  }
  return 'flex flex-col min-h-0 h-full bg-[var(--bg-secondary)]';
}
