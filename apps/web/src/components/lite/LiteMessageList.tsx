import { useLanguage } from '../../contexts/LanguageContext';
import type { LiteMessage } from '../../lib/lite-message-log';
import { MarkdownBody } from '../MarkdownBody';

/**
 * Lite シェル L3 B5: メッセージ一覧の純表示コンポーネント。
 *
 * AI バブル（`role !== 'user'`）のみ `MarkdownBody`（`lib/markdown-rules.ts` + 自前 React レンダラ、
 * `dangerouslySetInnerHTML` 不使用）で Markdown を描画する。user バブルは自分の入力を勝手に
 * 装飾しないよう、従来どおり `whitespace-pre-wrap` の素テキストのまま。
 *
 * dedupe/マージ済みの `LiteMessage[]`（`lib/lite-message-log.ts`）をそのまま描画するだけで、
 * このコンポーネント自身は重複排除・ソート等のロジックを一切持たない（state も持たない）。
 */
export interface LiteMessageListProps {
  messages: readonly LiteMessage[];
}

export function LiteMessageList({ messages }: LiteMessageListProps) {
  const { t } = useLanguage();

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center px-4">
        <div className="text-sm text-[var(--text-faint)] text-center">{t('lite.noMessagesYet')}</div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-3 py-2 flex flex-col gap-2">
      {messages.map((m, i) => (
        <div
          key={m.messageId ?? `${m.timestampMs}-${i}`}
          className={`max-w-[80%] rounded px-3 py-2 text-sm ${
            m.role === 'user'
              ? 'self-end bg-[var(--user-bubble)] text-white whitespace-pre-wrap break-words'
              : 'self-start bg-[var(--ai-bubble)] text-[var(--text-primary)]'
          }`}
        >
          {m.role === 'user' ? m.content : <MarkdownBody text={m.content} />}
        </div>
      ))}
    </div>
  );
}
