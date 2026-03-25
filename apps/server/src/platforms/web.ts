import type { FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import type { FileAttachment, WebClientMessage, ServerToWebMessage } from '@devrelay/shared';
import { parseCommandWithNLP } from '../services/command-parser.js';
import { executeCommand, getUserContext, handleProjectConnect } from '../services/command-handler.js';
import { getActiveProgressForChatId, getSessionIdByChatId, getSessionParticipants } from '../services/session-manager.js';
import { handleToolApprovalUserResponse, getPendingToolApprovalsForSession } from '../services/agent-manager.js';
import { prisma } from '../db/client.js';
import crypto from 'crypto';

/** 接続中の Web クライアント: chatId -> WebSocket */
const webClients = new Map<string, WebSocket>();

/** タイピングインジケーター状態 */
const typingStates = new Map<string, boolean>();

/** WS 不在時の未送信レスポンスキュー: chatId -> メッセージ配列 */
const pendingMessages = new Map<string, Array<{ message: string; files?: FileAttachment[]; projectId?: string }>>();

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

  // サーバー側 keepalive ping（Caddy プロキシ経由の接続維持、15秒間隔）
  const keepaliveInterval = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      ws.ping();
    }
  }, 15000);

  // 未送信キューをフラッシュ（WS 切断中に到着した完了メッセージを再送）
  const queued = pendingMessages.get(chatId);
  if (queued && queued.length > 0) {
    pendingMessages.delete(chatId);
    for (const msg of queued) {
      sendJson(ws, { type: 'web:response', payload: msg });
    }
    console.log(`📨 Flushed ${queued.length} pending message(s) for ${chatId}`);
  }

  // アクティブな進捗があれば即座に送信（WS 切断中の進捗ロスト復元）
  const progress = getActiveProgressForChatId(chatId);
  if (progress) {
    sendJson(ws, {
      type: 'web:progress',
      payload: { output: progress.output, elapsed: progress.elapsed, projectId: progress.projectId ?? undefined },
    });
    console.log(`📊 Restored active progress for ${chatId}`);
  }

  // 保留中のツール承認カードを復元（リロード時に承認操作を継続可能にする）
  const sessionId = getSessionIdByChatId(chatId);
  if (sessionId) {
    getPendingToolApprovalsForSession(sessionId).then(pendingApprovals => {
      for (const approval of pendingApprovals) {
        sendJson(ws, { type: 'web:tool:approval', payload: approval });
      }
      if (pendingApprovals.length > 0) {
        console.log(`🔐 Restored ${pendingApprovals.length} pending tool approval(s) for ${chatId}`);
      }
    }).catch(err => console.error('Failed to restore pending tool approvals:', err));
  }

  // メッセージハンドラ
  ws.on('message', async (data: Buffer) => {
    try {
      const msg: WebClientMessage = JSON.parse(data.toString());

      switch (msg.type) {
        case 'web:command': {
          const text = msg.payload.text?.trim();
          if (!text && (!msg.payload.files || msg.payload.files.length === 0)) break;

          const context = await getUserContext(userId, 'web', chatId);

          // projectId ヒント: クライアントが送信した projectId とコンテキストが一致しない場合、自動切り替え
          // タブ切替直後のレースコンディションを防止（//connect が先に到着しない場合に対応）
          const hintProjectId = msg.payload.projectId;
          if (hintProjectId && hintProjectId !== context.lastProjectId) {
            await handleProjectConnect(hintProjectId, context);
          }

          // サイドバーからの直接接続コマンド: //connect <projectId>
          if (text?.startsWith('//connect ')) {
            const projectId = text.slice('//connect '.length).trim();
            const response = await handleProjectConnect(projectId, context);
            if (response) {
              // projectId を含めて送信（クライアントで正しいタブにルーティング）
              sendJson(ws, { type: 'web:response', payload: { message: response, projectId } });
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
          console.log(`📨 Web: executing command type=${command.type}, input="${(text || '').substring(0, 50)}"`);

          // 同じセッションの他 Web クライアントにユーザーメッセージをブロードキャスト（全コマンド対象）
          {
            const sessionId = getSessionIdByChatId(chatId);
            if (sessionId) {
              const participants = getSessionParticipants(sessionId);
              for (const p of participants) {
                if (p.platform === 'web' && p.chatId !== chatId) {
                  const otherWs = webClients.get(p.chatId);
                  if (otherWs && otherWs.readyState === otherWs.OPEN) {
                    sendJson(otherWs, {
                      type: 'web:user_message',
                      payload: { content: text || '', files: msg.payload.files, projectId: context.lastProjectId },
                    });
                  }
                }
              }
            }
          }

          const response = await executeCommand(command, context, msg.payload.files);
          console.log(`📨 Web: response ${response ? `(${response.length} chars): ${response.substring(0, 80)}...` : '(empty)'}`);

          // レスポンスがある場合は同じセッションの全 Web クライアントにブロードキャスト
          if (response) {
            const sessionId = getSessionIdByChatId(chatId);
            if (sessionId) {
              const participants = getSessionParticipants(sessionId);
              for (const p of participants) {
                if (p.platform === 'web') {
                  const targetWs = webClients.get(p.chatId);
                  if (targetWs && targetWs.readyState === targetWs.OPEN) {
                    sendJson(targetWs, { type: 'web:response', payload: { message: response, projectId: context.lastProjectId } });
                  }
                }
              }
            } else {
              // セッション未参加（参加前のコマンド等）は送信元のみに返す
              sendJson(ws, { type: 'web:response', payload: { message: response } });
            }
          }
          break;
        }
        case 'web:tool:approval:response':
          // WebUI からのツール承認応答を agent-manager に転送（alwaysAllow, answers も含む）
          handleToolApprovalUserResponse(msg.payload.requestId, {
            behavior: msg.payload.behavior,
            approveAll: msg.payload.approveAll,
            alwaysAllow: msg.payload.alwaysAllow,
            answers: msg.payload.answers,
          });
          break;
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

  // 切断ハンドラ（新しい接続で上書きされた場合は削除しない）
  ws.on('close', () => {
    clearInterval(keepaliveInterval);
    if (webClients.get(chatId) === ws) {
      webClients.delete(chatId);
      // 再接続しなかった場合のみキューをクリア（60秒待機）
      setTimeout(() => {
        if (!webClients.has(chatId)) {
          pendingMessages.delete(chatId);
        }
      }, 60000);
    }
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
 * @param projectId メッセージのルーティング先タブ特定用（省略時はアクティブタブに表示）
 */
export async function sendWebMessage(chatId: string, message: string, files?: FileAttachment[], projectId?: string | null) {
  const ws = webClients.get(chatId);
  if (ws && ws.readyState === ws.OPEN) {
    sendJson(ws, { type: 'web:response', payload: { message, files, projectId: projectId ?? undefined } });
  } else {
    // WS 不在 → キューに保存（再接続時にフラッシュ）
    const queue = pendingMessages.get(chatId) || [];
    queue.push({ message, files, projectId: projectId ?? undefined });
    pendingMessages.set(chatId, queue);
    console.log(`📥 Queued message for offline client ${chatId} (${queue.length} pending)`);
  }
}

/**
 * Web クライアントに生の ServerToWebMessage を送信する
 * ツール承認リクエスト等、専用の型メッセージを直接送信する場合に使用
 */
export function sendWebRawMessage(chatId: string, message: ServerToWebMessage): boolean {
  const ws = webClients.get(chatId);
  if (ws && ws.readyState === ws.OPEN) {
    sendJson(ws, message);
    return true;
  }
  return false;
}

/**
 * 接続中の全 Web クライアントに ServerToWebMessage をブロードキャストする
 * セッション参加者が見つからない場合のフォールバック用
 * @returns 送信したクライアント数
 */
export function broadcastWebRawMessage(message: ServerToWebMessage): number {
  let sent = 0;
  for (const [chatId, ws] of webClients) {
    if (ws.readyState === ws.OPEN) {
      sendJson(ws, message);
      sent++;
    }
  }
  return sent;
}

/**
 * Web クライアントに進捗メッセージを送信し、messageId を返す
 * session-manager.ts の startProgressTracking() から呼ばれる
 * @param projectId ルーティング先タブ特定用
 */
export async function sendWebMessageWithId(chatId: string, content: string, projectId?: string | null): Promise<string | null> {
  const ws = webClients.get(chatId);
  if (!ws || ws.readyState !== ws.OPEN) return null;

  const messageId = `webmsg_${crypto.randomUUID()}`;
  sendJson(ws, { type: 'web:progress', payload: { output: content, elapsed: 0, projectId: projectId ?? undefined } });
  return messageId;
}

/**
 * Web クライアントの進捗メッセージを更新する
 * session-manager.ts の updateProgressMessages() から呼ばれる
 * @param projectId ルーティング先タブ特定用
 */
export async function editWebMessage(
  chatId: string,
  _messageId: string,
  content: string,
  elapsed?: number,
  projectId?: string | null
): Promise<boolean> {
  const ws = webClients.get(chatId);
  if (!ws || ws.readyState !== ws.OPEN) return false;

  sendJson(ws, {
    type: 'web:progress',
    payload: { output: content, elapsed: elapsed ?? 0, projectId: projectId ?? undefined },
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
