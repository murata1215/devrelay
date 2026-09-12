import type { ReactNode, CSSProperties } from 'react';
import { usePanelResize } from '../hooks/usePanelResize';
import {
  THREAD_PANE_WIDTH_STORAGE_KEY,
  THREAD_PANE_WIDTH_MIN,
  THREAD_PANE_WIDTH_MAX,
  THREAD_PANE_WIDTH_DEFAULT,
  resolveThreadPaneShellClass,
  resolveResizeHandleClass,
  RESIZE_OVERLAY_CLASS,
} from '../lib/panel-resize-rules';

/**
 * classic チャット画面のスレッド一覧（左ペイン）を囲むラッパー。
 * `ThreadList.tsx` は /lite と共有しているため無変更のまま、幅の state・localStorage 永続化・
 * ドラッグハンドルはすべてここが所有する（右レール `RightRail.tsx` と同じ分担、`usePanelResize` を共用）。
 *
 * `ThreadList.tsx` の root は `w-56`（14rem）固定のままだが、`index.css` の `.thread-pane` ルール
 * （アンレイヤー宣言）が 48rem 以上でこれを CSS 変数 `--thread-pane-w` 経由で上書きする。
 * 折りたたみ中（`collapsed`）はラッパーを一切描かず children をそのまま返す。これにより
 * `ThreadList.tsx` の折りたたみストリップ（`w-8`）が今と全く同じ DOM で描画され、
 * `.thread-pane` の 14rem が空白として残る、あるいはストリップ自体が広がる、といった事故を避ける。
 * フック自体は早期 return より前で必ず呼ぶ（React Hooks のルール。折りたたみ中も幅の state は保持される
 * ので、展開すると直前の幅に戻る）。
 */
export interface ThreadPaneProps {
  /** 折りたたみ状態（`ChatPage` の `threadPanelCollapsed`） */
  collapsed: boolean;
  /** 中身（`<ThreadList />`） */
  children: ReactNode;
}

export function ThreadPane({ collapsed, children }: ThreadPaneProps) {
  const { width, resizing, onResizeStart } = usePanelResize({
    storageKey: THREAD_PANE_WIDTH_STORAGE_KEY,
    min: THREAD_PANE_WIDTH_MIN,
    max: THREAD_PANE_WIDTH_MAX,
    defaultWidth: THREAD_PANE_WIDTH_DEFAULT,
    edge: 'right',
  });

  if (collapsed) {
    return <>{children}</>;
  }

  return (
    <>
      {/* リサイズ中のオーバーレイ（テキスト選択防止。RightRail と共通） */}
      {resizing && <div className={RESIZE_OVERLAY_CLASS} />}

      <div
        className={resolveThreadPaneShellClass()}
        style={{ ['--thread-pane-w' as string]: `${width}px` } as CSSProperties}
      >
        {children}
        {/* リサイズハンドル（右端。md 未満は非表示） */}
        <span className={resolveResizeHandleClass('right')} onMouseDown={onResizeStart} />
      </div>
    </>
  );
}
