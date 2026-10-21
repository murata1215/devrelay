import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { threads as threadsApi, sessions as sessionsApi, type ThreadSummary } from '../lib/api';
import {
  CONVERSATION_RAIL_LIMIT,
  CONVERSATION_RAIL_POLL_MS,
  markSeen,
  resolveEffectiveSeenAt,
  decideAutoSeen,
  resolveConversationStatus,
  type ConversationStatus,
} from '../lib/conversation-rail-rules';

/**
 * 会話履歴レール（右レール第3タブ）のデータ取得フック。
 *
 * `GET /api/threads`（`projectId` 省略＝全プロジェクト横断）を直近 `CONVERSATION_RAIL_LIMIT` 件
 * ポーリングする。`ThreadList.tsx` とは独立（表示専用の `ConversationRail.tsx` から使う）。
 * `ChatPage` に1インスタンスだけ置き、drawer/rail 両方の `ConversationRail` へ同じ結果を配る
 * （ポーリングの二重化を避けるため）。
 *
 * 既読状態（緑✓の解除）はサーバー管理（`Session.lastSeenAiAt` / `GET /api/threads` の `seenAt` /
 * `POST /api/sessions/:id/seen`）。端末・ブラウザをまたいで同期する（旧 localStorage 管理から移行）。
 * `localSeenOverrides` はポーリング間隔（`CONVERSATION_RAIL_POLL_MS`）中の楽観的 UI 反映のためだけの
 * つなぎで、永続化しない（次回ポーリングでサーバー値に必ず追いつく）。
 * 算術・判定ロジックは一切ここに書かず、すべて `conversation-rail-rules.ts` の純関数に委譲する
 * （`src/hooks/` は `tsconfig.test.json` の対象外で単体テストできないため、`usePanelResize.ts` と同じ方針）。
 */

export interface UseConversationFeedOptions {
  /** この値が変化するたびに即座に再取得する（ChatPage の `threadRefreshToken` 等） */
  refreshToken?: number;
  /** 自ブラウザの `tab.progress` から判定した「今実行中とみなす sessionId の集合」（即時性の補完） */
  localRunningSessionIds?: ReadonlySet<string>;
  /** 現在アクティブなタブが参照している sessionId（自動既読化の判定に使う） */
  activeSessionId?: string | null;
  /** false のときはポーリングも初回フェッチも行わない（既定 true） */
  enabled?: boolean;
}

/** 会話履歴レールの1行分（`ThreadSummary` に表示状態を足したもの）。
 *  フィールド名は `conversationStatus`（`ThreadSummary.status` の 'active'|'ended' と衝突するため）。 */
export interface ConversationFeedItem extends ThreadSummary {
  conversationStatus: ConversationStatus;
}

export interface UseConversationFeedResult {
  items: ConversationFeedItem[];
  loading: boolean;
  error: boolean;
  /** 一覧を手動で再取得する（「再試行」ボタン等） */
  refetch: () => void;
  /** 指定スレッドを既読にする（行クリック時に呼ぶ）。`POST /api/sessions/:id/seen` を叩き、
   *  サーバーが実際に書き込んだ値（応答の `seenAt`）でローカル上書きを更新する。
   *  クライアント側で時刻を計算しない（サーバー/ブラウザの時計ずれで永久未読・永久既読になるのを防ぐ）。 */
  markConversationSeen: (sessionId: string) => void;
}

export function useConversationFeed(options: UseConversationFeedOptions = {}): UseConversationFeedResult {
  const { refreshToken, localRunningSessionIds, activeSessionId = null, enabled = true } = options;

  const [rawItems, setRawItems] = useState<ThreadSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  /** ポーリング間隔中だけ有効な楽観的上書き（sessionId → 既読時点の lastAiAt ISO 文字列）。
   *  永続化しない。次回ポーリングでサーバー応答の `seenAt` に置き換わる（`resolveEffectiveSeenAt` 参照）。 */
  const [localSeenOverrides, setLocalSeenOverrides] = useState<Record<string, string>>({});

  /** stale-response 防止（並行フェッチ時に古い結果を捨てる。`ThreadList.tsx` の `fetchThreads` と同じ方針） */
  const requestSeqRef = useRef(0);
  /** `activeSessionId` の最新値を effect 外の非同期コールバックから読むための ref */
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;

  /** `POST /api/sessions/:id/seen` を叩き、応答の `seenAt` でローカル上書きを更新する（fire-and-forget）。 */
  const markConversationSeen = useCallback((sessionId: string) => {
    sessionsApi.markSeen(sessionId)
      .then(({ seenAt }) => {
        if (!seenAt) return; // まだ AI 応答が無いスレッド（既読化は実質 no-op）
        setLocalSeenOverrides((prev) => markSeen(prev, sessionId, seenAt));
      })
      .catch(() => {
        // 既読化の失敗は表示を壊さない（次にポーリング or 再クリックで自然に追いつく）
      });
  }, []);

  const fetchFeed = useCallback(async () => {
    const seq = ++requestSeqRef.current;
    setLoading(true);
    setError(false);
    try {
      const { threads } = await threadsApi.list(undefined, CONVERSATION_RAIL_LIMIT);
      if (requestSeqRef.current !== seq) return; // stale response
      setRawItems(threads);

      // サーバー応答に出てこなくなった sessionId の上書きは捨てる（無限成長防止。
      // 一覧の件数上限は CONVERSATION_RAIL_LIMIT のため、保持件数も自然にそれ以下に収まる）。
      setLocalSeenOverrides((prev) => {
        const idsInList = new Set(threads.map((t) => t.sessionId));
        let changed = false;
        const next: Record<string, string> = {};
        for (const [sessionId, atIso] of Object.entries(prev)) {
          if (idsInList.has(sessionId)) {
            next[sessionId] = atIso;
          } else {
            changed = true;
          }
        }
        return changed ? next : prev;
      });

      // 現在開いているスレッドに新しい応答が来ていれば、可視時に限り自動既読化する
      // （一覧に出ただけでは既読にしない。要望「未確認を羅列して最新を追う」を壊さないため）。
      const visible = typeof document === 'undefined' || document.visibilityState === 'visible';
      for (const t of threads) {
        if (decideAutoSeen({ sessionId: t.sessionId, activeSessionId: activeSessionIdRef.current, visible })) {
          markConversationSeen(t.sessionId);
        }
      }
    } catch {
      if (requestSeqRef.current !== seq) return;
      setError(true);
    } finally {
      if (requestSeqRef.current === seq) setLoading(false);
    }
  }, [markConversationSeen]);

  // 初回フェッチ・refreshToken 変化時の即時再取得
  useEffect(() => {
    if (!enabled) return;
    fetchFeed();
  }, [enabled, refreshToken, fetchFeed]);

  // ポーリング（document.hidden 中は止める。visibilitychange で即フェッチして再開）
  useEffect(() => {
    if (!enabled) return;
    let intervalId: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (intervalId !== null) return;
      intervalId = setInterval(fetchFeed, CONVERSATION_RAIL_POLL_MS);
    };
    const stop = () => {
      if (intervalId === null) return;
      clearInterval(intervalId);
      intervalId = null;
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        fetchFeed();
        start();
      } else {
        stop();
      }
    };

    if (typeof document === 'undefined' || document.visibilityState === 'visible') start();
    document.addEventListener?.('visibilitychange', handleVisibilityChange);

    return () => {
      stop();
      document.removeEventListener?.('visibilitychange', handleVisibilityChange);
    };
  }, [enabled, fetchFeed]);

  const items = useMemo<ConversationFeedItem[]>(() => {
    return rawItems.map((item) => ({
      ...item,
      conversationStatus: resolveConversationStatus({
        running: item.running,
        localRunning: localRunningSessionIds?.has(item.sessionId) ?? false,
        lastAiAt: item.lastAiAt,
        lastActiveAt: item.lastActiveAt,
        seenAt: resolveEffectiveSeenAt(item.seenAt, localSeenOverrides[item.sessionId]),
      }),
    }));
  }, [rawItems, localSeenOverrides, localRunningSessionIds]);

  return { items, loading, error, refetch: fetchFeed, markConversationSeen };
}
