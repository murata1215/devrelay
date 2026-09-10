import { useLanguage } from '../../contexts/LanguageContext';
import type { LiteMessage } from '../../lib/lite-message-log';

/**
 * Lite シェル L3 B5: メッセージ一覧の純表示コンポーネント。
 *
 * markdown は描画しない（`renderMarkdown` は `ChatPage.tsx:1455` のモジュールローカル関数で
 * export されておらず、export すると `ChatPage.tsx` diff 0 制約を破る）。`whitespace-pre-wrap` の
 * 素テキストのみを表示する。
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
          className={`max-w-[80%] rounded px-3 py-2 text-sm whitespace-pre-wrap break-words ${
            m.role === 'user'
              ? 'self-end bg-[var(--user-bubble)] text-white'
              : 'self-start bg-[var(--ai-bubble)] text-[var(--text-primary)]'
          }`}
        >
          {m.content}
        </div>
      ))}
    </div>
  );
}
