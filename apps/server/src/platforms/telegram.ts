import TelegramBot, { Message } from 'node-telegram-bot-api';
import type { FileAttachment } from '@devrelay/shared';
import { parseCommandWithNLP } from '../services/command-parser.js';
import { executeCommand, getUserContext } from '../services/command-handler.js';

// Max file size to download (5MB)
const MAX_DOWNLOAD_SIZE = 5 * 1024 * 1024;

let bot: TelegramBot | null = null;

async function downloadFile(fileId: string): Promise<FileAttachment | null> {
  if (!bot) return null;

  try {
    const file = await bot.getFile(fileId);
    if (!file.file_path) return null;

    // Check file size (Telegram provides file_size for files under 20MB)
    if (file.file_size && file.file_size > MAX_DOWNLOAD_SIZE) {
      console.log(`⚠️ File too large: ${file.file_path} (${file.file_size} bytes)`);
      return null;
    }

    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    const response = await fetch(fileUrl);
    if (!response.ok) {
      console.error(`Failed to download file: ${response.status}`);
      return null;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const filename = file.file_path.split('/').pop() || 'file';

    // Guess mime type from extension
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    const mimeTypes: Record<string, string> = {
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'png': 'image/png',
      'gif': 'image/gif',
      'pdf': 'application/pdf',
      'txt': 'text/plain',
      'json': 'application/json',
      'zip': 'application/zip',
    };

    return {
      filename,
      content: buffer.toString('base64'),
      mimeType: mimeTypes[ext] || 'application/octet-stream',
      size: buffer.length,
    };
  } catch (err: any) {
    console.error(`Failed to download file:`, err.message);
    return null;
  }
}

export async function setupTelegramBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN is required');
  }

  // Create bot with polling (no webhook needed)
  bot = new TelegramBot(token, { polling: true });

  const botInfo = await bot.getMe();
  console.log(`🤖 Telegram bot logged in as @${botInfo.username}`);

  bot.on('message', async (msg: Message) => {
    // Get chat info
    const chatId = msg.chat.id.toString();
    const userId = msg.from?.id.toString() || chatId;
    const username = msg.from?.username || msg.from?.first_name || 'User';

    console.log(`📨 Message received: "${msg.text || '[file]'}" from @${username} (ID: ${userId})`);

    // Ignore messages without content
    if (!msg.text && !msg.document && !msg.photo) return;

    try {
      // Get or create user context
      const context = await getUserContext(userId, 'telegram', chatId);

      // Download files if present
      const files: FileAttachment[] = [];

      // Handle document attachments
      if (msg.document) {
        console.log(`📎 Downloading document: ${msg.document.file_name}`);
        const file = await downloadFile(msg.document.file_id);
        if (file) {
          // Use original filename if available
          file.filename = msg.document.file_name || file.filename;
          console.log(`✅ Downloaded: ${file.filename} (${file.size} bytes)`);
          files.push(file);
        }
      }

      // Handle photo attachments (get the largest size)
      if (msg.photo && msg.photo.length > 0) {
        const largestPhoto = msg.photo[msg.photo.length - 1];
        console.log(`📎 Downloading photo...`);
        const file = await downloadFile(largestPhoto.file_id);
        if (file) {
          console.log(`✅ Downloaded photo: ${file.filename} (${file.size} bytes)`);
          files.push(file);
        }
      }

      // Parse and execute command (with NLP if enabled)
      const content = msg.text || '';
      const command = await parseCommandWithNLP(content, context);
      const response = await executeCommand(command, context, files);

      // Send response (skip if empty - progress tracking handles it)
      if (response) {
        await sendTelegramMessage(chatId, response);
      }
    } catch (error) {
      console.error('Telegram message handling error:', error);
      await sendTelegramMessage(chatId, '❌ エラーが発生しました。しばらくしてからお試しください。');
    }
  });

  bot.on('polling_error', (error) => {
    console.error('Telegram polling error:', error.message);
  });
}

export async function sendTelegramMessage(chatId: string, content: string, files?: FileAttachment[]) {
  if (!bot) {
    console.error('Telegram bot not initialized');
    return;
  }

  try {
    // Send files first if present
    if (files && files.length > 0) {
      for (const file of files) {
        const buffer = Buffer.from(file.content, 'base64');
        console.log(`📎 Sending file: ${file.filename} (${file.size} bytes)`);
        await bot.sendDocument(chatId, buffer, {}, { filename: file.filename, contentType: file.mimeType });
      }
    }

    // Send text message if present
    if (content) {
      // Telegram has 4096 character limit per message
      const MAX_LENGTH = 4096;
      if (content.length <= MAX_LENGTH) {
        await bot.sendMessage(chatId, content);
      } else {
        // Split long messages
        const chunks = splitMessage(content, MAX_LENGTH);
        for (const chunk of chunks) {
          await bot.sendMessage(chatId, chunk);
        }
      }
    }
  } catch (error) {
    console.error('Failed to send Telegram message:', error);
  }
}

function splitMessage(content: string, maxLength: number): string[] {
  const chunks: string[] = [];
  let remaining = content;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a newline
    let splitIndex = remaining.lastIndexOf('\n', maxLength);
    if (splitIndex === -1 || splitIndex < maxLength / 2) {
      // Try to split at a space
      splitIndex = remaining.lastIndexOf(' ', maxLength);
    }
    if (splitIndex === -1 || splitIndex < maxLength / 2) {
      // Force split at maxLength
      splitIndex = maxLength;
    }

    chunks.push(remaining.substring(0, splitIndex));
    remaining = remaining.substring(splitIndex).trimStart();
  }

  return chunks;
}

export function getTelegramBot() {
  return bot;
}

// Typing indicator management
const typingIntervals = new Map<string, NodeJS.Timeout>();

export async function startTypingIndicator(chatId: string) {
  if (!bot) return;

  // Stop any existing typing for this chat
  stopTypingIndicator(chatId);

  try {
    // Send initial typing action
    await bot.sendChatAction(chatId, 'typing');

    // Keep sending typing every 4 seconds (Telegram typing lasts ~5 seconds)
    const interval = setInterval(async () => {
      try {
        await bot!.sendChatAction(chatId, 'typing');
      } catch {
        stopTypingIndicator(chatId);
      }
    }, 4000);

    typingIntervals.set(chatId, interval);
  } catch (err) {
    console.error('Failed to start typing indicator:', err);
  }
}

export function stopTypingIndicator(chatId: string) {
  const interval = typingIntervals.get(chatId);
  if (interval) {
    clearInterval(interval);
    typingIntervals.delete(chatId);
  }
}

// Send a message and return the message ID for later editing
export async function sendTelegramMessageWithId(chatId: string, content: string): Promise<number | null> {
  if (!bot) {
    console.error('Telegram bot not initialized');
    return null;
  }

  try {
    const message = await bot.sendMessage(chatId, content);
    return message.message_id;
  } catch (error) {
    console.error('Failed to send Telegram message:', error);
    return null;
  }
}

// Edit an existing message
export async function editTelegramMessage(chatId: string, messageId: number, content: string): Promise<boolean> {
  if (!bot) {
    console.error('Telegram bot not initialized');
    return false;
  }

  try {
    // Telegram has 4096 character limit, truncate if needed
    const MAX_LENGTH = 4096;
    const truncatedContent = content.length > MAX_LENGTH
      ? content.substring(0, MAX_LENGTH - 3) + '...'
      : content;

    await bot.editMessageText(truncatedContent, {
      chat_id: chatId,
      message_id: messageId,
    });
    return true;
  } catch (error: any) {
    // Ignore "message is not modified" errors
    if (!error.message?.includes('message is not modified')) {
      console.error('Failed to edit Telegram message:', error);
    }
    return false;
  }
}
