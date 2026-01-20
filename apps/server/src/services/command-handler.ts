import type { UserCommand, UserContext, Platform, FileAttachment } from '@devrelay/shared';
import { STATUS_EMOJI, AI_TOOL_NAMES } from '@devrelay/shared';
import { prisma } from '../db/client.js';
import {
  getConnectedMachines,
  getMachine,
  startSession as startAgentSession,
  sendPromptToAgent,
  endSession as endAgentSession,
  clearConversation,
  execConversation,
  applyAgreement
} from './agent-manager.js';
import {
  createSession,
  addParticipant,
  endSession,
  getRecentSessions,
  getSessionMessages,
  startProgressTracking,
  sendMessage
} from './session-manager.js';
import { getHelpText } from './command-parser.js';
import { createLinkCode } from './platform-link.js';

// User context storage (in-memory, keyed by chatId for channel-based sessions)
// This allows different channels to have different active sessions
const userContexts = new Map<string, UserContext>();

export async function getUserContext(userId: string, platform: Platform, chatId: string): Promise<UserContext> {
  // Key by chatId to allow different sessions per channel
  const key = `${platform}:${chatId}`;
  let context = userContexts.get(key);

  if (!context) {
    // Load lastProjectId from ChannelSession (per-channel, not per-user)
    const channelSession = await prisma.channelSession.findUnique({
      where: { platform_chatId: { platform, chatId } }
    });

    context = {
      userId,
      platform,
      chatId,
      lastProjectId: channelSession?.lastProjectId ?? undefined
    };
    userContexts.set(key, context);
  }

  return context;
}

export async function updateUserContext(userId: string, platform: Platform, chatId: string, updates: Partial<UserContext>) {
  const key = `${platform}:${chatId}`;
  const context = userContexts.get(key);
  if (context) {
    Object.assign(context, updates);

    // Persist lastProjectId to ChannelSession (per-channel, not per-user)
    if ('lastProjectId' in updates) {
      await prisma.channelSession.upsert({
        where: { platform_chatId: { platform, chatId } },
        update: { lastProjectId: updates.lastProjectId ?? null },
        create: {
          platform,
          chatId,
          lastProjectId: updates.lastProjectId ?? null
        }
      });
    }
  }
}

// Missed messages from Discord (messages between last mention and current mention)
export interface MissedMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

export async function executeCommand(
  command: UserCommand,
  context: UserContext,
  files?: FileAttachment[],
  missedMessages?: MissedMessage[]
): Promise<string> {
  switch (command.type) {
    case 'machine:list':
      return handleMachineList(context);

    case 'project:list':
      return handleProjectList(context);

    case 'select':
      return handleSelect(command.number, context);

    case 'status':
      return handleStatus(context);

    case 'recent':
      return handleRecent(context);

    case 'continue':
      return handleContinue(context);

    case 'clear':
      return handleClear(context);

    case 'exec':
      return handleExec(context);

    case 'link':
      return handleLink(context);

    case 'agreement':
      return handleAgreement(context);

    case 'session':
      return handleSession(context);

    case 'log':
      return handleLog(context, command.count);

    case 'summary':
      return handleSummary(context, command.period);

    case 'quit':
      return handleQuit(context);

    case 'help':
      return getHelpText();

    case 'ai:switch':
      return handleAiSwitch(context, command.tool);

    case 'ai:prompt':
      return handleAiPrompt(context, command.text, files, missedMessages);

    default:
      return '❓ 不明なコマンドです。`h` でヘルプを表示できます。';
  }
}

// -----------------------------------------------------------------------------
// Command Handlers
// -----------------------------------------------------------------------------

async function handleMachineList(context: UserContext): Promise<string> {
  // Check if the user is linked to a WebUI account
  const platformLink = await prisma.platformLink.findUnique({
    where: {
      platform_platformUserId: {
        platform: context.platform,
        platformUserId: context.userId
      }
    },
    include: { user: true }
  });

  if (!platformLink?.linkedAt) {
    // Not linked to WebUI account
    return '⚠️ WebUI アカウントに連携されていません。\n\n'
      + '`link` コマンドでリンクコードを取得し、WebUI の Settings ページで入力してください。';
  }

  // Get machines for the linked WebUI user
  const machines = await prisma.machine.findMany({
    where: { userId: platformLink.userId }
  });

  if (machines.length === 0) {
    return '📡 登録されているマシンがありません。\n\n'
      + 'マシンを追加するには:\n'
      + '1. WebUI の Machines ページで「Add Machine」をクリック\n'
      + '2. 生成されたトークンをコピー\n'
      + '3. 対象マシンで `devrelay setup` を実行してトークンを入力';
  }

  const list = machines.map((m, i) => {
    const emoji = m.status === 'online' ? STATUS_EMOJI.online : STATUS_EMOJI.offline;
    return `${i + 1}. ${m.name} ${emoji}`;
  }).join('\n');

  // Update context
  await updateUserContext(context.userId, context.platform, context.chatId, {
    lastListType: 'machine',
    lastListItems: machines.map(m => m.id)
  });

  return `📡 **マシン一覧**\n\n${list}`;
}

async function handleProjectList(context: UserContext): Promise<string> {
  if (!context.currentMachineId) {
    return '⚠️ マシンに接続されていません。\n`m` でマシン一覧を表示して接続してください。';
  }
  
  const projects = await prisma.project.findMany({
    where: { machineId: context.currentMachineId }
  });
  
  if (projects.length === 0) {
    return '📁 プロジェクトが登録されていません。\n\nマシン側で `devrelay projects add <path>` を実行してください。';
  }
  
  const list = projects.map((p, i) => {
    return `${i + 1}. ${p.name}`;
  }).join('\n');
  
  await updateUserContext(context.userId, context.platform, context.chatId, {
    lastListType: 'project',
    lastListItems: projects.map(p => p.id)
  });
  
  return `📁 **プロジェクト** (${context.currentMachineName})\n\n${list}`;
}

async function handleSelect(number: number, context: UserContext): Promise<string> {
  const items = context.lastListItems;
  const listType = context.lastListType;
  
  if (!items || !listType) {
    return '⚠️ 選択できる一覧がありません。\n`m` または `p` で一覧を表示してください。';
  }
  
  const index = number - 1;
  if (index < 0 || index >= items.length) {
    return `⚠️ ${number} は範囲外です。1〜${items.length} の数字を入力してください。`;
  }
  
  const selectedId = items[index];
  
  if (listType === 'machine') {
    return handleMachineConnect(selectedId, context);
  } else if (listType === 'project') {
    return handleProjectConnect(selectedId, context);
  } else if (listType === 'recent') {
    return handleRecentConnect(selectedId, context);
  }
  
  return '⚠️ 不明な選択です。';
}

async function handleMachineConnect(machineId: string, context: UserContext): Promise<string> {
  const machine = await prisma.machine.findUnique({ where: { id: machineId } });
  
  if (!machine) {
    return '❌ マシンが見つかりません。';
  }
  
  if (machine.status !== 'online') {
    return `⚠️ ${machine.name} はオフラインです。`;
  }
  
  await updateUserContext(context.userId, context.platform, context.chatId, {
    currentMachineId: machine.id,
    currentMachineName: machine.name,
    lastListType: undefined,
    lastListItems: undefined
  });
  
  return `✅ **${machine.name}** に接続しました`;
}

async function handleProjectConnect(projectId: string, context: UserContext): Promise<string> {
  const project = await prisma.project.findUnique({ 
    where: { id: projectId },
    include: { machine: true }
  });
  
  if (!project) {
    return '❌ プロジェクトが見つかりません。';
  }
  
  // Get or create user
  let user = await prisma.user.findFirst({
    where: { platformLinks: { some: { platformUserId: context.userId } } }
  });
  
  if (!user) {
    // Auto-create user
    user = await prisma.user.create({
      data: {
        platformLinks: {
          create: {
            platform: context.platform,
            platformUserId: context.userId,
            chatId: context.chatId
          }
        }
      }
    });
  }
  
  // Create session
  const sessionId = await createSession(
    user.id,
    project.machineId,
    project.id,
    project.defaultAi
  );
  
  // Add participant
  addParticipant(sessionId, context.platform, context.chatId);
  
  // Start AI on agent
  await startAgentSession(
    project.machineId,
    sessionId,
    project.name,
    project.path,
    project.defaultAi as any
  );
  
  await updateUserContext(context.userId, context.platform, context.chatId, {
    currentSessionId: sessionId,
    currentProjectName: project.name,
    currentMachineId: project.machineId,
    currentMachineName: project.machine.name,
    lastProjectId: project.id,  // 再接続用に保存
    lastListType: undefined,
    lastListItems: undefined
  });

  const aiName = AI_TOOL_NAMES[project.defaultAi] || project.defaultAi;
  return `🚀 **${project.name}** に接続\n${aiName} 起動完了`;
}

async function handleRecentConnect(sessionId: string, context: UserContext): Promise<string> {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: { machine: true, project: true }
  });
  
  if (!session) {
    return '❌ セッションが見つかりません。';
  }
  
  // Connect to the same machine/project
  await updateUserContext(context.userId, context.platform, context.chatId, {
    currentMachineId: session.machineId,
    currentMachineName: session.machine.name
  });
  
  return handleProjectConnect(session.projectId, context);
}

async function handleStatus(context: UserContext): Promise<string> {
  if (!context.currentMachineId) {
    return '📊 未接続\n\n`m` でマシン一覧を表示';
  }
  
  const parts = [`📊 **ステータス**`];
  parts.push(`├── Machine: ${context.currentMachineName}`);
  
  if (context.currentProjectName) {
    parts.push(`├── Project: ${context.currentProjectName}`);
    parts.push(`└── Ready: ✅`);
  } else {
    parts.push(`└── Project: 未選択 (\`p\` で一覧表示)`);
  }
  
  return parts.join('\n');
}

async function handleRecent(context: UserContext): Promise<string> {
  // Get user
  const user = await prisma.user.findFirst({
    where: { platformLinks: { some: { platformUserId: context.userId } } }
  });
  
  if (!user) {
    return '📜 作業履歴がありません。';
  }
  
  const sessions = await getRecentSessions(user.id, 5);
  
  if (sessions.length === 0) {
    return '📜 作業履歴がありません。';
  }
  
  const list = sessions.map((s, i) => {
    const date = formatRelativeDate(s.startedAt);
    return `${i + 1}. ${s.machine.name}/${s.project.name} (${date})`;
  }).join('\n');
  
  await updateUserContext(context.userId, context.platform, context.chatId, {
    lastListType: 'recent',
    lastListItems: sessions.map(s => s.id)
  });
  
  return `📜 **直近の作業**\n\n${list}`;
}

async function handleContinue(context: UserContext): Promise<string> {
  // Check if we have a last project ID
  if (!context.lastProjectId) {
    return '⚠️ 前回の接続先がありません。\n\n`m` でマシン一覧を表示して接続してください。';
  }

  // Verify the project still exists and machine is online
  const project = await prisma.project.findUnique({
    where: { id: context.lastProjectId },
    include: { machine: true }
  });

  if (!project) {
    return '❌ 前回のプロジェクトが見つかりません。\n\n`m` でマシン一覧を表示して接続してください。';
  }

  if (project.machine.status !== 'online') {
    return `⚠️ **${project.machine.name}** はオフラインです。\n\n`
      + `前回: ${project.machine.name}/${project.name}`;
  }

  // Connect to the project
  return handleProjectConnect(project.id, context);
}

async function handleClear(context: UserContext): Promise<string> {
  if (!context.currentSessionId || !context.currentMachineId) {
    return '⚠️ プロジェクトに接続されていません。';
  }

  // Get project path from session
  const session = await prisma.session.findUnique({
    where: { id: context.currentSessionId },
    include: { project: true }
  });

  if (!session) {
    return '❌ セッションが見つかりません。';
  }

  // Send clear command to agent
  await clearConversation(
    context.currentMachineId,
    context.currentSessionId,
    session.project.path
  );

  return '🗑️ 会話履歴をクリアしました';
}

async function handleExec(context: UserContext): Promise<string> {
  // プロジェクト未接続の場合、自動再接続を試みる
  if (!context.currentSessionId || !context.currentMachineId) {
    // 前回の接続先がある場合は自動再接続を試みる
    if (context.lastProjectId) {
      console.log(`🔄 [exec] Auto-reconnecting to last project: ${context.lastProjectId}`);
      const reconnectResult = await handleContinue(context);

      // 再接続成功（「🚀」で始まる）なら、そのまま exec を続行
      if (reconnectResult.startsWith('🚀')) {
        // context が更新されているので、再取得
        const updatedContext = await getUserContext(context.userId, context.platform, context.chatId);

        if (updatedContext.currentSessionId && updatedContext.currentMachineId) {
          // 再接続成功メッセージを取得（マシン名・プロジェクト名を含む）
          const machine = await prisma.machine.findUnique({
            where: { id: updatedContext.currentMachineId }
          });
          const projectName = updatedContext.currentProjectName || context.lastProjectId.split('/').pop() || context.lastProjectId;
          const machineName = machine?.name || 'Unknown';

          console.log(`✅ [exec] Auto-reconnect successful: ${machineName}/${projectName}`);

          // 再接続メッセージを先に送信（Discord/Telegram に直接送信）
          const reconnectMessage = `🔄 前回の接続先（${machineName} / ${projectName}）に再接続しました`;
          await sendMessage(updatedContext.platform, updatedContext.chatId, reconnectMessage);

          // exec を再帰呼び出し
          return handleExec(updatedContext);
        }
      }
      // 再接続失敗（オフラインなど）→ エラーメッセージを返す
      return reconnectResult;
    }

    // 前回の接続先がない場合
    return '⚠️ プロジェクトに接続されていません。\n\n`m` → マシン選択 → `p` → プロジェクト選択 の順で接続してください。';
  }

  // Get project path from session
  const session = await prisma.session.findUnique({
    where: { id: context.currentSessionId },
    include: { project: true }
  });

  if (!session) {
    return '❌ セッションが見つかりません。';
  }

  // Send exec command to agent (marks the conversation reset point)
  await execConversation(
    context.currentMachineId,
    context.currentSessionId,
    session.project.path,
    context.userId
  );

  return '🚀 **実行モード開始**\n会話履歴がリセットされました。実装を開始します。';
}

async function handleLink(context: UserContext): Promise<string> {
  // Get platform username if available (Discord: tag, Telegram: username)
  let platformName: string | undefined;

  // Check if already linked
  const existingLink = await prisma.platformLink.findUnique({
    where: {
      platform_platformUserId: {
        platform: context.platform,
        platformUserId: context.userId
      }
    },
    include: { user: true }
  });

  if (existingLink?.linkedAt) {
    // Already linked to a WebUI account
    return `✅ このアカウントは既に WebUI にリンクされています。\n\n`
      + `リンク先: ${existingLink.user.email || existingLink.user.name || 'WebUI User'}\n`
      + `リンク日: ${existingLink.linkedAt.toLocaleDateString('ja-JP')}`;
  }

  // Generate a link code
  const code = await createLinkCode(
    context.platform,
    context.userId,
    platformName,
    context.chatId
  );

  return `🔗 **アカウント連携コード**\n\n`
    + `\`${code}\`\n\n`
    + `このコードを DevRelay WebUI の Settings ページで入力してください。\n`
    + `⏰ 有効期限: 5分\n\n`
    + `WebUI: https://ribbon-re.jp/devrelay/settings`;
}

async function handleAgreement(context: UserContext): Promise<string> {
  if (!context.currentSessionId || !context.currentMachineId) {
    return '⚠️ プロジェクトに接続されていません。';
  }

  // Get project path from session
  const session = await prisma.session.findUnique({
    where: { id: context.currentSessionId },
    include: { project: true }
  });

  if (!session) {
    return '❌ セッションが見つかりません。';
  }

  // Start progress tracking
  await startProgressTracking(context.currentSessionId);

  // Send agreement apply command to agent
  await applyAgreement(
    context.currentMachineId,
    context.currentSessionId,
    session.project.path,
    context.userId
  );

  // Return empty since progress message is already sent
  return '';
}

async function handleSession(context: UserContext): Promise<string> {
  // 未接続の場合
  if (!context.currentSessionId || !context.currentMachineId) {
    const parts = ['📋 **セッション情報**', ''];
    parts.push('ステータス: 未接続');

    if (context.lastProjectId) {
      const lastProject = await prisma.project.findUnique({
        where: { id: context.lastProjectId },
        include: { machine: true }
      });
      if (lastProject) {
        parts.push('');
        parts.push(`前回の接続先: ${lastProject.machine.name} / ${lastProject.name}`);
        parts.push('`c` で再接続できます');
      }
    } else {
      parts.push('');
      parts.push('`m` でマシン一覧を表示して接続してください');
    }

    return parts.join('\n');
  }

  // セッション情報を取得
  const session = await prisma.session.findUnique({
    where: { id: context.currentSessionId },
    include: {
      project: true,
      machine: true,
      messages: {
        orderBy: { createdAt: 'desc' },
        take: 1
      }
    }
  });

  if (!session) {
    return '❌ セッションが見つかりません。';
  }

  // 会話履歴件数を取得
  const messageCount = await prisma.message.count({
    where: { sessionId: context.currentSessionId }
  });

  // セッション情報を構築
  const parts = ['📋 **セッション情報**', ''];
  parts.push(`マシン: ${session.machine.name}`);
  parts.push(`プロジェクト: ${session.project.name}`);
  parts.push(`AI ツール: ${AI_TOOL_NAMES[session.aiTool] || session.aiTool}`);
  parts.push(`ステータス: ${session.status === 'active' ? '🟢 アクティブ' : '⏹️ 終了'}`);
  parts.push(`会話履歴: ${messageCount}件`);

  // セッション開始時刻
  const startedAt = new Date(session.startedAt);
  const now = new Date();
  const diffMs = now.getTime() - startedAt.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMins / 60);

  let duration: string;
  if (diffHours > 0) {
    duration = `${diffHours}時間${diffMins % 60}分`;
  } else {
    duration = `${diffMins}分`;
  }
  parts.push(`セッション時間: ${duration}`);

  // 最後のメッセージ
  if (session.messages.length > 0) {
    const lastMsg = session.messages[0];
    const lastMsgTime = new Date(lastMsg.createdAt);
    const lastMsgDiff = Math.floor((now.getTime() - lastMsgTime.getTime()) / (1000 * 60));
    parts.push(`最終メッセージ: ${lastMsgDiff}分前`);
  }

  return parts.join('\n');
}

async function handleLog(context: UserContext, count?: number): Promise<string> {
  if (!context.currentSessionId) {
    return '⚠️ セッションが開始されていません。';
  }
  
  const messages = await getSessionMessages(context.currentSessionId, count || 10);
  
  if (messages.length === 0) {
    return '📝 メッセージがありません。';
  }
  
  const log = messages.reverse().map(m => {
    const prefix = m.role === 'user' ? '👤' : '🤖';
    const content = m.content.length > 100 ? m.content.slice(0, 100) + '...' : m.content;
    return `${prefix} ${content}`;
  }).join('\n\n');
  
  return `📝 **会話ログ** (${messages.length}件)\n\n${log}`;
}

async function handleSummary(context: UserContext, period?: string): Promise<string> {
  // TODO: Implement AI summary using Anthropic API
  return '📋 要約機能は準備中です。\n\n`log` でログを確認できます。';
}

async function handleQuit(context: UserContext): Promise<string> {
  if (context.currentSessionId) {
    await endSession(context.currentSessionId);
    
    if (context.currentMachineId) {
      await endAgentSession(context.currentMachineId, context.currentSessionId);
    }
  }
  
  await updateUserContext(context.userId, context.platform, context.chatId, {
    currentMachineId: undefined,
    currentMachineName: undefined,
    currentSessionId: undefined,
    currentProjectName: undefined,
    lastListType: undefined,
    lastListItems: undefined
  });
  
  return '👋 切断しました';
}

async function handleAiSwitch(context: UserContext, tool: string): Promise<string> {
  // TODO: Implement AI tool switching
  const name = AI_TOOL_NAMES[tool] || tool;
  return `🔄 AI を **${name}** に切り替えました`;
}

async function handleAiPrompt(
  context: UserContext,
  text: string,
  files?: FileAttachment[],
  missedMessages?: MissedMessage[]
): Promise<string> {
  console.log(`📝 handleAiPrompt called with text: ${text.substring(0, 50)}...`);
  console.log(`   Session: ${context.currentSessionId}, Machine: ${context.currentMachineId}`);
  if (files && files.length > 0) {
    console.log(`   Files: ${files.map(f => f.filename).join(', ')}`);
  }
  if (missedMessages && missedMessages.length > 0) {
    console.log(`   Missed messages: ${missedMessages.length}`);
  }

  // プロジェクト未接続の場合、自動再接続を試みる
  if (!context.currentSessionId || !context.currentMachineId) {
    // 前回の接続先がある場合は自動再接続を試みる
    if (context.lastProjectId) {
      console.log(`🔄 Auto-reconnecting to last project: ${context.lastProjectId}`);
      const reconnectResult = await handleContinue(context);

      // 再接続成功（「🚀」で始まる）なら、そのままプロンプトを続行
      if (reconnectResult.startsWith('🚀')) {
        // context が更新されているので、再取得
        const updatedContext = await getUserContext(context.userId, context.platform, context.chatId);

        if (updatedContext.currentSessionId && updatedContext.currentMachineId) {
          // 再接続成功メッセージを取得（マシン名・プロジェクト名を含む）
          const machine = await prisma.machine.findUnique({
            where: { id: updatedContext.currentMachineId }
          });
          const projectName = updatedContext.currentProjectName || context.lastProjectId.split('/').pop() || context.lastProjectId;
          const machineName = machine?.name || 'Unknown';

          console.log(`✅ Auto-reconnect successful: ${machineName}/${projectName}`);

          // 再接続メッセージを先に送信（Discord/Telegram に直接送信）
          const reconnectMessage = `🔄 前回の接続先（${machineName} / ${projectName}）に再接続しました`;
          await sendMessage(updatedContext.platform, updatedContext.chatId, reconnectMessage);

          // AI にプロンプト送信（再帰呼び出し）- 結果をそのまま返す
          return handleAiPrompt(updatedContext, text, files, missedMessages);
        }
      }
      // 再接続失敗（オフラインなど）→ エラーメッセージを返す
      return reconnectResult;
    }

    // 前回の接続先がない場合
    return '⚠️ プロジェクトに接続されていません。\n\n`m` → マシン選択 → `p` → プロジェクト選択 の順で接続してください。';
  }

  // Save missed messages to DB (for history)
  if (missedMessages && missedMessages.length > 0) {
    for (const msg of missedMessages) {
      await prisma.message.create({
        data: {
          sessionId: context.currentSessionId,
          role: msg.role === 'user' ? 'user' : 'ai',
          content: msg.content,
          platform: context.platform,
          createdAt: msg.timestamp
        }
      });
    }
  }

  // Save user message
  await prisma.message.create({
    data: {
      sessionId: context.currentSessionId,
      role: 'user',
      content: text,
      platform: context.platform
    }
  });

  console.log(`📤 Sending prompt to agent ${context.currentMachineId}`);

  // Start progress tracking (sends initial message)
  await startProgressTracking(context.currentSessionId);

  // Send to agent with files and missed messages
  await sendPromptToAgent(
    context.currentMachineId,
    context.currentSessionId,
    text,
    context.userId,
    files,
    missedMessages
  );

  // Return empty since progress message is already sent
  return '';
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function formatRelativeDate(date: Date): string {
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  
  if (days === 0) return '今日';
  if (days === 1) return '昨日';
  if (days < 7) return `${days}日前`;
  if (days < 30) return `${Math.floor(days / 7)}週間前`;
  return `${Math.floor(days / 30)}ヶ月前`;
}
