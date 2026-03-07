import type { FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import type { FileAttachment, WebClientMessage } from '@devrelay/shared';
import { parseCommandWithNLP } from '../services/command-parser.js';
import { executeCommand, getUserContext, handleProjectConnect } from '../services/command-handler.js';
import { prisma } from '../db/client.js';
import crypto from 'crypto';

/** 接続中の Web クライアント: chatId -> WebSocket */
const webClients = new Map<string, WebSocket>();

/** タイピングインジケーター状態 */
const typingStates = new Map<string, boolean>();

/**
 * Web クライアントの WebSocket 接続をセットアップする
 * 認証は upgrade リクエストのクエリパラメータから Bearer トークンを取得して検証
 */
export async function setupWebClientWebSocket(
  connection: { socket: WebSocket },
  req: FastifyRequest
) {
  const ws = connection.socket;
  const query = req.query as { token?: string; tabId?: string };

  // トークン検証
  const token = query.token;
  if (!token) {
    ws.send(JSON.stringify({ type: 'web:error', payload: { error: '認証トークンが必要です' } }));
    ws.close(4001, 'Missing token');
    return;
  }

  const authSession = await prisma.authSession.findUnique({
    where: { token },
    include: { user: true },
  });

  if (!authSession || authSession.expiresAt < new Date()) {
    ws.send(JSON.stringify({ type: 'web:error', payload: { error: '認証が無効です' } }));
    ws.close(4001, 'Invalid token');
    return;
  }

  const userId = authSession.user.id;
  const tabId = query.tabId || crypto.randomUUID();
  const chatId = `web:${userId}:${tabId}`;

  // 既存の接続があれば閉じる（同一タブの再接続）
  const existingWs = webClients.get(chatId);
  if (existingWs && existingWs.readyState === existingWs.OPEN) {
    existingWs.terminate();
  }

  webClients.set(chatId, ws);
  console.log(`🌐 Web client connected: ${chatId}`);

  // メッセージハンドラ
  ws.on('message', async (data: Buffer) => {
    try {
      const msg: WebClientMessage = JSON.parse(data.toString());

      switch (msg.type) {
        case 'web:command': {
          const text = msg.payload.text?.trim();
          if (!text && (!msg.payload.files || msg.payload.files.length === 0)) break;

          const context = await getUserContext(userId, 'web', chatId);

          // サイドバーからの直接接続コマンド: //connect <projectId>
          if (text?.startsWith('//connect ')) {
            const projectId = text.slice('//connect '.length).trim();
            const response = await handleProjectConnect(projectId, context);
            if (response) {
              sendJson(ws, { type: 'web:response', payload: { message: response } });
            }
            // 接続後にセッションIDをクライアントに通知（タブ復元用）
            const updatedContext = await getUserContext(userId, 'web', chatId);
            if (updatedContext.currentSessionId) {
              sendJson(ws, {
                type: 'web:session_info',
                payload: { projectId, sessionId: updatedContext.currentSessionId },
              });
            }
            break;
          }

          const command = await parseCommandWithNLP(text || '', context);
          const response = await executeCommand(command, context, msg.payload.files);

          // レスポンスがある場合は送信（進捗トラッキング中は空になる）
          if (response) {
            sendJson(ws, { type: 'web:response', payload: { message: response } });
          }
          break;
        }
        case 'web:ping':
          sendJson(ws, { type: 'web:pong' });
          break;
      }
    } catch (error) {
      console.error('Web client message handling error:', error);
      sendJson(ws, {
        type: 'web:error',
        payload: { error: 'メッセージ処理中にエラーが発生しました' },
      });
    }
  });

  // 切断ハンドラ
  ws.on('close', () => {
    webClients.delete(chatId);
    typingStates.delete(chatId);
    console.log(`🌐 Web client disconnected: ${chatId}`);
  });

  ws.on('error', (error) => {
    console.error(`Web client error (${chatId}):`, error);
  });
}

/**
 * Web クライアントにメッセージを送信する
 * session-manager.ts の sendMessage() から呼ばれる
 */
export async function sendWebMessage(chatId: string, message: string, files?: FileAttachment[]) {
  const ws = webClients.get(chatId);
  if (ws && ws.readyState === ws.OPEN) {
    sendJson(ws, { type: 'web:response', payload: { message, files } });
  }
}

/**
 * Web クライアントに進捗メッセージを送信し、messageId を返す
 * session-manager.ts の startProgressTracking() から呼ばれる
 */
export async function sendWebMessageWithId(chatId: string, content: string): Promise<string | null> {
  const ws = webClients.get(chatId);
  if (!ws || ws.readyState !== ws.OPEN) return null;

  const messageId = `webmsg_${crypto.randomUUID()}`;
  sendJson(ws, { type: 'web:progress', payload: { output: content, elapsed: 0 } });
  return messageId;
}

/**
 * Web クライアントの進捗メッセージを更新する
 * session-manager.ts の updateProgressMessages() から呼ばれる
 */
export async function editWebMessage(
  chatId: string,
  _messageId: string,
  content: string,
  elapsed?: number
): Promise<boolean> {
  const ws = webClients.get(chatId);
  if (!ws || ws.readyState !== ws.OPEN) return false;

  sendJson(ws, {
    type: 'web:progress',
    payload: { output: content, elapsed: elapsed ?? 0 },
  });
  return true;
}

/** タイピングインジケーターを開始 */
export async function startTypingIndicator(chatId: string) {
  typingStates.set(chatId, true);
}

/** タイピングインジケーターを停止 */
export function stopTypingIndicator(chatId: string) {
  typingStates.delete(chatId);
}

/** JSON メッセージ送信ヘルパー */
function sendJson(ws: WebSocket, data: unknown) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(data));
  }
}
