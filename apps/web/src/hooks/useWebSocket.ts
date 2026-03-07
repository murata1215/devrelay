import { useState, useEffect, useRef, useCallback } from 'react';
import { getToken } from '../lib/api';

/** サーバー → ブラウザ WebSocket メッセージ型 */
type ServerToWebMessage =
  | { type: 'web:response'; payload: { message: string; files?: Array<{ filename: string; content: string; mimeType: string }> } }
  | { type: 'web:progress'; payload: { output: string; elapsed: number } }
  | { type: 'web:session_info'; payload: { projectId: string; sessionId: string } }
  | { type: 'web:error'; payload: { error: string } }
  | { type: 'web:pong' };

/** チャットメッセージ */
export interface ChatMessage {
  id: string;
  role: 'user' | 'system' | 'ai';
  content: string;
  files?: Array<{ id?: string; filename: string; content?: string; mimeType: string }>;
  timestamp: Date;
}

/** 進捗情報 */
export interface ProgressInfo {
  output: string;
  elapsed: number;
}

/** コールバック設定 */
export interface WebSocketCallbacks {
  onMessage?: (msg: Omit<ChatMessage, 'id' | 'timestamp'>) => void;
  onProgress?: (info: ProgressInfo) => void;
  onProgressClear?: () => void;
  onSessionInfo?: (projectId: string, sessionId: string) => void;
}

/** WebSocket フックの戻り値 */
interface UseWebSocketReturn {
  connected: boolean;
  sendCommand: (text: string, files?: Array<{ filename: string; content: string; mimeType: string; size?: number }>) => void;
}

/** tabId を sessionStorage で管理（タブごとに独立） */
function getTabId(): string {
  let tabId = sessionStorage.getItem('devrelay-tab-id');
  if (!tabId) {
    tabId = crypto.randomUUID();
    sessionStorage.setItem('devrelay-tab-id', tabId);
  }
  return tabId;
}

/** WebSocket URL を構築 */
function buildWsUrl(tabId: string): string {
  const token = getToken();
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.host;
  return `${protocol}//${host}/ws/web?token=${token}&tabId=${tabId}`;
}

/**
 * Web チャット用 WebSocket 接続を管理するフック
 * メッセージ・進捗はコールバックで外部管理（タブ切り替え対応）
 */
export function useWebSocket(callbacks?: WebSocketCallbacks): UseWebSocketReturn {
  const [connected, setConnected] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);
  /** コールバックの最新値を常に参照するための ref */
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  const connect = useCallback(() => {
    const token = getToken();
    if (!token) return;

    const tabId = getTabId();
    const url = buildWsUrl(tabId);

    try {
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!mountedRef.current) return;
        setConnected(true);
        reconnectAttemptsRef.current = 0;

        // ハートビート（30秒間隔）
        pingTimerRef.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'web:ping' }));
          }
        }, 30000);
      };

      ws.onmessage = (event) => {
        if (!mountedRef.current) return;
        try {
          const msg: ServerToWebMessage = JSON.parse(event.data);
          const cb = callbacksRef.current;
          switch (msg.type) {
            case 'web:response':
              cb?.onProgressClear?.();
              if (msg.payload.message) {
                cb?.onMessage?.({ role: 'system', content: msg.payload.message, files: msg.payload.files });
              }
              break;
            case 'web:progress':
              cb?.onProgress?.({ output: msg.payload.output, elapsed: msg.payload.elapsed });
              break;
            case 'web:session_info':
              cb?.onSessionInfo?.(msg.payload.projectId, msg.payload.sessionId);
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

  const sendCommand = useCallback((text: string, files?: Array<{ filename: string; content: string; mimeType: string; size?: number }>) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

    wsRef.current.send(JSON.stringify({
      type: 'web:command',
      payload: { text, files },
    }));
  }, []);

  return { connected, sendCommand };
}
