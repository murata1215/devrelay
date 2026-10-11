import { useLanguage } from '../../contexts/LanguageContext';
import type { TranslationKey } from '../../i18n/messages';
import { type AnswerState, isKnowledgeAnswerKeyMissingError } from '../../lib/knowledge-answer-rules';
import { AnswerMarkdown } from './AnswerMarkdown';

/**
 * 高辻ナレッジ サイクル4: ナレッジ回答パネル（指示書 §3、D1〜D6）。カード一覧の上に置く。
 * `idle`/`disabled` のときは何も描画しない（検索前・トグル OFF・killswitch OFF）。
 * ライブの経過秒カウンタは出さない（ユーザー承認の最終決定: `setInterval` ガードは緩めない）。
 * スピナーのみ表示し、完了後にサーバーの `elapsedMs`/`model`/`usage` を小さく表示する。
 */
export interface KnowledgeAnswerPanelProps {
  state: AnswerState;
  onCitationClick: (rank: number) => void;
}

function describeAnswerError(message: string | null, t: (key: TranslationKey) => string): string {
  if (!message) return t('knowledge.answer.error.generic');
  if (isKnowledgeAnswerKeyMissingError(message)) return t('knowledge.answer.error.keyMissing');
  if (message === 'answerBusy') return t('knowledge.answer.error.busy');
  if (message === 'minuteRateLimited' || message === 'dailyRateLimited') return t('knowledge.answer.error.rateLimited');
  if (message === 'timeout') return t('knowledge.answer.error.timeout');
  // 未知のエラーはサーバーの原文（英語）をそのまま表示する（既存 KnowledgePage の err 表示と同じ流儀）。
  return message;
}

export function KnowledgeAnswerPanel({ state, onCitationClick }: KnowledgeAnswerPanelProps) {
  const { t } = useLanguage();

  if (state.status === 'idle' || state.status === 'disabled') {
    return null;
  }

  return (
    <div className="mb-3 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-4">
      {(state.status === 'loading' || state.status === 'streaming') && state.text.length === 0 && (
        <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
          <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-[var(--accent-blue)] border-t-transparent" aria-hidden="true" />
          <span>{t('knowledge.answer.thinking')}</span>
        </div>
      )}

      {(state.status === 'streaming' || state.status === 'done') && state.text.length > 0 && (
        <AnswerMarkdown text={state.text} onCitationClick={onCitationClick} />
      )}

      {state.status === 'error' && (
        <p className="text-sm text-[var(--text-danger)]">{describeAnswerError(state.errorMessage, t)}</p>
      )}

      {state.status === 'done' && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[var(--text-faint)]">
          {state.model && <span>{state.model}</span>}
          {state.usage && (
            <span>{t('knowledge.answer.tokens').replace('{n}', String(state.usage.input + state.usage.output))}</span>
          )}
          {state.elapsedMs !== null && (
            <span>{t('knowledge.answer.elapsed').replace('{s}', (state.elapsedMs / 1000).toFixed(1))}</span>
          )}
        </div>
      )}

      {state.status === 'done' && state.audited && (
        <p className="mt-1 text-xs text-[var(--text-muted)]">{t('knowledge.answer.auditNotice')}</p>
      )}
    </div>
  );
}
