import { useLanguage } from '../../contexts/LanguageContext';
import type { ToolApprovalPrompt } from '../../hooks/useWebSocket';
import type { LiteApprovalStatus } from './lite-shell-rules';

/**
 * Lite シェル L5: 承認/質問カード。**内部 state を一切持たない受動コンポーネント**（D6）。
 *
 * `onRespond` / `status` はどちらも省略可能な純加算 prop。両方省略したときの描画結果は
 * L3 B5 時点（表示専用プレースホルダ）と完全に一致する（ボタンは `disabled`、本文は
 * `lite.approvalPlaceholderBody`、`onClick` は付与しない）。AskUserQuestion
 * （`prompt.isQuestion: true`）のカードは呼び出し側 `LitePage` が `onRespond` を渡さないことで
 * このプレースホルダ表示のまま据え置く（L5.1 のスコープ）。
 *
 * 応答送信の可否判定（二重送信防止・切断中の扱い・fail-closed なスレッド一致判定）は一切ここに
 * 置かない。すべて `LitePage` が `lite-shell-rules.ts`（`decideApprovalRespond()` /
 * `selectVisibleApprovals()` 等）を通じて行い、結果だけを `onRespond` / `status` として渡す。
 * これにより「サーバー再送で pending に巻き戻ったのにボタンが disabled のまま」という
 * コンポーネント内 state 由来の不整合（このコンポーネントが内部 state を持たない設計の理由）が
 * 構造的に発生しない。
 */
export interface LiteApprovalCardProps {
  prompt: ToolApprovalPrompt;
  /** 承認/拒否ボタンのクリック時コールバック。省略時はボタンは常に disabled のまま
   * （L5.1 スコープの質問カード・可視性ゲート対象外のカード等）。 */
  onRespond?: (behavior: 'allow' | 'deny') => void;
  /** 表示ステータス。省略時は 'pending' 相当（今日と同じ常時 disabled 表示）。 */
  status?: LiteApprovalStatus;
}

export function LiteApprovalCard({ prompt, onRespond, status }: LiteApprovalCardProps) {
  const { t } = useLanguage();
  const responded = (status ?? 'pending') !== 'pending';

  return (
    <div className="mx-3 my-2 shrink-0 rounded border border-[var(--border-danger)] bg-[var(--bg-danger)] p-3 text-sm">
      <div className="font-semibold text-[var(--text-primary)]">{t('lite.approvalPlaceholderTitle')}</div>
      <div className="mt-1 text-[var(--text-secondary)]">{prompt.title ?? prompt.toolName}</div>
      {prompt.description && (
        <div className="mt-1 text-xs text-[var(--text-muted)] whitespace-pre-wrap">{prompt.description}</div>
      )}
      <div className="mt-2 text-xs text-[var(--text-faint)]">
        {!onRespond
          ? t('lite.approvalPlaceholderBody')
          : responded
            ? t('lite.approvalResponded')
            : t('lite.approvalRespondBody')}
      </div>
      <div className="mt-2 flex gap-2">
        <button
          disabled={!onRespond || responded}
          onClick={onRespond ? () => onRespond('allow') : undefined}
          className="text-xs px-3 py-1 rounded bg-[var(--bg-hover)] text-[var(--text-muted)] disabled:opacity-50"
        >
          {t('lite.approvePlaceholder')}
        </button>
        <button
          disabled={!onRespond || responded}
          onClick={onRespond ? () => onRespond('deny') : undefined}
          className="text-xs px-3 py-1 rounded bg-[var(--bg-hover)] text-[var(--text-muted)] disabled:opacity-50"
        >
          {t('lite.denyPlaceholder')}
        </button>
      </div>
    </div>
  );
}
