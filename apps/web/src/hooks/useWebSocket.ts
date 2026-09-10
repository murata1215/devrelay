import { useState, useEffect, useRef, useCallback } from 'react';
import { getToken } from '../lib/api';
import { getTabId } from '../lib/tab-id';

/** ツール承認プロンプト情報 */
export interface ToolApprovalPrompt {
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  title?: string;
  description?: string;
  projectId?: string;
  /** AskUserQuestion の場合 true */
  isQuestion?: boolean;
  /** teamexec/crossquery 時の発信元プロジェクトID（発信元タブにも承認カードを表示） */
  originProjectId?: string;
  /** Lite シェル L3: 対象スレッドの sessionId（server サイクル4で付与済み `tool-approval-payload.ts`）。
   * `shouldShowApprovalCard()`（`lite-shell-rules.ts`、fail-closed）の判定に使う。無いと Lite の
   * 承認ゲートが素通りしてしまうため、classic 側は使わなくても常に受信・保持する（加算のみ）。 */
  sessionId?: string;
}

/** ツール承認解決情報 */
export interface ToolApprovalResolved {
  requestId: string;
  behavior: 'allow' | 'deny';
  projectId?: string;
}

/** 自動承認通知情報（approveAllMode 時） */
export interface ToolApprovalAuto {
  toolName: string;
  toolInput: Record<string, unknown>;
  projectId?: string;
}

/** サーバー → ブラウザ WebSocket メッセージ型（projectId: タブルーティング用、sessionId: スレッドルーティング用） */
type ServerToWebMessage =
  | { type: 'web:response'; payload: { message: string; files?: Array<{ filename: string; content: string; mimeType: string }>; projectId?: string; sessionId?: string; messageId?: string } }
  | { type: 'web:progress'; payload: { output: string; elapsed: number; projectId?: string; sessionId?: string } }
  | { type: 'web:session_info'; payload: { projectId: string; sessionId: string; title?: string; agentScopeId?: string } }
  | { type: 'web:user_message'; payload: { content: string; files?: Array<{ filename: string; content: string; mimeType: string }>; projectId?: string; sessionId?: string; messageId?: string } }
  | { type: 'web:tool:approval'; payload: ToolApprovalPrompt }
  | { type: 'web:tool:approval:resolved'; payload: ToolApprovalResolved }
  | { type: 'web:tool:approval:auto'; payload: ToolApprovalAuto }
  | { type: 'web:error'; payload: { error: string } }
  | { type: 'web:pong' };

/** チャットメッセージ */
export interface ChatMessage {
  id: string;
  role: 'user' | 'system' | 'ai';
  content: string;
  files?: Array<{ id?: string; filename: string; content?: string; mimeType: string; size?: number }>;
  timestamp: Date;
  sourceProjectName?: string;  // クロスプロジェクトクエリの送信元プロジェクト名
}

/** 進捗情報 */
export interface ProgressInfo {
  output: string;
  elapsed: number;
}

/** コールバック設定（projectId: 対象タブ特定用、省略時はアクティブタブ。sessionId: タブ内スレッド特定用、サイクル3） */
export interface WebSocketCallbacks {
  onMessage?: (msg: Omit<ChatMessage, 'id' | 'timestamp'> & { messageId?: string }, projectId?: string, sessionId?: string) => void;
  onProgress?: (info: ProgressInfo, projectId?: string, sessionId?: string) => void;
  onProgressClear?: (projectId?: string, sessionId?: string) => void;
  onSessionInfo?: (projectId: string, sessionId: string, title?: string, agentScopeId?: string) => void;
  /** ツール承認リクエスト受信時のコールバック */
  onToolApproval?: (prompt: ToolApprovalPrompt) => void;
  /** ツール承認解決（他ブラウザからの応答含む）受信時のコールバック */
  onToolApprovalResolved?: (resolved: ToolApprovalResolved) => void;
  /** 自動承認通知（approveAllMode 時）受信時のコールバック */
  onToolApprovalAuto?: (info: ToolApprovalAuto) => void;
  /** WebSocket 再接続時のコールバック（セッション再登録・履歴リフレッシュ用） */
  onReconnect?: () => void;
}

/** WebSocket フックの戻り値 */
interface UseWebSocketReturn {
  connected: boolean;
  /** L4: 送信できたかどうかを呼び出し側が判定できるよう `boolean` を返す（純加算。既存呼び出し元
   * `ChatPage.tsx` は戻り値を無視しているため無変更のまま動く）。`false` は WS 未接続で
   * フレームが送信されなかったことを表す（Lite の楽観的表示のロールバックに使う）。 */
  sendCommand: (text: string, files?: Array<{ filename: string; content: string; mimeType: string; size?: number }>, projectId?: string) => boolean;
  /** ツール承認応答を送信（ユーザーが許可/拒否を選択） */
  sendToolApprovalResponse: (requestId: string, behavior: 'allow' | 'deny', approveAll?: boolean, alwaysAllow?: boolean, answers?: Record<string, string>) => void;
}

/** WebSocket URL を構築 */
function buildWsUrl(tabId: string): string {
  const token = getToken();
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.host;
  return `${protocol}//${host}/ws/web?token=${token}&tabId=${tabId}`;
}

/** Lite シェル L3: `useWebSocket` の optional 引数。 */
export interface UseWebSocketOptions {
  /** 指定時はこの tabId で WS を張る（省略時は従来どおり `getTabId()`＝classic の
   * sessionStorage 由来の値）。Lite はマウント時にメモリ生成した tabId をここに渡す。
   * **絶対規則**: `sessionsApi.switchThread()` に渡す tabId と必ず同一値にすること。
   * 食い違うと「参加登録は chatId B・ソケットは chatId A」となり、エラーを一切出さずに
   * WS が無音になる（S1/S2 参照）。 */
  tabId?: string;
}

/**
 * Web チャット用 WebSocket 接続を管理するフック
 * メッセージ・進捗はコールバックで外部管理（タブ切り替え対応）
 */
export function useWebSocket(callbacks?: WebSocketCallbacks, options?: UseWebSocketOptions): UseWebSocketReturn {
  const [connected, setConnected] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);
  /** コールバックの最新値を常に参照するための ref */
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;
  /** `options.tabId` の最新値を常に参照するための ref（`connect` の依存配列を `[]` のまま保つため。
   * 依存配列に入れると、呼び出し側が毎レンダー新しい tabId 値を作った場合に close/open の
   * 再接続ストームになり、そのたびにサーバーで `removeWebParticipantFromAllSessions` が走る）。 */
  const tabIdOverrideRef = useRef(options?.tabId);
  tabIdOverrideRef.current = options?.tabId;

  const connect = useCallback(() => {
    const token = getToken();
    if (!token) return;

    const tabId = tabIdOverrideRef.current || getTabId();
    const url = buildWsUrl(tabId);

    // 既存の WS があればクリーンアップ（stale close イベント防止）
    if (wsRef.current) {
      const oldWs = wsRef.current;
      oldWs.onclose = null;
      oldWs.onmessage = null;
      oldWs.onerror = null;
      if (oldWs.readyState === WebSocket.OPEN || oldWs.readyState === WebSocket.CONNECTING) {
        oldWs.close();
      }
      wsRef.current = null;
    }

    try {
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!mountedRef.current) return;
        const isReconnect = reconnectAttemptsRef.current > 0;
        setConnected(true);
        reconnectAttemptsRef.current = 0;

        // ハートビート（30秒間隔）
        pingTimerRef.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'web:ping' }));
          }
        }, 30000);

        // 再接続時: セッション再登録・履歴リフレッシュをトリガー
        if (isReconnect) {
          callbacksRef.current?.onReconnect?.();
        }
      };

      ws.onmessage = (event) => {
        if (!mountedRef.current) return;
        try {
          const msg: ServerToWebMessage = JSON.parse(event.data);
          const cb = callbacksRef.current;
          switch (msg.type) {
            case 'web:response':
              cb?.onProgressClear?.(msg.payload.projectId, msg.payload.sessionId);
              if (msg.payload.message) {
                cb?.onMessage?.({ role: 'system', content: msg.payload.message, files: msg.payload.files, messageId: msg.payload.messageId }, msg.payload.projectId, msg.payload.sessionId);
              }
              break;
            case 'web:progress':
              cb?.onProgress?.({ output: msg.payload.output, elapsed: msg.payload.elapsed }, msg.payload.projectId, msg.payload.sessionId);
              break;
            case 'web:session_info':
              cb?.onSessionInfo?.(msg.payload.projectId, msg.payload.sessionId, msg.payload.title, msg.payload.agentScopeId);
              break;
            case 'web:user_message':
              // 他タブ/ウィンドウからのユーザーメッセージ
              cb?.onMessage?.({ role: 'user', content: msg.payload.content, files: msg.payload.files, messageId: msg.payload.messageId }, msg.payload.projectId, msg.payload.sessionId);
              break;
            case 'web:tool:approval':
              cb?.onToolApproval?.(msg.payload);
              break;
            case 'web:tool:approval:resolved':
              cb?.onToolApprovalResolved?.(msg.payload);
              break;
            case 'web:tool:approval:auto':
              cb?.onToolApprovalAuto?.(msg.payload);
              break;
            case 'web:error':
              cb?.onMessage?.({ role: 'system', content: `❌ ${msg.payload.error}` });
              break;
            case 'web:pong':
              break;
          }
        } catch {
          // JSON パースエラーは無視
        }
      };

      ws.onclose = () => {
        if (!mountedRef.current) return;
        // 古い WS の close イベントは無視（新しい WS が既に接続済み）
        if (wsRef.current !== ws) return;
        setConnected(false);
        if (pingTimerRef.current) {
          clearInterval(pingTimerRef.current);
          pingTimerRef.current = null;
        }

        // 自動再接続（exponential backoff: 2s, 4s, 8s, ... max 30s）
        const delay = Math.min(2000 * Math.pow(2, reconnectAttemptsRef.current), 30000);
        reconnectAttemptsRef.current++;
        reconnectTimerRef.current = setTimeout(() => {
          if (mountedRef.current) connect();
        }, delay);
      };

      ws.onerror = () => {
        // onclose が後に呼ばれるのでここでは何もしない
      };
    } catch {
      // WebSocket 作成エラー
    }
  }, []);

  // マウント時に接続、アンマウント時にクリーンアップ
  useEffect(() => {
    mountedRef.current = true;
    connect();

    return () => {
      mountedRef.current = false;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
      if (pingTimerRef.current) {
        clearInterval(pingTimerRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connect]);

  const sendCommand = useCallback((text: string, files?: Array<{ filename: string; content: string; mimeType: string; size?: number }>, projectId?: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return false;

    wsRef.current.send(JSON.stringify({
      type: 'web:command',
      payload: { text, files, ...(projectId ? { projectId } : {}) },
    }));
    return true;
  }, []);

  /** ツール承認応答を Server に送信 */
  const sendToolApprovalResponse = useCallback((requestId: string, behavior: 'allow' | 'deny', approveAll?: boolean, alwaysAllow?: boolean, answers?: Record<string, string>) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

    wsRef.current.send(JSON.stringify({
      type: 'web:tool:approval:response',
      payload: { requestId, behavior, ...(approveAll ? { approveAll: true } : {}), ...(alwaysAllow ? { alwaysAllow: true } : {}), ...(answers ? { answers } : {}) },
    }));
  }, []);

  return { connected, sendCommand, sendToolApprovalResponse };
}
