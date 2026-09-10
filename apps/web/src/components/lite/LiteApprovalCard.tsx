import { useLanguage } from '../../contexts/LanguageContext';
import type { ToolApprovalPrompt } from '../../hooks/useWebSocket';

/**
 * Lite シェル L3 B5: 承認/質問カードのプレースホルダ。
 *
 * L5（承認/質問カードの操作）のスコープ外。このコンポーネントは**表示のみ**で一切の操作を
 * 許可しない: `onClick` を一切持たず、`sendToolApprovalResponse` の呼び出し・識別子（`requestId` /
 * `behavior` 等）を含まない。ボタンは常に `disabled`。
 *
 * どのカードを表示するかは呼び出し側 `LitePage` が `shouldShowApprovalCard()`
 * （`lite-shell-rules.ts`、R5 の唯一の fail-closed 例外）で判定してから渡す。
 */
export interface LiteApprovalCardProps {
  prompt: ToolApprovalPrompt;
}

export function LiteApprovalCard({ prompt }: LiteApprovalCardProps) {
  const { t } = useLanguage();

  return (
    <div className="mx-3 my-2 rounded border border-[var(--border-danger)] bg-[var(--bg-danger)] p-3 text-sm">
      <div className="font-semibold text-[var(--text-primary)]">{t('lite.approvalPlaceholderTitle')}</div>
      <div className="mt-1 text-[var(--text-secondary)]">{prompt.title ?? prompt.toolName}</div>
      {prompt.description && (
        <div className="mt-1 text-xs text-[var(--text-muted)] whitespace-pre-wrap">{prompt.description}</div>
      )}
      <div className="mt-2 text-xs text-[var(--text-faint)]">{t('lite.approvalPlaceholderBody')}</div>
      <div className="mt-2 flex gap-2">
        <button
          disabled
          className="text-xs px-3 py-1 rounded bg-[var(--bg-hover)] text-[var(--text-muted)] disabled:opacity-50"
        >
          {t('lite.approvePlaceholder')}
        </button>
        <button
          disabled
          className="text-xs px-3 py-1 rounded bg-[var(--bg-hover)] text-[var(--text-muted)] disabled:opacity-50"
        >
          {t('lite.denyPlaceholder')}
        </button>
      </div>
    </div>
  );
}
