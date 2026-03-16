import crypto from 'crypto';
import type { UserCommand, UserContext, Platform, FileAttachment, AiTool } from '@devrelay/shared';
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
  switchAiTool,
  isAgentRestarted,
  clearAgentRestarted,
  cancelAiProcess,
  checkAgentVersion,
  updateAgent,
  executeCrossProjectQuery,
  executeCrossProjectExec,
  isAgentConnected,
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
  getActiveSessions,
  getSessionParticipants
} from './session-manager.js';
import { getHelpText } from './command-parser.js';
import { createLinkCode } from './platform-link.js';
import { processMessageFilesEmbedding } from './embedding-service.js';
import {
  createTestflightService,
  listTestflightServices,
  removeTestflightService,
  getTestflightServiceInfo,
} from './testflight-manager.js';

// User context storage (in-memory, keyed by chatId for channel-based sessions)
// This allows different channels to have different active sessions
const userContexts = new Map<string, UserContext>();

// x コマンドの連続確認用: チャンネルごとに前回のコマンドが clear だったかを記録
const pendingClear = new Set<string>();

// u コマンドの連続確認用: チャンネルごとに前回のコマンドが update だったかを記録
const pendingUpdate = new Set<string>();

// w コマンド判定用プロンプトプレフィックス（command-parser.ts と一致させる）
const W_PROMPT_PREFIX = 'doc/changelog.md があれば';

/**
 * context から DB の User.id を解決する
 * web プラットフォームでは userId が既に DB User.id のためそのまま返す
 * Discord/Telegram では PlatformLink 経由で解決
 */
async function resolveDbUserId(context: UserContext): Promise<string | null> {
  if (context.platform === 'web') return context.userId;
  const link = await prisma.platformLink.findFirst({
    where: { platformUserId: context.userId },
    select: { userId: true, linkedAt: true }
  });
  return link?.linkedAt ? link.userId : null;
}

/**
 * context から DB の User を取得または作成する
 * web プラットフォームでは userId が DB User.id のため直接取得
 * Discord/Telegram では PlatformLink 経由で取得/作成
 */
async function resolveOrCreateUser(context: UserContext) {
  if (context.platform === 'web') {
    return prisma.user.findUnique({ where: { id: context.userId } });
  }
  let user = await prisma.user.findFirst({
    where: { platformLinks: { some: { platformUserId: context.userId } } }
  });
  if (!user) {
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
  return user;
}

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
  // clear/update 以外のコマンドが来たら確認状態をリセット
  const chatKey = `${context.platform}:${context.chatId}`;
  if (command.type !== 'clear') {
    pendingClear.delete(chatKey);
  }
  if (command.type !== 'update') {
    pendingUpdate.delete(chatKey);
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

    case 'build':
      return handleBuild(context);

    case 'log':
      return handleLog(context, command.count);

    case 'summary':
      return handleSummary(context, command.period);

    case 'kill':
      return handleKill(context);

    case 'update':
      return handleUpdate(context);

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

    case 'testflight':
      return handleTestflight(context, command);

    case 'ask:member':
      return handleAskMember(context, command.targetProject, command.question);

    case 'teamexec:member':
      return handleTeamExec(context, command.targetProject, command.instruction);

    default:
      return '❓ 不明なコマンドです。`h` でヘルプを表示できます。';
  }
}

// -----------------------------------------------------------------------------
// Command Handlers
// -----------------------------------------------------------------------------

async function handleMachineList(context: UserContext): Promise<string> {
  // DB の User.id を解決（web: 直接、Discord/Telegram: PlatformLink 経由）
  const dbUserId = await resolveDbUserId(context);

  if (!dbUserId) {
    return '⚠️ WebUI アカウントに連携されていません。\n\n'
      + '`link` コマンドでリンクコードを取得し、WebUI の Settings ページで入力してください。';
  }

  // Get machines for the user
  const machines = await prisma.machine.findMany({
    where: { userId: dbUserId, deletedAt: null }
  });

  if (machines.length === 0) {
    return '📡 登録されているエージェントがありません。\n\n'
      + 'エージェントを追加するには:\n'
      + '1. WebUI の Agents ページで「Add Agent」をクリック\n'
      + '2. 生成されたトークンをコピー\n'
      + '3. 対象マシンで `devrelay setup` を実行してトークンを入力';
  }

  const list = machines.map((m: Machine & { status: string; displayName: string | null }, i: number) => {
    const emoji = m.status === 'online' ? STATUS_EMOJI.online : STATUS_EMOJI.offline;
    const displayName = m.displayName ?? m.name;
    return `${i + 1}. ${displayName} ${emoji}`;
  }).join('\n');

  // Update context
  await updateUserContext(context.userId, context.platform, context.chatId, {
    lastListType: 'machine',
    lastListItems: machines.map((m: Machine) => m.id)
  });

  return `📡 **エージェント一覧**\n\n${list}`;
}

async function handleProjectList(context: UserContext): Promise<string> {
  if (!context.currentMachineId) {
    return '⚠️ エージェントに接続されていません。\n`m` でエージェント一覧を表示して接続してください。';
  }
  
  const projects = await prisma.project.findMany({
    where: { machineId: context.currentMachineId }
  });
  
  if (projects.length === 0) {
    return '📁 プロジェクトが登録されていません。\n\nエージェント側で `devrelay projects add <path>` を実行してください。';
  }
  
  const list = projects.map((p: Project, i: number) => {
    return `${i + 1}. ${p.name}`;
  }).join('\n');

  await updateUserContext(context.userId, context.platform, context.chatId, {
    lastListType: 'project',
    lastListItems: projects.map((p: Project) => p.id)
  });
  
  // currentMachineName は既に displayName ?? name が設定されている
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
  const machine = await prisma.machine.findFirst({ where: { id: machineId, deletedAt: null } });

  if (!machine) {
    return '❌ エージェントが見つかりません。';
  }

  const machineDisplayName = machine.displayName ?? machine.name;

  if (machine.status !== 'online') {
    return `⚠️ ${machineDisplayName} はオフラインです。`;
  }

  await updateUserContext(context.userId, context.platform, context.chatId, {
    currentMachineId: machine.id,
    currentMachineName: machineDisplayName,
    lastListType: undefined,
    lastListItems: undefined
  });

  return `✅ **${machineDisplayName}** に接続しました`;
}

export async function handleProjectConnect(projectId: string, context: UserContext): Promise<string> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { machine: true }
  });

  if (!project) {
    return '❌ プロジェクトが見つかりません。';
  }

  // Get or create user
  const user = await resolveOrCreateUser(context);
  if (!user) {
    return '❌ ユーザー情報の取得に失敗しました。';
  }

  // 既存のアクティブセッションを検索（同一ユーザー・同一プロジェクト・同一マシン）
  let sessionId: string;
  let isResumed = false;

  const existingSession = await prisma.session.findFirst({
    where: {
      userId: user.id,
      projectId: project.id,
      machineId: project.machineId,
      status: 'active',
    },
    orderBy: { startedAt: 'desc' },
  });

  if (existingSession) {
    sessionId = existingSession.id;
    isResumed = true;
  } else {
    sessionId = await createSession(
      user.id,
      project.machineId,
      project.id,
      project.defaultAi
    );
  }

  // 前のセッションのクリーンアップ
  // Web クライアントは複数タブで複数セッションに同時参加するため、
  // 旧セッションの進捗トラッカー・参加者を維持する（タブ切り替え時に進捗が消えない）
  if (context.currentSessionId && context.currentSessionId !== sessionId) {
    if (context.platform !== 'web') {
      stopProgressTracking(context.currentSessionId);
      removeParticipant(context.currentSessionId, context.platform, context.chatId);
    }
  }

  // Add participant
  addParticipant(sessionId, context.platform, context.chatId);

  // 新規セッションのみ Agent に通知（再利用時は Agent 側で既に活性化済み）
  if (!isResumed) {
    await startAgentSession(
      project.machineId,
      sessionId,
      project.name,
      project.path,
      project.defaultAi as any
    );
    // Agent 再起動フラグをクリア（handleProjectConnect でセッションを開始済みのため、
    // handleAiPrompt / handleExec での二重セッション作成を防止）
    clearAgentRestarted(project.machineId);
  }

  // 表示名は displayName があればそちらを使用
  const projectMachineDisplayName = project.machine.displayName ?? project.machine.name;

  await updateUserContext(context.userId, context.platform, context.chatId, {
    currentSessionId: sessionId,
    currentProjectName: project.name,
    currentMachineId: project.machineId,
    currentMachineName: projectMachineDisplayName,
    lastProjectId: project.id,  // 再接続用に保存
    lastListType: undefined,
    lastListItems: undefined
  });

  const aiName = AI_TOOL_NAMES[project.defaultAi] || project.defaultAi;
  if (isResumed) {
    return `🔄 **${project.name}** に再接続\n${aiName} セッション復元`;
  }
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
  
  // Connect to the same machine/project（displayName があればそちらを使用）
  const recentMachineDisplayName = session.machine.displayName ?? session.machine.name;
  await updateUserContext(context.userId, context.platform, context.chatId, {
    currentMachineId: session.machineId,
    currentMachineName: recentMachineDisplayName
  });

  return handleProjectConnect(session.projectId, context);
}

async function handleStatus(context: UserContext): Promise<string> {
  if (!context.currentMachineId) {
    return '📊 未接続\n\n`m` でエージェント一覧を表示';
  }
  
  const parts = [`📊 **ステータス**`];
  parts.push(`├── Agent: ${context.currentMachineName}`);
  
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
  const dbUserId = await resolveDbUserId(context);
  if (!dbUserId) {
    return '📜 作業履歴がありません。';
  }

  const sessions = await getRecentSessions(dbUserId, 5);
  
  if (sessions.length === 0) {
    return '📜 作業履歴がありません。';
  }
  
  type SessionWithRelations = Session & {
    machine: { name: string; displayName: string | null };
    project: { name: string };
  };
  const list = sessions.map((s: SessionWithRelations, i: number) => {
    const date = formatRelativeDate(s.startedAt);
    const machineDisplay = s.machine.displayName ?? s.machine.name;
    return `${i + 1}. ${machineDisplay}/${s.project.name} (${date})`;
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
    return '⚠️ 前回の接続先がありません。\n\n`m` でエージェント一覧を表示して接続してください。';
  }

  // Verify the project still exists and machine is online
  const project = await prisma.project.findUnique({
    where: { id: context.lastProjectId },
    include: { machine: true }
  });

  if (!project) {
    return '❌ 前回のプロジェクトが見つかりません。\n\n`m` でエージェント一覧を表示して接続してください。';
  }

  const continueDisplayName = project.machine.displayName ?? project.machine.name;
  if (project.machine.status !== 'online') {
    return `⚠️ **${continueDisplayName}** はオフラインです。\n\n`
      + `前回: ${continueDisplayName}/${project.name}`;
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
    // w コマンド未実行の場合は警告を追加（BuildLog から判定: サーバー再起動でも消失しない）
    const wDone = await prisma.buildLog.findFirst({
      where: {
        sessionId: context.currentSessionId,
        prompt: { startsWith: W_PROMPT_PREFIX },
      },
    });
    const warnPrefix = !wDone
      ? '⚠️ `w` コマンド（ドキュメント更新・コミット）を実行していません。\n'
      : '';
    return `${warnPrefix}⚠️ 会話履歴をクリアしますか？ もう一度 \`x\` を送信してください。`;
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
          const machine = await prisma.machine.findFirst({
            where: { id: updatedContext.currentMachineId, deletedAt: null }
          });
          const projectName = updatedContext.currentProjectName || context.lastProjectId.split('/').pop() || context.lastProjectId;
          // 表示名は displayName ?? name
          const machineName = machine?.displayName ?? machine?.name ?? 'Unknown';

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
    return '⚠️ プロジェクトに接続されていません。\n\n`m` → エージェント選択 → `p` → プロジェクト選択 の順で接続してください。';
  }

  // Agent 再起動後の場合、セッションを再開始
  if (isAgentRestarted(context.currentMachineId)) {
    console.log(`🔄 [exec] Agent was restarted, re-establishing session for ${context.currentMachineId}`);

    stopProgressTracking(context.currentSessionId);
    removeParticipant(context.currentSessionId, context.platform, context.chatId);

    const oldSession = await prisma.session.findUnique({
      where: { id: context.currentSessionId },
      include: { project: true }
    });

    if (!oldSession) {
      clearAgentRestarted(context.currentMachineId);
      return '❌ セッション情報が見つかりません。`c` で再接続してください。';
    }

    // oldSession.userId を使用（context.userId は Discord のプラットフォームID であり、DB の User ID ではない）
    const newSessionId = await createSession(
      oldSession.userId,
      context.currentMachineId,
      oldSession.projectId,
      oldSession.aiTool
    );
    addParticipant(newSessionId, context.platform, context.chatId);

    await startAgentSession(
      context.currentMachineId,
      newSessionId,
      oldSession.project.name,
      oldSession.project.path,
      oldSession.aiTool as any
    );

    await updateUserContext(context.userId, context.platform, context.chatId, {
      currentSessionId: newSessionId
    });
    context.currentSessionId = newSessionId;

    clearAgentRestarted(context.currentMachineId);
    console.log(`✅ [exec] Session re-established: ${newSessionId}`);
  }

  // Get project path from session
  const session = await prisma.session.findUnique({
    where: { id: context.currentSessionId },
    include: { project: true }
  });

  if (!session) {
    return '❌ セッションが見つかりません。';
  }

  // exec メッセージを保存（Conversations ページで表示するため）
  const execContent = customPrompt ? `[exec] ${customPrompt}` : '[exec]';
  await prisma.message.create({
    data: {
      sessionId: context.currentSessionId,
      role: 'user',
      content: execContent,
      platform: context.platform
    }
  });

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
  // Web プラットフォームではリンクコード不要（既に認証済み）
  if (context.platform === 'web') {
    return '✅ Web インターフェースから直接操作しているため、アカウント連携は不要です。';
  }

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
    + `WebUI: https://devrelay.io/settings`;
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

  // agreement メッセージを保存（Conversations ページで表示するため）
  await prisma.message.create({
    data: {
      sessionId: context.currentSessionId,
      role: 'user',
      content: '[agreement]',
      platform: context.platform
    }
  });

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
        const lastDisplay = lastProject.machine.displayName ?? lastProject.machine.name;
        parts.push(`   前回: ${lastDisplay} / ${lastProject.name} (c で再接続)`);
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
        parts.push(`• ${sess.machineDisplayName} / ${sess.projectName} (${durationStr})`);
      }
    }

    // オンラインのマシン一覧を表示（アクティブセッションがないマシン）
    const onlineMachines = await prisma.machine.findMany({
      where: { status: 'online', deletedAt: null }
    });

    const activeSessionMachineNames = new Set(activeSessions.map(s => s.machineName));
    const idleMachines = onlineMachines.filter(m => !activeSessionMachineNames.has(m.name));

    if (idleMachines.length > 0) {
      for (const machine of idleMachines) {
        const idleDisplayName = machine.displayName ?? machine.name;
        parts.push(`• ${idleDisplayName} (idle)`);
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

  // 現在のセッション（1行形式）- displayName があればそちらを表示
  const currentMachineDisplay = session.machine.displayName ?? session.machine.name;
  parts.push(`📍 ${currentMachineDisplay} / ${session.project.name} (${durationStr})`);

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
    parts.push(`• ${sess.machineDisplayName} / ${sess.projectName} (${sessDurationStr})`);
  }

  // アクティブセッションがないオンラインマシン
  const onlineMachines = await prisma.machine.findMany({
    where: {
      status: 'online',
      deletedAt: null,
      id: { not: session.machineId }
    }
  });

  const activeSessionMachineNames = new Set(otherActiveSessions.map(s => s.machineName));
  const idleMachines = onlineMachines.filter(m => !activeSessionMachineNames.has(m.name));

  for (const machine of idleMachines) {
    const idleMachineDisplay = machine.displayName ?? machine.name;
    parts.push(`• ${idleMachineDisplay} (idle)`);
  }

  return parts.join('\n');
}

/**
 * ビルドログを表示する
 * ユーザーの全プロジェクトについて、各マシンの最新ビルド番号と
 * 全体の最新ビルド番号との差分を表示
 */
async function handleBuild(context: UserContext): Promise<string> {
  // ユーザーの DB ID を取得
  const dbUserId = await resolveDbUserId(context);

  if (!dbUserId) {
    return '📋 ビルドログがありません。`e` / `exec` で実行するとビルドが記録されます。';
  }

  // ユーザーのマシン一覧とプロジェクトを取得
  const machines = await prisma.machine.findMany({
    where: { userId: dbUserId, deletedAt: null },
    include: { projects: true },
  });

  // 全プロジェクト名を重複なしで収集
  const projectNames = [...new Set(machines.flatMap(m => m.projects.map(p => p.name)))].sort();

  if (projectNames.length === 0) {
    return '⚠️ プロジェクトがありません。';
  }

  const lines: string[] = [];

  for (const projectName of projectNames) {
    // このプロジェクト名の最新ビルド番号（全マシン共通）
    const latestBuild = await prisma.buildLog.findFirst({
      where: { projectName },
      orderBy: { buildNumber: 'desc' },
      select: { buildNumber: true, createdAt: true },
    });

    if (!latestBuild) continue;  // ビルドログなし → スキップ

    // 最新ビルドの日付をフォーマット
    const latestDate = latestBuild.createdAt.toLocaleDateString('ja-JP', { month: 'short', day: 'numeric' });

    // 各マシンの最新ビルド番号
    const machineLines: string[] = [];
    for (const machine of machines) {
      const hasProject = machine.projects.some(p => p.name === projectName);
      if (!hasProject) continue;

      const machineBuild = await prisma.buildLog.findFirst({
        where: { projectName, machineId: machine.id },
        orderBy: { buildNumber: 'desc' },
        select: { buildNumber: true, createdAt: true },
      });

      const displayName = machine.displayName ?? machine.name;
      if (machineBuild) {
        const behind = latestBuild.buildNumber - machineBuild.buildNumber;
        const buildDate = machineBuild.createdAt.toLocaleDateString('ja-JP', { month: 'short', day: 'numeric' });
        if (behind > 0) {
          machineLines.push(`  ${displayName}: #${machineBuild.buildNumber} (${buildDate}) -${behind}`);
        } else {
          machineLines.push(`  ${displayName}: #${machineBuild.buildNumber} (${buildDate}) ✅`);
        }
      } else {
        machineLines.push(`  ${displayName}: -`);
      }
    }

    lines.push(`**${projectName}** (latest: #${latestBuild.buildNumber}, ${latestDate})`);
    lines.push(...machineLines);
  }

  if (lines.length === 0) {
    return '📋 ビルドログがありません。`e` / `exec` で実行するとビルドが記録されます。';
  }

  return `📋 **ビルドログ**\n\n${lines.join('\n')}`;
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

/** 実行中の AI プロセスを強制停止する */
async function handleKill(context: UserContext): Promise<string> {
  if (!context.currentSessionId || !context.currentMachineId) {
    return '⚠️ プロジェクトに接続されていません。';
  }

  await cancelAiProcess(context.currentMachineId, context.currentSessionId);

  // フィードバックは agent:ai:cancelled 経由で返るため空文字
  return '';
}

/** Agent のバージョン確認・更新（2回連続で更新実行） */
async function handleUpdate(context: UserContext): Promise<string> {
  if (!context.currentMachineId) {
    return '⚠️ エージェントに接続されていません。\n`m` でエージェント一覧を表示して接続してください。';
  }

  const chatKey = `${context.platform}:${context.chatId}`;

  // 2回目の u: 更新実行
  if (pendingUpdate.has(chatKey)) {
    pendingUpdate.delete(chatKey);
    updateAgent(context.currentMachineId, context.platform, context.chatId);
    return '🔄 Agent を更新中...\n（接続が一時的に切断されます）';
  }

  // 1回目の u: バージョン確認
  try {
    const info = await checkAgentVersion(context.currentMachineId);

    if (info.error) {
      return `❌ バージョン確認に失敗しました: ${info.error}`;
    }

    if (info.isDevRepo) {
      return '⚠️ 開発リポジトリから実行中のため、リモート更新は不可。\n`pnpm deploy-agent` を使用してください。';
    }

    if (!info.hasUpdate) {
      return `✅ Agent は最新です\n  commit: ${info.localCommit.slice(0, 7)} (${info.localDate})`;
    }

    // 更新あり: pendingUpdate フラグを設定
    pendingUpdate.add(chatKey);
    const displayName = context.currentMachineName || 'Agent';
    return `📦 **${displayName}**\n`
      + `  ローカル: ${info.localCommit.slice(0, 7)} (${info.localDate})\n`
      + `  リモート: ${info.remoteCommit.slice(0, 7)} (${info.remoteDate})\n`
      + `  ⚠️ 更新があります\n\n`
      + `もう一度 \`u\` を送信すると更新を実行します。`;
  } catch (err) {
    return `❌ バージョン確認に失敗しました: ${(err as Error).message}`;
  }
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
    return '⚠️ プロジェクトに接続されていません。\n\n`m` → エージェント選択 → `p` → プロジェクト選択 の順で接続してください。';
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
          const machine = await prisma.machine.findFirst({
            where: { id: updatedContext.currentMachineId, deletedAt: null }
          });
          const projectName = updatedContext.currentProjectName || context.lastProjectId.split('/').pop() || context.lastProjectId;
          // 表示名は displayName ?? name
          const machineName = machine?.displayName ?? machine?.name ?? 'Unknown';

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
    return '⚠️ プロジェクトに接続されていません。\n\n`m` → エージェント選択 → `p` → プロジェクト選択 の順で接続してください。';
  }

  // Agent 再起動後の場合、Agent 側の sessionInfoMap がクリアされているため
  // セッションを再開始してから プロンプトを送信する
  if (isAgentRestarted(context.currentMachineId)) {
    console.log(`🔄 Agent was restarted, re-establishing session for ${context.currentMachineId}`);

    // 旧セッションの全参加者を取得（新セッションへのマイグレーション用）
    const oldParticipants = getSessionParticipants(context.currentSessionId);

    // 旧セッションの進捗トラッカーをクリーンアップ
    stopProgressTracking(context.currentSessionId);

    // DB から旧セッションのプロジェクト情報を取得
    const oldSession = await prisma.session.findUnique({
      where: { id: context.currentSessionId },
      include: { project: true }
    });

    if (!oldSession) {
      clearAgentRestarted(context.currentMachineId);
      return '❌ セッション情報が見つかりません。`c` で再接続してください。';
    }

    // 新しいセッションを作成（oldSession.userId を使用。context.userId は Discord のプラットフォームID であり、DB の User ID ではない）
    const newSessionId = await createSession(
      oldSession.userId,
      context.currentMachineId,
      oldSession.projectId,
      oldSession.aiTool
    );

    // 旧セッションの全参加者を新セッションにマイグレーション（他ブラウザも含む）
    for (const p of oldParticipants) {
      addParticipant(newSessionId, p.platform, p.chatId);
      removeParticipant(context.currentSessionId, p.platform, p.chatId);
    }
    // 送信者が旧セッションに含まれていなかった場合のフォールバック
    addParticipant(newSessionId, context.platform, context.chatId);

    // Agent に server:session:start を送信（Agent 側の sessionInfoMap を初期化）
    await startAgentSession(
      context.currentMachineId,
      newSessionId,
      oldSession.project.name,
      oldSession.project.path,
      oldSession.aiTool as any
    );

    // context を新しいセッションIDで更新
    await updateUserContext(context.userId, context.platform, context.chatId, {
      currentSessionId: newSessionId
    });
    context.currentSessionId = newSessionId;

    // フラグをクリア（次回以降は通常フロー）
    clearAgentRestarted(context.currentMachineId);
    console.log(`✅ Session re-established: ${newSessionId}`);
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

  // Save user message（添付ファイルがあれば MessageFile も同時作成）
  const userMessage = await prisma.message.create({
    data: {
      sessionId: context.currentSessionId,
      role: 'user',
      content: text,
      platform: context.platform,
      files: files && files.length > 0 ? {
        create: files.map(f => ({
          filename: f.filename,
          mimeType: f.mimeType,
          size: f.size,
          content: Buffer.from(f.content, 'base64'),
          direction: 'input',
        })),
      } : undefined,
    }
  });

  // 添付ファイルの埋め込みを非同期生成（fire-and-forget）
  if (files && files.length > 0) {
    processMessageFilesEmbedding(userMessage.id).catch(err =>
      console.error('[Embedding] fire-and-forget error:', err.message));
  }

  console.log(`📤 Sending prompt to agent ${context.currentMachineId}`);

  // Start progress tracking (sends initial message)
  await startProgressTracking(context.currentSessionId);

  // Send to agent with files and missed messages
  // エラー時はトラッカーをクリーンアップして永遠にスタックしないようにする
  try {
    await sendPromptToAgent(
      context.currentMachineId,
      context.currentSessionId,
      text,
      context.userId,
      files,
      missedMessages
    );
  } catch (error) {
    stopProgressTracking(context.currentSessionId);
    throw error;
  }

  // Return empty since progress message is already sent
  return '';
}

/**
 * testflight コマンドハンドラ
 * サービスの一覧・作成・削除・詳細表示を処理
 */
async function handleTestflight(
  context: UserContext,
  command: Extract<UserCommand, { type: 'testflight' }>
): Promise<string> {
  console.log(`🚀 handleTestflight: subcommand=${command.subcommand}, name=${'name' in command ? command.name : '(none)'}, userId=${context.userId}`);
  const dbUserId = await resolveDbUserId(context);
  if (!dbUserId) {
    console.log(`🚀 handleTestflight: dbUserId not found for ${context.userId}`);
    return '⚠️ WebUI アカウントに連携されていません。\n\n'
      + '`link` コマンドでリンクコードを取得し、WebUI の Settings ページで入力してください。';
  }
  console.log(`🚀 handleTestflight: dbUserId=${dbUserId}`);

  let result: string;
  switch (command.subcommand) {
    case 'list':
      result = await listTestflightServices(dbUserId);
      break;
    case 'create':
      result = await createTestflightService(dbUserId, command.name);
      break;
    case 'remove':
      result = await removeTestflightService(dbUserId, command.name);
      break;
    case 'info':
      result = await getTestflightServiceInfo(dbUserId, command.name);
      break;
    default:
      result = '❓ 不明なサブコマンドです。`testflight` で一覧を表示できます。';
  }
  console.log(`🚀 handleTestflight: result (${result.length} chars): ${result.substring(0, 100)}...`);
  return result;
}

// -----------------------------------------------------------------------------
// Cross-project query
// -----------------------------------------------------------------------------

/** 他プロジェクトのエージェントに質問を投げる */
async function handleAskMember(
  context: UserContext,
  targetProjectName: string,
  question: string,
): Promise<string> {
  const dbUserId = await resolveDbUserId(context);
  if (!dbUserId) {
    return '⚠️ WebUI アカウントに連携されていません。`link` コマンドでリンクしてください。';
  }

  // プロジェクト名で検索（case-insensitive、同一ユーザー所有）
  const targetProject = await prisma.project.findFirst({
    where: {
      name: { equals: targetProjectName, mode: 'insensitive' },
      machine: { userId: dbUserId, deletedAt: null },
    },
    include: { machine: { select: { id: true, name: true, displayName: true, status: true } } },
  });

  if (!targetProject) {
    return `❌ プロジェクト "${targetProjectName}" が見つかりません。`;
  }

  if (targetProject.machine.status !== 'online' || !isAgentConnected(targetProject.machine.id)) {
    const machineName = targetProject.machine.displayName ?? targetProject.machine.name;
    return `⚠️ ${targetProject.name} のエージェント (${machineName}) はオフラインです。`;
  }

  // フィードバック送信（非同期で先に表示）
  await sendMessage(context.platform, context.chatId, `🔗 ${targetProject.name} に質問中...`);

  // 一時セッション作成
  const tempSessionId = `crossquery_${crypto.randomUUID()}`;
  await prisma.session.create({
    data: {
      id: tempSessionId,
      userId: dbUserId,
      machineId: targetProject.machine.id,
      projectId: targetProject.id,
      aiTool: targetProject.defaultAi,
      status: 'active',
    },
  });

  // ユーザーの質問を DB に保存（Conversations ページで表示するため）
  await prisma.message.create({
    data: {
      sessionId: tempSessionId,
      role: 'user',
      content: question,
      platform: context.platform,
    },
  });

  try {
    const result = await executeCrossProjectQuery(
      targetProject.machine.id,
      tempSessionId,
      targetProject.name,
      targetProject.path,
      targetProject.defaultAi as AiTool,
      question,
      dbUserId,
    );

    await prisma.session.update({
      where: { id: tempSessionId },
      data: { status: 'ended', endedAt: new Date() },
    });

    return `💬 **${targetProject.name}** の回答:\n\n${result.output}`;
  } catch (error: any) {
    await prisma.session.update({
      where: { id: tempSessionId },
      data: { status: 'ended', endedAt: new Date() },
    }).catch(() => {});

    return `❌ ${targetProject.name} への質問が失敗しました: ${error.message}`;
  }
}

/**
 * teamexec コマンド: 他プロジェクトに exec モードで実行依頼する
 * ask と異なり、プランを飛ばして直接実装を実行する
 */
async function handleTeamExec(
  context: UserContext,
  targetProjectName: string,
  instruction: string,
): Promise<string> {
  const dbUserId = await resolveDbUserId(context);
  if (!dbUserId) {
    return '⚠️ WebUI アカウントに連携されていません。`link` コマンドでリンクしてください。';
  }

  // プロジェクト名で検索（case-insensitive、同一ユーザー所有）
  const targetProject = await prisma.project.findFirst({
    where: {
      name: { equals: targetProjectName, mode: 'insensitive' },
      machine: { userId: dbUserId, deletedAt: null },
    },
    include: { machine: { select: { id: true, name: true, displayName: true, status: true } } },
  });

  if (!targetProject) {
    return `❌ プロジェクト "${targetProjectName}" が見つかりません。`;
  }

  if (targetProject.machine.status !== 'online' || !isAgentConnected(targetProject.machine.id)) {
    const machineName = targetProject.machine.displayName ?? targetProject.machine.name;
    return `⚠️ ${targetProject.name} のエージェント (${machineName}) はオフラインです。`;
  }

  // フィードバック送信（非同期で先に表示）
  await sendMessage(context.platform, context.chatId, `🔧 ${targetProject.name} に実行依頼中...`);

  // 一時セッション作成（teamexec_ プレフィックスで Conversations ページ区別用）
  const tempSessionId = `teamexec_${crypto.randomUUID()}`;
  await prisma.session.create({
    data: {
      id: tempSessionId,
      userId: dbUserId,
      machineId: targetProject.machine.id,
      projectId: targetProject.id,
      aiTool: targetProject.defaultAi,
      status: 'active',
    },
  });

  // ユーザーの指示を DB に保存（Conversations ページで表示するため）
  await prisma.message.create({
    data: {
      sessionId: tempSessionId,
      role: 'user',
      content: `[teamexec] ${instruction}`,
      platform: context.platform,
    },
  });

  try {
    const result = await executeCrossProjectExec(
      targetProject.machine.id,
      tempSessionId,
      targetProject.name,
      targetProject.path,
      targetProject.defaultAi as AiTool,
      instruction,
      dbUserId,
    );

    await prisma.session.update({
      where: { id: tempSessionId },
      data: { status: 'ended', endedAt: new Date() },
    });

    return `🔧 **${targetProject.name}** の実行結果:\n\n${result.output}`;
  } catch (error: any) {
    await prisma.session.update({
      where: { id: tempSessionId },
      data: { status: 'ended', endedAt: new Date() },
    }).catch(() => {});

    return `❌ ${targetProject.name} への実行依頼が失敗しました: ${error.message}`;
  }
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
