import type { Platform, UserContext, Session, FileAttachment } from '@devbridge/shared';
import { prisma } from '../db/client.js';
import { sendDiscordMessage } from '../platforms/discord.js';
// import { sendTelegramMessage } from '../platforms/telegram.js';
// import { sendLineMessage } from '../platforms/line.js';

// Active sessions: sessionId -> Session participants
const sessionParticipants = new Map<string, Array<{ platform: Platform; chatId: string }>>();

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
    await sendMessage(platform, chatId, message, files);
  }
}

export async function sendMessage(platform: Platform, chatId: string, message: string, files?: FileAttachment[]) {
  switch (platform) {
    case 'discord':
      await sendDiscordMessage(chatId, message, files);
      break;
    case 'telegram':
      // await sendTelegramMessage(chatId, message, files);
      console.log(`[Telegram] ${chatId}: ${message}`);
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
