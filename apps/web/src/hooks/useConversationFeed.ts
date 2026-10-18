import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { threads as threadsApi, type ThreadSummary } from '../lib/api';
import {
  CONVERSATION_RAIL_LIMIT,
  CONVERSATION_RAIL_POLL_MS,
  CONVERSATION_SEEN_STORAGE_KEY,
  CONVERSATION_SEEN_MAX,
  readSeenMap,
  serializeSeenMap,
  seedSeenMap,
  markSeen,
  pruneSeenMap,
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
 * 既読状態（緑✓の解除）は localStorage で管理する（DB 変更なし。複数端末では同期しない）。
 * 算術・判定ロジックは一切ここに書かず、すべて `conversation-rail-rules.ts` の純関数に委譲する
 * （`src/hooks/` は `tsconfig.test.json` の対象外で単体テストできないため、`usePanelResize.ts` と同じ方針）。
 */

/** localStorage 読み取りを try/catch で包む（プライベートモード等で例外になる環境向け） */
function safeGetItem(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** localStorage 書き込みを try/catch で包む */
function safeSetItem(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* プライベートモード等で書き込み不可でも動作を継続 */
  }
}

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
  /** 指定スレッドを既読にする（行クリック時に呼ぶ）。`lastAiAt` は呼び出し時点でサーバーが
   *  返していた値をそのまま渡すこと（`Date.now()` を渡すとサーバー/ブラウザの時計ずれで
   *  永久未読・永久既読になりうる）。 */
  markConversationSeen: (sessionId: string, lastAiAt: string | null | undefined) => void;
}

export function useConversationFeed(options: UseConversationFeedOptions = {}): UseConversationFeedResult {
  const { refreshToken, localRunningSessionIds, activeSessionId = null, enabled = true } = options;

  const [rawItems, setRawItems] = useState<ThreadSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  /** 既読マップ（sessionId → 既読時点の lastAiAt ISO 文字列）。初期値は localStorage から同期的に復元 */
  const [seenMap, setSeenMap] = useState<Record<string, string>>(() => readSeenMap(safeGetItem(CONVERSATION_SEEN_STORAGE_KEY)).seen);
  /** 初回シード（未初期化時の全件既読化）を一度だけ行うためのフラグ */
  const seededRef = useRef(false);
  useEffect(() => {
    seededRef.current = readSeenMap(safeGetItem(CONVERSATION_SEEN_STORAGE_KEY)).initialized;
  }, []);

  /** stale-response 防止（並行フェッチ時に古い結果を捨てる。`ThreadList.tsx` の `fetchThreads` と同じ方針） */
  const requestSeqRef = useRef(0);
  /** `activeSessionId` の最新値を effect 外の非同期コールバックから読むための ref */
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;

  /** 既読マップを更新し、同時に localStorage へ永続化する（上限超過分は古い順に破棄） */
  const commitSeenMap = useCallback((updater: (prev: Record<string, string>) => Record<string, string>) => {
    setSeenMap((prev) => {
      const next = pruneSeenMap(updater(prev), CONVERSATION_SEEN_MAX);
      if (next !== prev) safeSetItem(CONVERSATION_SEEN_STORAGE_KEY, serializeSeenMap(next));
      return next;
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

      // 初回（未初期化）のみ全件既読シード。これを先に行ってから自動既読を適用する。
      if (!seededRef.current) {
        seededRef.current = true;
        commitSeenMap((prev) => seedSeenMap({ initialized: false, seen: prev }, threads));
      }

      // 現在開いているスレッドに新しい応答が来ていれば、可視時に限り自動既読化する
      // （一覧に出ただけでは既読にしない。要望「未確認を羅列して最新を追う」を壊さないため）。
      const visible = typeof document === 'undefined' || document.visibilityState === 'visible';
      const autoSeenEntries = threads.filter((t) =>
        decideAutoSeen({ sessionId: t.sessionId, activeSessionId: activeSessionIdRef.current, visible })
      );
      if (autoSeenEntries.length > 0) {
        commitSeenMap((prev) => {
          let next = prev;
          for (const t of autoSeenEntries) {
            if (t.lastAiAt) next = markSeen(next, t.sessionId, t.lastAiAt);
          }
          return next;
        });
      }
    } catch {
      if (requestSeqRef.current !== seq) return;
      setError(true);
    } finally {
      if (requestSeqRef.current === seq) setLoading(false);
    }
  }, [commitSeenMap]);

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

  const markConversationSeen = useCallback((sessionId: string, lastAiAt: string | null | undefined) => {
    commitSeenMap((prev) => markSeen(prev, sessionId, lastAiAt));
  }, [commitSeenMap]);

  const items = useMemo<ConversationFeedItem[]>(() => {
    return rawItems.map((item) => ({
      ...item,
      conversationStatus: resolveConversationStatus({
        running: item.running,
        localRunning: localRunningSessionIds?.has(item.sessionId) ?? false,
        lastAiAt: item.lastAiAt,
        lastActiveAt: item.lastActiveAt,
        seenAt: seenMap[item.sessionId] ?? null,
      }),
    }));
  }, [rawItems, seenMap, localRunningSessionIds]);

  return { items, loading, error, refetch: fetchFeed, markConversationSeen };
}
