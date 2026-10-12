import { useState } from 'react';
import { useLanguage } from '../../contexts/LanguageContext';
import type { TranslationKey } from '../../i18n/messages';
import { type ConversationState, isKnowledgeAnswerKeyMissingError } from '../../lib/knowledge-answer-rules';
import { AnswerMarkdown } from './AnswerMarkdown';

/**
 * 高辻ナレッジ サイクル4: ナレッジ回答パネル（指示書 §3、D1〜D6）。カード一覧の上に置く。
 * サイクル4.5: 1 問 1 答ではなく会話（追い質問可能）。最初の往復はサイクル4 と同じ見た目のまま、
 * 2 問目以降は質問（小さく右寄せ）＋回答を縦に積む。最後の往復が `done` のときだけ
 * 「続けて聞く…」入力を表示する（D1）。
 * ライブの経過秒カウンタは出さない（ユーザー承認の最終決定: `setInterval` ガードは緩めない）。
 * スピナーのみ表示し、完了後にサーバーの `elapsedMs`/`model`/`usage` を小さく表示する
 * （最後の往復にのみ表示。過去の往復には出さない）。
 */
export interface KnowledgeAnswerPanelProps {
  conversation: ConversationState;
  onCitationClick: (ref: number) => void;
  onFollowUp: (question: string) => void;
  onClear: () => void;
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

export function KnowledgeAnswerPanel({ conversation, onCitationClick, onFollowUp, onClear }: KnowledgeAnswerPanelProps) {
  const { t } = useLanguage();
  const [draft, setDraft] = useState('');

  if (conversation.status === 'idle' || conversation.status === 'disabled') {
    return null;
  }

  const lastIndex = conversation.turns.length - 1;
  const lastTurn = lastIndex >= 0 ? conversation.turns[lastIndex] : null;
  const canFollowUp = lastTurn?.answer.status === 'done';

  const submitFollowUp = () => {
    const trimmed = draft.trim();
    if (trimmed.length === 0) return;
    onFollowUp(trimmed);
    setDraft('');
  };

  return (
    <div className="mb-3 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-4">
      {conversation.turns.map((turn, index) => {
        const { answer } = turn;
        const isLast = index === lastIndex;

        return (
          <div key={answer.answerId ?? index} className={index > 0 ? 'mt-3 border-t border-[var(--border-color)] pt-3' : ''}>
            {index > 0 && (
              <p className="mb-1 text-right text-xs font-medium text-[var(--text-muted)]">
                {t('knowledge.answer.questionPrefix')} {turn.question}
              </p>
            )}

            {(answer.status === 'loading' || answer.status === 'streaming') && answer.text.length === 0 && (
              <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
                <span
                  className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-[var(--accent-blue)] border-t-transparent"
                  aria-hidden="true"
                />
                <span>{t('knowledge.answer.thinking')}</span>
              </div>
            )}

            {(answer.status === 'streaming' || answer.status === 'done') && answer.text.length > 0 && (
              <AnswerMarkdown text={answer.text} onCitationClick={onCitationClick} />
            )}

            {answer.status === 'error' && <p className="text-sm text-[var(--text-danger)]">{describeAnswerError(answer.errorMessage, t)}</p>}

            {answer.status === 'done' && answer.sources.length > 0 && (
              <div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-[var(--text-faint)]">
                <span>{t('knowledge.answer.sourcesLabel')}:</span>
                {answer.sources.map((s) => (
                  <button
                    key={s.ref}
                    type="button"
                    onClick={() => onCitationClick(s.ref)}
                    className="rounded bg-[var(--accent-blue)]/20 px-1 font-medium text-[var(--text-link)] hover:underline"
                  >
                    [{s.ref}]
                  </button>
                ))}
              </div>
            )}

            {isLast && answer.status === 'done' && (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[var(--text-faint)]">
                {answer.model && <span>{answer.model}</span>}
                {answer.usage && (
                  <span>{t('knowledge.answer.tokens').replace('{n}', String(answer.usage.input + answer.usage.output))}</span>
                )}
                {answer.elapsedMs !== null && (
                  <span>{t('knowledge.answer.elapsed').replace('{s}', (answer.elapsedMs / 1000).toFixed(1))}</span>
                )}
              </div>
            )}

            {isLast && answer.status === 'done' && answer.audited && (
              <p className="mt-1 text-xs text-[var(--text-muted)]">{t('knowledge.answer.auditNotice')}</p>
            )}
          </div>
        );
      })}

      <div className="mt-3 flex items-center gap-2">
        {canFollowUp && (
          <>
            <input
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  submitFollowUp();
                }
              }}
              placeholder={t('knowledge.answer.followUpPlaceholder')}
              className="flex-1 rounded border border-[var(--border-color)] bg-[var(--bg-primary)] px-2 py-1 text-sm text-[var(--text-primary)]"
            />
            <button
              type="button"
              onClick={submitFollowUp}
              disabled={draft.trim().length === 0}
              className="rounded bg-[var(--accent-blue)] px-3 py-1 text-sm text-white disabled:opacity-50"
            >
              {t('knowledge.answer.followUpSend')}
            </button>
          </>
        )}
        <button type="button" onClick={onClear} className="text-xs text-[var(--text-muted)] underline">
          {t('knowledge.answer.clearConversation')}
        </button>
      </div>
    </div>
  );
}
