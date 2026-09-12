import { useState, useRef, useCallback, useEffect } from 'react';
import { computeResizeWidth, readWidth, type PanelResizeEdge } from '../lib/panel-resize-rules';

/**
 * classic チャット画面の左右ペイン（右レール・スレッド一覧）共通のドラッグリサイズ実装。
 * リサイズのドラッグ処理・localStorage 永続化はここに一本化する（RightRail.tsx / ThreadPane.tsx が
 * それぞれ独自実装を持たないようにするための唯一の入口）。算術（clamp・delta 計算）は必ず
 * `panel-resize-rules.ts` の `computeResizeWidth`/`readWidth` を呼ぶ（フック内に `Math.min`/`Math.max`
 * を書かない。`src/hooks/` は `tsconfig.test.json` の対象外で単体テストできないため）。
 *
 * 旧 `RightRail.tsx` の実装からの意図的な差分（どちらも既存の潜在バグの修正）:
 * - `widthRef.current` を mousemove ハンドラ内で即時更新してから `setWidth` する
 *   （旧実装は render 中に ref を同期していたため、最後の mousemove が React にコミットされる前に
 *   mouseup が来ると 1 イベント分古い幅が保存され得た）。
 * - アンマウント時にドラッグ中のリスナーを確実に解除する（旧実装は mouseup でのみ解除しており、
 *   ドラッグ中に呼び出し元がアンマウントされると document のリスナーが漏れ続けていた）。
 */

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

export interface UsePanelResizeArgs {
  /** 幅を保存する localStorage キー */
  storageKey: string;
  /** 最小幅（px） */
  min: number;
  /** 最大幅（px） */
  max: number;
  /** 既定幅（px。localStorage 未保存時） */
  defaultWidth: number;
  /** ハンドルが付いている辺 */
  edge: PanelResizeEdge;
}

export interface UsePanelResizeResult {
  /** 現在の幅（px） */
  width: number;
  /** ドラッグ中かどうか（オーバーレイの表示判定に使う） */
  resizing: boolean;
  /** ハンドルの onMouseDown に渡すハンドラ */
  onResizeStart: (e: React.MouseEvent) => void;
}

export function usePanelResize(args: UsePanelResizeArgs): UsePanelResizeResult {
  const { storageKey, min, max, defaultWidth } = args;
  const [width, setWidth] = useState(() => readWidth(safeGetItem(storageKey), { min, max, fallback: defaultWidth }));
  const [resizing, setResizing] = useState(false);
  const widthRef = useRef(width);

  /** ドラッグ中に呼び出し元へ渡す config を毎レンダー最新化する（useCallback の identity は固定のまま） */
  const configRef = useRef(args);
  configRef.current = args;

  /** アンマウント時にドラッグ中のリスナーを確実に解除するためのクリーンアップ関数 */
  const cleanupRef = useRef<(() => void) | null>(null);

  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setResizing(true);
    const startX = e.clientX;
    const startWidth = widthRef.current;

    const handleMouseMove = (ev: MouseEvent) => {
      const { min: curMin, max: curMax, edge: curEdge } = configRef.current;
      const next = computeResizeWidth({ startWidth, startX, clientX: ev.clientX, edge: curEdge, min: curMin, max: curMax });
      widthRef.current = next;
      setWidth(next);
    };

    const handleMouseUp = () => {
      setResizing(false);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      cleanupRef.current = null;
      safeSetItem(configRef.current.storageKey, String(widthRef.current));
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    cleanupRef.current = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  useEffect(() => {
    return () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
  }, []);

  return { width, resizing, onResizeStart };
}
