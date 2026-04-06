import type { Platform, UserContext, Session, FileAttachment } from '@devrelay/shared';
import { prisma } from '../db/client.js';
import {
  sendDiscordMessage,
  startTypingIndicator as startDiscordTyping,
  stopTypingIndicator as stopDiscordTyping,
  sendDiscordMessageWithId,
  editDiscordMessage
} from '../platforms/discord.js';
import {
  sendTelegramMessage,
  startTypingIndicator as startTelegramTyping,
  stopTypingIndicator as stopTelegramTyping,
  sendTelegramMessageWithId,
  editTelegramMessage
} from '../platforms/telegram.js';
import {
  sendWebMessage,
  startTypingIndicator as startWebTyping,
  stopTypingIndicator as stopWebTyping,
  sendWebMessageWithId,
  editWebMessage
} from '../platforms/web.js';
import { sendPushNotificationForSession } from './push-notification-service.js';
import { sendFcmNotificationForSession } from './fcm-service.js';
// import { sendLineMessage } from '../platforms/line.js';

// Active sessions: sessionId -> Session participants
const sessionParticipants = new Map<string, Array<{ platform: Platform; chatId: string }>>();

/** 指定セッションの参加者一覧を取得 */
export function getSessionParticipants(sessionId: string): Array<{ platform: Platform; chatId: string }> {
  return sessionParticipants.get(sessionId) || [];
}

/** chatId が参加しているセッション ID を逆引き */
export function getSessionIdByChatId(chatId: string): string | null {
  for (const [sessionId, participants] of sessionParticipants) {
    if (participants.some(p => p.chatId === chatId)) return sessionId;
  }
  return null;
}

// Progress tracking for streaming output
interface MessageInfo {
  messageId: string | number;  // string for Discord, number for Telegram
  platform: Platform;
}
interface ProgressTracker {
  messages: Map<string, MessageInfo>;  // chatId -> { messageId, platform }
  outputBuffer: string;
  contextInfo: string;  // Context usage info to prepend to final message
  startTime: number;
  updateInterval: NodeJS.Timeout | null;
  timeoutTimer: NodeJS.Timeout | null;  // タイムアウト自動クリーンアップ用
  projectId: string | null;  // Web クライアントへのルーティング用
}
const progressTrackers = new Map<string, ProgressTracker>();

/** sessionId → projectId のキャッシュ（DB クエリ不要で projectId を取得するため） */
const sessionProjectMap = new Map<string, string>();

const PROGRESS_UPDATE_INTERVAL = 8000; // 8 seconds
const MAX_OUTPUT_LINES = 15;
/** エージェント無応答時の自動タイムアウト（5分） */
const PROGRESS_TIMEOUT = 300_000;

// Restore session participants from ChannelSession on server startup
export async function restoreSessionParticipants() {
  // Get all ChannelSession records with active sessions
  const channelSessions = await prisma.channelSession.findMany({
    where: {
      currentSessionId: { not: null }
    }
  });

  let restoredCount = 0;
  let reactivatedCount = 0;
  for (const cs of channelSessions) {
    if (cs.currentSessionId) {
      // Check if session exists and get machine status
      const session = await prisma.session.findUnique({
        where: { id: cs.currentSessionId },
        include: { machine: true }
      });

      if (session) {
        // sessionId → projectId キャッシュを更新
        sessionProjectMap.set(session.id, session.projectId);
        // Restore if machine is online (regardless of session status)
        if (session.machine.status === 'online') {
          addParticipant(cs.currentSessionId, cs.platform as Platform, cs.chatId);
          restoredCount++;
          console.log(`✅ Restored session participant: ${cs.platform}:${cs.chatId} -> ${cs.currentSessionId}`);

          // Reactivate ended sessions when machine is back online
          if (session.status === 'ended') {
            await prisma.session.update({
              where: { id: cs.currentSessionId },
              data: { status: 'active', endedAt: null }
            });
            reactivatedCount++;
            console.log(`🔄 Reactivated session: ${cs.currentSessionId}`);
          }
        } else {
          // マシンがオフライン: クリアせず保持（Agent 再接続時に復元される）
          // サーバー起動時は全マシンが offline のため、ここでクリアすると全セッションが失われる
          console.log(`⏳ Machine offline, keeping session for later: ${cs.platform}:${cs.chatId}`);
        }
      } else {
        // Session no longer exists, clear ChannelSession
        await prisma.channelSession.update({
          where: { id: cs.id },
          data: {
            currentSessionId: null,
            currentMachineId: null
          }
        });
        console.log(`🧹 Cleared stale session: ${cs.platform}:${cs.chatId}`);
      }
    }
  }

  console.log(`📋 Restored ${restoredCount} session participant(s), reactivated ${reactivatedCount} session(s)`);
}

/**
 * 特定マシンのセッション参加者を復元する
 * Agent再接続時に呼び出し、ChannelSessionからセッションを復元する
 *
 * @param machineId 復元対象のマシンID
 */
export async function restoreSessionParticipantsForMachine(machineId: string) {
  // このマシンに関連する ChannelSession を取得
  const channelSessions = await prisma.channelSession.findMany({
    where: {
      currentSessionId: { not: null },
      currentMachineId: machineId
    }
  });

  let restoredCount = 0;
  for (const cs of channelSessions) {
    if (cs.currentSessionId) {
      const session = await prisma.session.findUnique({
        where: { id: cs.currentSessionId }
      });

      if (session) {
        sessionProjectMap.set(session.id, session.projectId);
        addParticipant(cs.currentSessionId, cs.platform as Platform, cs.chatId);
        restoredCount++;

        // ended のセッションを active に戻す
        if (session.status === 'ended') {
          await prisma.session.update({
            where: { id: cs.currentSessionId },
            data: { status: 'active', endedAt: null }
          });
          console.log(`🔄 Reactivated session: ${cs.currentSessionId}`);
        }
      }
    }
  }

  if (restoredCount > 0) {
    console.log(`📋 Restored ${restoredCount} session participant(s) for machine ${machineId}`);
  }
}

export async function createSession(
  userId: string,
  machineId: string,
  projectId: string,
  aiTool: string
): Promise<string> {
  const session = await prisma.session.create({
    data: {
      userId,
      machineId,
      projectId,
      aiTool,
      status: 'active'
    }
  });
  
  sessionParticipants.set(session.id, []);
  sessionProjectMap.set(session.id, projectId);
  return session.id;
}

export function addParticipant(sessionId: string, platform: Platform, chatId: string) {
  const participants = sessionParticipants.get(sessionId) || [];
  
  // Avoid duplicates
  if (!participants.some(p => p.platform === platform && p.chatId === chatId)) {
    participants.push({ platform, chatId });
    sessionParticipants.set(sessionId, participants);
  }
}

export function removeParticipant(sessionId: string, platform: Platform, chatId: string) {
  const participants = sessionParticipants.get(sessionId) || [];
  const filtered = participants.filter(p => !(p.platform === platform && p.chatId === chatId));
  sessionParticipants.set(sessionId, filtered);
}

/**
 * 指定した Web chatId を全セッションの参加者リストから除去する
 * WS 切断時に呼び出し、stale 参加者の蓄積を防止する
 * インメモリ + DB（ChannelSession）の両方をクリーンアップ
 */
export async function removeWebParticipantFromAllSessions(chatId: string): Promise<void> {
  // インメモリから除去
  for (const [sessionId, participants] of sessionParticipants) {
    const filtered = participants.filter(p => !(p.platform === 'web' && p.chatId === chatId));
    if (filtered.length !== participants.length) {
      sessionParticipants.set(sessionId, filtered);
    }
  }
  // DB（ChannelSession）からも除去（サーバー再起動時の復元を防止）
  try {
    await prisma.channelSession.deleteMany({
      where: { platform: 'web', chatId },
    });
  } catch (e: any) {
    console.warn(`ChannelSession cleanup warning for ${chatId}:`, e.message);
  }
}

export async function endSession(sessionId: string) {
  await prisma.session.update({
    where: { id: sessionId },
    data: { status: 'ended', endedAt: new Date() }
  });
  
  sessionParticipants.delete(sessionId);
}

export async function broadcastToSession(sessionId: string, message: string, isComplete: boolean, files?: FileAttachment[]) {
  const participants = sessionParticipants.get(sessionId) || [];
  let projectId = sessionProjectMap.get(sessionId);

  // キャッシュにない場合は DB から取得（複数エージェント同時実行時のレースコンディション対策）
  if (!projectId) {
    try {
      const session = await prisma.session.findUnique({
        where: { id: sessionId },
        select: { projectId: true },
      });
      if (session?.projectId) {
        projectId = session.projectId;
        sessionProjectMap.set(sessionId, projectId);
        console.log(`📍 projectId resolved from DB for session ${sessionId.substring(0, 8)}...: ${projectId.substring(0, 8)}...`);
      }
    } catch (err) {
      console.error(`Failed to resolve projectId for session ${sessionId}:`, err);
    }
  }

  for (const { platform, chatId } of participants) {
    // Stop typing indicator when response is complete
    if (isComplete) {
      if (platform === 'discord') {
        stopDiscordTyping(chatId);
      } else if (platform === 'telegram') {
        stopTelegramTyping(chatId);
      } else if (platform === 'web') {
        stopWebTyping(chatId);
      }
    }
    // Web クライアントには projectId を含めてルーティング可能にする
    if (platform === 'web') {
      await sendWebMessage(chatId, message, files, projectId);
    } else {
      await sendMessage(platform, chatId, message, files);
    }
  }
}

export async function startTypingForSession(sessionId: string) {
  const participants = sessionParticipants.get(sessionId) || [];

  for (const { platform, chatId } of participants) {
    if (platform === 'discord') {
      await startDiscordTyping(chatId);
    } else if (platform === 'telegram') {
      await startTelegramTyping(chatId);
    } else if (platform === 'web') {
      await startWebTyping(chatId);
    }
  }
}

// Start progress tracking for a session
export async function startProgressTracking(sessionId: string) {
  const participants = sessionParticipants.get(sessionId) || [];

  // Clean up any existing tracker
  stopProgressTracking(sessionId);

  // projectId をキャッシュから取得（なければ DB から）
  let projectId = sessionProjectMap.get(sessionId) ?? null;
  if (!projectId) {
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      select: { projectId: true },
    });
    if (session) {
      projectId = session.projectId;
      sessionProjectMap.set(sessionId, projectId);
    }
  }

  const tracker: ProgressTracker = {
    messages: new Map(),
    outputBuffer: '',
    contextInfo: '',
    startTime: Date.now(),
    updateInterval: null,
    timeoutTimer: null,
    projectId,
  };

  // Send initial progress message to all participants
  for (const { platform, chatId } of participants) {
    if (platform === 'discord') {
      const messageId = await sendDiscordMessageWithId(chatId, formatProgressMessage('', 0));
      if (messageId) {
        tracker.messages.set(chatId, { messageId, platform });
      }
    } else if (platform === 'telegram') {
      const messageId = await sendTelegramMessageWithId(chatId, formatProgressMessage('', 0));
      if (messageId) {
        tracker.messages.set(chatId, { messageId, platform });
      }
    } else if (platform === 'web') {
      const messageId = await sendWebMessageWithId(chatId, formatProgressMessage('', 0), projectId);
      if (messageId) {
        tracker.messages.set(chatId, { messageId, platform });
      }
    }
  }

  // Start periodic updates
  tracker.updateInterval = setInterval(() => {
    updateProgressMessages(sessionId);
  }, PROGRESS_UPDATE_INTERVAL);

  // エージェント無応答時の自動タイムアウト
  tracker.timeoutTimer = setTimeout(() => {
    console.warn(`⏱️ Progress timeout for session ${sessionId} (${PROGRESS_TIMEOUT / 1000}s)`);
    finalizeProgress(sessionId, '⏱️ タイムアウト: エージェントから応答がありませんでした（5分経過）');
  }, PROGRESS_TIMEOUT);

  progressTrackers.set(sessionId, tracker);
}

// Add output to the buffer
export function appendSessionOutput(sessionId: string, output: string) {
  const tracker = progressTrackers.get(sessionId);
  if (tracker) {
    // タイムアウトタイマーをリセット（最後の出力から5分に延長）
    if (tracker.timeoutTimer) {
      clearTimeout(tracker.timeoutTimer);
    }
    tracker.timeoutTimer = setTimeout(() => {
      console.warn(`⏱️ Progress timeout for session ${sessionId} (${PROGRESS_TIMEOUT / 1000}s since last output)`);
      finalizeProgress(sessionId, '⏱️ タイムアウト: エージェントから応答がありませんでした（5分経過）');
    }, PROGRESS_TIMEOUT);

    // Check if this is context info (starts with 📊)
    if (output.startsWith('📊') && tracker.contextInfo === '') {
      tracker.contextInfo = output;
      console.log(`📊 Context info captured: ${output.trim()}`);
    } else {
      tracker.outputBuffer += output;
      console.log(`📝 Buffer updated: ${tracker.outputBuffer.length} chars total`);
    }
  } else {
    console.log(`⚠️ No tracker found for session ${sessionId}`);
  }
}

// Update progress messages
async function updateProgressMessages(sessionId: string) {
  const tracker = progressTrackers.get(sessionId);
  if (!tracker) return;

  const elapsed = Math.floor((Date.now() - tracker.startTime) / 1000);
  const content = formatProgressMessage(tracker.outputBuffer, elapsed);

  for (const [chatId, { messageId, platform }] of tracker.messages) {
    if (platform === 'discord') {
      await editDiscordMessage(chatId, messageId as string, content);
    } else if (platform === 'telegram') {
      await editTelegramMessage(chatId, messageId as number, content);
    } else if (platform === 'web') {
      const elapsed = Math.floor((Date.now() - (progressTrackers.get(sessionId)?.startTime ?? Date.now())) / 1000);
      await editWebMessage(chatId, messageId as string, content, elapsed, tracker.projectId);
    }
  }
}

// Format the progress message
function formatProgressMessage(output: string, elapsedSeconds: number): string {
  const lines = output.split('\n').filter(line => line.trim());
  const lastLines = lines.slice(-MAX_OUTPUT_LINES);

  let content = `🤖 **処理中...**\n`;
  content += `⏱️ ${elapsedSeconds}秒経過\n`;

  if (lastLines.length > 0) {
    content += `\`\`\`\n`;
    content += lastLines.join('\n');
    content += `\n\`\`\``;
  }

  return content;
}

/**
 * 指定 chatId にアクティブな進捗トラッカーがあれば最新状態を返す
 * WS 再接続時に進捗表示を即座に復元するために使用
 */
export function getActiveProgressForChatId(chatId: string): { output: string; elapsed: number; projectId?: string | null } | null {
  for (const [sessionId, participants] of sessionParticipants.entries()) {
    if (!participants.some(p => p.chatId === chatId)) continue;
    const tracker = progressTrackers.get(sessionId);
    if (!tracker) continue;
    const elapsed = Math.floor((Date.now() - tracker.startTime) / 1000);
    const content = formatProgressMessage(tracker.outputBuffer, elapsed);
    return { output: content, elapsed, projectId: tracker.projectId };
  }
  return null;
}

// Stop progress tracking and clean up
export function stopProgressTracking(sessionId: string) {
  const tracker = progressTrackers.get(sessionId);
  if (tracker) {
    if (tracker.updateInterval) {
      clearInterval(tracker.updateInterval);
    }
    if (tracker.timeoutTimer) {
      clearTimeout(tracker.timeoutTimer);
    }
    progressTrackers.delete(sessionId);
  }
}

/** セッションの contextInfo（📊 Rate Limit 等）を取得する */
export function getSessionContextInfo(sessionId: string): string {
  return progressTrackers.get(sessionId)?.contextInfo || '';
}

// Finalize progress with final message
export async function finalizeProgress(sessionId: string, finalMessage: string, files?: FileAttachment[], messageId?: string) {
  const tracker = progressTrackers.get(sessionId);
  const participants = sessionParticipants.get(sessionId) || [];

  // Stop the update interval and timeout timer
  if (tracker?.updateInterval) {
    clearInterval(tracker.updateInterval);
  }
  if (tracker?.timeoutTimer) {
    clearTimeout(tracker.timeoutTimer);
  }

  // Prepend context info to final message if available
  let messageToSend = finalMessage;
  if (tracker?.contextInfo) {
    messageToSend = tracker.contextInfo + finalMessage;
  }

  // Delete progress messages and send final response
  for (const { platform, chatId } of participants) {
    const msgInfo = tracker?.messages.get(chatId);

    if (platform === 'discord') {
      stopDiscordTyping(chatId);

      // Edit progress message to show completion, or send new message
      if (msgInfo && !files?.length) {
        // Edit existing message with final content
        await editDiscordMessage(chatId, msgInfo.messageId as string, messageToSend);
      } else {
        // Delete progress message and send new one with files
        if (msgInfo) {
          await editDiscordMessage(chatId, msgInfo.messageId as string, '✅ 完了');
        }
        await sendDiscordMessage(chatId, messageToSend, files);
      }
    } else if (platform === 'telegram') {
      stopTelegramTyping(chatId);

      // Edit progress message to show completion, or send new message
      if (msgInfo && !files?.length) {
        // Edit existing message with final content
        await editTelegramMessage(chatId, msgInfo.messageId as number, messageToSend);
      } else {
        // Delete progress message and send new one with files
        if (msgInfo) {
          await editTelegramMessage(chatId, msgInfo.messageId as number, '✅ 完了');
        }
        await sendTelegramMessage(chatId, messageToSend, files);
      }
    } else if (platform === 'web') {
      stopWebTyping(chatId);
      // tracker の projectId がない場合は sessionProjectMap からフォールバック
      const finalProjectId = tracker?.projectId ?? sessionProjectMap.get(sessionId);
      await sendWebMessage(chatId, messageToSend, files, finalProjectId, messageId);
    }
  }

  progressTrackers.delete(sessionId);

  // プッシュ通知（タブが閉じていても届く）
  sendPushNotificationForSession(sessionId, messageToSend).catch(() => {});
  // FCM プッシュ通知（モバイルアプリ用）
  sendFcmNotificationForSession(sessionId, messageToSend).catch(() => {});
}

export async function sendMessage(platform: Platform, chatId: string, message: string, files?: FileAttachment[], projectId?: string | null) {
  switch (platform) {
    case 'discord':
      await sendDiscordMessage(chatId, message, files);
      break;
    case 'telegram':
      await sendTelegramMessage(chatId, message, files);
      break;
    case 'web':
      await sendWebMessage(chatId, message, files, projectId);
      break;
    case 'line':
      // await sendLineMessage(chatId, message, files);
      console.log(`[LINE] ${chatId}: ${message}`);
      break;
    case 'slack':
      // await sendSlackMessage(chatId, message, files);
      console.log(`[Slack] ${chatId}: ${message}`);
      break;
  }
}

export async function getRecentSessions(userId: string, limit: number = 5) {
  return prisma.session.findMany({
    where: { userId },
    orderBy: { startedAt: 'desc' },
    take: limit,
    include: {
      machine: true,
      project: true,
      _count: { select: { messages: true } }
    }
  });
}

export async function getSessionMessages(sessionId: string, limit: number = 10) {
  return prisma.message.findMany({
    where: { sessionId },
    orderBy: { createdAt: 'desc' },
    take: limit
  });
}

// Clear all sessions for a specific machine (called when machine goes offline)
export async function clearSessionsForMachine(machineId: string) {
  const sessionsToClear: string[] = [];

  for (const [sessionId, participants] of sessionParticipants.entries()) {
    // Get session info from DB to check if it belongs to this machine
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      select: { machineId: true },
    });

    if (session && session.machineId === machineId) {
      sessionsToClear.push(sessionId);

      // Notify participants that the session ended
      for (const { platform, chatId } of participants) {
        await sendMessage(platform, chatId, '⚠️ マシンがオフラインになったため、セッションが終了しました。`c` で再接続できます。');
      }
    }
  }

  // Clear the sessions
  for (const sessionId of sessionsToClear) {
    sessionParticipants.delete(sessionId);

    // Update DB session status
    await prisma.session.update({
      where: { id: sessionId },
      data: { status: 'ended', endedAt: new Date() },
    }).catch(() => {
      // Ignore errors if session doesn't exist
    });
  }

  if (sessionsToClear.length > 0) {
    console.log(`[SessionManager] Cleared ${sessionsToClear.length} sessions for machine ${machineId}`);
  }
}

// Get all active sessions (in-memory sessions with participants)
/**
 * メモリ内のアクティブセッション（参加者がいるセッション）を取得
 * displayName が設定されている場合は machineDisplayName に反映
 */
export async function getActiveSessions() {
  const activeSessions: Array<{
    sessionId: string;
    machineName: string;
    machineDisplayName: string;
    projectName: string;
    aiTool: string;
    participants: Array<{ platform: Platform; chatId: string }>;
    startedAt: Date;
  }> = [];

  for (const [sessionId, participants] of sessionParticipants.entries()) {
    if (participants.length === 0) continue;

    // Get session info from DB
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      include: {
        machine: true,
        project: true,
      },
    });

    if (session && session.status === 'active') {
      activeSessions.push({
        sessionId,
        machineName: session.machine.name,
        machineDisplayName: session.machine.displayName ?? session.machine.name,
        projectName: session.project.name,
        aiTool: session.aiTool,
        participants,
        startedAt: session.startedAt,
      });
    }
  }

  return activeSessions;
}
