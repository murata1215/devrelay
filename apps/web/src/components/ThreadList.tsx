import { useState, useEffect, useRef, useCallback, type MouseEvent } from 'react';
import { threads as threadsApi, sessions as sessionsApi, type ThreadSummary, type ThreadSwitchResult, type ThreadCreateResult } from '../lib/api';
import { getTabId } from '../lib/tab-id';
import { sortThreadsDesc, deriveThreadLabel, isDefaultThread, applyThreadRename, upsertThread } from '../lib/thread-list-rules';
import { useLanguage } from '../contexts/LanguageContext';

/**
 * スレッド管理 サイクル3（WebUI）: プロジェクト内（または `projectId` 省略時はユーザーの全プロジェクト
 * 横断、Lite シェル v2 用）のスレッド一覧パネル。
 *
 * API 呼び出し（一覧取得・新規作成・切替・改名）はすべて本コンポーネントが持つ（ホスト側 `ChatPage` に
 * 分岐を散らさない）。全 API 呼び出しは try/catch で握り、例外を親へ伝播させない
 * （一覧取得が失敗してもチャット本体は壊さない）。
 */

/** 相対時刻表示（`Intl.RelativeTimeFormat` を使用。純モジュール `thread-list-rules.ts` には
 * i18n 補間の都合で置けないため、このコンポーネント内だけの非純関数として保持する） */
function formatRelativeTime(iso: string, locale: 'en-US' | 'ja-JP', justNowLabel: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  const diffSec = Math.round((Date.now() - ms) / 1000);
  if (diffSec < 60) return justNowLabel;
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 60 * 60 * 24 * 365],
    ['month', 60 * 60 * 24 * 30],
    ['day', 60 * 60 * 24],
    ['hour', 60 * 60],
    ['minute', 60],
  ];
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  for (const [unit, secInUnit] of units) {
    if (diffSec >= secInUnit) {
      return rtf.format(-Math.floor(diffSec / secInUnit), unit);
    }
  }
  return justNowLabel;
}

export interface ThreadListProps {
  /** 省略時はユーザーの全スレッド（Lite シェル v2 用）。v1（ChatPage内）はタブの projectId を渡す */
  projectId?: string;
  /** ハイライト対象の現在スレッド */
  currentSessionId: string | null;
  /** switch 成功後に呼ばれる */
  onSelect: (r: ThreadSwitchResult) => void;
  /** 新規作成成功後に呼ばれる */
  onCreate?: (r: ThreadCreateResult) => void;
  /** これが変化したら一覧を再取得する（session_info 受信時等） */
  refreshToken?: number;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

export function ThreadList({ projectId, currentSessionId, onSelect, onCreate, refreshToken, collapsed, onToggleCollapse }: ThreadListProps) {
  const { t, locale } = useLanguage();
  const [items, setItems] = useState<ThreadSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [creating, setCreating] = useState(false);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);
  /** stale closure 防止（並行フェッチ時に古い projectId の結果を捨てる） */
  const requestSeqRef = useRef(0);

  /** スレッド一覧を取得する（失敗しても例外を投げない） */
  const fetchThreads = useCallback(async () => {
    const seq = ++requestSeqRef.current;
    setLoading(true);
    setError(false);
    try {
      const { threads } = await threadsApi.list(projectId);
      if (requestSeqRef.current !== seq) return; // stale response
      setItems(sortThreadsDesc(threads));
    } catch {
      if (requestSeqRef.current !== seq) return;
      setError(true);
    } finally {
      if (requestSeqRef.current === seq) setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    fetchThreads();
  }, [fetchThreads, refreshToken]);

  useEffect(() => {
    if (renamingId) renameInputRef.current?.focus();
  }, [renamingId]);

  /** 新規スレッド作成 */
  const handleCreate = useCallback(async () => {
    if (!projectId || creating) return;
    setCreating(true);
    try {
      const tabId = getTabId();
      const result = await threadsApi.create({ projectId, tabId });
      setItems((prev) => upsertThread(prev, {
        sessionId: result.sessionId,
        title: result.title,
        projectId: result.projectId,
        projectName: result.projectName,
        machineName: '',
        machineOnline: true,
        aiTool: '',
        status: 'active',
        lastActiveAt: new Date().toISOString(),
        firstUserMessage: null,
        messageCount: 0,
        isScoped: true,
      }));
      onCreate?.(result);
      fetchThreads();
    } catch {
      // 一覧を壊さない。ChatPage 側に例外を伝播させない。
    } finally {
      setCreating(false);
    }
  }, [projectId, creating, onCreate, fetchThreads]);

  /** スレッド切替 */
  const handleSelect = useCallback(async (sessionId: string) => {
    if (sessionId === currentSessionId || switchingId) return;
    setSwitchingId(sessionId);
    try {
      const tabId = getTabId();
      const result = await sessionsApi.switchThread(sessionId, tabId);
      onSelect(result);
    } catch {
      // 失敗時は何もしない（切替前の状態を維持）
    } finally {
      setSwitchingId(null);
    }
  }, [currentSessionId, switchingId, onSelect]);

  /** 改名開始 */
  const startRename = useCallback((e: MouseEvent, sessionId: string, currentTitle: string | null) => {
    e.stopPropagation();
    setRenamingId(sessionId);
    setRenameValue(currentTitle ?? '');
  }, []);

  /** 改名確定 */
  const commitRename = useCallback(async (sessionId: string) => {
    const title = renameValue.trim();
    setRenamingId(null);
    if (!title) return;
    const prevItems = items;
    setItems((prev) => applyThreadRename(prev, sessionId, title));
    try {
      await sessionsApi.rename(sessionId, title);
    } catch {
      setItems(prevItems); // ロールバック
    }
  }, [renameValue, items]);

  if (collapsed) {
    return (
      <div className="hidden md:flex flex-col items-center w-8 shrink-0 border-r border-[var(--border-color)] bg-[var(--bg-secondary)] pt-2">
        <button
          onClick={onToggleCollapse}
          title={t('thread.expand')}
          className="text-[var(--text-muted)] hover:text-[var(--text-primary)] p-1"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 6l6 6-6 6" />
          </svg>
        </button>
      </div>
    );
  }

  return (
    <div className="w-56 h-full shrink-0 border-r border-[var(--border-color)] bg-[var(--bg-secondary)] flex flex-col z-[35] md:z-auto">
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border-color)]">
        <span className="text-xs font-semibold text-[var(--text-muted)]">{t('thread.panelTitle')}</span>
        <div className="flex items-center gap-1">
          <button
            onClick={handleCreate}
            disabled={!projectId || creating}
            className="text-xs px-2 py-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:opacity-50"
          >
            {creating ? t('thread.creating') : t('thread.new')}
          </button>
          {onToggleCollapse && (
            <button onClick={onToggleCollapse} title={t('thread.collapse')} className="text-[var(--text-muted)] hover:text-[var(--text-primary)] p-1">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 6l-6 6 6 6" />
              </svg>
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading && items.length === 0 && (
          <div className="px-3 py-4 text-xs text-[var(--text-faint)] text-center">{t('common.loading')}</div>
        )}
        {error && (
          <div className="px-3 py-4 text-xs text-center">
            <div className="text-[var(--text-faint)] mb-1">{t('thread.loadFailed')}</div>
            <button onClick={fetchThreads} className="text-[var(--text-muted)] hover:text-[var(--text-primary)] underline">
              {t('thread.retry')}
            </button>
          </div>
        )}
        {!loading && !error && items.length === 0 && (
          <div className="px-3 py-4 text-xs text-[var(--text-faint)] text-center">{t('thread.empty')}</div>
        )}
        {items.map((item) => {
          const label = deriveThreadLabel(item);
          const displayText = label.kind === 'fallback' ? t('thread.untitled') : label.text;
          const isActive = item.sessionId === currentSessionId;
          const isRenaming = renamingId === item.sessionId;
          return (
            <div
              key={item.sessionId}
              onClick={() => !isRenaming && handleSelect(item.sessionId)}
              className={`
                group px-3 py-2 border-b border-[var(--border-color)] cursor-pointer
                ${isActive ? 'bg-[var(--bg-selected)]' : 'hover:bg-[var(--bg-hover)]'}
                ${switchingId === item.sessionId ? 'opacity-60' : ''}
              `}
            >
              <div className="flex items-center justify-between gap-1">
                {isRenaming ? (
                  <input
                    ref={renameInputRef}
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={() => commitRename(item.sessionId)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); commitRename(item.sessionId); }
                      if (e.key === 'Escape') { e.preventDefault(); setRenamingId(null); }
                    }}
                    placeholder={t('thread.renamePlaceholder')}
                    className="flex-1 text-xs bg-[var(--bg-primary)] border border-[var(--border-color)] rounded px-1 py-0.5 text-[var(--text-primary)] min-w-0"
                  />
                ) : (
                  <span className={`text-xs truncate flex-1 ${isActive ? 'font-semibold text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'}`}>
                    {displayText}
                  </span>
                )}
                {!isRenaming && (
                  <button
                    onClick={(e) => startRename(e, item.sessionId, item.title)}
                    title={t('thread.rename')}
                    className="opacity-0 group-hover:opacity-100 text-[var(--text-faint)] hover:text-[var(--text-primary)] shrink-0"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z" />
                    </svg>
                  </button>
                )}
              </div>
              <div className="flex items-center gap-1.5 mt-1">
                {isDefaultThread(item) && (
                  <span className="text-[10px] px-1 rounded bg-[var(--bg-hover)] text-[var(--text-faint)]">{t('thread.default')}</span>
                )}
                {!projectId && (
                  <span className="text-[10px] px-1 rounded bg-[var(--bg-hover)] text-[var(--text-faint)] truncate">{item.projectName}</span>
                )}
                <span className="text-[10px] text-[var(--text-faint)] ml-auto shrink-0">
                  {formatRelativeTime(item.lastActiveAt, locale, t('thread.timeJustNow'))}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
