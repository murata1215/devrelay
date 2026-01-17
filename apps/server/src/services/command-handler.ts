import type { UserCommand, UserContext, Platform, FileAttachment } from '@devrelay/shared';
import { STATUS_EMOJI, AI_TOOL_NAMES } from '@devrelay/shared';
import { prisma } from '../db/client.js';
import {
  getConnectedMachines,
  getMachine,
  startSession as startAgentSession,
  sendPromptToAgent,
  endSession as endAgentSession,
  clearConversation
} from './agent-manager.js';
import {
  createSession,
  addParticipant,
  endSession,
  getRecentSessions,
  getSessionMessages,
  startProgressTracking
} from './session-manager.js';
import { getHelpText } from './command-parser.js';

// User context storage (in-memory, lastProjectId is persisted to DB)
const userContexts = new Map<string, UserContext>();

export async function getUserContext(userId: string, platform: Platform, chatId: string): Promise<UserContext> {
  const key = `${platform}:${userId}`;
  let context = userContexts.get(key);

  if (!context) {
    // Load lastProjectId from DB
    const platformLink = await prisma.platformLink.findUnique({
      where: { platform_platformUserId: { platform, platformUserId: userId } }
    });

    context = {
      userId,
      platform,
      chatId,
      lastProjectId: platformLink?.lastProjectId ?? undefined
    };
    userContexts.set(key, context);
  }

  return context;
}

export async function updateUserContext(userId: string, platform: Platform, updates: Partial<UserContext>) {
  const key = `${platform}:${userId}`;
  const context = userContexts.get(key);
  if (context) {
    Object.assign(context, updates);

    // Persist lastProjectId to DB when it changes
    if ('lastProjectId' in updates) {
      await prisma.platformLink.updateMany({
        where: { platform, platformUserId: userId },
        data: { lastProjectId: updates.lastProjectId ?? null }
      });
    }
  }
}

export async function executeCommand(
  command: UserCommand,
  context: UserContext,
  files?: FileAttachment[]
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
      return handleAiPrompt(context, command.text, files);

    default:
      return '❓ 不明なコマンドです。`h` でヘルプを表示できます。';
  }
}

// -----------------------------------------------------------------------------
// Command Handlers
// -----------------------------------------------------------------------------

async function handleMachineList(context: UserContext): Promise<string> {
  // Get machines for this user
  const machines = await prisma.machine.findMany({
    where: { user: { platformLinks: { some: { platformUserId: context.userId } } } }
  });
  
  if (machines.length === 0) {
    return '📡 登録されているマシンがありません。\n\nマシンを追加するには、対象マシンで `devrelay` コマンドを実行してください。';
  }
  
  const list = machines.map((m, i) => {
    const emoji = m.status === 'online' ? STATUS_EMOJI.online : STATUS_EMOJI.offline;
    return `${i + 1}. ${m.name} ${emoji}`;
  }).join('\n');
  
  // Update context
  await updateUserContext(context.userId, context.platform, {
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
  
  await updateUserContext(context.userId, context.platform, {
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
  
  await updateUserContext(context.userId, context.platform, {
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
  
  await updateUserContext(context.userId, context.platform, {
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
  await updateUserContext(context.userId, context.platform, {
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
  
  await updateUserContext(context.userId, context.platform, {
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
  
  await updateUserContext(context.userId, context.platform, {
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

async function handleAiPrompt(context: UserContext, text: string, files?: FileAttachment[]): Promise<string> {
  console.log(`📝 handleAiPrompt called with text: ${text.substring(0, 50)}...`);
  console.log(`   Session: ${context.currentSessionId}, Machine: ${context.currentMachineId}`);
  if (files && files.length > 0) {
    console.log(`   Files: ${files.map(f => f.filename).join(', ')}`);
  }

  if (!context.currentSessionId || !context.currentMachineId) {
    return '⚠️ プロジェクトに接続されていません。\n\n`m` → マシン選択 → `p` → プロジェクト選択 の順で接続してください。';
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

  // Send to agent with files
  await sendPromptToAgent(
    context.currentMachineId,
    context.currentSessionId,
    text,
    context.userId,
    files
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
