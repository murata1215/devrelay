import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  projects as projectsApi,
  machines as machinesApi,
  sessions as sessionsApi,
  type Project,
  type ThreadSummary,
} from '../lib/api';
import { useLanguage } from '../contexts/LanguageContext';
import { LiteHeader } from '../components/lite/LiteHeader';
import { LiteComposer } from '../components/lite/LiteComposer';
import { LiteMessageList } from '../components/lite/LiteMessageList';
import { LiteApprovalCard } from '../components/lite/LiteApprovalCard';
import { ThreadList } from '../components/ThreadList';
import {
  buildProjectSelectorOptions,
  resolveThreadProjectView,
  filterProjectsByLiveMachines,
  shouldShowApprovalCard,
} from '../components/lite/lite-shell-rules';
import { decideInboundDisplay } from '../lib/thread-routing-client';
import { appendMessage, mergeHistory, type LiteMessage } from '../lib/lite-message-log';
import { useWebSocket, type ToolApprovalPrompt, type ToolApprovalResolved } from '../hooks/useWebSocket';

/** REST 履歴取得の 1 回あたり件数。`lite-message-log.ts` の `MAX_LOG_SIZE`（50）と揃える。 */
const HISTORY_FETCH_LIMIT = 50;

/**
 * Lite シェル L3: WS 接続 + メッセージ読み取り。
 *
 * 参照プラン `~/.claude/plans/refactored-cooking-thunder.md`。設計判断の根拠（S1〜S5）は
 * プラン本文を参照（このファイルには結論のみを短く残す）。
 *
 * **S1（最重要）**: スレッド選択時は必ず `sessionsApi.switchThread(sessionId, tabId)`（REST）を呼ぶ。
 * サーバーの配信はユーザー単位ではなく `sessionParticipants`（chatId = `web:${userId}:${tabId}`）
 * 単位のため、switch を呼ばないタブには WS メッセージが一切届かない（エラーも出ない）。
 *
 * **S2**: 参加登録は「選択時」ではなく「`connected` の立ち上がりエッジ」で発行する
 * （E2 の依存配列 `[connected, selectedSessionId, tabId]`）。WS の close で
 * サーバーは chatId を全セッションの参加者から除去し、Lite は `//connect` で回復できないため。
 *
 * **絶対規則**: `tabId` はマウント時にメモリ生成し（`crypto.randomUUID()`、永続化しない）、
 * `useWebSocket` と `sessionsApi.switchThread()` の**両方に同一値**を渡す。食い違うと
 * 「参加登録は chatId B・ソケットは chatId A」となり、エラーを一切出さずに WS が無音になる。
 *
 * **S3（A2）**: `GET /api/projects` を情報源のまま維持し、`GET /api/machines` の id 集合を
 * 生存マシンの許可リストとして交差させる（`filterProjectsByLiveMachines`）。
 *
 * **S4（A3）**: 並び順は `ThreadList`/サーバーが既に `lastActiveAt desc` で解決済み。ここでは
 * プロジェクト未選択時も横断一覧を維持する（`ThreadList` に `projectId` を渡さない）。
 *
 * **S5（B7 からの方針転換）**: `readOnly` は解除しない。`onLocalSelect` を受けた本コンポーネントが
 * switch の唯一の所有者になる（`ThreadList` 自身が `switchThread` を呼ぶ経路を作らない）。
 */
export function LitePage() {
  const { t } = useLanguage();
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedProjectId = searchParams.get('project');
  const selectedSessionId = searchParams.get('session');

  const [projectsById, setProjectsById] = useState<ReadonlyMap<string, Project>>(new Map());
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectsLoadFailed, setProjectsLoadFailed] = useState(false);
  /** `null` = `/api/machines` 未取得・取得失敗（fail-open）。空の `Set` = 正常取得できて生存マシン
   * 0 件（fail-open にしない。`filterProjectsByLiveMachines` の意味論、人間の承認条件 1）。 */
  const [liveMachineIds, setLiveMachineIds] = useState<ReadonlySet<string> | null>(null);

  const [messages, setMessages] = useState<readonly LiteMessage[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyLoadFailed, setHistoryLoadFailed] = useState(false);
  /** E2（参加登録）成功後にインクリメントし、E3（履歴取得）を再実行させる（GET と参加登録成立の
   * 隙間に落ちたメッセージを埋めるための 'refresh' 再取得トリガー）。 */
  const [historyEpoch, setHistoryEpoch] = useState(0);
  /** R5 fail-closed の唯一の例外（`shouldShowApprovalCard`）を通過したカードのみ保持する。 */
  const [approvalPrompt, setApprovalPrompt] = useState<ToolApprovalPrompt | null>(null);

  /** tabId: マウント時にメモリ生成のみ（`localStorage`/`sessionStorage` は一切使わない）。
   * classic の `getTabId()`（sessionStorage 由来）とは構造的に別値になるため chatId 衝突は起きない。 */
  const tabIdRef = useRef<string | null>(null);
  if (tabIdRef.current === null) {
    tabIdRef.current = crypto.randomUUID();
  }
  const tabId = tabIdRef.current;

  /** E2 の switch 呼び出しを直列化する promise チェーン。A→B と素早く切り替えたとき POST の
   * 到着順が入れ替わってサーバーの `currentSessionId` が古いまま残るのを防ぐ。 */
  const switchChainRef = useRef<Promise<void>>(Promise.resolve());

  /** WS コールバックは `useWebSocket` の内部 `connect` の外（`onmessage`）から常に最新の
   * 選択状態を見る必要があるため、レンダーごとに最新の選択状態を ref に反映する。 */
  const viewRef = useRef({ sessionId: selectedSessionId, projectId: selectedProjectId });
  viewRef.current = { sessionId: selectedSessionId, projectId: selectedProjectId };

  // ---------------------------------------------------------------------
  // E1: projects + machines（マウント時 1 回）
  // ---------------------------------------------------------------------
  useEffect(() => {
    let active = true;
    projectsApi.list()
      .then((list) => {
        if (!active) return;
        setProjectsById(new Map(list.map((p) => [p.id, p])));
        setProjectsLoading(false);
      })
      .catch(() => {
        if (!active) return;
        setProjectsLoadFailed(true);
        setProjectsLoading(false);
      });
    machinesApi.list()
      .then((list) => {
        if (!active) return;
        setLiveMachineIds(new Set(list.map((m) => m.id)));
      })
      .catch(() => {
        // fail-open: liveMachineIds は null のまま（filterProjectsByLiveMachines がそのまま通す）
      });
    return () => { active = false; };
  }, []);

  const handleMessage = useCallback(
    (msg: { role: 'user' | 'system' | 'ai'; content: string; messageId?: string }, projectId?: string, sessionId?: string) => {
      const decision = decideInboundDisplay({
        payloadSessionId: sessionId,
        tabSessionId: viewRef.current.sessionId,
        payloadProjectId: projectId,
        tabProjectId: viewRef.current.projectId,
      });
      if (!decision.display) return;
      setMessages((prev) => appendMessage(prev, { role: msg.role, content: msg.content, messageId: msg.messageId }, Date.now()));
    },
    []
  );

  const handleToolApproval = useCallback((prompt: ToolApprovalPrompt) => {
    if (!shouldShowApprovalCard({ viewSessionId: viewRef.current.sessionId, payloadSessionId: prompt.sessionId })) return;
    setApprovalPrompt(prompt);
  }, []);

  const handleToolApprovalResolved = useCallback((resolved: ToolApprovalResolved) => {
    setApprovalPrompt((prev) => (prev && prev.requestId === resolved.requestId ? null : prev));
  }, []);

  const { connected } = useWebSocket(
    {
      onMessage: handleMessage,
      onToolApproval: handleToolApproval,
      onToolApprovalResolved: handleToolApprovalResolved,
    },
    { tabId }
  );

  // ---------------------------------------------------------------------
  // E2 実装本体: 参加登録（S1/S2）。
  // ---------------------------------------------------------------------
  useEffect(() => {
    if (!connected || !selectedSessionId) return;
    switchChainRef.current = switchChainRef.current
      .then(() => sessionsApi.switchThread(selectedSessionId, tabId))
      .then(() => {
        setHistoryEpoch((e) => e + 1);
      })
      .catch(() => {
        // 1 回の失敗でチェーンが永久に詰まらないよう握りつぶす
      });
  }, [connected, selectedSessionId, tabId]);

  // ---------------------------------------------------------------------
  // E3: 履歴取得。`connected` を依存に入れない（瞬断のたびに再取得ループになるため）。
  // ---------------------------------------------------------------------
  const historySeqRef = useRef(0);
  const prevSessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    const isSameSession = prevSessionIdRef.current === selectedSessionId;
    prevSessionIdRef.current = selectedSessionId;

    if (!selectedSessionId) {
      setMessages([]);
      setHistoryLoading(false);
      setHistoryLoadFailed(false);
      return;
    }

    const seq = ++historySeqRef.current;
    setHistoryLoading(true);
    setHistoryLoadFailed(false);
    sessionsApi.getMessages(selectedSessionId, { limit: HISTORY_FETCH_LIMIT })
      .then(({ messages: history }) => {
        if (historySeqRef.current !== seq) return; // stale 応答破棄
        const normalized: LiteMessage[] = history.map((m) => ({
          role: m.role === 'ai' ? 'system' : m.role,
          content: m.content,
          timestampMs: Date.parse(m.createdAt),
          messageId: m.id,
        }));
        const mode = isSameSession ? 'refresh' : 'replace';
        setMessages((prev) => mergeHistory(prev, normalized, mode, Date.now()));
        setHistoryLoading(false);
      })
      .catch(() => {
        if (historySeqRef.current !== seq) return;
        setHistoryLoadFailed(true);
        setHistoryLoading(false);
      });
  }, [selectedSessionId, historyEpoch]);

  const liveProjects = filterProjectsByLiveMachines(Array.from(projectsById.values()), liveMachineIds);
  const projectOptions = buildProjectSelectorOptions(liveProjects);

  /** S5: `readOnly` を維持したまま、行クリックは URL 更新のみを行う。`switchThread` の発行は
   * 上の E2 が `selectedSessionId` の変化を検知して一元的に行う（switch の所有者を単一化する）。 */
  const handleLocalSelect = useCallback((item: ThreadSummary) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('project', item.projectId);
      next.set('session', item.sessionId);
      return next;
    });
  }, [setSearchParams]);

  const handleProjectChange = useCallback((projectId: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (projectId) {
        next.set('project', projectId);
      } else {
        next.delete('project');
      }
      return next;
    });
  }, [setSearchParams]);

  const resolveProjectLabel = useCallback((projectId: string, fallbackName: string) => {
    return resolveThreadProjectView({ projectId, projects: projectsById, fallbackProjectName: fallbackName }).projectLabel;
  }, [projectsById]);

  return (
    <div className="lite-root h-screen flex flex-col bg-[var(--bg-primary)]">
      <LiteHeader connected={connected} />
      <div className="flex-1 flex min-h-0">
        <ThreadList
          currentSessionId={selectedSessionId}
          readOnly
          onLocalSelect={handleLocalSelect}
          resolveProjectLabel={resolveProjectLabel}
          createProjectId={selectedProjectId ?? undefined}
          /* L3 でも readOnly のため呼ばれない（S5）。将来 L4/L5 で差し替える。 */
          onSelect={() => {}}
        />
        <div className="flex-1 flex flex-col min-w-0">
          {!selectedSessionId ? (
            <div className="flex-1 flex items-center justify-center px-4">
              <div className="text-sm text-[var(--text-faint)] text-center">{t('lite.emptyState')}</div>
            </div>
          ) : historyLoading ? (
            <div className="flex-1 flex items-center justify-center px-4">
              <div className="text-sm text-[var(--text-faint)] text-center">{t('lite.historyLoading')}</div>
            </div>
          ) : historyLoadFailed ? (
            <div className="flex-1 flex items-center justify-center px-4">
              <div className="text-sm text-[var(--text-danger)] text-center">{t('lite.historyLoadFailed')}</div>
            </div>
          ) : (
            <LiteMessageList messages={messages} />
          )}
          {approvalPrompt && <LiteApprovalCard prompt={approvalPrompt} />}
          <LiteComposer
            options={projectOptions}
            selectedProjectId={selectedProjectId}
            onProjectChange={handleProjectChange}
            projectsLoading={projectsLoading}
            projectsLoadFailed={projectsLoadFailed}
          />
        </div>
      </div>
    </div>
  );
}
