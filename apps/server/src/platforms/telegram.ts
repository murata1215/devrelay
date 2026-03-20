import TelegramBot, { Message } from 'node-telegram-bot-api';
import type { FileAttachment, ToolApprovalPromptPayload } from '@devrelay/shared';
import { parseCommandWithNLP } from '../services/command-parser.js';
import { executeCommand, getUserContext } from '../services/command-handler.js';
import { handleToolApprovalUserResponse } from '../services/agent-manager.js';
import { formatToolInputForText } from '../services/tool-format.js';

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

    const fileUrl = `https://api.telegram.org/file/bot${currentToken || process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
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

// トークンをモジュールレベルで保持（ファイルダウンロード用）
let currentToken: string | null = null;

export async function setupTelegramBot(providedToken?: string) {
  const token = providedToken || process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN is required');
  }
  currentToken = token;

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
      // Note: msg.caption is used when photo/document has a caption instead of msg.text
      const content = msg.text || msg.caption || '';
      const command = await parseCommandWithNLP(content, context);
      console.log(`📨 Telegram: executing command type=${command.type}, input="${content.substring(0, 50)}"`);
      const response = await executeCommand(command, context, files);
      console.log(`📨 Telegram: response ${response ? `(${response.length} chars): ${response.substring(0, 80)}...` : '(empty)'}`);

      // Send response (skip if empty - progress tracking handles it)
      if (response) {
        await sendTelegramMessage(chatId, response);
      }
    } catch (error) {
      console.error('Telegram message handling error:', error);
      await sendTelegramMessage(chatId, '❌ エラーが発生しました。しばらくしてからお試しください。');
    }
  });

  // ツール承認インラインキーボードのコールバックハンドラを登録
  setupToolApprovalCallbackHandler();

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

// -----------------------------------------------------------------------------
// Tool Approval: Telegram インラインキーボード承認
// -----------------------------------------------------------------------------

/** requestId → Telegram メッセージ情報（キーボード削除・編集用） */
const toolApprovalMessages = new Map<string, { chatId: string; messageId: number }>();

/**
 * Telegram チャットにツール承認リクエストをインラインキーボード付きで送信する
 */
export async function sendTelegramToolApproval(chatId: string, payload: ToolApprovalPromptPayload): Promise<void> {
  if (!bot) {
    console.error('Telegram bot not initialized');
    return;
  }

  try {
    // AskUserQuestion の場合: 質問 + 選択肢キーボードを表示
    if (payload.isQuestion) {
      const questions = (payload.toolInput as any).questions as Array<{ question: string; options: Array<{ label: string; description?: string }> }> || [];
      const q = questions[0];
      if (!q) return;

      const optionsText = q.options.map((o, i) => `${i + 1}. *${o.label}*${o.description ? ` — ${o.description}` : ''}`).join('\n');
      const content = `❓ *${q.question}*\n\n${optionsText}`;

      // 各選択肢をボタンとして表示（1行に2つまで）
      const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
      for (let i = 0; i < q.options.length; i += 2) {
        const row = [{ text: q.options[i].label, callback_data: `tq_${payload.requestId}_${i}` }];
        if (q.options[i + 1]) {
          row.push({ text: q.options[i + 1].label, callback_data: `tq_${payload.requestId}_${i + 1}` });
        }
        keyboard.push(row);
      }

      const msg = await bot.sendMessage(chatId, content, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard },
      });

      toolApprovalMessages.set(payload.requestId, { chatId, messageId: msg.message_id });
      console.log(`❓ Telegram question sent: ${q.question} (${payload.requestId.substring(0, 8)}...)`);
      return;
    }

    const inputText = formatToolInputForText(payload.toolName, payload.toolInput);
    const content = `🔧 *ツール承認が必要です*\n\`${payload.toolName}\`${inputText ? `\n\`\`\`\n${inputText}\n\`\`\`` : ''}`;

    const msg = await bot.sendMessage(chatId, content, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ 許可', callback_data: `ta_a_${payload.requestId}` },
            { text: '❌ 拒否', callback_data: `ta_d_${payload.requestId}` },
          ],
          [
            { text: '🔓 以降すべて許可', callback_data: `ta_aa_${payload.requestId}` },
            { text: '📌 常に許可', callback_data: `ta_al_${payload.requestId}` },
          ],
        ],
      },
    });

    toolApprovalMessages.set(payload.requestId, { chatId, messageId: msg.message_id });
    console.log(`🔐 Telegram tool approval sent: ${payload.toolName} (${payload.requestId.substring(0, 8)}...)`);
  } catch (error) {
    console.error('Failed to send Telegram tool approval:', error);
  }
}

/**
 * 他プラットフォームで承認済みの場合に Telegram メッセージのキーボードを削除する
 */
export async function resolveTelegramToolApproval(requestId: string, behavior: 'allow' | 'deny'): Promise<void> {
  const info = toolApprovalMessages.get(requestId);
  if (!info || !bot) return;
  toolApprovalMessages.delete(requestId);

  try {
    const statusText = behavior === 'allow' ? '✅ 許可されました' : '❌ 拒否されました';
    // キーボードを削除してステータスを追記
    await bot.editMessageReplyMarkup(
      { inline_keyboard: [] },
      { chat_id: info.chatId, message_id: info.messageId }
    );
    // テキストにステータスを追記
    await bot.editMessageText(
      `🔧 *ツール承認*\n${statusText}`,
      { chat_id: info.chatId, message_id: info.messageId, parse_mode: 'Markdown' }
    );
  } catch (error: any) {
    if (!error.message?.includes('message is not modified')) {
      console.error('Failed to resolve Telegram tool approval message:', error);
    }
  }
}

/**
 * Telegram チャットに自動承認通知を送信する（キーボードなし）
 */
export async function sendTelegramToolApprovalAuto(chatId: string, toolName: string, toolInput: Record<string, unknown>): Promise<void> {
  if (!bot) return;

  try {
    const inputText = formatToolInputForText(toolName, toolInput);
    const content = `🔓 自動承認: \`${toolName}\`${inputText ? ` — ${inputText.substring(0, 100)}` : ''}`;
    await bot.sendMessage(chatId, content, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('Failed to send Telegram auto approval:', error);
  }
}

/**
 * Telegram の callback_query ハンドラを設定する（インラインキーボード承認用）
 * setupTelegramBot() から呼ばれる
 */
function setupToolApprovalCallbackHandler() {
  if (!bot) return;

  bot.on('callback_query', async (query) => {
    // AskUserQuestion の質問回答（tq_ プレフィックス）
    if (query.data?.startsWith('tq_')) {
      const parts = query.data.split('_');
      if (parts.length < 3) return;
      const requestId = parts[1];
      const optionIndex = parseInt(parts[2], 10);

      // ボタンのテキストから選択肢を取得
      const selectedLabel = query.message?.reply_markup?.inline_keyboard
        ?.flat()
        ?.find(btn => btn.callback_data === query.data)
        ?.text || `Option ${optionIndex + 1}`;

      // 質問テキストをメッセージから抽出
      const questionMatch = query.message?.text?.match(/❓ (.+)/);
      const questionText = questionMatch?.[1]?.replace(/\*/g, '') || 'Question';

      console.log(`❓ Telegram question answered: "${selectedLabel}" (${requestId.substring(0, 8)}...)`);

      const answers: Record<string, string> = { [questionText]: selectedLabel };
      const handled = handleToolApprovalUserResponse(requestId, { behavior: 'allow', answers });

      if (handled) {
        toolApprovalMessages.delete(requestId);
        try {
          await bot!.answerCallbackQuery(query.id, { text: `回答: ${selectedLabel}` });
          if (query.message) {
            await bot!.editMessageText(
              `❓ *質問*\n✅ 回答: ${selectedLabel}`,
              { chat_id: query.message.chat.id, message_id: query.message.message_id, parse_mode: 'Markdown' }
            );
          }
        } catch (err) {
          console.error('Failed to update Telegram question callback:', err);
        }
      } else {
        try {
          await bot!.answerCallbackQuery(query.id, { text: '⚠️ この質問は既に回答済みです' });
        } catch (err) {
          console.error('Failed to update Telegram question callback:', err);
        }
      }
      return;
    }

    if (!query.data || !query.data.startsWith('ta_')) return;

    // callback_data 形式: ta_<action>_<requestId>
    const parts = query.data.split('_');
    if (parts.length < 3) return;
    const action = parts[1]; // a(allow), d(deny), aa(approveall), al(always-allow)
    const requestId = parts.slice(2).join('_');

    let behavior: 'allow' | 'deny';
    let approveAll = false;
    let alwaysAllow = false;

    if (action === 'a') {
      behavior = 'allow';
    } else if (action === 'd') {
      behavior = 'deny';
    } else if (action === 'aa') {
      behavior = 'allow';
      approveAll = true;
    } else if (action === 'al') {
      behavior = 'allow';
      alwaysAllow = true;
    } else {
      return;
    }

    const logSuffix = approveAll ? ' (approve-all)' : alwaysAllow ? ' (always-allow)' : '';
    console.log(`🔐 Telegram callback: ${behavior}${logSuffix} (${requestId.substring(0, 8)}...)`);

    // agent-manager に応答を転送
    const handled = handleToolApprovalUserResponse(requestId, { behavior, approveAll, alwaysAllow });

    if (handled) {
      // キーボードを削除して結果を表示
      toolApprovalMessages.delete(requestId);
      const statusText = behavior === 'allow'
        ? (approveAll ? '🔓 以降すべて許可しました' : alwaysAllow ? '📌 常に許可しました' : '✅ 許可しました')
        : '❌ 拒否しました';

      try {
        await bot!.answerCallbackQuery(query.id, { text: statusText });
        if (query.message) {
          await bot!.editMessageText(
            `🔧 *ツール承認*\n${statusText}`,
            { chat_id: query.message.chat.id, message_id: query.message.message_id, parse_mode: 'Markdown' }
          );
        }
      } catch (err) {
        console.error('Failed to update Telegram callback:', err);
      }
    } else {
      // 既に応答済みまたはタイムアウト
      try {
        await bot!.answerCallbackQuery(query.id, { text: '⚠️ この承認は既に処理済みです' });
        if (query.message) {
          await bot!.editMessageText(
            `🔧 *ツール承認*\n⚠️ この承認は既に処理済みです`,
            { chat_id: query.message.chat.id, message_id: query.message.message_id, parse_mode: 'Markdown' }
          );
        }
      } catch (err) {
        console.error('Failed to update Telegram callback:', err);
      }
    }
  });

  console.log('🔐 Telegram tool approval callback handler registered');
}
