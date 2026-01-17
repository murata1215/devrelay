import { Client, GatewayIntentBits, Events, Message, AttachmentBuilder, Attachment } from 'discord.js';
import type { FileAttachment } from '@devbridge/shared';
import { parseCommand } from '../services/command-parser.js';
import { executeCommand, getUserContext } from '../services/command-handler.js';

// Max file size to download (5MB)
const MAX_DOWNLOAD_SIZE = 5 * 1024 * 1024;

async function downloadAttachment(attachment: Attachment): Promise<FileAttachment | null> {
  try {
    if (attachment.size > MAX_DOWNLOAD_SIZE) {
      console.log(`⚠️ Attachment too large: ${attachment.name} (${attachment.size} bytes)`);
      return null;
    }

    const response = await fetch(attachment.url);
    if (!response.ok) {
      console.error(`Failed to download attachment: ${response.status}`);
      return null;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    return {
      filename: attachment.name || 'file',
      content: buffer.toString('base64'),
      mimeType: attachment.contentType || 'application/octet-stream',
      size: attachment.size,
    };
  } catch (err: any) {
    console.error(`Failed to download attachment ${attachment.name}:`, err.message);
    return null;
  }
}

let client: Client | null = null;

export async function setupDiscordBot() {
  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.once(Events.ClientReady, (c) => {
    console.log(`🤖 Discord bot logged in as ${c.user.tag}`);
  });

  client.on(Events.MessageCreate, async (message: Message) => {
    console.log(`📨 Message received: "${message.content}" from ${message.author.tag} (ID: ${message.author.id})`);

    // Ignore bot messages
    if (message.author.bot) return;

    // Only respond to DMs or mentions
    const isDM = !message.guild;
    const isMentioned = message.mentions.has(client!.user!.id);

    if (!isDM && !isMentioned) return;

    // Get message content (remove mention if present)
    let content = message.content;
    if (isMentioned) {
      content = content.replace(/<@!?\d+>/g, '').trim();
    }

    if (!content && message.attachments.size === 0) return;

    try {
      // Get or create user context
      const context = await getUserContext(
        message.author.id,
        'discord',
        message.channel.id
      );

      // Download attachments if present
      const files: FileAttachment[] = [];
      if (message.attachments.size > 0) {
        console.log(`📎 Downloading ${message.attachments.size} attachment(s)...`);
        for (const [, attachment] of message.attachments) {
          const file = await downloadAttachment(attachment);
          if (file) {
            console.log(`✅ Downloaded: ${file.filename} (${file.size} bytes)`);
            files.push(file);
          }
        }
      }

      // Parse and execute command
      const command = parseCommand(content || '', context);
      const response = await executeCommand(command, context, files);

      // Send response (skip if empty - progress tracking handles it)
      if (response) {
        await message.reply(response);
      }
    } catch (error) {
      console.error('Discord message handling error:', error);
      await message.reply('❌ エラーが発生しました。しばらくしてからお試しください。');
    }
  });

  await client.login(process.env.DISCORD_BOT_TOKEN);
}

export async function sendDiscordMessage(channelId: string, content: string, files?: FileAttachment[]) {
  if (!client) {
    console.error('Discord client not initialized');
    return;
  }

  try {
    const channel = await client.channels.fetch(channelId);
    if (channel && channel.isTextBased() && 'send' in channel) {
      // Build attachments from files
      const attachments: AttachmentBuilder[] = [];
      if (files && files.length > 0) {
        for (const file of files) {
          const buffer = Buffer.from(file.content, 'base64');
          const attachment = new AttachmentBuilder(buffer, { name: file.filename });
          attachments.push(attachment);
          console.log(`📎 Attaching file: ${file.filename} (${file.size} bytes)`);
        }
      }

      // Send message with attachments
      if (attachments.length > 0) {
        await (channel as any).send({
          content: content || undefined,
          files: attachments,
        });
      } else if (content) {
        await (channel as any).send(content);
      }
    }
  } catch (error) {
    console.error('Failed to send Discord message:', error);
  }
}

export function getDiscordClient() {
  return client;
}

// Typing indicator management
const typingIntervals = new Map<string, NodeJS.Timeout>();

export async function startTypingIndicator(channelId: string) {
  if (!client) return;

  // Stop any existing typing for this channel
  stopTypingIndicator(channelId);

  try {
    const channel = await client.channels.fetch(channelId);
    if (channel && channel.isTextBased() && 'sendTyping' in channel) {
      // Send initial typing
      await (channel as any).sendTyping();

      // Keep sending typing every 8 seconds (Discord typing lasts ~10 seconds)
      const interval = setInterval(async () => {
        try {
          await (channel as any).sendTyping();
        } catch {
          stopTypingIndicator(channelId);
        }
      }, 8000);

      typingIntervals.set(channelId, interval);
    }
  } catch (err) {
    console.error('Failed to start typing indicator:', err);
  }
}

export function stopTypingIndicator(channelId: string) {
  const interval = typingIntervals.get(channelId);
  if (interval) {
    clearInterval(interval);
    typingIntervals.delete(channelId);
  }
}

// Send a message and return the message ID for later editing
export async function sendDiscordMessageWithId(channelId: string, content: string): Promise<string | null> {
  if (!client) {
    console.error('Discord client not initialized');
    return null;
  }

  try {
    const channel = await client.channels.fetch(channelId);
    if (channel && channel.isTextBased() && 'send' in channel) {
      const message = await (channel as any).send(content);
      return message.id;
    }
  } catch (error) {
    console.error('Failed to send Discord message:', error);
  }
  return null;
}

// Edit an existing message
export async function editDiscordMessage(channelId: string, messageId: string, content: string): Promise<boolean> {
  if (!client) {
    console.error('Discord client not initialized');
    return false;
  }

  try {
    const channel = await client.channels.fetch(channelId);
    if (channel && channel.isTextBased() && 'messages' in channel) {
      const message = await (channel as any).messages.fetch(messageId);
      if (message) {
        await message.edit(content);
        return true;
      }
    }
  } catch (error) {
    console.error('Failed to edit Discord message:', error);
  }
  return false;
}
