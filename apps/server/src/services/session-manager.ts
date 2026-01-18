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
// import { sendLineMessage } from '../platforms/line.js';

// Active sessions: sessionId -> Session participants
const sessionParticipants = new Map<string, Array<{ platform: Platform; chatId: string }>>();

// Progress tracking for streaming output
interface MessageInfo {
  messageId: string | number;  // string for Discord, number for Telegram
  platform: Platform;
}
interface ProgressTracker {
  messages: Map<string, MessageInfo>;  // chatId -> { messageId, platform }
  outputBuffer: string;
  startTime: number;
  updateInterval: NodeJS.Timeout | null;
}
const progressTrackers = new Map<string, ProgressTracker>();

const PROGRESS_UPDATE_INTERVAL = 8000; // 8 seconds
const MAX_OUTPUT_LINES = 15;

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

export async function endSession(sessionId: string) {
  await prisma.session.update({
    where: { id: sessionId },
    data: { status: 'ended', endedAt: new Date() }
  });
  
  sessionParticipants.delete(sessionId);
}

export async function broadcastToSession(sessionId: string, message: string, isComplete: boolean, files?: FileAttachment[]) {
  const participants = sessionParticipants.get(sessionId) || [];

  for (const { platform, chatId } of participants) {
    // Stop typing indicator when response is complete
    if (isComplete) {
      if (platform === 'discord') {
        stopDiscordTyping(chatId);
      } else if (platform === 'telegram') {
        stopTelegramTyping(chatId);
      }
    }
    await sendMessage(platform, chatId, message, files);
  }
}

export async function startTypingForSession(sessionId: string) {
  const participants = sessionParticipants.get(sessionId) || [];

  for (const { platform, chatId } of participants) {
    if (platform === 'discord') {
      await startDiscordTyping(chatId);
    } else if (platform === 'telegram') {
      await startTelegramTyping(chatId);
    }
  }
}

// Start progress tracking for a session
export async function startProgressTracking(sessionId: string) {
  const participants = sessionParticipants.get(sessionId) || [];

  // Clean up any existing tracker
  stopProgressTracking(sessionId);

  const tracker: ProgressTracker = {
    messages: new Map(),
    outputBuffer: '',
    startTime: Date.now(),
    updateInterval: null,
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
    }
  }

  // Start periodic updates
  tracker.updateInterval = setInterval(() => {
    updateProgressMessages(sessionId);
  }, PROGRESS_UPDATE_INTERVAL);

  progressTrackers.set(sessionId, tracker);
}

// Add output to the buffer
export function appendSessionOutput(sessionId: string, output: string) {
  const tracker = progressTrackers.get(sessionId);
  if (tracker) {
    tracker.outputBuffer += output;
    console.log(`📝 Buffer updated: ${tracker.outputBuffer.length} chars total`);
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

// Stop progress tracking and clean up
export function stopProgressTracking(sessionId: string) {
  const tracker = progressTrackers.get(sessionId);
  if (tracker) {
    if (tracker.updateInterval) {
      clearInterval(tracker.updateInterval);
    }
    progressTrackers.delete(sessionId);
  }
}

// Finalize progress with final message
export async function finalizeProgress(sessionId: string, finalMessage: string, files?: FileAttachment[]) {
  const tracker = progressTrackers.get(sessionId);
  const participants = sessionParticipants.get(sessionId) || [];

  // Stop the update interval
  if (tracker?.updateInterval) {
    clearInterval(tracker.updateInterval);
  }

  // Delete progress messages and send final response
  for (const { platform, chatId } of participants) {
    const msgInfo = tracker?.messages.get(chatId);

    if (platform === 'discord') {
      stopDiscordTyping(chatId);

      // Edit progress message to show completion, or send new message
      if (msgInfo && !files?.length) {
        // Edit existing message with final content
        await editDiscordMessage(chatId, msgInfo.messageId as string, finalMessage);
      } else {
        // Delete progress message and send new one with files
        if (msgInfo) {
          await editDiscordMessage(chatId, msgInfo.messageId as string, '✅ 完了');
        }
        await sendDiscordMessage(chatId, finalMessage, files);
      }
    } else if (platform === 'telegram') {
      stopTelegramTyping(chatId);

      // Edit progress message to show completion, or send new message
      if (msgInfo && !files?.length) {
        // Edit existing message with final content
        await editTelegramMessage(chatId, msgInfo.messageId as number, finalMessage);
      } else {
        // Delete progress message and send new one with files
        if (msgInfo) {
          await editTelegramMessage(chatId, msgInfo.messageId as number, '✅ 完了');
        }
        await sendTelegramMessage(chatId, finalMessage, files);
      }
    }
  }

  progressTrackers.delete(sessionId);
}

export async function sendMessage(platform: Platform, chatId: string, message: string, files?: FileAttachment[]) {
  switch (platform) {
    case 'discord':
      await sendDiscordMessage(chatId, message, files);
      break;
    case 'telegram':
      await sendTelegramMessage(chatId, message, files);
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
