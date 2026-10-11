import { useCallback, useEffect, useRef, useState } from 'react';
import { useLanguage } from '../../contexts/LanguageContext';
import { useOrganization } from '../../contexts/OrganizationContext';
import { knowledge as knowledgeApi, type KnowledgeThread, type KnowledgeThreadMessage, type ClassificationValue, type ThreadClassification } from '../../lib/api';
import {
  buildHighlightSegments,
  buildThreadPageRequest,
  deriveThreadCursors,
  isThreadNotVisibleError,
  mergeThreadMessages,
  KNOWLEDGE_THREAD_PAGE_SIZE,
} from '../../lib/knowledge-search-rules';
import { canShowThreadEditor } from '../../lib/clearance-rules';
import { LevelBadge } from './LevelBadge';
import { CompartmentChips } from './CompartmentChips';
import { ClassificationEditor } from './ClassificationEditor';

/**
 * 高辻ナレッジ サイクル3（WebUI）: スレッドビューア（指示書 §3.2）。
 * `GET /api/knowledge/threads/:sessionId` を使う読み取り専用ビューア。**ChatPage へは遷移しない**
 * （D2: ChatPage は自分のセッション前提の 2,000 行超のコンポーネントで、他人のスレッドを混ぜると危険）。
 *
 * `key={sessionId}` で親からマウントされる前提（スレッド切替で内部状態が自然にリセットされる）。
 * `setSearchParams` はここでは一切呼ばない（URL の書き込みは `KnowledgePage` の 1 箇所に集約し、
 * fetch コールバックからの URL 書き込みによる無限ループ（LitePage で文書化済みの罠）を避ける）。
 */
export interface KnowledgeThreadViewerProps {
  sessionId: string;
  /** 検索結果から開いたときのヒット位置（`occurredAt` = AI メッセージの createdAt）。 */
  anchorMessageId: string | null;
  anchorTimestamp: string | null;
  query: string;
  onClose: () => void;
  onClassificationSaved: (sessionId: string, after: ClassificationValue | ThreadClassification) => void;
}

export function KnowledgeThreadViewer({
  sessionId,
  anchorMessageId,
  anchorTimestamp,
  query,
  onClose,
  onClassificationSaved,
}: KnowledgeThreadViewerProps) {
  const { t, locale } = useLanguage();
  const { organization } = useOrganization();

  const [thread, setThread] = useState<KnowledgeThread | null>(null);
  const [messages, setMessages] = useState<KnowledgeThreadMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadingNewer, setLoadingNewer] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [hasOlder, setHasOlder] = useState(true);
  const [hasNewer, setHasNewer] = useState(false);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const nodeRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const scrolledRef = useRef(false);
  const [flashId, setFlashId] = useState<string | null>(null);

  // 初回読み込み（アンカー指定があれば anchor ページング、無ければ先頭から）
  useEffect(() => {
    let dead = false;
    setLoading(true);
    setErr(null);
    setMessages([]);
    scrolledRef.current = false;
    const req = anchorMessageId
      ? buildThreadPageRequest({ direction: 'anchor', anchorTimestamp })
      : buildThreadPageRequest({ direction: 'initial' });
    knowledgeApi
      .getThread(sessionId, req)
      .then((res) => {
        if (dead) return;
        setThread(res);
        setMessages(res.messages);
        setHasOlder(res.messages.length === KNOWLEDGE_THREAD_PAGE_SIZE || res.hasMore);
        setHasNewer(Boolean(anchorMessageId)); // anchor 読みの場合、後続がある可能性を残す
      })
      .catch((e) => {
        if (!dead) setErr(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!dead) setLoading(false);
      });
    return () => {
      dead = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // アンカー行への一度だけのスクロール（見つかるまで繰り返しのページ取得後も再試行する）
  useEffect(() => {
    if (scrolledRef.current || !anchorMessageId || messages.length === 0) return;
    const node = nodeRefs.current[anchorMessageId];
    if (!node) return;
    scrolledRef.current = true;
    node.scrollIntoView({ block: 'center', behavior: 'auto' });
    setFlashId(anchorMessageId);
    const id = window.setTimeout(() => setFlashId(null), 2000);
    return () => window.clearTimeout(id);
  }, [messages, anchorMessageId]);

  const loadOlder = useCallback(async () => {
    const { first } = deriveThreadCursors(messages);
    if (!first) return;
    setLoadingOlder(true);
    const container = containerRef.current;
    const prevScrollHeight = container?.scrollHeight ?? 0;
    try {
      const req = buildThreadPageRequest({ direction: 'older', firstLoadedTimestamp: first });
      const res = await knowledgeApi.getThread(sessionId, req);
      setMessages((prev) => mergeThreadMessages(prev, res.messages));
      setHasOlder(res.messages.length === KNOWLEDGE_THREAD_PAGE_SIZE);
      requestAnimationFrame(() => {
        if (container) container.scrollTop += container.scrollHeight - prevScrollHeight;
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingOlder(false);
    }
  }, [messages, sessionId]);

  const loadNewer = useCallback(async () => {
    const { last } = deriveThreadCursors(messages);
    if (!last) return;
    setLoadingNewer(true);
    try {
      const req = buildThreadPageRequest({ direction: 'newer', lastLoadedTimestamp: last });
      const res = await knowledgeApi.getThread(sessionId, req);
      setMessages((prev) => mergeThreadMessages(prev, res.messages));
      setHasNewer(res.messages.length === KNOWLEDGE_THREAD_PAGE_SIZE);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingNewer(false);
    }
  }, [messages, sessionId]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  if (loading) {
    return <div className="p-4 text-sm text-[var(--text-muted)]">{t('knowledge.thread.loading')}</div>;
  }

  if (err && !thread) {
    const displayMessage = isThreadNotVisibleError(err) ? t('knowledge.thread.notFound') : err;
    return (
      <div className="p-4">
        <p className="text-sm text-[var(--text-danger)]">{displayMessage}</p>
        <button onClick={onClose} className="mt-2 text-xs text-[var(--text-link)] hover:underline">
          {t('knowledge.thread.close')}
        </button>
      </div>
    );
  }

  if (!thread) return null;

  const role = organization?.role ?? null;
  const canEdit = canShowThreadEditor({ isOwn: thread.isOwn, role });
  const anchorFound = anchorMessageId ? messages.some((m) => m.id === anchorMessageId) : true;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-start justify-between gap-2 border-b border-[var(--border-color)] p-3">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-[var(--text-primary)]">
            {thread.threadTitle ?? t('knowledge.thread.title')}
          </h2>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)]">
            <span>{thread.projectName}</span>
            <LevelBadge level={thread.level} compact />
            {thread.compartment && <CompartmentChips values={[thread.compartment]} />}
            <span>{thread.isOwn ? t('knowledge.own') : t('knowledge.ownerBy').replace('{name}', thread.ownerName)}</span>
          </div>
        </div>
        <button
          onClick={onClose}
          className="shrink-0 px-2 py-1 text-xs border border-[var(--border-color)] rounded text-[var(--text-secondary)]"
        >
          {t('knowledge.thread.close')}
        </button>
      </div>

      {!thread.isOwn && (
        <div className="border-b border-[var(--border-color)] bg-amber-500/10 px-3 py-1.5 text-xs text-amber-500">
          {t('knowledge.thread.auditNotice')}
        </div>
      )}

      {canEdit && (
        <div className="border-b border-[var(--border-color)] p-2">
          <ClassificationEditor
            target={{ kind: 'thread', sessionId: thread.sessionId }}
            canEdit={canEdit}
            onSaved={(after) => onClassificationSaved(thread.sessionId, after)}
          />
        </div>
      )}

      {!anchorFound && anchorMessageId && (
        <p className="border-b border-[var(--border-color)] bg-[var(--bg-tertiary)]/40 px-3 py-1.5 text-xs text-[var(--text-muted)]">
          {t('knowledge.thread.anchorMissing')}
        </p>
      )}

      <div ref={containerRef} className="flex-1 space-y-2 overflow-y-auto p-3 md:h-[calc(100vh-14rem)]">
        <div className="flex justify-center">
          {hasOlder ? (
            <button
              onClick={loadOlder}
              disabled={loadingOlder}
              className="px-2 py-1 text-xs border border-[var(--border-color)] rounded text-[var(--text-secondary)] disabled:opacity-50"
            >
              {t('knowledge.thread.loadOlder')}
            </button>
          ) : (
            <span className="text-xs text-[var(--text-faint)]">{t('knowledge.thread.noOlder')}</span>
          )}
        </div>

        {messages.map((m) => {
          const isAnchor = m.id === anchorMessageId;
          const highlight = isAnchor ? buildHighlightSegments(m.content, query) : null;
          return (
            <div
              key={m.id}
              ref={(el) => {
                nodeRefs.current[m.id] = el;
              }}
              data-message-id={m.id}
              className={`rounded border p-2 text-sm ${
                m.role === 'user'
                  ? 'ml-0 mr-8 border-[var(--border-color)] bg-[var(--bg-secondary)]'
                  : 'ml-8 mr-0 border-[var(--border-color)] bg-[var(--ai-bubble)]'
              } ${isAnchor ? 'ring-1 ring-[var(--accent-blue)] border-l-2 border-l-[var(--accent-blue)]' : ''} ${
                flashId === m.id ? 'bg-[var(--bg-hover)]' : ''
              }`}
            >
              <div className="mb-1 flex items-center justify-between text-[10px] text-[var(--text-faint)]">
                <span>{m.role === 'user' ? t('knowledge.thread.roleUser') : t('knowledge.thread.roleAi')}</span>
                <span>{new Date(m.timestamp).toLocaleString(locale)}</span>
              </div>
              <div className="whitespace-pre-wrap break-words text-[var(--text-primary)]">
                {highlight
                  ? highlight.map((s, i) =>
                      s.match ? (
                        <mark key={i} className="rounded bg-[var(--accent-blue)]/25 px-0.5">
                          {s.text}
                        </mark>
                      ) : (
                        <span key={i}>{s.text}</span>
                      )
                    )
                  : m.content}
              </div>
              {m.truncated && (
                <p className="mt-1 text-[10px] text-[var(--text-faint)]">
                  {m.truncatedSide === 'tail' ? t('knowledge.thread.truncatedHead') : t('knowledge.thread.truncatedTail')}
                </p>
              )}
            </div>
          );
        })}

        <div className="flex justify-center">
          {hasNewer ? (
            <button
              onClick={loadNewer}
              disabled={loadingNewer}
              className="px-2 py-1 text-xs border border-[var(--border-color)] rounded text-[var(--text-secondary)] disabled:opacity-50"
            >
              {t('knowledge.thread.loadNewer')}
            </button>
          ) : (
            <span className="text-xs text-[var(--text-faint)]">{t('knowledge.thread.noNewer')}</span>
          )}
        </div>
      </div>
      {err && <p className="border-t border-[var(--border-color)] p-2 text-xs text-[var(--text-danger)]">{err}</p>}
    </div>
  );
}
