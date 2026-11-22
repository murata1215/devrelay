/**
 * チャットタブバー（`ChatPage.tsx`）のタブクローズ（単体・一括）ルールを決定する純関数群。
 * 外部 import ゼロ（node:test から dist-test/ を直接 import する。tab-order-rules.ts と同じ流儀）。
 *
 * 背景（2026-11-22、Pulse タブ増殖バグの事後対応）:
 * Pulse 経由で実機約60タブまで膨れ上がった環境向けに、一括クローズ（他のタブを閉じる／
 * 以降のタブを閉じる／すべて閉じる）の手段が無かった（×ボタンで1枚ずつ閉じるしかなかった）。
 * 本モジュールは単体クローズと一括クローズを同じ判定関数で扱い、挙動の重複実装を避ける。
 */

/** クローズ判定に必要な最小限のタブの形。 */
export interface ClosableTabLike {
  projectId: string;
  pinned: boolean;
}

/** クローズの範囲。 */
export type CloseScope = 'self' | 'others' | 'right' | 'all';

/** `resolveTabClose` の引数。 */
export interface ResolveTabCloseArgs<T extends ClosableTabLike> {
  /** 全タブ（tabs state そのもの）。 */
  tabs: T[];
  /** TabBar が実際に表示していたタブの projectId 列（= visibleTabs の順）。
   *  サーバー絞り込み中は、ここに含まれない（= 絞り込みで隠れている）タブを一括クローズの対象にしない
   *  （D&D を index ではなく projectId ベースにしたのと同じ「見えているものだけ操作する」設計）。 */
  scopeIds: string[];
  scope: CloseScope;
  /** 右クリックされた基準タブの projectId（'all' では範囲の決定に使わない）。 */
  targetId: string | null;
  activeTabId: string | null;
}

/** `resolveTabClose` の結果。 */
export interface ResolveTabCloseResult<T> {
  tabs: T[];
  /** クローズ後の次のアクティブタブ ID（全滅時は null）。 */
  nextActiveTabId: string | null;
  /** 実際に閉じられた projectId 列（空ならクローズ対象が無かった = no-op）。 */
  closedIds: string[];
}

/** scope に応じて「閉じる候補」の projectId 集合を決める（ピン止めは呼び出し元でまとめて除外する）。 */
function resolveCandidateIds(scopeIds: string[], scope: CloseScope, targetId: string | null): string[] {
  switch (scope) {
    case 'self':
      return targetId ? [targetId] : [];
    case 'others':
      return scopeIds.filter(id => id !== targetId);
    case 'right': {
      const idx = targetId ? scopeIds.indexOf(targetId) : -1;
      if (idx === -1) return [];
      return scopeIds.slice(idx + 1);
    }
    case 'all':
      return scopeIds;
  }
}

/**
 * 1枚/一括いずれのクローズでも「閉じた後のタブ配列」と「次のアクティブ ID」を返す唯一の判定。
 * ピン止めタブは常に除外する（既存の単体クローズのピン保護を一般化したもの）。
 */
export function resolveTabClose<T extends ClosableTabLike>(args: ResolveTabCloseArgs<T>): ResolveTabCloseResult<T> {
  const { tabs, scopeIds, scope, targetId, activeTabId } = args;
  const candidateIds = new Set(resolveCandidateIds(scopeIds, scope, targetId));
  const closedIds: string[] = [];
  const survivors = tabs.filter(t => {
    if (!candidateIds.has(t.projectId) || t.pinned) return true;
    closedIds.push(t.projectId);
    return false;
  });

  if (closedIds.length === 0) {
    return { tabs, nextActiveTabId: activeTabId, closedIds: [] };
  }

  // アクティブタブが生き残っていればそのまま
  if (activeTabId && survivors.some(t => t.projectId === activeTabId)) {
    return { tabs: survivors, nextActiveTabId: activeTabId, closedIds };
  }

  let nextActiveTabId: string | null = null;
  if (scope === 'others' || scope === 'right') {
    // targetId は候補に含めていないため必ず生存する
    nextActiveTabId = targetId;
  } else {
    // 'self' / 'all': 元配列での閉じたタブの最初の index を基準に、最も近い生存タブへ寄せる
    // （既存の単体クローズ実装と同一の式: Math.min(closedIdx, survivors.length - 1)）
    const closedIdx = tabs.findIndex(t => closedIds.includes(t.projectId));
    nextActiveTabId = survivors[Math.min(closedIdx, survivors.length - 1)]?.projectId ?? null;
  }

  return { tabs: survivors, nextActiveTabId, closedIds };
}

/** 右クリックメニューの左上座標を画面内にクランプする（多段タブバー・画面端対応）。 */
export interface ClampContextMenuArgs {
  x: number;
  y: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  margin?: number;
}

export function clampContextMenuPosition(args: ClampContextMenuArgs): { left: number; top: number } {
  const margin = args.margin ?? 4;
  const maxLeft = Math.max(margin, args.viewportWidth - args.width - margin);
  const maxTop = Math.max(margin, args.viewportHeight - args.height - margin);
  const left = Math.min(Math.max(args.x, margin), maxLeft);
  const top = Math.min(Math.max(args.y, margin), maxTop);
  return { left, top };
}
