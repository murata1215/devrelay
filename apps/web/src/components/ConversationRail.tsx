import { useLanguage } from '../contexts/LanguageContext';
import type { ConversationFeedItem } from '../hooks/useConversationFeed';
import { deriveThreadLabel, isQuestionThread, isCancelledThread } from '../lib/thread-list-rules';
import { deriveAgentLabel, formatConversationScope } from '../lib/conversation-rail-rules';
import { formatRelativeTime } from './ThreadList';

/**
 * 会話履歴レール（右レール第3タブ・`Servers`/`Agents` の隣）の表示専用コンポーネント。
 *
 * `ThreadList.tsx` とは独立（表示専用、作成・改名ボタンを持たない）。データ取得・既読管理は
 * `useConversationFeed` が担い、本コンポーネントは `items`（表示状態込み）を受け取って
 * 描画するだけ。状態アイコンは `TabBar`（`ChatPage.tsx`）の markup をそのまま踏襲し、
 * 見た目の一貫性を保つ（実行中=スピナー / 未確認=緑✓ / 確認済み=マークなし）。
 */
export interface ConversationRailProps {
  items: ConversationFeedItem[];
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  currentSessionId: string | null;
  onSelect: (item: ConversationFeedItem) => void;
  /** `item.projectName` はサーバー側で `project.name`（`displayName` ではない）。
   *  指定すると行1行目の「エージェント名/プロジェクト名」のプロジェクト部分に使う
   *  （`ThreadList` と同じ契約。改名・カスタムタブ名を反映させるため呼び出し側が渡す）。 */
  resolveProjectLabel?: (projectId: string, fallbackName: string) => string;
}

/** 状態アイコン1個分（`TabBar` の markup をそのまま踏襲。要望「マークなし」のため seen は空スペーサ） */
function StatusIcon({ status }: { status: ConversationFeedItem['conversationStatus'] }) {
  if (status === 'running') {
    return <span className="w-3 h-3 border-2 border-[var(--accent-blue)] border-t-transparent rounded-full animate-spin inline-block shrink-0" />;
  }
  if (status === 'unread') {
    return <span className="text-green-500 text-xs shrink-0 w-3 inline-block text-center">✓</span>;
  }
  return <span className="w-3 h-3 shrink-0 inline-block" />;
}

export function ConversationRail({ items, loading, error, onRetry, currentSessionId, onSelect, resolveProjectLabel }: ConversationRailProps) {
  const { t, locale } = useLanguage();

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex-1 overflow-y-auto">
        {loading && items.length === 0 && (
          <div className="px-3 py-4 text-xs text-[var(--text-faint)] text-center">{t('common.loading')}</div>
        )}
        {error && items.length === 0 && (
          <div className="px-3 py-4 text-xs text-center">
            <div className="text-[var(--text-faint)] mb-1">{t('conversation.loadFailed')}</div>
            <button onClick={onRetry} className="text-[var(--text-muted)] hover:text-[var(--text-primary)] underline">
              {t('thread.retry')}
            </button>
          </div>
        )}
        {!loading && !error && items.length === 0 && (
          <div className="px-3 py-4 text-xs text-[var(--text-faint)] text-center">{t('conversation.empty')}</div>
        )}
        {items.map((item) => {
          const label = deriveThreadLabel(item);
          // 2026-10-22 見た目改修: 「エージェント名/プロジェクト名」を主役（1行目・太字）にし、
          // 会話タイトルを2行目（従）に下げる。全プロジェクト横断の一覧では
          // 「どのエージェントのどのプロジェクトの会話か」が先に分かるべきという要望に基づく。
          const projectLabel = resolveProjectLabel ? resolveProjectLabel(item.projectId, item.projectName) : item.projectName;
          const scopeText = formatConversationScope({ agentLabel: deriveAgentLabel(item.machineName), projectLabel });
          // 1行目で既にプロジェクトが分かるため、タイトル未設定時のフォールバックはプロジェクト名を
          // 重複させず「(無題)」にする（旧実装は `item.projectName || t('thread.untitled')` だった）。
          const titleText = label.kind === 'fallback' ? t('thread.untitled') : label.text;
          const isActive = item.sessionId === currentSessionId;
          return (
            <div
              key={item.sessionId}
              onClick={() => onSelect(item)}
              title={`${item.machineName} / ${item.projectName}`}
              className={`
                flex items-start gap-1.5 px-3 py-2 border-b border-[var(--border-color)] cursor-pointer
                ${isActive ? 'bg-[var(--bg-selected)]' : 'hover:bg-[var(--bg-hover)]'}
              `}
            >
              <span className="mt-0.5"><StatusIcon status={item.conversationStatus} /></span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span
                    className={`text-xs font-semibold truncate ${isActive ? 'text-[var(--accent-blue)]' : 'text-[var(--text-primary)]'}`}
                    title={item.conversationStatus === 'running' ? t('conversation.running') : item.conversationStatus === 'unread' ? t('conversation.unread') : undefined}
                  >
                    {scopeText || t('thread.untitled')}
                  </span>
                  <span className="text-[10px] text-[var(--text-faint)] ml-auto shrink-0">
                    {formatRelativeTime(item.lastActiveAt, locale, t('thread.timeJustNow'))}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <span className="text-[11px] text-[var(--text-secondary)] truncate">{titleText}</span>
                  {isQuestionThread(item) && (
                    <span className="text-[10px] px-1 rounded bg-[var(--bg-hover)] text-[var(--text-faint)] shrink-0">{t('thread.question')}</span>
                  )}
                  {isCancelledThread(item) && (
                    <span className="text-[10px] px-1 rounded bg-[var(--bg-hover)] text-[var(--text-faint)] shrink-0">{t('thread.cancelled')}</span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
