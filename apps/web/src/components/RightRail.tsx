import { useState, useRef, useCallback, type ReactNode } from 'react';
import { useLanguage } from '../contexts/LanguageContext';
import { RAIL_WIDTH_STORAGE_KEY, readRailWidth, clampRailWidth, resolveRailBadge } from '../lib/right-rail-rules';

/**
 * classic チャット画面の右レール。
 * 上段（Servers/Agents、`serversSlot`）と下段（Approvals/Docs/Issues/Plan、`docPanelSlot`）を
 * 縦積みで表示する「器」。中身のコンポーネント自体は無変更で、置き場所と幅・折りたたみだけを
 * このコンポーネントが所有する（`temporal-leaping-otter.md` 判断1/3）。
 *
 * 折りたたみ状態の永続化は呼び出し元（`ChatPage`）が担当する
 * （`threadPanelCollapsed`/`ThreadList` と同じ分担）。幅の永続化は本コンポーネントが担当する
 * （旧 DocPanel のリサイズロジックをそのまま移設・`devrelay-panel-width` キーを流用）。
 */
export interface RightRailProps {
  /** 折りたたみ状態 */
  collapsed: boolean;
  /** 折りたたみ切替（呼び出し元が localStorage 永続化する） */
  onToggle: () => void;
  /** 折りたたみ中バッジに表示する承認待ち件数（`toolApprovals` の `status === 'pending'` 件数） */
  pendingApprovalCount: number;
  /** 上段: Servers/Agents（`Sidebar` に `variant="rail"` を渡したインスタンス） */
  serversSlot: ReactNode;
  /** 下段: DocPanel（有効タブが1つも無い場合は `null` を渡す） */
  docPanelSlot: ReactNode | null;
}

/** localStorage 読み取りを try/catch で包む（プライベートモード等で例外になる環境向け） */
function safeGetItem(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** localStorage 書き込みを try/catch で包む */
function safeSetItem(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* プライベートモード等で書き込み不可でも動作を継続 */
  }
}

export function RightRail({ collapsed, onToggle, pendingApprovalCount, serversSlot, docPanelSlot }: RightRailProps) {
  const { t } = useLanguage();
  /** リサイズ状態（旧 DocPanel から移設。ロジック・定数は無変更） */
  const [railWidth, setRailWidth] = useState(() => readRailWidth(safeGetItem(RAIL_WIDTH_STORAGE_KEY)));
  const [resizing, setResizing] = useState(false);
  const railWidthRef = useRef(railWidth);
  railWidthRef.current = railWidth;

  /** リサイズハンドル（旧 DocPanel の handleResizeStart と同一ロジック） */
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setResizing(true);
    const startX = e.clientX;
    const startWidth = railWidthRef.current;

    const handleMouseMove = (ev: MouseEvent) => {
      // 右端パネルなので左にドラッグ = 幅拡大
      const delta = startX - ev.clientX;
      setRailWidth(clampRailWidth(startWidth + delta));
    };

    const handleMouseUp = () => {
      setResizing(false);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      safeSetItem(RAIL_WIDTH_STORAGE_KEY, String(railWidthRef.current));
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, []);

  const badge = resolveRailBadge({ collapsed, pendingCount: pendingApprovalCount });

  if (collapsed) {
    return (
      <div className="hidden md:flex flex-col items-center w-8 shrink-0 border-l border-[var(--border-color)] bg-[var(--bg-secondary)] pt-2">
        <button
          onClick={onToggle}
          title={t('rail.expand')}
          className="relative text-[var(--text-muted)] hover:text-[var(--text-primary)] p-1"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 6l-6 6 6 6" />
          </svg>
          {badge.show && (
            <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] px-[3px] rounded-full bg-red-500 text-white text-[9px] leading-[14px] text-center">
              {badge.label}
            </span>
          )}
        </button>
      </div>
    );
  }

  return (
    <>
      {/* リサイズ中のオーバーレイ（テキスト選択防止。旧 DocPanel から移設） */}
      {resizing && <div className="fixed inset-0 z-50 cursor-col-resize" />}

      <aside
        style={{ width: railWidth }}
        className="relative shrink-0 hidden md:flex flex-col min-h-0 border-l border-[var(--border-color)] bg-[var(--bg-secondary)]"
      >
        {/* リサイズハンドル（旧 DocPanel から移設） */}
        <div
          className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-[var(--accent-blue)] hover:opacity-50 z-10"
          onMouseDown={handleResizeStart}
        />

        {/* 上段: Servers/Agents（768px 以上から表示） */}
        <div className="flex-1 min-h-0 flex flex-col">{serversSlot}</div>

        {/* 下段: DocPanel（1024px 以上のみ・従来の可視性を保存） */}
        {docPanelSlot && (
          <div className="hidden lg:flex flex-col min-h-0 flex-1 border-t border-[var(--border-color)]">
            {docPanelSlot}
          </div>
        )}
      </aside>
    </>
  );
}
