import crypto from 'crypto';
import type { UserCommand, UserContext, Platform, FileAttachment, AiTool, ModelSelectableAiTool, Language } from '@devrelay/shared';
import { STATUS_EMOJI, AI_TOOL_NAMES, AI_MODEL_CATALOG, isModelSelectableAiTool, isUnsafeModelId, DEFAULT_CHAT_LANGUAGE, isLanguage, tChat, W_COMMAND_PROMPT_PREFIXES } from '@devrelay/shared';
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
import { getUserSetting, setUserSetting, SettingKeys, modelSettingKey } from './user-settings.js';
import { checkCommandPermission, hasIpRestriction } from './org-control.js';
import { resolvePermissionPolicy } from './permission-policy.js';
import { fenceHumanText, validateHumanTextLength, neutralizeHumanInputTag } from './human-text-fence.js';
import {
  createTestflightService,
  listTestflightServices,
  removeTestflightService,
  copyTestflightService,
  getTestflightServiceInfo,
} from './testflight-manager.js';

// User context storage (in-memory, keyed by chatId for channel-based sessions)
// This allows different channels to have different active sessions
const userContexts = new Map<string, UserContext>();

// x コマンドの連続確認用: チャンネルごとに前回のコマンドが clear だったかを記録
const pendingClear = new Set<string>();

// u コマンドの連続確認用: チャンネルごとに前回のコマンドが update だったかを記録
const pendingUpdate = new Set<string>();

// w コマンド判定用プロンプトプレフィックス（JA/EN の2要素）
// packages/shared/src/i18n.ts の W_COMMAND_PROMPT_PREFIXES から取得することで、
// プロンプト文面を変更しても判定側が自動追従し、同期漏れ（#90, #304 の再発）を防ぐ。
// #316: 言語対応により JA/EN どちらの言語で実行された `w` も判定できるよう2要素になった。
const [W_PROMPT_PREFIX_JA, W_PROMPT_PREFIX_EN] = W_COMMAND_PROMPT_PREFIXES;

/**
 * #334: チャット `e,<指示>`（ゲート②）の長さ上限（string.length = UTF-16 コードユニット数基準）。
 * 超過時は切り詰めず明示エラーで拒否する（静かなフォールバック禁止、#325）。
 */
const EXEC_INSTRUCTION_MAX_LENGTH = 4000;

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

/**
 * #316: チャット表示言語を UserSettings.language から解決する。
 * 未リンク（Discord/Telegram の PlatformLink 未解決）・未設定時は DEFAULT_CHAT_LANGUAGE（'ja'）。
 * WebUI の既定 'en' とは非対称: 設定を一度も触っていない既存ユーザーのチャットが
 * 突然英語化するのを防ぐため。
 */
async function resolveChatLanguage(context: UserContext): Promise<Language> {
  const dbUserId = await resolveDbUserId(context);
  if (!dbUserId) return DEFAULT_CHAT_LANGUAGE;
  const stored = await getUserSetting(dbUserId, SettingKeys.LANGUAGE);
  return isLanguage(stored) ? stored : DEFAULT_CHAT_LANGUAGE;
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

  // #316: 言語設定は毎回軽量に再解決する（WebUI で切り替えた直後のメッセージから反映させるため）
  context.language = await resolveChatLanguage(context);

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
  // #316: チャット表示言語（getUserContext で毎回再解決済み。念のためデフォルトへフォールバック）
  const lang: Language = context.language ?? DEFAULT_CHAT_LANGUAGE;

  // エンタープライズ統制ゲート（#268）: 組織の member はマネージャーが1人以上割り当てられるまでコマンド発行不可。
  // 組織未所属・admin・manager は素通し。Discord/Telegram の未リンクユーザーは User 特定不可のため従来どおり素通し。
  const dbUserId = await resolveDbUserId(context);
  if (dbUserId) {
    const permission = await checkCommandPermission(dbUserId);
    if (!permission.allowed) {
      return permission.reason ?? tChat(lang, 'security.permissionDenied');
    }
    // 組織 IP アクセス制限（#285）: Discord/Telegram など IP 判定不能な経路は、
    // IP 制限が有効な組織のユーザーをブロックする（抜け穴防止）。
    // web 経路は authenticate() で request.ip をチェック済みのためここでは対象外。
    if (context.platform !== 'web' && (await hasIpRestriction(dbUserId))) {
      return tChat(lang, 'security.ipRestricted');
    }
  }

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
      return handleExec(context, command.prompt, command.promptOrigin);

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
      return getHelpText(lang);

    case 'ai:list':
      return handleAiList(context);

    case 'ai:switch':
      return handleAiSwitch(context, command.tool);

    case 'model:list':
      return handleModelList(context, command.tool);

    case 'model:set':
      return handleModelSet(context, command.target, command.model, command.tool);

    case 'ai:prompt':
      return handleAiPrompt(context, command.text, files, missedMessages);

    case 'testflight':
      return handleTestflight(context, command);

    case 'ask:member':
      return handleAskMember(context, command.targetProject, command.question);

    case 'teamexec:member':
      return handleTeamExec(context, command.targetProject, command.instruction);

    case 'disconnect':
      return handleDisconnectRemote(context);

    default:
      return tChat(lang, 'common.unknownCommand');
  }
}

// -----------------------------------------------------------------------------
// Command Handlers
// -----------------------------------------------------------------------------

async function handleMachineList(context: UserContext): Promise<string> {
  const lang: Language = context.language ?? DEFAULT_CHAT_LANGUAGE;
  // DB の User.id を解決（web: 直接、Discord/Telegram: PlatformLink 経由）
  const dbUserId = await resolveDbUserId(context);

  if (!dbUserId) {
    return tChat(lang, 'machine.notLinked');
  }

  // Get machines for the user
  const machines = await prisma.machine.findMany({
    where: { userId: dbUserId, deletedAt: null }
  });

  if (machines.length === 0) {
    return tChat(lang, 'machine.empty');
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

  return tChat(lang, 'machine.listHeader', { list });
}

async function handleProjectList(context: UserContext): Promise<string> {
  const lang: Language = context.language ?? DEFAULT_CHAT_LANGUAGE;
  if (!context.currentMachineId) {
    return tChat(lang, 'common.agentNotConnected');
  }

  const projects = await prisma.project.findMany({
    where: { machineId: context.currentMachineId, deletedAt: null }
  });

  if (projects.length === 0) {
    return tChat(lang, 'project.empty');
  }

  const list = projects.map((p: Project, i: number) => {
    return `${i + 1}. ${p.name}`;
  }).join('\n');

  await updateUserContext(context.userId, context.platform, context.chatId, {
    lastListType: 'project',
    lastListItems: projects.map((p: Project) => p.id)
  });

  // currentMachineName は既に displayName ?? name が設定されている
  return tChat(lang, 'project.listHeader', { machine: context.currentMachineName ?? '', list });
}

async function handleSelect(number: number, context: UserContext): Promise<string> {
  const lang: Language = context.language ?? DEFAULT_CHAT_LANGUAGE;
  const items = context.lastListItems;
  const listType = context.lastListType;

  if (!items || !listType) {
    return tChat(lang, 'select.noList');
  }

  const index = number - 1;
  if (index < 0 || index >= items.length) {
    return tChat(lang, 'select.outOfRange', { number, max: items.length });
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

  return tChat(lang, 'select.unknown');
}

async function handleMachineConnect(machineId: string, context: UserContext): Promise<string> {
  const lang: Language = context.language ?? DEFAULT_CHAT_LANGUAGE;
  const machine = await prisma.machine.findFirst({ where: { id: machineId, deletedAt: null } });

  if (!machine) {
    return tChat(lang, 'machine.notFound');
  }

  const machineDisplayName = machine.displayName ?? machine.name;

  if (machine.status !== 'online') {
    return tChat(lang, 'machine.offline', { name: machineDisplayName });
  }

  await updateUserContext(context.userId, context.platform, context.chatId, {
    currentMachineId: machine.id,
    currentMachineName: machineDisplayName,
    lastListType: undefined,
    lastListItems: undefined
  });

  return tChat(lang, 'machine.connected', { name: machineDisplayName });
}

export async function handleProjectConnect(projectId: string, context: UserContext): Promise<string> {
  const lang: Language = context.language ?? DEFAULT_CHAT_LANGUAGE;
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { machine: true }
  });

  if (!project) {
    return tChat(lang, 'project.notFound');
  }

  // Get or create user
  const user = await resolveOrCreateUser(context);
  if (!user) {
    return tChat(lang, 'project.userInfoFailed');
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

  // #307: このプロジェクトで直近使っていた AI ツールを引き継ぐための単一情報源。
  // active セッションがあればその aiTool、無ければ status を問わず直近セッションの aiTool、
  // それも無ければ project.defaultAi にフォールバックする。
  // これをやらないと Agent 切断→再接続のたびに `a` で選んだツールが project.defaultAi に巻き戻る。
  let effectiveAi: string;

  if (existingSession) {
    sessionId = existingSession.id;
    isResumed = true;
    effectiveAi = existingSession.aiTool;
  } else {
    const lastSession = await prisma.session.findFirst({
      where: {
        userId: user.id,
        projectId: project.id,
        machineId: project.machineId,
      },
      orderBy: { startedAt: 'desc' },
    });
    effectiveAi = lastSession?.aiTool || project.defaultAi;

    sessionId = await createSession(
      user.id,
      project.machineId,
      project.id,
      effectiveAi
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
      effectiveAi as any
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

  const aiName = AI_TOOL_NAMES[effectiveAi] || effectiveAi;
  if (isResumed) {
    return tChat(lang, 'continue.reconnected', { project: project.name, ai: aiName });
  }
  return tChat(lang, 'continue.connected', { project: project.name, ai: aiName });
}

async function handleRecentConnect(sessionId: string, context: UserContext): Promise<string> {
  const lang: Language = context.language ?? DEFAULT_CHAT_LANGUAGE;
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: { machine: true, project: true }
  });

  if (!session) {
    return tChat(lang, 'common.sessionNotFound');
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
  const lang: Language = context.language ?? DEFAULT_CHAT_LANGUAGE;
  if (!context.currentMachineId) {
    return tChat(lang, 'status.notConnected');
  }

  const parts = [`📊 **${lang === 'en' ? 'Status' : 'ステータス'}**`];
  parts.push(`├── Agent: ${context.currentMachineName}`);

  if (context.currentProjectName) {
    parts.push(`├── Project: ${context.currentProjectName}`);
    parts.push(`└── Ready: ✅`);
  } else {
    parts.push(lang === 'en' ? '└── Project: (none, run `p` to list)' : '└── Project: 未選択 (`p` で一覧表示)');
  }

  return parts.join('\n');
}

async function handleRecent(context: UserContext): Promise<string> {
  const lang: Language = context.language ?? DEFAULT_CHAT_LANGUAGE;
  // Get user
  const dbUserId = await resolveDbUserId(context);
  if (!dbUserId) {
    return tChat(lang, 'recent.empty');
  }

  const sessions = await getRecentSessions(dbUserId, 5);

  if (sessions.length === 0) {
    return tChat(lang, 'recent.empty');
  }

  type SessionWithRelations = Session & {
    machine: { name: string; displayName: string | null };
    project: { name: string };
  };
  const list = sessions.map((s: SessionWithRelations, i: number) => {
    const date = formatRelativeDate(s.startedAt, lang);
    const machineDisplay = s.machine.displayName ?? s.machine.name;
    return `${i + 1}. ${machineDisplay}/${s.project.name} (${date})`;
  }).join('\n');

  await updateUserContext(context.userId, context.platform, context.chatId, {
    lastListType: 'recent',
    lastListItems: sessions.map((s: Session) => s.id)
  });

  return tChat(lang, 'recent.header', { list });
}

async function handleContinue(context: UserContext): Promise<string> {
  const lang: Language = context.language ?? DEFAULT_CHAT_LANGUAGE;
  // Check if we have a last project ID
  if (!context.lastProjectId) {
    return tChat(lang, 'continue.noPrevious');
  }

  // Verify the project still exists and machine is online
  const project = await prisma.project.findUnique({
    where: { id: context.lastProjectId },
    include: { machine: true }
  });

  if (!project) {
    return tChat(lang, 'continue.projectNotFound');
  }

  const continueDisplayName = project.machine.displayName ?? project.machine.name;
  if (project.machine.status !== 'online') {
    return tChat(lang, 'continue.offline', { name: continueDisplayName, prev: `${continueDisplayName}/${project.name}` });
  }

  // Connect to the project
  return handleProjectConnect(project.id, context);
}

async function handleClear(context: UserContext): Promise<string> {
  const lang: Language = context.language ?? DEFAULT_CHAT_LANGUAGE;
  if (!context.currentSessionId || !context.currentMachineId) {
    return tChat(lang, 'common.notConnected');
  }

  // 2回連続確認: 1回目は確認メッセージ、2回目で実行
  const chatKey = `${context.platform}:${context.chatId}`;
  if (!pendingClear.has(chatKey)) {
    pendingClear.add(chatKey);
    // w コマンド未実行の場合は警告を追加（BuildLog から判定: サーバー再起動でも消失しない）
    // #316: w コマンドは JA/EN どちらの言語でも実行され得るため、両方のプレフィックスで判定する
    const wDone = await prisma.buildLog.findFirst({
      where: {
        sessionId: context.currentSessionId,
        OR: [
          { prompt: { startsWith: W_PROMPT_PREFIX_JA } },
          { prompt: { startsWith: W_PROMPT_PREFIX_EN } },
        ],
      },
    });
    const warnPrefix = !wDone ? tChat(lang, 'clear.wWarning') : '';
    return tChat(lang, 'clear.confirm', { warnPrefix });
  }

  // 2回目: 確認状態をクリアして実行
  pendingClear.delete(chatKey);

  // Get project path from session
  const session = await prisma.session.findUnique({
    where: { id: context.currentSessionId },
    include: { project: true }
  });

  if (!session) {
    return tChat(lang, 'common.sessionNotFound');
  }

  // Send clear command to agent
  await clearConversation(
    context.currentMachineId,
    context.currentSessionId,
    session.project.path
  );

  return tChat(lang, 'clear.done');
}

async function handleExec(
  context: UserContext,
  customPrompt?: string,
  promptOrigin?: string
): Promise<string> {
  const lang: Language = context.language ?? DEFAULT_CHAT_LANGUAGE;

  // #334（ゲート②）: 長さ検証は制御コマンド解析→payload抽出の直後、
  // enqueue / WebSocket送信 / Message作成 / exec・teamexec転送のいずれよりも前に行う。
  // 切り詰めず明示エラーで拒否する（静かなフォールバック禁止、#325）。
  // promptOrigin==='human' は `e,<指示>` 等の人間入力（command-parser.ts で付与）、
  // 'system' は `w` コマンド等 DevRelay 自身が生成した固定プロンプトのため検証対象外。
  if (promptOrigin === 'human' && customPrompt !== undefined) {
    const validation = validateHumanTextLength(customPrompt, EXEC_INSTRUCTION_MAX_LENGTH);
    if (!validation.ok) {
      return tChat(lang, 'humanText.tooLong', {
        rawLength: String(validation.rawLength),
        limit: String(validation.limit)
      });
    }
  }

  // 接続プロジェクト（teamexec 先）がある場合、そちらに転送する
  if (context.lastRemoteProjectId) {
    const remoteName = context.lastRemoteProjectName || context.lastRemoteProjectId;
    console.log(`🔗 [exec] Forwarding to connected project: ${remoteName}`);
    await sendMessage(context.platform, context.chatId, tChat(lang, 'exec.forwarding', { name: remoteName }));

    // customPrompt がなければデフォルトの exec プロンプト
    const instruction = customPrompt || tChat(lang, 'exec.defaultInstruction');

    // 既存の handleTeamExec を呼び出す（接続プロジェクト名で検索）
    return handleTeamExec(context, remoteName, instruction);
  }

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
          const reconnectMessage = tChat(lang, 'exec.reconnected', { machine: machineName, project: projectName });
          await sendMessage(updatedContext.platform, updatedContext.chatId, reconnectMessage);

          // exec を再帰呼び出し（カスタムプロンプトと promptOrigin も引き継ぐ）
          return handleExec(updatedContext, customPrompt, promptOrigin);
        }
      }
      // 再接続失敗（オフラインなど）→ エラーメッセージを返す
      return reconnectResult;
    }

    // 前回の接続先がない場合
    return tChat(lang, 'common.notConnectedGuide');
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
      return tChat(lang, 'exec.sessionInfoNotFound');
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
    return tChat(lang, 'common.sessionNotFound');
  }

  // exec メッセージを保存（Conversations ページで表示するため）
  // #334: raw text はここ（Message.content）に無切り詰めで全文保存される。
  // humanTextMeta は監査用メタ情報のみを持ち、rawRef で本行を指す（このレコード自身が raw の所在）。
  const execContent = customPrompt ? `[exec] ${customPrompt}` : '[exec]';
  const execHumanTextMeta =
    promptOrigin === 'human' && customPrompt !== undefined
      ? JSON.stringify({
          kind: 'execInstruction',
          origin: 'human',
          rawLength: customPrompt.length,
          limit: EXEC_INSTRUCTION_MAX_LENGTH,
          fenced: true,
          neutralized: neutralizeHumanInputTag(customPrompt).count,
          rawRef: 'message.content'
        })
      : undefined;
  await prisma.message.create({
    data: {
      sessionId: context.currentSessionId,
      role: 'user',
      content: execContent,
      platform: context.platform,
      ...(execHumanTextMeta ? { humanTextMeta: execHumanTextMeta } : {})
    }
  });

  // Start progress tracking
  await startProgressTracking(context.currentSessionId);

  // #309: model は渡さず execConversation 側（agent-manager.ts）で aiTool に応じたモデル設定を解決する
  // （command-handler で claude 固定キーを直読みすると codex 等の他ツールに対応できないため。単一情報源化）
  // #312: w コマンド（W_COMMAND_PROMPT）かどうかを判定して Agent に伝搬する。
  // Codex の workspace-write サンドボックスは .git を read-only にし commit が失敗するため、
  // w 実行時のみ Agent 側で danger-full-access に切り替える。
  // #334: 従来の startsWith(W_PROMPT_PREFIX_*) 判定は fence 適用後の文字列に依存する脆い実装だったため、
  // command-parser.ts が解析時点で付与する構造的な promptOrigin（'system'）に置き換える。
  const isWCommand = promptOrigin === 'system';

  // #334（ゲート②）: 人間入力（promptOrigin==='human'）のみ provenance fence で囲って Agent へ渡す。
  // fence はセキュリティ境界ではなく「人間由来のデータである」ことを示す目印であり、
  // 権限制御は #332/#333 の permissionPolicy / decidePlanPermission() が担う。
  // 'system'（w コマンド等）はそのまま無変更で渡す（#314/#315 の danger-full-access 切替に影響させない）。
  const promptForAgent =
    promptOrigin === 'human' && customPrompt !== undefined
      ? fenceHumanText('execInstruction', customPrompt)
      : customPrompt;

  await execConversation(
    context.currentMachineId,
    context.currentSessionId,
    session.project.path,
    context.userId,
    promptForAgent,
    undefined,
    isWCommand,
  );

  // Return empty since progress message is already sent
  return '';
}

async function handleLink(context: UserContext): Promise<string> {
  const lang: Language = context.language ?? DEFAULT_CHAT_LANGUAGE;
  // Web プラットフォームではリンクコード不要（既に認証済み）
  if (context.platform === 'web') {
    return tChat(lang, 'link.webNotNeeded');
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
    return tChat(lang, 'link.alreadyLinked', {
      target: existingLink.user.email || existingLink.user.name || 'WebUI User',
      date: existingLink.linkedAt.toLocaleDateString(lang === 'en' ? 'en-US' : 'ja-JP'),
    });
  }

  // Generate a link code
  const code = await createLinkCode(
    context.platform,
    context.userId,
    platformName,
    context.chatId
  );

  return tChat(lang, 'link.code', { code });
}

async function handleAgreement(context: UserContext): Promise<string> {
  const lang: Language = context.language ?? DEFAULT_CHAT_LANGUAGE;
  if (!context.currentSessionId || !context.currentMachineId) {
    return tChat(lang, 'common.notConnected');
  }

  // Get project path from session
  const session = await prisma.session.findUnique({
    where: { id: context.currentSessionId },
    include: { project: true }
  });

  if (!session) {
    return tChat(lang, 'common.sessionNotFound');
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
  const lang: Language = context.language ?? DEFAULT_CHAT_LANGUAGE;
  // メモリ内のアクティブセッション（参加者がいるセッション）を取得
  const activeSessions = await getActiveSessions();

  // 現在接続中のセッションの詳細情報を表示
  if (!context.currentSessionId) {
    // 未接続の場合
    const parts: string[] = [];
    parts.push(tChat(lang, 'session.notConnected'));

    // 前回の接続先情報があれば表示
    if (context.lastProjectId) {
      const lastProject = await prisma.project.findUnique({
        where: { id: context.lastProjectId },
        include: { machine: true }
      });
      if (lastProject) {
        const lastDisplay = lastProject.machine.displayName ?? lastProject.machine.name;
        parts.push(tChat(lang, 'session.lastConnection', { machine: lastDisplay, project: lastProject.name }));
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
        const durationStr = formatDuration(durationMs, lang);
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
    return tChat(lang, 'session.fetchFailed');
  }

  const now = new Date();
  const startedAt = new Date(session.startedAt);
  const durationMs = now.getTime() - startedAt.getTime();
  const durationStr = formatDuration(durationMs, lang);

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
    const sessDurationStr = formatDuration(sessDurationMs, lang);
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
  const lang: Language = context.language ?? DEFAULT_CHAT_LANGUAGE;
  // ユーザーの DB ID を取得
  const dbUserId = await resolveDbUserId(context);

  if (!dbUserId) {
    return tChat(lang, 'build.noLogsYet');
  }

  // ユーザーのマシン一覧とプロジェクトを取得
  const machines = await prisma.machine.findMany({
    where: { userId: dbUserId, deletedAt: null },
    include: { projects: { where: { deletedAt: null } } }, // ソフトデリート済みプロジェクトを除外（#323）
  });

  // 全プロジェクト名を重複なしで収集
  const projectNames = [...new Set(machines.flatMap(m => m.projects.map(p => p.name)))].sort();

  if (projectNames.length === 0) {
    return tChat(lang, 'build.noProjects');
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
    return tChat(lang, 'build.noLogsYet');
  }

  return `${tChat(lang, 'build.header')}\n\n${lines.join('\n')}`;
}

function formatDuration(ms: number, lang: Language = DEFAULT_CHAT_LANGUAGE): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    const remainingMinutes = minutes % 60;
    return tChat(lang, 'duration.hoursMinutes', { h: hours, m: remainingMinutes });
  } else if (minutes > 0) {
    const remainingSeconds = seconds % 60;
    return tChat(lang, 'duration.minutesSeconds', { m: minutes, s: remainingSeconds });
  } else {
    return tChat(lang, 'duration.seconds', { s: seconds });
  }
}

async function handleLog(context: UserContext, count?: number): Promise<string> {
  const lang: Language = context.language ?? DEFAULT_CHAT_LANGUAGE;
  if (!context.currentSessionId) {
    return tChat(lang, 'log.notStarted');
  }

  const messages = await getSessionMessages(context.currentSessionId, count || 10);

  if (messages.length === 0) {
    return tChat(lang, 'log.empty');
  }

  const log = messages.reverse().map((m: Message) => {
    const prefix = m.role === 'user' ? '👤' : '🤖';
    const content = m.content.length > 100 ? m.content.slice(0, 100) + '...' : m.content;
    return `${prefix} ${content}`;
  }).join('\n\n');

  return tChat(lang, 'log.header', { count: messages.length, log });
}

async function handleSummary(context: UserContext, period?: string): Promise<string> {
  // TODO: Implement AI summary using Anthropic API
  const lang: Language = context.language ?? DEFAULT_CHAT_LANGUAGE;
  return tChat(lang, 'summary.comingSoon');
}

/** 実行中の AI プロセスを強制停止する */
async function handleKill(context: UserContext): Promise<string> {
  const lang: Language = context.language ?? DEFAULT_CHAT_LANGUAGE;
  if (!context.currentSessionId || !context.currentMachineId) {
    return tChat(lang, 'common.notConnected');
  }

  await cancelAiProcess(context.currentMachineId, context.currentSessionId);

  // フィードバックは agent:ai:cancelled 経由で返るため空文字
  return '';
}

/**
 * バージョン確認結果から「実行中コードの鮮度」表示行を生成（#256）
 * git reset は成功したのに dist が再ビルドされず古いまま実行され続ける
 * 「stale dist デッドロック」を検知するため、実行中エントリファイルの mtime を表示し、
 * ローカルコミットより古い場合は再ビルド漏れの警告を出す
 */
function formatRunningCodeLines(info: { runningCodeMtime?: string; runningCodeStale?: boolean }, lang: Language = DEFAULT_CHAT_LANGUAGE): string {
  if (!info.runningCodeMtime) return '';
  // ISO を読みやすい形式（UTC）に整形
  const mtimeDisp = new Date(info.runningCodeMtime).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  let lines = tChat(lang, 'runningCode.line', { mtime: mtimeDisp });
  if (info.runningCodeStale) {
    lines += tChat(lang, 'runningCode.staleWarning');
  }
  return lines;
}

/** Agent のバージョン確認・更新（2回連続で更新実行） */
async function handleUpdate(context: UserContext): Promise<string> {
  const lang: Language = context.language ?? DEFAULT_CHAT_LANGUAGE;
  if (!context.currentMachineId) {
    return tChat(lang, 'common.agentNotConnected');
  }

  const chatKey = `${context.platform}:${context.chatId}`;

  // 2回目の u: 更新実行
  if (pendingUpdate.has(chatKey)) {
    pendingUpdate.delete(chatKey);
    // セッションから projectId を取得（WebUI でリクエスト元タブに結果を返すため）
    let projectId: string | undefined;
    if (context.currentSessionId) {
      const session = await prisma.session.findUnique({
        where: { id: context.currentSessionId },
        select: { projectId: true },
      });
      projectId = session?.projectId;
    }
    // #320: 更新完了/失敗/タイムアウト通知の表示言語を伝搬
    updateAgent(context.currentMachineId, context.platform, context.chatId, projectId, lang);
    return tChat(lang, 'update.updating');
  }

  // 1回目の u: バージョン確認
  try {
    const info = await checkAgentVersion(context.currentMachineId, lang);

    if (info.error) {
      return tChat(lang, 'update.checkFailed', { error: info.error });
    }

    if (info.isDevRepo) {
      return tChat(lang, 'update.devRepoWarning');
    }

    if (!info.hasUpdate) {
      return tChat(lang, 'update.upToDate', {
        commit: info.localCommit.slice(0, 7),
        date: info.localDate,
        runningCodeLines: formatRunningCodeLines(info, lang),
      });
    }

    // 更新あり: pendingUpdate フラグを設定
    pendingUpdate.add(chatKey);
    const displayName = context.currentMachineName || 'Agent';
    return tChat(lang, 'update.available', {
      machine: displayName,
      localCommit: info.localCommit.slice(0, 7),
      localDate: info.localDate,
      remoteCommit: info.remoteCommit.slice(0, 7),
      remoteDate: info.remoteDate,
      runningCodeLines: formatRunningCodeLines(info, lang),
    });
  } catch (err) {
    return tChat(lang, 'update.checkFailed', { error: (err as Error).message });
  }
}

async function handleQuit(context: UserContext): Promise<string> {
  const lang: Language = context.language ?? DEFAULT_CHAT_LANGUAGE;
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
  
  return tChat(lang, 'quit.done');
}

/**
 * `l` コマンドでツールが明示されなかった場合に使う「現在セッションの AI ツール」を解決する（#309）。
 * セッション未接続・DB 取得失敗時は 'claude'（従来の唯一対応ツール）にフォールバックする。
 */
async function resolveContextModelTool(context: UserContext): Promise<ModelSelectableAiTool> {
  if (context.currentSessionId) {
    try {
      const session = await prisma.session.findUnique({
        where: { id: context.currentSessionId },
        select: { aiTool: true },
      });
      if (session?.aiTool && isModelSelectableAiTool(session.aiTool)) {
        return session.aiTool;
      }
    } catch {
      // DB 失敗時は claude にフォールバック（下の return で処理）
    }
  }
  return 'claude';
}

/** AI モデル一覧 + 現在の設定を表示（#309: tool 省略時は現在セッションのツール） */
async function handleModelList(context: UserContext, tool?: ModelSelectableAiTool): Promise<string> {
  const targetTool = tool ?? await resolveContextModelTool(context);
  const toolLabel = AI_TOOL_NAMES[targetTool] || targetTool;
  const catalog = AI_MODEL_CATALOG[targetTool];

  const planModel = await getUserSetting(context.userId, modelSettingKey(targetTool, 'plan')) || '(default)';
  const execModel = await getUserSetting(context.userId, modelSettingKey(targetTool, 'exec')) || '(default)';

  const lines = [`🧠 **${toolLabel} モデル設定**\n`];
  lines.push(`Plan: **${planModel}**`);
  lines.push(`Exec: **${execModel}**\n`);
  lines.push('**候補モデル**（カタログ外の ID も指定可能）:');
  for (const m of catalog) {
    lines.push(`  \`${m.id}\` — ${m.name}（${m.description}）`);
  }
  lines.push('\n**設定方法:**');
  lines.push(`\`l sonnet\` — 現在のツール（${toolLabel}）の Plan/Exec 両方を変更`);
  lines.push('`l plan:haiku` / `l exec:opus` — 現在のツールの片方のみ変更');
  lines.push('`l codex` — Codex CLI の設定を表示');
  lines.push('`l codex:plan:gpt-5.6-terra` — ツールを明示して変更');
  return lines.join('\n');
}

/** AI モデルを設定する（#309: tool 省略時は現在セッションのツール） */
async function handleModelSet(context: UserContext, target: 'both' | 'plan' | 'exec', model: string, tool?: ModelSelectableAiTool): Promise<string> {
  const targetTool = tool ?? await resolveContextModelTool(context);
  const toolLabel = AI_TOOL_NAMES[targetTool] || targetTool;
  const catalog = AI_MODEL_CATALOG[targetTool];

  // 危険文字（引数・TOML インジェクション対策）は無条件で拒否
  if (isUnsafeModelId(model)) {
    return `❌ モデル ID に使用できない文字が含まれています: \`${model}\``;
  }

  // カタログ一致を優先（大文字小文字を無視）、無ければカタログ外 ID として警告付きで許可
  const matched = catalog.find(m => m.id.toLowerCase() === model.toLowerCase());
  const modelId = matched?.id ?? model;
  const warning = matched ? '' : `\n⚠️ カタログ外の ID です（新モデル等で意図的な場合は無視してください）`;

  if (target === 'both' || target === 'plan') {
    await setUserSetting(context.userId, modelSettingKey(targetTool, 'plan'), modelId);
  }
  if (target === 'both' || target === 'exec') {
    await setUserSetting(context.userId, modelSettingKey(targetTool, 'exec'), modelId);
  }

  const targetLabel = target === 'both' ? 'Plan/Exec' : target === 'plan' ? 'Plan' : 'Exec';
  const displayName = matched?.name ?? modelId;
  return `✅ ${toolLabel} の ${targetLabel} モデルを **${displayName}** (\`${modelId}\`) に変更しました${warning}`;
}

async function handleAiList(context: UserContext): Promise<string> {
  const lang: Language = context.language ?? DEFAULT_CHAT_LANGUAGE;
  if (!context.currentSessionId || !context.currentMachineId) {
    return tChat(lang, 'common.notConnectedGuide');
  }

  try {
    const result = await getAiToolList(context.currentMachineId, context.currentSessionId);

    if (!result || result.available.length === 0) {
      return tChat(lang, 'ai.noTools');
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

    return tChat(lang, 'ai.listHeader', { list });
  } catch (err) {
    console.error('Failed to get AI tool list:', err);
    return tChat(lang, 'ai.listFailed');
  }
}

async function handleAiSwitch(context: UserContext, tool: string): Promise<string> {
  const lang: Language = context.language ?? DEFAULT_CHAT_LANGUAGE;
  if (!context.currentSessionId || !context.currentMachineId) {
    return tChat(lang, 'common.notConnected');
  }

  try {
    const result = await switchAiTool(context.currentMachineId, context.currentSessionId, tool as any);

    if (result.success) {
      // Update session's aiTool in DB
      const updatedSession = await prisma.session.update({
        where: { id: context.currentSessionId },
        data: { aiTool: tool },
        select: { projectId: true }
      });

      // #307: プロジェクトの既定 AI ツールも更新する。
      // これをしないと、次回このプロジェクトに新規セッションで接続した際
      // （Agent 切断→再接続等）に `a` で選んだツールが失われ project.defaultAi に戻ってしまう。
      // ask/teamexec/MCP 経由の実行も project.defaultAi を参照するため、ここで揃えておく。
      await prisma.project.update({
        where: { id: updatedSession.projectId },
        data: { defaultAi: tool }
      }).catch((err) => {
        console.error('Failed to update project.defaultAi:', err);
      });

      const name = AI_TOOL_NAMES[tool] || tool;
      return tChat(lang, 'ai.switched', { name });
    } else {
      return tChat(lang, 'ai.switchFailed', { error: result.error || tChat(lang, 'ai.unknownError') });
    }
  } catch (err) {
    console.error('Failed to switch AI tool:', err);
    return tChat(lang, 'ai.switchFailedGeneric');
  }
}

async function handleAiPrompt(
  context: UserContext,
  text: string,
  files?: FileAttachment[],
  missedMessages?: MissedMessage[]
): Promise<string> {
  const lang: Language = context.language ?? DEFAULT_CHAT_LANGUAGE;
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
          const reconnectMessage = tChat(lang, 'exec.reconnected', { machine: machineName, project: projectName });
          await sendMessage(updatedContext.platform, updatedContext.chatId, reconnectMessage);

          // AI にプロンプト送信（再帰呼び出し）- 結果をそのまま返す
          return handleAiPrompt(updatedContext, text, files, missedMessages);
        }
      }
      // 再接続失敗（オフラインなど）→ エラーメッセージを返す
      return reconnectResult;
    }

    // 前回の接続先がない場合
    return tChat(lang, 'common.notConnectedGuide');
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
      return tChat(lang, 'exec.sessionInfoNotFound');
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

  // セッション情報を取得（Agent 再起動時の自動初期化用に projectPath と aiTool を送信）
  const currentSession = await prisma.session.findUnique({
    where: { id: context.currentSessionId },
    include: { project: { select: { path: true } } }
  });

  // Start progress tracking (sends initial message)
  await startProgressTracking(context.currentSessionId);

  // #309: model は渡さず sendPromptToAgent 側（agent-manager.ts）で aiTool に応じたモデル設定を解決する
  // （command-handler で claude 固定キーを直読みすると codex 等の他ツールに対応できないため。単一情報源化）

  // Send to agent with files and missed messages
  // エラー時はトラッカーをクリーンアップして永遠にスタックしないようにする
  try {
    await sendPromptToAgent(
      context.currentMachineId,
      context.currentSessionId,
      text,
      context.userId,
      files,
      missedMessages,
      currentSession?.project.path,
      currentSession?.aiTool as AiTool | undefined,
      false,  // forceNewSession
      undefined, // model: 未指定（UserSettings から補完）
      undefined, // language: 未指定（UserSettings から補完）
      resolvePermissionPolicy('chat'),  // #332: チャット経由は従来どおり Machine.skipPermissions に従う
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

  // help は DB アクセス不要なので early return
  if (command.subcommand === 'help') {
    return getTestflightHelpText();
  }

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
      result = await createTestflightService(dbUserId, command.name, command.template);
      break;
    case 'remove':
      result = await removeTestflightService(dbUserId, command.name);
      break;
    case 'copy':
      result = await copyTestflightService(dbUserId, command.srcName, command.destName);
      break;
    case 'info':
      result = await getTestflightServiceInfo(dbUserId, command.name);
      break;
    default:
      result = '❓ 不明なサブコマンドです。`testflight help` で詳細ヘルプを表示できます。';
  }
  console.log(`🚀 handleTestflight: result (${result.length} chars): ${result.substring(0, 100)}...`);
  return result;
}

/**
 * テストフライト専用の詳細ヘルプテキストを生成
 */
function getTestflightHelpText(): string {
  return `
🛫 **TestFlight ヘルプ**

サブドメイン付きサービスを自動作成・管理するコマンドです。
作成したサービスは \`<name>.devrelay.io\` で即アクセスできます。

**基本コマンド**
\`testflight\` - サービス一覧を表示
\`testflight <name>\` - 新規サービス作成（プレースホルダー）
\`testflight cp <src> <dest>\` - サービスを複製（DB データ含む）
\`testflight rm <name>\` - サービスをアーカイブ（削除）
\`testflight info <name>\` - サービスの詳細情報を表示
\`testflight help\` - このヘルプを表示

**テンプレートオプション**
\`testflight <name> --phaser\` - Phaser 3 ゲームプロジェクトを作成

**--phaser テンプレート詳細**
Vite + Phaser 3 + TypeScript のゲーム開発環境を自動構築します。
- サンプル: 棒消し（Nim）対戦ゲーム + マッチメイキング + CPU 対戦 + 管理画面（/stats）
- HMR 対応の dev サーバーが PM2 で常駐起動（プロセス名: \`tf-<name>\`）
- Discord/Telegram から AI にゲーム改造指示が可能
- 画面サイズ: 480x720（モバイルファースト、Scale.FIT）

**サービス名ルール**
- 英小文字で始まる、英小文字・数字・ハイフンの組み合わせ
- 3〜30文字
- 予約語不可: devrelay, app, api, www, admin, test, staging, prod

**例**
\`testflight mygame --phaser\` → https://mygame.devrelay.io に Nim 対戦ゲーム
\`testflight mysite\` → https://mysite.devrelay.io にプレースホルダー
\`testflight cp mygame newgame\` → mygame を newgame に複製（リネーム代わり）
`.trim();
}

// -----------------------------------------------------------------------------
// Cross-project query
// -----------------------------------------------------------------------------

/** #295: ask / teamexec の宛先候補（マシン情報付きプロジェクト） */
type CrossTargetProject = Project & {
  machine: { id: string; name: string; displayName: string | null; status: string };
};

/**
 * #295: ask / teamexec の宛先を「Team に登録済みのプロジェクト」から解決する
 *
 * 従来は全プロジェクト（実運用で 330 件）から `findFirst` で先頭 1 件を取っており、
 * 同名プロジェクトがあると宛先を取り違えた（#294 の暴走の一因）。
 * チャットは発信元マシンが曖昧なため、許可集合は「ユーザーが所有する Team のメンバー全体」とする。
 *
 * @param dbUserId ユーザー ID
 * @param targetProjectName 指定されたプロジェクト名
 * @returns 解決できたプロジェクト、または呼び出し元がそのまま返すエラーメッセージ
 */
async function resolveCrossTargetByName(
  dbUserId: string,
  targetProjectName: string
): Promise<{ ok: false; error: string } | { ok: true; project: CrossTargetProject; legacy: boolean }> {
  const includeMachine = { machine: { select: { id: true, name: true, displayName: true, status: true } } } as const;

  // 移行措置: Team を 1 つも作っていないユーザーは従来どおり全プロジェクトを対象にする
  const teamCount = await prisma.team.count({ where: { userId: dbUserId } });
  const candidates = await prisma.project.findMany({
    where: {
      deletedAt: null,
      machine: { userId: dbUserId, deletedAt: null },
      ...(teamCount > 0 ? { teamMembers: { some: { team: { userId: dbUserId } } } } : {}),
    },
    include: includeMachine,
  });

  const needle = targetProjectName.trim().toLowerCase();
  const label = (p: typeof candidates[number]) => p.displayName ?? p.name;
  const matches = (() => {
    const exact = candidates.filter(p => label(p).toLowerCase() === needle || p.name.toLowerCase() === needle);
    if (exact.length > 0) return exact;
    return candidates.filter(p => label(p).toLowerCase().includes(needle) || p.name.toLowerCase().includes(needle));
  })();

  const format = (list: typeof candidates) => list
    .map(p => `  - ${label(p)} (${p.machine.displayName ?? p.machine.name})${p.machine.status === 'online' ? '' : ' ⏸ offline'}`)
    .join('\n');

  if (matches.length === 0) {
    return {
      ok: false,
      error: `❌ "${targetProjectName}" は宛先として登録されていません。\n\n`
        + (candidates.length > 0 ? `送信できる宛先:\n${format(candidates)}\n\n` : '')
        + 'WebUI の Team ページで宛先プロジェクトを登録してください。',
    };
  }

  // #294 と同じ思想: 複数一致は勝手に選ばず候補を提示して中止する
  if (matches.length > 1) {
    return {
      ok: false,
      error: `❌ "${targetProjectName}" に一致する宛先が ${matches.length} 件あります。宛先を特定できません。\n\n`
        + `候補:\n${format(matches)}\n\n`
        + 'プロジェクトの表示名を変えて一意にするか、WebUI の Team ページで登録を整理してください。',
    };
  }

  return { ok: true, project: matches[0], legacy: teamCount === 0 };
}

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

  // #295: Team に登録済みの宛先から解決（同名が複数あれば候補を提示して中止）
  const resolved = await resolveCrossTargetByName(dbUserId, targetProjectName);
  if (!resolved.ok) return resolved.error;
  const targetProject = resolved.project;

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
  // 送信元プロジェクト名を保存（クロスクエリの送信元表示用）
  await prisma.message.create({
    data: {
      sessionId: tempSessionId,
      role: 'user',
      content: question,
      platform: context.platform,
      sourceProjectName: context.currentProjectName ?? undefined,
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

  // #295: Team に登録済みの宛先から解決（同名が複数あれば候補を提示して中止）
  const resolved = await resolveCrossTargetByName(dbUserId, targetProjectName);
  if (!resolved.ok) return resolved.error;
  const targetProject = resolved.project;

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
  // 送信元プロジェクト名を保存（クロスクエリの送信元表示用）
  await prisma.message.create({
    data: {
      sessionId: tempSessionId,
      role: 'user',
      content: `[teamexec] ${instruction}`,
      platform: context.platform,
      sourceProjectName: context.currentProjectName ?? undefined,
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

    // teamexec 成功 → 接続プロジェクトとして記憶（以降の exec/w がこのプロジェクトに転送される）
    context.lastRemoteProjectId = targetProject.id;
    context.lastRemoteProjectName = targetProject.displayName ?? targetProject.name;

    return `🔧 **${targetProject.name}** の実行結果:\n\n${result.output}\n\n🔗 ${targetProject.name} に接続中（\`e\` / \`w\` はこのプロジェクトに転送されます。\`d\` で解除）`;
  } catch (error: any) {
    await prisma.session.update({
      where: { id: tempSessionId },
      data: { status: 'ended', endedAt: new Date() },
    }).catch(() => {});

    return `❌ ${targetProject.name} への実行依頼が失敗しました: ${error.message}`;
  }
}

/**
 * 接続プロジェクト（teamexec 先）を解除する
 * 解除後、exec/w コマンドは自身のプロジェクトに戻る
 */
async function handleDisconnectRemote(context: UserContext): Promise<string> {
  const lang: Language = context.language ?? DEFAULT_CHAT_LANGUAGE;
  if (!context.lastRemoteProjectId) {
    return tChat(lang, 'disconnect.notConnected');
  }

  const remoteName = context.lastRemoteProjectName || context.lastRemoteProjectId;
  context.lastRemoteProjectId = undefined;
  context.lastRemoteProjectName = undefined;

  return tChat(lang, 'disconnect.done', { name: remoteName });
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function formatRelativeDate(date: Date, lang: Language = DEFAULT_CHAT_LANGUAGE): string {
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));

  if (lang === 'en') {
    if (days === 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 7) return `${days}d ago`;
    if (days < 30) return `${Math.floor(days / 7)}w ago`;
    return `${Math.floor(days / 30)}mo ago`;
  }

  if (days === 0) return '今日';
  if (days === 1) return '昨日';
  if (days < 7) return `${days}日前`;
  if (days < 30) return `${Math.floor(days / 7)}週間前`;
  return `${Math.floor(days / 30)}ヶ月前`;
}
