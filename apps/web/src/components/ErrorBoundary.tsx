import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * レンダー中の例外を局所化する React Error Boundary。
 *
 * #310（app.devrelay.io 全画面真っ白障害）や今回（aisignage/lfuser クリックで全画面真っ白）が
 * 示すとおり、`apps/web` には元々 Error Boundary が 1 つも無かった。DB / Agent 由来の未検証な
 * JSON（例: `Machine.managementInfo`）を描画するコンポーネントが 1 つでも例外を投げると、React が
 * ツリー全体を unmount してヘッダー・ナビごと消える（Class コンポーネント以外に例外を止める手段が
 * React に無いため、これは関数コンポーネント側でいくら null チェックを足しても構造的に防げない）。
 *
 * 個々の null チェック（`machine-display-rules.ts` 等）は「よくある壊れ方」を直すための第一防御であり、
 * このコンポーネントは「それでも防ぎきれなかった未知の壊れ方」に対する最終防御（fail-closed だが
 * 影響範囲をラップした部分だけに閉じ込める）。
 */
interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    // 原因不明のまま真っ白になる最悪の失敗モードを避けるため、必ずコンソールに残す
    console.error('[ErrorBoundary] Uncaught render error:', error, errorInfo);
    this.setState({ errorInfo });
  }

  private handleReload = (): void => {
    window.location.reload();
  };

  private handleDismiss = (): void => {
    this.setState({ error: null, errorInfo: null });
  };

  render(): ReactNode {
    const { error, errorInfo } = this.state;
    if (!error) {
      return this.props.children;
    }

    return (
      <div className="p-6 max-w-2xl mx-auto">
        <div className="bg-red-500/10 border border-red-500/40 rounded-lg p-6">
          <h2 className="text-lg font-bold text-[var(--text-danger,#f87171)] mb-2">
            ⚠️ 表示中にエラーが発生しました
          </h2>
          <p className="text-sm text-[var(--text-muted,#94a3b8)] mb-4">
            この画面の一部が不正なデータのために描画できませんでした。他の画面は操作を継続できます。
          </p>
          <p className="text-xs font-mono break-all bg-black/20 rounded px-3 py-2 mb-4">
            {error.message}
          </p>
          {errorInfo?.componentStack && (
            <details className="mb-4">
              <summary className="text-xs cursor-pointer text-[var(--text-faint,#64748b)]">
                詳細（component stack）
              </summary>
              <pre className="text-xs whitespace-pre-wrap break-all mt-2 opacity-70">
                {errorInfo.componentStack}
              </pre>
            </details>
          )}
          <div className="flex gap-2">
            <button
              onClick={this.handleDismiss}
              className="bg-[var(--bg-tertiary,#334155)] hover:opacity-80 text-[var(--text-primary,#e2e8f0)] px-4 py-2 rounded-lg text-sm transition-opacity"
            >
              閉じる（再試行）
            </button>
            <button
              onClick={this.handleReload}
              className="bg-[var(--accent-blue,#3b82f6)] hover:opacity-90 text-white px-4 py-2 rounded-lg text-sm transition-opacity"
            >
              ページを再読み込み
            </button>
          </div>
        </div>
      </div>
    );
  }
}
