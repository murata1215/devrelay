import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  projects as projectsApi,
  machines as machinesApi,
  sessions as sessionsApi,
  threads as threadsApi,
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
  sortProjectSelectorOptions,
  resolveThreadProjectView,
  filterProjectsByLiveMachines,
  shouldShowApprovalCard,
  decideSendAction,
  resolveComposerPlaceholderReason,
  decideProjectSelectorUrl,
  shouldShowNewThreadNotice,
  buildThreadCreateRequest,
  resolveSendInFlight,
  resolveConfirmationOnProjectChange,
  decideThreadListRefresh,
  upsertApproval,
  removeApproval,
  markApprovalResponded,
  selectVisibleApprovals,
  canRespondToApproval,
  decideApprovalRespond,
  type LiteApprovalEntry,
} from '../components/lite/lite-shell-rules';
import { decideInboundDisplay } from '../lib/thread-routing-client';
import { appendMessage, mergeHistory, type LiteMessage } from '../lib/lite-message-log';
import { appendOutbox, removeOutbox, composeDisplayMessages, type OutboxEntry } from '../lib/lite-outbox';
import { useWebSocket, type ToolApprovalPrompt, type ToolApprovalResolved } from '../hooks/useWebSocket';

/** REST 履歴取得の 1 回あたり件数。`lite-message-log.ts` の `MAX_LOG_SIZE`（50）と揃える。 */
const HISTORY_FETCH_LIMIT = 50;

/**
 * Lite シェル L4: 送信 + 新規スレッド（+ L3 手直し）。
 *
 * 参照プラン `~/.claude/plans/enchanted-bouncing-kitten.md`。L3 の設計判断（S1〜S5）は
 * プラン本文・過去の JSDoc を参照（結論のみ短く残す）。
 *
 * **S1（最重要）**: スレッド選択時は必ず `sessionsApi.switchThread(sessionId, tabId)`（REST）を呼ぶ。
 * サーバーの配信はユーザー単位ではなく `sessionParticipants`（chatId = `web:${userId}:${tabId}`）
 * 単位のため、switch を呼ばないタブには WS メッセージが一切届かない（エラーも出ない）。
 *
 * **S2**: 参加登録は「選択時」ではなく「`connected` の立ち上がりエッジ」で発行する
 * （E2 の依存配列 `[connected, selectedSessionId, tabId]`）。
 *
 * **絶対規則**: `tabId` はマウント時にメモリ生成し（`crypto.randomUUID()`、永続化しない）、
 * `useWebSocket` と `sessionsApi.switchThread()` の**両方に同一値**を渡す。
 *
 * **S3（A2）**: `GET /api/projects` を情報源のまま維持し、`GET /api/machines` の id 集合を
 * 生存マシンの許可リストとして交差させる（`filterProjectsByLiveMachines`）。
 *
 * **S4（A3）**: 並び順は `ThreadList`/サーバーが既に `lastActiveAt desc` で解決済み。
 *
 * **S5（B7 からの方針転換）**: `readOnly` は解除しない。`onLocalSelect` を受けた本コンポーネントが
 * switch の唯一の所有者になる（L4 でも「＋新規」は `onRequestCreate` 経由で本コンポーネントに残す）。
 *
 * ---
 *
 * **L4 追加分**:
 *
 * **R1/R2（送信の核心的な難所）**: `apps/server/src/platforms/web.ts` の `web:user_message`
 * broadcast は送信者自身の chatId を除外するため、Lite タブは自分の発言を WS 経由で二度と
 * 受け取らない。かつ `mergeHistory('replace' | 'refresh')` は history が空だと live 専用エントリを
 * 消してしまう。そのため楽観的表示を `messages` の外側（`lib/lite-outbox.ts`）に保持し、
 * `composeDisplayMessages()` でレンダー時に純粋合成する（B5 の dedupe はここで完結する）。
 *
 * **F1（既存スレッドへの意図しない合流）対策**: 選択中スレッドの「実際の」プロジェクト ID は
 * `threadProjectConfirmation` state で追跡する。情報源は 2 つ（どちらもサーバー確認済みの値のみ）:
 * (1) スレッド一覧のクリック（`handleLocalSelect`、`ThreadSummary.projectId` は
 * `GET /api/threads` のサーバー応答）、(2) `sessionsApi.switchThread()` の応答
 * （`ThreadSwitchResult.projectId`）。両方とも `sendCommand` の `projectId` ヒント（F1 の罠）は
 * 一切使わない。未確認（例: 別セッションからの直後の切替でまだ応答が来ていない、深いリンクでの
 * 初回ロード直後）の間は `resolvedSelectedThreadProjectId` が `null` になり、
 * `decideSendAction()` は「不一致（mismatch）」側に倒れて `create-then-send` を選ぶ
 * （fail-safe: 誤って既存スレッドに合流するより、稀に不要な新規スレッドを作るほうが安全）。
 *
 * **A3**: プロジェクトセレクタを変更すると `decideProjectSelectorUrl()` が別プロジェクトの場合
 * `session` を URL から取り除く。これにより「セレクタ変更後に選択スレッドと選択プロジェクトが
 * 食い違う」状態はアプリ内操作だけでは発生しない（深いリンクの初回ロード時のみ、上記の
 * fail-safe に委ねる）。
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
  /** R5 fail-closed の唯一の例外（`shouldShowApprovalCard`）を通過したカードのみ保持する。
   * L5: requestId キーの `Map` にして同時複数件を保持する（単数 state だと 2 件目到着で
   * 1 件目が消えていた）。描画時にも `selectVisibleApprovals()` で同じ述語を再適用する
   * （§16、下記 `approvalList` 参照）。 */
  const [approvals, setApprovals] = useState<ReadonlyMap<string, LiteApprovalEntry>>(new Map());

  /** L4 B0: 送信中・未確定の自分の発言。表示は `composeDisplayMessages()` がレンダー時に合成する
   * （`messages` state へは書き戻さない）。 */
  const [outbox, setOutbox] = useState<readonly OutboxEntry[]>([]);
  /** L4 送信欄の本文（Composer は状態を持たないため、ここで保持する）。 */
  const [composerBody, setComposerBody] = useState('');
  /** L4 送信中フラグ（Composer のボタン表示・`decideSendAction` の `inFlight` に使う）。 */
  const [sending, setSending] = useState(false);
  /** B4: 「＋新規」ボタン専用の作成中フラグ（`ThreadList` の `createInFlight` にそのまま渡す）。
   * `sending`（送信中）とは独立: 「＋新規」は作成のみで送信しないため、送信フラグを流用すると
   * 無関係な送信中表示と混線する。 */
  const [creatingThread, setCreatingThread] = useState(false);
  /** L4 F1 対策: 選択中スレッドの「サーバー確認済み」プロジェクト ID。`sessionId` が
   * `selectedSessionId` と一致するときのみ有効（他セッションへ切り替わったら自動的に無効化）。 */
  const [threadProjectConfirmation, setThreadProjectConfirmation] = useState<{ sessionId: string; projectId: string } | null>(null);
  /** L4.1: `creatingThread` state のミラー。`handleSend` が非同期な state 更新を跨いで同期的に
   * 読む必要があるため（`sendingRef` と同じ流儀）。`setCreatingThread` を呼ぶ箇所では必ずここも
   * 同時に更新する。 */
  const creatingThreadRef = useRef(false);
  /** L4.1: `handleProjectChange` で最後に要求されたプロジェクト ID。react-router-dom v7 の
   * `BrowserRouter` は URL 更新を `React.startTransition` でラップし低優先度になるため、
   * URL 由来の `selectedProjectId` が追いつくまでの間 `resolveSendInFlight()` の project 軸判定に使う
   * （state ではなく ref: 通常優先度で即座に読み書きできる必要があるため）。 */
  const requestedProjectIdRef = useRef<string | null>(null);

  /** tabId: マウント時にメモリ生成のみ（`localStorage`/`sessionStorage` は一切使わない）。 */
  const tabIdRef = useRef<string | null>(null);
  if (tabIdRef.current === null) {
    tabIdRef.current = crypto.randomUUID();
  }
  const tabId = tabIdRef.current;

  /** E2 の switch 呼び出しと L4 の送信操作を直列化する promise チェーン。A→B と素早く切り替えたとき
   * 到着順が入れ替わってサーバーの `currentSessionId` が古いまま残るのを防ぐ（B3: 作成・切替・送信も
   * このチェーンの中で行う）。 */
  const switchChainRef = useRef<Promise<void>>(Promise.resolve());

  /** WS コールバックは `useWebSocket` の内部 `connect` の外（`onmessage`）から常に最新の
   * 選択状態を見る必要があるため、レンダーごとに最新の選択状態を ref に反映する。 */
  const viewRef = useRef({ sessionId: selectedSessionId, projectId: selectedProjectId });
  viewRef.current = { sessionId: selectedSessionId, projectId: selectedProjectId };

  /** 送信の二重発火防止（React state 更新の非同期性を跨いで即座に判定する必要があるため ref を使う。
   * classic `ChatPage.tsx` の `sendingRef` と同じ流儀）。 */
  const sendingRef = useRef(false);

  /** L5 D4: 承認応答の二重送信防止。`entry.status` は `setState` 経由の非同期反映のため同一 tick の
   * 2 回目クリックには古い値のまま見える。`sendingRef` と同じ流儀で同期的な ref を使う。 */
  const respondedRef = useRef<Set<string>>(new Set());
  /** L5 D3: `sendToolApprovalResponse` は WS が OPEN でないと無言で `return` する（戻り値なし）ため、
   * 応答可否判定に `connected` を含める。WS コールバックと同じ理由でレンダーごとに ref へ反映する。 */
  const connectedRef = useRef(false);

  // ---------------------------------------------------------------------
  // L4.1: スレッド一覧（ThreadList）の自動再取得。ポーリングはしない。
  // classic `ChatPage.tsx` の `threadRefreshToken`（:2465/:2480）と同じ「トークンを増やして
  // ThreadList 側の useEffect を再実行させる」方式を踏襲する。
  // ---------------------------------------------------------------------
  const [threadRefreshToken, setThreadRefreshToken] = useState(0);
  /** 直近に実際に再取得を実行した時刻（`decideThreadListRefresh` の入力）。 */
  const lastThreadRefreshAtRef = useRef<number | null>(null);
  /** trailing 用に仕込んだタイマー（二重スケジュール防止 + アンマウント時のクリーンアップ用）。 */
  const threadRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** 一覧再取得トリガー（201後・送信成功後・WS受信時・タブ復帰時）の唯一の入口。
   * `decideThreadListRefresh()` の判定に従い、即時実行 or trailing スケジュール or 何もしない。 */
  const requestThreadRefresh = useCallback(() => {
    const decision = decideThreadListRefresh({
      now: Date.now(),
      lastRefreshAt: lastThreadRefreshAtRef.current,
      pendingTimer: threadRefreshTimerRef.current !== null,
    });
    if (decision.kind === 'refresh-now') {
      lastThreadRefreshAtRef.current = Date.now();
      setThreadRefreshToken((c) => c + 1);
    } else if (decision.kind === 'schedule') {
      threadRefreshTimerRef.current = setTimeout(() => {
        threadRefreshTimerRef.current = null;
        lastThreadRefreshAtRef.current = Date.now();
        setThreadRefreshToken((c) => c + 1);
      }, decision.delayMs);
    }
    // 'skip' のときは何もしない（既に trailing タイマーが仕込まれている）
  }, []);

  // アンマウント時に trailing タイマーを掃除する（メモリリーク・アンマウント後の setState 防止）。
  useEffect(() => {
    return () => {
      if (threadRefreshTimerRef.current) {
        clearTimeout(threadRefreshTimerRef.current);
        threadRefreshTimerRef.current = null;
      }
    };
  }, []);

  // タブ復帰時（visibilitychange/focus）の再取得。classic タブでの操作は Lite の chatId とは
  // 別参加者のため WS 経由では届かない（E2E-C）。ポーリングではなく、実際の復帰イベント駆動。
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') requestThreadRefresh();
    };
    const handleFocus = () => requestThreadRefresh();
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('focus', handleFocus);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('focus', handleFocus);
    };
  }, [requestThreadRefresh]);

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
      // L4.1 項目2: 選択中スレッド以外宛のメッセージでも一覧の lastActiveAt/タイトルは変わりうるため、
      // 表示可否の判定（decideInboundDisplay の early-return）より前で一覧再取得を要求する。
      requestThreadRefresh();
      const decision = decideInboundDisplay({
        payloadSessionId: sessionId,
        tabSessionId: viewRef.current.sessionId,
        payloadProjectId: projectId,
        tabProjectId: viewRef.current.projectId,
      });
      if (!decision.display) return;
      setMessages((prev) => appendMessage(prev, { role: msg.role, content: msg.content, messageId: msg.messageId }, Date.now()));
    },
    [requestThreadRefresh]
  );

  /** L5: 到着時ゲートは §5 の fail-closed 述語を一字一句そのまま維持する。通過後は D5 に従い
   * `respondedRef` からも削除する（サーバー再送＝まだ pending が権威。楽観的な応答済み扱いを
   * リセットしないと、送信が実際には届いていなかった場合に二度と応答できなくなる）。 */
  const handleToolApproval = useCallback((prompt: ToolApprovalPrompt) => {
    if (!shouldShowApprovalCard({ viewSessionId: viewRef.current.sessionId, payloadSessionId: prompt.sessionId })) return;
    respondedRef.current.delete(prompt.requestId);
    setApprovals((prev) => upsertApproval(prev, prompt));
  }, []);

  /** 後始末（カードを閉じる）の唯一の入口。`respondedRef` と `approvals` state を必ず同時に掃除する。 */
  const forgetApproval = useCallback((id: string) => {
    respondedRef.current.delete(id);
    setApprovals((prev) => removeApproval(prev, id));
  }, []);

  const handleToolApprovalResolved = useCallback((resolved: ToolApprovalResolved) => {
    forgetApproval(resolved.requestId);
  }, [forgetApproval]);

  /** L4.1 項目2: `web:session_info` 受信時は一覧再取得のみ行う。**`setSearchParams` は絶対に呼ばない**
   * （`session_info → setSearchParams → E2 → switchThread → session_info` の無限ループになるため）。 */
  const handleSessionInfo = useCallback(() => {
    requestThreadRefresh();
  }, [requestThreadRefresh]);

  /** L4.1 項目2: 再接続時（WS 瞬断からの復帰）も一覧が古いままになりうるため再取得する。 */
  const handleReconnect = useCallback(() => {
    requestThreadRefresh();
  }, [requestThreadRefresh]);

  const { connected, sendCommand, sendToolApprovalResponse } = useWebSocket(
    {
      onMessage: handleMessage,
      onToolApproval: handleToolApproval,
      onToolApprovalResolved: handleToolApprovalResolved,
      onSessionInfo: handleSessionInfo,
      onReconnect: handleReconnect,
    },
    { tabId }
  );
  // L5 D3: レンダーごとに最新の接続状態を ref へ反映する（`viewRef` と同じ理由）。
  connectedRef.current = connected;

  /** L5: 承認/拒否ボタンのクリック。`decideApprovalRespond()`（純関数）が可否を判定し、
   * `send` のときだけ実際に `sendToolApprovalResponse` を呼ぶ。D2: 2000ms タイマーは移植しない
   * （`resolved` 受信で `forgetApproval` が呼ばれてカードが閉じるのを待つのみ）。 */
  const handleApprovalRespond = useCallback(
    (requestId: string, isQuestion: boolean | undefined, behavior: 'allow' | 'deny') => {
      const decision = decideApprovalRespond(
        { requestId, isQuestion, alreadySent: respondedRef.current.has(requestId), connected: connectedRef.current },
        behavior
      );
      if (decision.kind !== 'send') return;
      respondedRef.current.add(decision.requestId);
      sendToolApprovalResponse(decision.requestId, decision.behavior);
      setApprovals((prev) => markApprovalResponded(prev, decision.requestId, decision.behavior));
    },
    [sendToolApprovalResponse]
  );

  // ---------------------------------------------------------------------
  // E2 実装本体: 参加登録（S1/S2）。成功したら threadProjectConfirmation も更新する（F1 対策）。
  // ---------------------------------------------------------------------
  useEffect(() => {
    if (!connected || !selectedSessionId) return;
    // `selectedSessionId` は const（上の searchParams.get('session') 由来）のため、この effect 実行内で
    // 閉じたクロージャは常にこの時点の値を指す（TS の narrowing もネストしたアロー関数まで有効）。
    switchChainRef.current = switchChainRef.current
      .then(() => sessionsApi.switchThread(selectedSessionId, tabId))
      .then((result) => {
        setHistoryEpoch((e) => e + 1);
        setThreadProjectConfirmation({ sessionId: selectedSessionId, projectId: result.projectId });
      })
      .catch(() => {
        // 1 回の失敗でチェーンが永久に詰まらないよう握りつぶす
      });
  }, [connected, selectedSessionId, tabId]);

  // ---------------------------------------------------------------------
  // E3: 履歴取得。`connected` を依存に入れない（瞬断のたびに再取得ループになるため）。
  // L4: セッションが切り替わったら（`!isSameSession`）fetch 完了を待たず同期的に `messages` を
  // 空にする（B-x: 前スレッドの本文が新スレッドの表示と一瞬混ざるのを防ぐ。描画ゲートを
  // `historyLoading` の有無から `displayMessages.length` ベースへ変えたことに伴う手当て）。
  // ---------------------------------------------------------------------
  const historySeqRef = useRef(0);
  const prevSessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    const isSameSession = prevSessionIdRef.current === selectedSessionId;
    prevSessionIdRef.current = selectedSessionId;

    if (!isSameSession) {
      setMessages([]);
    }

    if (!selectedSessionId) {
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
  /** A1: マシン名 → プロジェクト名の順で安定ソート（`buildProjectSelectorOptions` 自体は
   * API 返り順保持のまま無変更、ソートは呼び出し側の責務）。 */
  const projectOptions = sortProjectSelectorOptions(buildProjectSelectorOptions(liveProjects));

  /** S5: `readOnly` を維持したまま、行クリックは URL 更新のみを行う。`switchThread` の発行は
   * 上の E2 が `selectedSessionId` の変化を検知して一元的に行う（switch の所有者を単一化する）。
   * A3 前半（クリック時にプロジェクトセレクタも同期する）は元々 `item.projectId` を URL に
   * 書いていたことで満たされている。L4: `threadProjectConfirmation` も同時に更新する
   * （`ThreadSummary.projectId` はサーバー応答なので信頼できる。F1 対策の即時確定）。 */
  const handleLocalSelect = useCallback((item: ThreadSummary) => {
    setThreadProjectConfirmation({ sessionId: item.sessionId, projectId: item.projectId });
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('project', item.projectId);
      next.set('session', item.sessionId);
      return next;
    });
  }, [setSearchParams]);

  /** A3 後半: プロジェクトセレクタ変更時、別プロジェクトなら選択中スレッドを URL から外す
   * （`decideProjectSelectorUrl`）。L4.1: `requestedProjectIdRef` を即座に更新し（`resolveSendInFlight`
   * の project 軸判定用）、`threadProjectConfirmation` が別プロジェクトの古い値のままにならないよう
   * `resolveConfirmationOnProjectChange` で揃える（これが無いと切替後に送信が永久ブロックされる）。 */
  const handleProjectChange = useCallback((projectId: string) => {
    requestedProjectIdRef.current = projectId;
    setThreadProjectConfirmation((prev) => resolveConfirmationOnProjectChange(prev, projectId));
    setSearchParams((prev) => {
      const current = decideProjectSelectorUrl({
        currentProjectId: prev.get('project'),
        currentSessionId: prev.get('session'),
        nextProjectId: projectId,
      });
      const next = new URLSearchParams(prev);
      if (current.project) next.set('project', current.project); else next.delete('project');
      if (current.session) next.set('session', current.session); else next.delete('session');
      return next;
    });
  }, [setSearchParams]);

  const resolveProjectLabel = useCallback((projectId: string, fallbackName: string) => {
    return resolveThreadProjectView({ projectId, projects: projectsById, fallbackProjectName: fallbackName }).projectLabel;
  }, [projectsById]);

  /** F1 対策: 選択中スレッドの「サーバー確認済み」プロジェクト ID。未確認（別セッション用の値が
   * 残っている・まだ応答が来ていない）なら `null`（`decideSendAction` は不一致側に倒れる）。 */
  const resolvedSelectedThreadProjectId =
    threadProjectConfirmation && threadProjectConfirmation.sessionId === selectedSessionId
      ? threadProjectConfirmation.projectId
      : null;

  const selectedProjectOnline = selectedProjectId
    ? resolveThreadProjectView({ projectId: selectedProjectId, projects: projectsById }).online
    : false;

  const currentSendAction = decideSendAction({
    selectedSessionId,
    selectedThreadProjectId: resolvedSelectedThreadProjectId,
    selectedProjectId,
    tabId,
    machineOnline: selectedProjectOnline,
    connected,
    hasText: composerBody.trim().length > 0,
    hasFiles: false,
    inFlight: resolveSendInFlight({
      sending,
      creatingThread,
      confirmationSessionId: threadProjectConfirmation ? threadProjectConfirmation.sessionId : null,
      urlSessionId: selectedSessionId,
      requestedProjectId: requestedProjectIdRef.current,
      urlProjectId: selectedProjectId,
    }),
  });
  const sendDisabled = currentSendAction.kind === 'blocked';
  const placeholderReason = resolveComposerPlaceholderReason(
    currentSendAction.kind === 'blocked' ? currentSendAction.reason : null
  );
  const showNewThreadNotice = shouldShowNewThreadNotice({
    selectedProjectId,
    selectedSessionId,
    selectedThreadProjectId: resolvedSelectedThreadProjectId,
  });
  const newThreadNoticeProjectLabel =
    showNewThreadNotice && selectedProjectId ? resolveProjectLabel(selectedProjectId, '') : null;

  /**
   * B2/B3: 送信操作。`decideSendAction()` の結果に従い、既存スレッドへの送信（B2）または
   * 新規スレッド作成 + 送信（B3）を行う。B3 は `switchChainRef` の中で直列化し、E2（参加登録）と
   * 到着順が入れ替わらないようにする。R1/R2: 送信直後に自分の発言を outbox へ積み、WS の
   * 自己エコーが無くても `composeDisplayMessages()` で表示されるようにする（B5）。
   */
  const handleSend = useCallback(() => {
    if (sendingRef.current) return;
    const text = composerBody.trim();
    const inFlight = resolveSendInFlight({
      sending: sendingRef.current,
      creatingThread: creatingThreadRef.current,
      confirmationSessionId: threadProjectConfirmation ? threadProjectConfirmation.sessionId : null,
      urlSessionId: selectedSessionId,
      requestedProjectId: requestedProjectIdRef.current,
      urlProjectId: selectedProjectId,
    });
    const action = decideSendAction({
      selectedSessionId,
      selectedThreadProjectId: resolvedSelectedThreadProjectId,
      selectedProjectId,
      tabId,
      machineOnline: selectedProjectOnline,
      connected,
      hasText: text.length > 0,
      hasFiles: false,
      inFlight,
    });
    if (action.kind === 'blocked') return;

    sendingRef.current = true;
    setSending(true);

    const clientId = crypto.randomUUID();
    const originalBody = composerBody;
    const knownMessageIds = messages.filter((m) => m.messageId).map((m) => m.messageId as string);

    switchChainRef.current = switchChainRef.current
      .then(async () => {
        let targetSessionId: string;
        let targetProjectId: string;

        if (action.kind === 'create-then-send') {
          const result = await threadsApi.create(action.request);
          targetSessionId = result.sessionId;
          targetProjectId = result.projectId;
          requestThreadRefresh();
          setThreadProjectConfirmation({ sessionId: targetSessionId, projectId: targetProjectId });
          setSearchParams((prev) => {
            const next = new URLSearchParams(prev);
            next.set('project', targetProjectId);
            next.set('session', targetSessionId);
            return next;
          });
          // R8/B3: 201 が同期点（サーバーは既に switchChatToThread 済み）。E2 も
          // `selectedSessionId` の変化を検知して冪等に switchThread を呼ぶが、ここでも明示的に
          // 待って直後の送信の一貫性を保つ（B4 の tabId 絶対規則: 同一 tabId で呼ぶ）。
          await sessionsApi.switchThread(targetSessionId, tabId);
        } else {
          targetSessionId = action.sessionId;
          targetProjectId = action.sendProjectIdHint;
        }

        setOutbox((prev) => appendOutbox(prev, {
          clientId,
          sessionId: targetSessionId,
          content: text,
          createdAtMs: Date.now(),
          knownMessageIds,
        }));

        // R3: projectId ヒントは渡さない（F1 の罠。既に switchThread でサーバー文脈は確定済み）。
        const ok = sendCommand(text);
        if (!ok) {
          setOutbox((prev) => removeOutbox(prev, clientId));
          setComposerBody(originalBody);
        } else {
          setComposerBody('');
          // L4.1 項目2: 送信成功後は一覧の lastActiveAt/タイトルが変わるため再取得を要求する。
          requestThreadRefresh();
        }
      })
      .catch(() => {
        setOutbox((prev) => removeOutbox(prev, clientId));
      })
      .finally(() => {
        sendingRef.current = false;
        setSending(false);
      });
  }, [composerBody, selectedSessionId, resolvedSelectedThreadProjectId, selectedProjectId, tabId, selectedProjectOnline, connected, messages, sendCommand, setSearchParams, threadProjectConfirmation, requestThreadRefresh]);

  /** B4: 「＋新規」ボタン。B3 と同じ経路（作成のみ。送信はしない）。作成リクエストは B3 と同じ唯一の
   * factory `buildThreadCreateRequest()` を通す（R8: tabId 必須を型と実行時の両方で保証する）。 */
  const handleRequestCreate = useCallback((projectId: string) => {
    const request = buildThreadCreateRequest({ projectId, tabId });
    if (!request) return; // tabId は常に非空のはずだが、型の整合のためフォールバックする
    creatingThreadRef.current = true;
    setCreatingThread(true);
    switchChainRef.current = switchChainRef.current
      .then(async () => {
        const result = await threadsApi.create(request);
        // L4.1 項目2: 201 直後に一覧再取得を要求する（項目1: これにより直後の送信は
        // resolveSendInFlight() の「URL 未追従」窓を経てから send-existing に落ち着く）。
        requestThreadRefresh();
        setThreadProjectConfirmation({ sessionId: result.sessionId, projectId: result.projectId });
        setSearchParams((prev) => {
          const next = new URLSearchParams(prev);
          next.set('project', result.projectId);
          next.set('session', result.sessionId);
          return next;
        });
        await sessionsApi.switchThread(result.sessionId, tabId);
      })
      .catch(() => {
        // 一覧を壊さない。ThreadList 側にも例外を伝播させない。
      })
      .finally(() => {
        creatingThreadRef.current = false;
        setCreatingThread(false);
      });
  }, [tabId, setSearchParams, requestThreadRefresh]);

  const displayMessages = composeDisplayMessages(messages, outbox, selectedSessionId);
  /** L5: §5 の fail-closed 述語（`shouldShowApprovalCard` 経由）を描画時にも再適用する。到着時ゲート
   * だけだと、スレッド A を見ている間に届いたカードが B へ切替後も残り続けてしまう（申し送り済みの
   * 既知の穴を今回はここで塞ぐ。新しいゲートは作らず既存述語の適用箇所を増やすだけ）。 */
  const approvalList = selectVisibleApprovals(approvals, selectedSessionId);

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
          onRequestCreate={handleRequestCreate}
          createInFlight={creatingThread}
          refreshToken={threadRefreshToken}
          /* L3 でも readOnly のため呼ばれない（S5）。将来 L5 で差し替える。 */
          onSelect={() => {}}
        />
        <div className="flex-1 flex flex-col min-w-0 min-h-0">
          {!selectedSessionId ? (
            <div className="flex-1 flex items-center justify-center px-4">
              <div className="text-sm text-[var(--text-faint)] text-center">{t('lite.emptyState')}</div>
            </div>
          ) : (
            <>
              {historyLoadFailed && (
                <div className="px-4 py-1 text-xs text-[var(--text-danger)] text-center shrink-0">
                  {t('lite.historyLoadFailed')}
                </div>
              )}
              {displayMessages.length === 0 && historyLoading ? (
                <div className="flex-1 flex items-center justify-center px-4">
                  <div className="text-sm text-[var(--text-faint)] text-center">{t('lite.historyLoading')}</div>
                </div>
              ) : (
                <LiteMessageList messages={displayMessages} />
              )}
            </>
          )}
          {approvalList.length > 0 && (
            <div className="shrink-0 max-h-[40vh] overflow-y-auto">
              {approvalList.map((entry) => (
                <LiteApprovalCard
                  key={entry.requestId}
                  prompt={entry}
                  status={entry.status}
                  onRespond={
                    canRespondToApproval(entry)
                      ? (behavior) => handleApprovalRespond(entry.requestId, entry.isQuestion, behavior)
                      : undefined
                  }
                />
              ))}
            </div>
          )}
          <LiteComposer
            options={projectOptions}
            selectedProjectId={selectedProjectId}
            onProjectChange={handleProjectChange}
            projectsLoading={projectsLoading}
            projectsLoadFailed={projectsLoadFailed}
            body={composerBody}
            onBodyChange={setComposerBody}
            onSend={handleSend}
            placeholderReason={placeholderReason}
            sendDisabled={sendDisabled}
            sending={sending || creatingThread}
            newThreadNoticeProjectLabel={newThreadNoticeProjectLabel}
          />
        </div>
      </div>
    </div>
  );
}
