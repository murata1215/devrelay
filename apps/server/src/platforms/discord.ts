import { Client, GatewayIntentBits, Events, Message, AttachmentBuilder, Attachment, Collection, TextChannel, DMChannel, ButtonBuilder, ActionRowBuilder, ButtonStyle, ComponentType } from 'discord.js';
import type { FileAttachment, ToolApprovalPromptPayload } from '@devrelay/shared';
import { parseCommandWithNLP } from '../services/command-parser.js';
import { executeCommand, getUserContext } from '../services/command-handler.js';
import { handleToolApprovalUserResponse } from '../services/agent-manager.js';
import { prisma } from '../db/client.js';
import { formatToolInputForText } from '../services/tool-format.js';

// Max file size to download (5MB)
const MAX_DOWNLOAD_SIZE = 5 * 1024 * 1024;

// Discord message limit (using 1500 for safety with emojis/multibyte chars)
const MAX_MESSAGE_LENGTH = 1500;

/**
 * Split a long message into chunks that fit within Discord's limit
 * Tries to split at newlines for better readability
 */
function splitMessage(content: string): string[] {
  const chunks: string[] = [];
  let remaining = content;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_MESSAGE_LENGTH) {
      chunks.push(remaining);
      break;
    }

    // Find the last newline within the limit
    let splitIndex = remaining.lastIndexOf('\n', MAX_MESSAGE_LENGTH);

    // If no newline found, try to split at a space
    if (splitIndex <= 0) {
      splitIndex = remaining.lastIndexOf(' ', MAX_MESSAGE_LENGTH);
    }

    // If still no good split point, force split at max length
    if (splitIndex <= 0) {
      splitIndex = MAX_MESSAGE_LENGTH;
    }

    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex).trimStart();
  }

  return chunks;
}

// Max messages to fetch when catching up on missed messages
const MAX_CATCHUP_MESSAGES = 50;

/**
 * Fetch messages between the last mention and now
 * Returns messages in chronological order (oldest first)
 */
async function fetchMessagesSinceLastMention(
  channel: TextChannel | DMChannel,
  lastMentionMessageId: string | null,
  currentMessageId: string,
  botId: string
): Promise<Array<{ role: 'user' | 'assistant'; content: string; timestamp: Date }>> {
  const messages: Array<{ role: 'user' | 'assistant'; content: string; timestamp: Date }> = [];

  if (!lastMentionMessageId) {
    // No previous mention, skip catching up
    return messages;
  }

  try {
    // Fetch messages after the last mention
    const fetchedMessages = await channel.messages.fetch({
      after: lastMentionMessageId,
      limit: MAX_CATCHUP_MESSAGES
    });

    // Filter and convert messages
    for (const [id, msg] of fetchedMessages) {
      // Skip the current message (it will be handled separately)
      if (id === currentMessageId) continue;

      // Skip system messages
      if (msg.system) continue;

      // Determine role
      const isBot = msg.author.id === botId;
      const role = isBot ? 'assistant' : 'user';

      // Get content (remove mention if present)
      let content = msg.content;
      if (!isBot) {
        content = content.replace(/<@!?\d+>/g, '').trim();
      }

      // Skip empty messages
      if (!content) continue;

      messages.push({
        role,
        content,
        timestamp: msg.createdAt
      });
    }

    // Sort by timestamp (oldest first)
    messages.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    console.log(`📨 Fetched ${messages.length} messages since last mention`);
  } catch (err) {
    console.error('Failed to fetch messages since last mention:', err);
  }

  return messages;
}

/**
 * Update the last mention message ID in the database
 */
async function updateLastMentionMessageId(
  platform: string,
  platformUserId: string,
  messageId: string
): Promise<void> {
  try {
    await prisma.platformLink.updateMany({
      where: { platform, platformUserId },
      data: {
        lastMentionMessageId: messageId,
        lastMentionAt: new Date()
      }
    });
  } catch (err) {
    console.error('Failed to update last mention message ID:', err);
  }
}

/**
 * Get the last mention message ID from the database
 */
async function getLastMentionMessageId(
  platform: string,
  platformUserId: string
): Promise<string | null> {
  try {
    const link = await prisma.platformLink.findUnique({
      where: { platform_platformUserId: { platform, platformUserId } }
    });
    return link?.lastMentionMessageId || null;
  } catch (err) {
    console.error('Failed to get last mention message ID:', err);
    return null;
  }
}

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

export async function setupDiscordBot(token?: string) {
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

      // If this is a mention in a guild channel, fetch messages since last mention
      let missedMessages: Array<{ role: 'user' | 'assistant'; content: string; timestamp: Date }> = [];
      if (isMentioned && !isDM && message.channel.isTextBased()) {
        const lastMentionMessageId = await getLastMentionMessageId('discord', message.author.id);
        missedMessages = await fetchMessagesSinceLastMention(
          message.channel as TextChannel,
          lastMentionMessageId,
          message.id,
          client!.user!.id
        );

        // Update last mention message ID
        await updateLastMentionMessageId('discord', message.author.id, message.id);
      }

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

      // Parse and execute command (with NLP if enabled)
      const command = await parseCommandWithNLP(content || '', context);
      console.log(`📨 Discord: executing command type=${command.type}, input="${(content || '').substring(0, 50)}"`);
      const response = await executeCommand(command, context, files, missedMessages);
      console.log(`📨 Discord: response ${response ? `(${response.length} chars): ${response.substring(0, 80)}...` : '(empty)'}`);

      // Send response (skip if empty - progress tracking handles it)
      if (response) {
        // Split response if it exceeds Discord's limit
        const chunks = splitMessage(response);

        // Reply with first chunk
        await message.reply(chunks[0]);

        // Send remaining chunks as follow-up messages
        for (let i = 1; i < chunks.length; i++) {
          await (message.channel as TextChannel | DMChannel).send(chunks[i]);
        }
      }
    } catch (error) {
      console.error('Discord message handling error:', error);
      await message.reply('❌ エラーが発生しました。しばらくしてからお試しください。');
    }
  });

  // ツール承認ボタンのインタラクションハンドラを登録
  setupToolApprovalInteractionHandler();

  await client.login(token || process.env.DISCORD_BOT_TOKEN);
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

      // Split content into chunks if needed
      const chunks = content ? splitMessage(content) : [''];

      // Send first chunk with attachments
      if (attachments.length > 0) {
        await (channel as any).send({
          content: chunks[0] || undefined,
          files: attachments,
        });
        // Send remaining chunks without attachments
        for (let i = 1; i < chunks.length; i++) {
          await (channel as any).send(chunks[i]);
        }
      } else if (content) {
        // Send all chunks
        for (const chunk of chunks) {
          await (channel as any).send(chunk);
        }
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
// Note: If content exceeds limit, only first chunk is returned for editing
export async function sendDiscordMessageWithId(channelId: string, content: string): Promise<string | null> {
  if (!client) {
    console.error('Discord client not initialized');
    return null;
  }

  try {
    const channel = await client.channels.fetch(channelId);
    if (channel && channel.isTextBased() && 'send' in channel) {
      const chunks = splitMessage(content);

      // Send first chunk and get message ID
      const message = await (channel as any).send(chunks[0]);

      // Send remaining chunks (won't be editable)
      for (let i = 1; i < chunks.length; i++) {
        await (channel as any).send(chunks[i]);
      }

      return message.id;
    }
  } catch (error) {
    console.error('Failed to send Discord message:', error);
  }
  return null;
}

// Edit an existing message (splits if content exceeds limit)
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
        const chunks = splitMessage(content);

        // Edit original message with first chunk
        await message.edit(chunks[0]);

        // Send remaining chunks as new messages
        for (let i = 1; i < chunks.length; i++) {
          await (channel as any).send(chunks[i]);
        }

        return true;
      }
    }
  } catch (error) {
    console.error('Failed to edit Discord message:', error);
  }
  return false;
}

// -----------------------------------------------------------------------------
// Tool Approval: Discord ボタン承認
// -----------------------------------------------------------------------------

/** requestId → Discord メッセージ情報（ボタン無効化・編集用） */
const toolApprovalMessages = new Map<string, { channelId: string; messageId: string }>();

/**
 * Discord チャンネルにツール承認リクエストをボタン付きで送信する
 */
export async function sendDiscordToolApproval(channelId: string, payload: ToolApprovalPromptPayload): Promise<void> {
  if (!client) {
    console.error('Discord client not initialized');
    return;
  }

  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased() || !('send' in channel)) return;

    const inputText = formatToolInputForText(payload.toolName, payload.toolInput);
    const content = `🔧 **ツール承認が必要です**\n\`${payload.toolName}\`${inputText ? `\n\`\`\`\n${inputText}\n\`\`\`` : ''}`;

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`ta_allow_${payload.requestId}`)
        .setLabel('許可')
        .setEmoji('✅')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`ta_deny_${payload.requestId}`)
        .setLabel('拒否')
        .setEmoji('❌')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`ta_approveall_${payload.requestId}`)
        .setLabel('以降すべて許可')
        .setEmoji('🔓')
        .setStyle(ButtonStyle.Secondary),
    );

    const msg = await (channel as any).send({ content, components: [row] });
    toolApprovalMessages.set(payload.requestId, { channelId, messageId: msg.id });
    console.log(`🔐 Discord tool approval sent: ${payload.toolName} (${payload.requestId.substring(0, 8)}...)`);
  } catch (error) {
    console.error('Failed to send Discord tool approval:', error);
  }
}

/**
 * 他プラットフォームで承認済みの場合に Discord メッセージのボタンを無効化する
 */
export async function resolveDiscordToolApproval(requestId: string, behavior: 'allow' | 'deny'): Promise<void> {
  const info = toolApprovalMessages.get(requestId);
  if (!info || !client) return;
  toolApprovalMessages.delete(requestId);

  try {
    const channel = await client.channels.fetch(info.channelId);
    if (!channel || !channel.isTextBased() || !('messages' in channel)) return;

    const msg = await (channel as any).messages.fetch(info.messageId);
    if (!msg) return;

    const statusText = behavior === 'allow' ? '✅ **許可されました**' : '❌ **拒否されました**';
    await msg.edit({ content: `${msg.content}\n${statusText}`, components: [] });
  } catch (error) {
    console.error('Failed to resolve Discord tool approval message:', error);
  }
}

/**
 * Discord チャンネルに自動承認通知を送信する（ボタンなし）
 */
export async function sendDiscordToolApprovalAuto(channelId: string, toolName: string, toolInput: Record<string, unknown>): Promise<void> {
  if (!client) return;

  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased() || !('send' in channel)) return;

    const inputText = formatToolInputForText(toolName, toolInput);
    const content = `🔓 自動承認: \`${toolName}\`${inputText ? ` — ${inputText.substring(0, 100)}` : ''}`;
    await (channel as any).send(content);
  } catch (error) {
    console.error('Failed to send Discord auto approval:', error);
  }
}

/**
 * Discord の InteractionCreate ハンドラを設定する（ボタン承認用）
 * setupDiscordBot() から呼ばれる
 */
function setupToolApprovalInteractionHandler() {
  if (!client) return;

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton()) return;

    const customId = interaction.customId;
    if (!customId.startsWith('ta_')) return;

    // customId 形式: ta_<action>_<requestId>
    const parts = customId.split('_');
    if (parts.length < 3) return;
    const action = parts[1]; // allow, deny, approveall
    const requestId = parts.slice(2).join('_'); // requestId に _ が含まれる可能性に対応

    let behavior: 'allow' | 'deny';
    let approveAll = false;

    if (action === 'allow') {
      behavior = 'allow';
    } else if (action === 'deny') {
      behavior = 'deny';
    } else if (action === 'approveall') {
      behavior = 'allow';
      approveAll = true;
    } else {
      return;
    }

    console.log(`🔐 Discord button: ${behavior}${approveAll ? ' (approve-all)' : ''} (${requestId.substring(0, 8)}...)`);

    // agent-manager に応答を転送
    const handled = handleToolApprovalUserResponse(requestId, { behavior, approveAll });

    if (handled) {
      // ボタンを無効化して結果を表示
      toolApprovalMessages.delete(requestId);
      const statusText = behavior === 'allow'
        ? (approveAll ? '🔓 **以降すべて許可しました**' : '✅ **許可しました**')
        : '❌ **拒否しました**';

      try {
        await interaction.update({
          content: `${interaction.message.content}\n${statusText}`,
          components: [],
        });
      } catch (err) {
        console.error('Failed to update Discord interaction:', err);
      }
    } else {
      // 既に応答済みまたはタイムアウト
      try {
        await interaction.update({
          content: `${interaction.message.content}\n⚠️ **この承認は既に処理済みです**`,
          components: [],
        });
      } catch (err) {
        console.error('Failed to update Discord interaction:', err);
      }
    }
  });

  console.log('🔐 Discord tool approval interaction handler registered');
}
