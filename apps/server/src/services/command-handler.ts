import type { UserCommand, UserContext, Platform, FileAttachment } from '@devrelay/shared';
import { STATUS_EMOJI, AI_TOOL_NAMES } from '@devrelay/shared';
import { Machine, Project, Session, Message } from '@prisma/client';
import { prisma } from '../db/client.js';
import {
  getConnectedMachines,
  getMachine,
  startSession as startAgentSession,
  sendPromptToAgent,
  endSession as endAgentSession,
  clearConversation,
  execConversation,
  applyAgreement,
  getAiToolList,
  switchAiTool
} from './agent-manager.js';
import {
  createSession,
  addParticipant,
  removeParticipant,
  endSession,
  getRecentSessions,
  getSessionMessages,
  startProgressTracking,
  stopProgressTracking,
  sendMessage,
  getActiveSessions
} from './session-manager.js';
import { getHelpText } from './command-parser.js';
import { createLinkCode } from './platform-link.js';

// User context storage (in-memory, keyed by chatId for channel-based sessions)
// This allows different channels to have different active sessions
const userContexts = new Map<string, UserContext>();

// x コマンドの連続確認用: チャンネルごとに前回のコマンドが clear だったかを記録
const pendingClear = new Set<string>();

export async function getUserContext(userId: string, platform: Platform, chatId: string): Promise<UserContext> {
  // Key by chatId to allow different sessions per channel
  const key = `${platform}:${chatId}`;
  let context = userContexts.get(key);

  if (!context) {
    // Load session info from ChannelSession (per-channel, not per-user)
    const channelSession = await prisma.channelSession.findUnique({
      where: { platform_chatId: { platform, chatId } }
    });

    context = {
      userId,
      platform,
      chatId,
      lastProjectId: channelSession?.lastProjectId ?? undefined,
      // Restore currentSessionId and currentMachineId after server restart
      currentSessionId: channelSession?.currentSessionId ?? undefined,
      currentMachineId: channelSession?.currentMachineId ?? undefined
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

    // Persist session info to ChannelSession (per-channel, not per-user)
    const dbUpdates: Record<string, string | null> = {};
    if ('lastProjectId' in updates) {
      dbUpdates.lastProjectId = updates.lastProjectId ?? null;
    }
    if ('currentSessionId' in updates) {
      dbUpdates.currentSessionId = updates.currentSessionId ?? null;
    }
    if ('currentMachineId' in updates) {
      dbUpdates.currentMachineId = updates.currentMachineId ?? null;
    }

    if (Object.keys(dbUpdates).length > 0) {
      await prisma.channelSession.upsert({
        where: { platform_chatId: { platform, chatId } },
        update: dbUpdates,
        create: {
          platform,
          chatId,
          ...dbUpdates
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
  // clear 以外のコマンドが来たら確認状態をリセット
  const chatKey = `${context.platform}:${context.chatId}`;
  if (command.type !== 'clear') {
    pendingClear.delete(chatKey);
  }

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
      return handleExec(context, command.prompt);

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

    case 'ai:list':
      return handleAiList(context);

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

  const list = machines.map((m: Machine & { status: string }, i: number) => {
    const emoji = m.status === 'online' ? STATUS_EMOJI.online : STATUS_EMOJI.offline;
    return `${i + 1}. ${m.name} ${emoji}`;
  }).join('\n');

  // Update context
  await updateUserContext(context.userId, context.platform, context.chatId, {
    lastListType: 'machine',
    lastListItems: machines.map((m: Machine) => m.id)
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
  
  const list = projects.map((p: Project, i: number) => {
    return `${i + 1}. ${p.name}`;
  }).join('\n');

  await updateUserContext(context.userId, context.platform, context.chatId, {
    lastListType: 'project',
    lastListItems: projects.map((p: Project) => p.id)
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
  } else if (listType === 'ai') {
    return handleAiSwitch(context, selectedId);
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

  // Clean up previous session's progress tracker if switching sessions
  if (context.currentSessionId) {
    stopProgressTracking(context.currentSessionId);
    removeParticipant(context.currentSessionId, context.platform, context.chatId);
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
  
  type SessionWithRelations = Session & {
    machine: { name: string };
    project: { name: string };
  };
  const list = sessions.map((s: SessionWithRelations, i: number) => {
    const date = formatRelativeDate(s.startedAt);
    return `${i + 1}. ${s.machine.name}/${s.project.name} (${date})`;
  }).join('\n');

  await updateUserContext(context.userId, context.platform, context.chatId, {
    lastListType: 'recent',
    lastListItems: sessions.map((s: Session) => s.id)
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

  // 2回連続確認: 1回目は確認メッセージ、2回目で実行
  const chatKey = `${context.platform}:${context.chatId}`;
  if (!pendingClear.has(chatKey)) {
    pendingClear.add(chatKey);
    return '⚠️ 会話履歴をクリアしますか？ もう一度 `x` を送信してください。';
  }

  // 2回目: 確認状態をクリアして実行
  pendingClear.delete(chatKey);

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

async function handleExec(context: UserContext, customPrompt?: string): Promise<string> {
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

          // exec を再帰呼び出し（カスタムプロンプトも引き継ぐ）
          return handleExec(updatedContext, customPrompt);
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

  // Start progress tracking
  await startProgressTracking(context.currentSessionId);

  // Send exec command to agent (marks the conversation reset point and auto-starts AI)
  await execConversation(
    context.currentMachineId,
    context.currentSessionId,
    session.project.path,
    context.userId,
    customPrompt
  );

  // Return empty since progress message is already sent
  return '';
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
  // メモリ内のアクティブセッション（参加者がいるセッション）を取得
  const activeSessions = await getActiveSessions();

  // 現在接続中のセッションの詳細情報を表示
  if (!context.currentSessionId) {
    // 未接続の場合
    const parts: string[] = [];
    parts.push('📍 未接続');

    // 前回の接続先情報があれば表示
    if (context.lastProjectId) {
      const lastProject = await prisma.project.findUnique({
        where: { id: context.lastProjectId },
        include: { machine: true }
      });
      if (lastProject) {
        parts.push(`   前回: ${lastProject.machine.name} / ${lastProject.name} (c で再接続)`);
      }
    }

    // 他のアクティブセッションを表示（同じマシン+プロジェクトの重複を排除）
    if (activeSessions.length > 0) {
      const uniqueSessions = new Map<string, typeof activeSessions[0]>();
      for (const sess of activeSessions) {
        const key = `${sess.machineName}:${sess.projectName}`;
        const existing = uniqueSessions.get(key);
        // より新しいセッションを優先
        if (!existing || new Date(sess.startedAt) > new Date(existing.startedAt)) {
          uniqueSessions.set(key, sess);
        }
      }
      for (const sess of uniqueSessions.values()) {
        const durationMs = Date.now() - new Date(sess.startedAt).getTime();
        const durationStr = formatDuration(durationMs);
        parts.push(`• ${sess.machineName} / ${sess.projectName} (${durationStr})`);
      }
    }

    // オンラインのマシン一覧を表示（アクティブセッションがないマシン）
    const onlineMachines = await prisma.machine.findMany({
      where: { status: 'online' }
    });

    const activeSessionMachineNames = new Set(activeSessions.map(s => s.machineName));
    const idleMachines = onlineMachines.filter(m => !activeSessionMachineNames.has(m.name));

    if (idleMachines.length > 0) {
      for (const machine of idleMachines) {
        parts.push(`• ${machine.name} (idle)`);
      }
    }

    return parts.join('\n');
  }

  // 現在のセッション情報を取得
  const session = await prisma.session.findUnique({
    where: { id: context.currentSessionId },
    include: {
      machine: true,
      project: true,
      messages: {
        orderBy: { createdAt: 'desc' },
        take: 1
      },
      _count: {
        select: { messages: true }
      }
    }
  });

  if (!session) {
    return '⚠️ セッション情報を取得できませんでした';
  }

  const now = new Date();
  const startedAt = new Date(session.startedAt);
  const durationMs = now.getTime() - startedAt.getTime();
  const durationStr = formatDuration(durationMs);

  const parts: string[] = [];

  // 現在のセッション（1行形式）
  parts.push(`📍 ${session.machine.name} / ${session.project.name} (${durationStr})`);

  // 他のアクティブセッション（現在のセッション以外、同じマシン+プロジェクトの重複を排除）
  const otherActiveSessions = activeSessions.filter(s => s.sessionId !== context.currentSessionId);
  const uniqueOtherSessions = new Map<string, typeof otherActiveSessions[0]>();
  for (const sess of otherActiveSessions) {
    const key = `${sess.machineName}:${sess.projectName}`;
    // 現在のセッションと同じマシン+プロジェクトはスキップ
    if (key === `${session.machine.name}:${session.project.name}`) continue;
    const existing = uniqueOtherSessions.get(key);
    // より新しいセッションを優先
    if (!existing || new Date(sess.startedAt) > new Date(existing.startedAt)) {
      uniqueOtherSessions.set(key, sess);
    }
  }
  for (const sess of uniqueOtherSessions.values()) {
    const sessDurationMs = Date.now() - new Date(sess.startedAt).getTime();
    const sessDurationStr = formatDuration(sessDurationMs);
    parts.push(`• ${sess.machineName} / ${sess.projectName} (${sessDurationStr})`);
  }

  // アクティブセッションがないオンラインマシン
  const onlineMachines = await prisma.machine.findMany({
    where: {
      status: 'online',
      id: { not: session.machineId }
    }
  });

  const activeSessionMachineNames = new Set(otherActiveSessions.map(s => s.machineName));
  const idleMachines = onlineMachines.filter(m => !activeSessionMachineNames.has(m.name));

  for (const machine of idleMachines) {
    parts.push(`• ${machine.name} (idle)`);
  }

  return parts.join('\n');
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    const remainingMinutes = minutes % 60;
    return `${hours}時間${remainingMinutes}分`;
  } else if (minutes > 0) {
    const remainingSeconds = seconds % 60;
    return `${minutes}分${remainingSeconds}秒`;
  } else {
    return `${seconds}秒`;
  }
}

async function handleLog(context: UserContext, count?: number): Promise<string> {
  if (!context.currentSessionId) {
    return '⚠️ セッションが開始されていません。';
  }
  
  const messages = await getSessionMessages(context.currentSessionId, count || 10);
  
  if (messages.length === 0) {
    return '📝 メッセージがありません。';
  }
  
  const log = messages.reverse().map((m: Message) => {
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
    // Clean up progress tracker before ending session
    stopProgressTracking(context.currentSessionId);
    removeParticipant(context.currentSessionId, context.platform, context.chatId);

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

async function handleAiList(context: UserContext): Promise<string> {
  if (!context.currentSessionId || !context.currentMachineId) {
    return '⚠️ プロジェクトに接続されていません。\n\n`m` → マシン選択 → `p` → プロジェクト選択 の順で接続してください。';
  }

  try {
    const result = await getAiToolList(context.currentMachineId, context.currentSessionId);

    if (!result || result.available.length === 0) {
      return '⚠️ AI ツールが設定されていません。';
    }

    const list = result.available.map((tool, i) => {
      const name = AI_TOOL_NAMES[tool] || tool;
      const current = tool === result.currentTool ? ' ✓' : '';
      const defaultMark = tool === result.defaultTool ? ' (default)' : '';
      return `${i + 1}. ${name}${current}${defaultMark}`;
    }).join('\n');

    // Update context for number selection
    await updateUserContext(context.userId, context.platform, context.chatId, {
      lastListType: 'ai',
      lastListItems: result.available
    });

    return `🤖 **AI ツール**\n\n${list}\n\n\`a 1\` または \`a claude\` で切り替え`;
  } catch (err) {
    console.error('Failed to get AI tool list:', err);
    return '❌ AI ツール一覧の取得に失敗しました。';
  }
}

async function handleAiSwitch(context: UserContext, tool: string): Promise<string> {
  if (!context.currentSessionId || !context.currentMachineId) {
    return '⚠️ プロジェクトに接続されていません。';
  }

  try {
    const result = await switchAiTool(context.currentMachineId, context.currentSessionId, tool as any);

    if (result.success) {
      // Update session's aiTool in DB
      await prisma.session.update({
        where: { id: context.currentSessionId },
        data: { aiTool: tool }
      });

      const name = AI_TOOL_NAMES[tool] || tool;
      return `🔄 AI を **${name}** に切り替えました`;
    } else {
      return `❌ AI 切り替えに失敗しました: ${result.error || '不明なエラー'}`;
    }
  } catch (err) {
    console.error('Failed to switch AI tool:', err);
    return '❌ AI 切り替えに失敗しました。';
  }
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
