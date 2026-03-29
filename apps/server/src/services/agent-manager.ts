import type { WebSocket } from 'ws';
import type { FastifyRequest } from 'fastify';
import {
  PROTOCOL_VERSION,
  type AgentMessage,
  type ServerToAgentMessage,
  type Machine,
  type Project,
  type AiTool,
  type FileAttachment,
  type WorkState,
  type AiListResponsePayload,
  type AiSwitchedPayload,
  type AiCancelledPayload,
  type AgentVersionInfoPayload,
  type AgentUpdateStatusPayload,
  type ToolApprovalRequestPayload,
  type ToolApprovalAutoPayload,
  type ToolApprovalPromptPayload,
  type ServerToWebMessage,
  type Platform,
} from '@devrelay/shared';
import { prisma } from '../db/client.js';
import { appendSessionOutput, finalizeProgress, broadcastToSession, clearSessionsForMachine, restoreSessionParticipantsForMachine, sendMessage, getSessionParticipants } from './session-manager.js';
import { sendWebRawMessage, broadcastWebRawMessage } from '../platforms/web.js';
import { sendDiscordToolApproval, resolveDiscordToolApproval, sendDiscordToolApprovalAuto } from '../platforms/discord.js';
import { sendTelegramToolApproval, resolveTelegramToolApproval, sendTelegramToolApprovalAuto } from '../platforms/telegram.js';
import { summarizeBuildOutput } from './build-summarizer.js';
import { buildAgreementApplyPrompt } from './agreement-template.js';
import { getUserSetting, SettingKeys } from './user-settings.js';
import { generateToolRule } from './tool-format.js';
import { processMessageFilesEmbedding } from './embedding-service.js';
import type { ManagementInfo } from '@devrelay/shared';

/** サーバーが要求する最小プロトコルバージョン（これ未満の Agent は会話制限） */
const MIN_PROTOCOL_VERSION = 1;

/** バージョン不足の Agent を記録（接続は許可するが会話は拒否、u コマンドのみ許可） */
const outdatedAgents = new Set<string>();

// Connected agents: machineId -> WebSocket
const connectedAgents = new Map<string, WebSocket>();

// Machine info cache: machineId -> Machine
const machineCache = new Map<string, Machine>();

// Pending history requests: requestId -> { resolve, reject, timeout }
interface HistoryRequest<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}
const pendingHistoryDatesRequests = new Map<string, HistoryRequest<string[]>>();
const pendingHistoryExportRequests = new Map<string, HistoryRequest<string>>();

// AI tool list/switch requests
const pendingAiListRequests = new Map<string, HistoryRequest<AiListResponsePayload>>();
const pendingAiSwitchRequests = new Map<string, HistoryRequest<AiSwitchedPayload>>();

// クロスプロジェクトクエリの待機: sessionId → { resolve, reject, timeout }
// ask-member API が一時セッションの完了を待つために使用
const pendingCrossQueries = new Map<string, HistoryRequest<{ output: string; files?: FileAttachment[] }>>();

// プロジェクトファイル読み取り要求の待機: requestId → { resolve, reject, timeout }
const pendingFileReadRequests = new Map<string, HistoryRequest<{ content: string | null; error?: string }>>();

// プランファイル読み取り要求の待機: requestId → { resolve, reject, timeout }
const pendingPlanRequests = new Map<string, HistoryRequest<{ filename: string | null; content: string | null }>>();

// Agent ローカルの projectsDirs: machineId -> string[]（接続時に報告される）
const agentLocalProjectsDirs = new Map<string, string[]>();

// Heartbeat: メモリ内で lastSeenAt を管理し、60秒ごとにまとめて DB 更新（バッチ化）
const lastSeenMap = new Map<string, Date>();

// 未配信の設定更新: machineId -> { payload, retries, createdAt }
// pushConfigUpdate で WebSocket 送信が失敗する場合（接続が半開き状態等）に備え、
// 次回 agent:ping 受信時にリトライする。Agent から agent:config:ack を受信したら削除。
// 旧バージョン Agent は ack を返さないため、最大リトライ回数で打ち切る。
const MAX_CONFIG_RETRIES = 5;
interface PendingConfigUpdate {
  config: { projectsDirs?: string[] | null; allowedTools?: string[] | null; skipPermissions?: boolean };
  retries: number;
}
const pendingConfigUpdates = new Map<string, PendingConfigUpdate>();

/** 切断猶予タイマー: 短時間の切断（Caddy reload 等）で再接続した場合にオフライン通知をキャンセルする */
const disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
const DISCONNECT_GRACE_PERIOD = 5000; // 5秒

// バージョン確認リクエスト: machineId -> Promise コールバック
const pendingVersionCheckRequests = new Map<string, HistoryRequest<AgentVersionInfoPayload>>();

// 更新リクエストの通知先: machineId -> { platform, chatId, projectId }（完了/エラー通知用）
const pendingUpdateNotify = new Map<string, { platform: Platform; chatId: string; projectId?: string }>();

// Agent 再接続フラグ: Agent が再接続した machineId を記録
// 再接続後の最初のプロンプトでセッション再開始が必要かを判定するために使用
const needsSessionRestart = new Set<string>();

export function setupAgentWebSocket(connection: { socket: WebSocket }, req: FastifyRequest) {
  const ws = connection.socket;
  let machineId: string | null = null;

  console.log('🔌 New agent connection attempt');

  ws.on('message', async (data) => {
    try {
      const message: AgentMessage = JSON.parse(data.toString());

      switch (message.type) {
        case 'agent:connect':
          // handleAgentConnect が DB の machine.id を返す（token 無効時は null）
          // payload.machineId は Agent config 由来で空文字の場合があるため使わない
          machineId = await handleAgentConnect(ws, message.payload) ?? machineId;
          break;

        case 'agent:disconnect':
          await handleAgentDisconnect(message.payload.machineId, ws);
          break;

        case 'agent:projects':
          await handleProjectsUpdate(message.payload.machineId, message.payload.projects);
          break;

        case 'agent:ai:output':
          await handleAiOutput(message.payload);
          break;

        case 'agent:ai:status':
          await handleAiStatus(message.payload);
          break;

        case 'agent:storage:saved':
          await handleStorageSaved(message.payload);
          break;

        case 'agent:ping':
          await handleAgentPing(ws, message.payload);
          break;

        case 'agent:session:restore':
          await handleSessionRestore(ws, message.payload);
          break;

        case 'agent:history:dates':
          await handleHistoryDates(message.payload);
          break;

        case 'agent:history:export':
          await handleHistoryExport(message.payload);
          break;

        case 'agent:ai:list':
          await handleAgentAiList(message.payload);
          break;

        case 'agent:ai:switched':
          await handleAgentAiSwitched(message.payload);
          break;

        case 'agent:session:aiTool':
          await handleSessionAiTool(message.payload);
          break;

        case 'agent:ai:cancelled':
          await handleAiCancelled(message.payload);
          break;

        case 'agent:config:ack':
          // Agent が設定更新を受信・適用完了 → pending から削除
          handleConfigAck(message.payload.machineId);
          break;

        case 'agent:version:info':
          handleVersionInfo(message.payload);
          break;

        case 'agent:update:status':
          await handleUpdateStatus(message.payload);
          break;

        case 'agent:project:file:content':
          handleProjectFileContent(message.payload);
          break;

        case 'agent:tool:approval:request':
          await handleToolApprovalRequest(message.payload);
          break;

        case 'agent:tool:approval:auto':
          await handleToolApprovalAuto(message.payload);
          break;

        case 'agent:plan:content':
          handlePlanContent(message.payload);
          break;
      }
    } catch (err) {
      console.error('Error processing agent message:', err);
    }
  });

  ws.on('close', async () => {
    if (machineId) {
      await handleAgentDisconnect(machineId, ws);
      console.log(`🔌 Agent disconnected: ${machineId}`);
    }
  });

  ws.on('error', (err) => {
    console.error('Agent WebSocket error:', err);
  });
}

// -----------------------------------------------------------------------------
// Handlers
// -----------------------------------------------------------------------------

async function handleAgentConnect(
  ws: WebSocket,
  payload: { machineId: string; machineName: string; token: string; projects: Project[]; availableAiTools: AiTool[]; managementInfo?: any; projectsDirs?: string[]; protocolVersion?: number }
): Promise<string | null> {
  const { machineId, machineName, token, projects, availableAiTools, managementInfo, projectsDirs: localDirs } = payload;

  // Verify token（ソフトデリート済みの Machine は接続拒否）
  const machine = await prisma.machine.findFirst({
    where: { token, deletedAt: null }
  });

  if (!machine) {
    sendToAgent(ws, {
      type: 'server:connect:ack',
      payload: { success: false, error: 'Invalid token' }
    });
    ws.close();
    return null;
  }

  // プロトコルバージョンチェック（旧 Agent は protocolVersion 未送信 = 0 として扱う）
  // ソフトリジェクション: 接続は許可するが会話を制限（u コマンドで更新可能にするため）
  const agentVersion = payload.protocolVersion ?? 0;
  const isOutdated = agentVersion < MIN_PROTOCOL_VERSION;
  if (isOutdated) {
    console.log(`⚠️ Agent ${machine.name} outdated: protocol v${agentVersion} < v${MIN_PROTOCOL_VERSION} (connection allowed, conversations blocked)`);
    outdatedAgents.add(machine.id);
  } else {
    // 更新後の再接続でクリア
    outdatedAgents.delete(machine.id);
  }

  // 切断猶予タイマーをキャンセル（短時間の再接続ではオフライン通知を抑制）
  const pendingDisconnectTimer = disconnectTimers.get(machine.id);
  if (pendingDisconnectTimer) {
    clearTimeout(pendingDisconnectTimer);
    disconnectTimers.delete(machine.id);
    console.log(`🔌 Cancelled disconnect timer for ${machine.id} (reconnected)`);
  }

  // Agent から送信された machineName で DB の名前を自動更新する条件:
  // 1. 仮名（agent-N）→ 正式名への更新（初回接続時）
  // 2. 旧形式（hostname のみ）→ 新形式（hostname/username）への自動マイグレーション
  //    例: DB "DESKTOP-Q43QT7L" + Agent "DESKTOP-Q43QT7L/fwjg2" → 更新
  //    ユーザーが手動で別名に設定した場合は上書きしない（hostname が一致しないため）
  let updatedName = machine.name;
  const trimmedName = machineName?.trim();
  if (trimmedName && trimmedName.length > 0 && trimmedName !== machine.name) {
    const isProvisional = machine.name.startsWith('agent-');
    // 旧形式判定: Agent が hostname/username で送信し、DB の名前が hostname 部分と一致
    const isOldFormat = trimmedName.includes('/') && machine.name === trimmedName.split('/')[0];

    if (isProvisional || isOldFormat) {
      // 同じユーザーに同名の Agent が既にないか確認（重複防止）
      const duplicate = await prisma.machine.findFirst({
        where: { userId: machine.userId, name: trimmedName, id: { not: machine.id }, deletedAt: null },
      });
      if (!duplicate) {
        updatedName = trimmedName;
      } else if (duplicate.status === 'offline') {
        // 重複マシンが offline の場合、旧マシン名をリネームして新マシンに名前を譲る
        const oldName = `${duplicate.name} (old)`;
        await prisma.machine.update({
          where: { id: duplicate.id },
          data: { name: oldName },
        });
        console.log(`📝 Renamed offline duplicate: ${duplicate.name} → ${oldName} (id: ${duplicate.id})`);
        updatedName = trimmedName;
      }
    }
  }

  // マシン状態を更新（仮名の場合は名前も更新、管理コマンド情報も保存）
  await prisma.machine.update({
    where: { id: machine.id },
    data: {
      status: 'online',
      lastSeenAt: new Date(),
      name: updatedName,
      ...(managementInfo ? { managementInfo } : {}),
    }
  });

  // Update projects
  for (const project of projects) {
    await prisma.project.upsert({
      where: {
        machineId_name: { machineId: machine.id, name: project.name }
      },
      update: { path: project.path, defaultAi: project.defaultAi },
      create: {
        machineId: machine.id,
        name: project.name,
        path: project.path,
        defaultAi: project.defaultAi
      }
    });
  }

  // 同じホスト名を持つ兄弟マシンから displayName を自動計算
  // 例: 兄弟マシン "x220/user1" に displayName "vps-prod/user1" がある場合、
  // 新しいマシン "x220/user2" には "vps-prod/user2" を自動設定
  let autoDisplayName = machine.displayName;
  if (!autoDisplayName && updatedName.includes('/')) {
    const hostname = updatedName.split('/')[0];
    const username = updatedName.split('/').slice(1).join('/');

    // 同じユーザーの同じホスト名の兄弟マシンで displayName が設定されているものを検索
    const sibling = await prisma.machine.findFirst({
      where: {
        userId: machine.userId,
        name: { startsWith: `${hostname}/` },
        displayName: { not: null },
        id: { not: machine.id },
        deletedAt: null,
      },
      select: { displayName: true },
    });

    if (sibling?.displayName) {
      // 兄弟の displayName からエイリアス部分を抽出して新しい displayName を構築
      const siblingAlias = sibling.displayName.split('/')[0];
      autoDisplayName = `${siblingAlias}/${username}`;

      // DB に保存
      await prisma.machine.update({
        where: { id: machine.id },
        data: { displayName: autoDisplayName },
      });
    }
  }

  // 旧接続が残っていれば即座に破棄（terminate はハンドシェイク不要で close イベントを即発火）
  // close() だと相手が既に切断済みの場合ハンドシェイク応答が来ず close イベントが永遠に発火しない
  const existingWs = connectedAgents.get(machine.id);
  if (existingWs && existingWs !== ws) {
    console.log(`🔌 Closing stale WebSocket for ${machine.id} before new connection`);
    try { existingWs.terminate(); } catch {}
  }

  // Store connection and agent's local projectsDirs
  connectedAgents.set(machine.id, ws);
  if (localDirs && localDirs.length > 0) {
    agentLocalProjectsDirs.set(machine.id, localDirs);
  }
  machineCache.set(machine.id, {
    id: machine.id,
    name: updatedName,
    displayName: autoDisplayName,
    status: 'online',
    lastSeen: new Date(),
    projects
  });

  // Server 管理のプロジェクト検索パスを取得（null ならローカル設定にフォールバック）
  const serverProjectsDirs = machine.projectsDirs as string[] | null;

  // Agent の OS に応じた allowedTools を UserSettings から取得
  const agentOs = (managementInfo as ManagementInfo | null)?.os;
  const allowedToolsKey = agentOs === 'win32' ? SettingKeys.ALLOWED_TOOLS_WINDOWS : SettingKeys.ALLOWED_TOOLS_LINUX;
  const allowedToolsRaw = await getUserSetting(machine.userId, allowedToolsKey);
  const allowedTools = allowedToolsRaw ? JSON.parse(allowedToolsRaw) as string[] : null;

  // 再接続時に connect:ack で最新の DB 値を配信するため、pending リトライは不要
  pendingConfigUpdates.delete(machine.id);

  sendToAgent(ws, {
    type: 'server:connect:ack',
    payload: {
      success: true,
      machineId: machine.id,
      projectsDirs: serverProjectsDirs,
      allowedTools,
      skipPermissions: machine.skipPermissions || undefined,
      disableAsk: machine.disableAsk || undefined,
      ...(isOutdated && {
        updateRequired: true,
        minProtocolVersion: MIN_PROTOCOL_VERSION,
      }),
    }
  });

  console.log(`✅ Agent connected: ${updatedName} (${machine.id})`);

  // Agent再接続時にセッション参加者を復元（切断前のセッションを継続可能にする）
  await restoreSessionParticipantsForMachine(machine.id);

  // Agent 再接続フラグを設定（次回プロンプト時にセッション再開始が必要）
  // Agent 再起動で sessionInfoMap がクリアされるため、server:session:start の再送が必要
  needsSessionRestart.add(machine.id);

  // Agent 更新後の再接続なら、リクエスト元に完了通知を送信
  const updateRequestor = pendingUpdateNotify.get(machine.id);
  if (updateRequestor) {
    pendingUpdateNotify.delete(machine.id);
    const displayName = autoDisplayName || updatedName;
    sendMessage(updateRequestor.platform, updateRequestor.chatId,
      `✅ **${displayName}** の更新が完了しました`, undefined, updateRequestor.projectId);
  }

  return machine.id;
}

/**
 * Agent 切断時の処理
 * pm2 restart 時などに旧接続の close イベントが新接続の後に遅延発火する場合があるため、
 * 切断された WebSocket が現在の接続と同一かを確認し、異なればスキップする（Race Condition 防止）
 *
 * @param machineId 切断された Agent のマシンID
 * @param disconnectedWs 切断された WebSocket インスタンス（close イベントから渡される）
 */
async function handleAgentDisconnect(machineId: string, disconnectedWs?: WebSocket) {
  // 既に新しい接続に差し替わっている場合は、古い接続の切断として扱いスキップ
  const currentWs = connectedAgents.get(machineId);
  if (disconnectedWs && currentWs && currentWs !== disconnectedWs) {
    console.log(`🔌 Stale connection closed for ${machineId} (new connection already active), skipping disconnect`);
    return;
  }

  connectedAgents.delete(machineId);
  machineCache.delete(machineId);
  agentLocalProjectsDirs.delete(machineId);
  pendingConfigUpdates.delete(machineId);
  outdatedAgents.delete(machineId);

  try {
    await prisma.machine.update({
      where: { id: machineId },
      data: { status: 'offline' }
    });
  } catch (err) {
    // Machine may not exist in DB (e.g., already deleted)
    console.log(`⚠️ Could not update machine status for ${machineId}:`, err);
  }

  // セッションクリア + 通知を猶予期間後に遅延実行
  // 短時間の切断（Caddy reload 等）で Agent が再接続した場合はキャンセルされる
  const existingTimer = disconnectTimers.get(machineId);
  if (existingTimer) clearTimeout(existingTimer);

  const timer = setTimeout(async () => {
    disconnectTimers.delete(machineId);
    // 再接続済みならスキップ
    if (connectedAgents.has(machineId)) {
      console.log(`🔌 Machine ${machineId} reconnected within grace period, skipping offline notification`);
      return;
    }
    await clearSessionsForMachine(machineId);
  }, DISCONNECT_GRACE_PERIOD);

  disconnectTimers.set(machineId, timer);
}

async function handleProjectsUpdate(machineId: string, projects: Project[]) {
  const cached = machineCache.get(machineId);
  if (cached) {
    cached.projects = projects;
  }

  // Update DB
  for (const project of projects) {
    await prisma.project.upsert({
      where: {
        machineId_name: { machineId, name: project.name }
      },
      update: { path: project.path, defaultAi: project.defaultAi },
      create: {
        machineId,
        name: project.name,
        path: project.path,
        defaultAi: project.defaultAi
      }
    });
  }
}

async function handleAiOutput(payload: { machineId: string; sessionId: string; output: string; isComplete: boolean; files?: FileAttachment[]; usageData?: any; isExec?: boolean; execPrompt?: string }) {
  const { sessionId, output, isComplete, files, usageData, isExec, execPrompt } = payload;

  console.log(`📥 AI Output received: isComplete=${isComplete}, length=${output.length}${isExec ? ' [EXEC]' : ''}`);

  if (isComplete) {
    // クロスプロジェクトクエリの待機中なら resolve（DB 保存は通常フローで行う）
    const pendingQuery = pendingCrossQueries.get(sessionId);
    if (pendingQuery) {
      pendingCrossQueries.delete(sessionId);
      clearTimeout(pendingQuery.timeout);
      pendingQuery.resolve({ output, files });
      console.log(`🔗 Cross-project query completed for session ${sessionId}`);
      // early return せず、通常のメッセージ保存フローに進む
    }

    // Save final output to DB（usageData がある場合は JSON として保存、出力ファイルも同時保存）
    const aiMessage = await prisma.message.create({
      data: {
        sessionId,
        role: 'ai',
        content: output,
        platform: 'system',
        usageData: usageData ?? undefined,
        files: files && files.length > 0 ? {
          create: files.map(f => ({
            filename: f.filename,
            mimeType: f.mimeType,
            size: f.size,
            content: Buffer.from(f.content, 'base64'),
            direction: 'output',
          })),
        } : undefined,
      }
    });

    // 出力ファイルの埋め込みを非同期生成（fire-and-forget）
    if (files && files.length > 0) {
      processMessageFilesEmbedding(aiMessage.id).catch(err =>
        console.error('[Embedding] fire-and-forget error:', err.message));
    }

    if (usageData) {
      const models = usageData.modelUsage ? Object.keys(usageData.modelUsage).join(', ') : 'unknown';
      console.log(`💾 Usage data saved: duration=${usageData.durationMs}ms, models=${models}`);
    }

    // BuildLog: exec 実行完了時にビルドログを自動作成
    // フォールバックサマリー（先頭200文字）で即座に作成し、
    // 非同期で AI 要約を生成して DB を上書きする（fire-and-forget）
    if (isExec && output.trim()) {
      try {
        const session = await prisma.session.findUnique({
          where: { id: sessionId },
          include: { project: true },
        });

        if (session) {
          // フォールバックサマリーで即座に BuildLog 作成（ユーザー応答を遅延させない）
          const fallbackSummary = extractBuildSummary(output);
          const buildNumber = await createBuildLog({
            projectName: session.project.name,
            projectId: session.projectId,
            machineId: session.machineId,
            sessionId,
            userId: session.userId,
            summary: fallbackSummary,
            prompt: execPrompt,
          });
          console.log(`📋 BuildLog #${buildNumber} created for ${session.project.name}`);

          // AI 要約を非同期で生成し、完了後に DB を更新（fire-and-forget）
          updateBuildLogSummaryAsync(
            session.project.name,
            buildNumber,
            session.userId,
            output,
            execPrompt,
          );
        }
      } catch (err) {
        console.error('❌ Failed to create BuildLog:', (err as Error).message);
      }
    }

    // Log files if present
    if (files && files.length > 0) {
      console.log(`📎 Received ${files.length} file(s) from agent for session ${sessionId}`);
    }

    // Finalize progress with final message
    await finalizeProgress(sessionId, output, files);
  } else {
    // Append partial output to progress buffer
    appendSessionOutput(sessionId, output);
  }
}

/**
 * AI 応答テキストからビルドサマリーを抽出する
 * Markdown 装飾を除去し、先頭 maxLength 文字を取得
 */
function extractBuildSummary(output: string, maxLength: number = 200): string {
  let text = output;

  // contextInfo 行を除去（📊, 📝 で始まる行）
  text = text.replace(/^[📊📝].+\n?/gm, '');

  // Markdown 見出しを除去（# ## ### など）
  text = text.replace(/^#{1,6}\s+/gm, '');

  // コードブロックを除去
  text = text.replace(/```[\s\S]*?```/g, '[code]');

  // Markdown の太字・斜体を除去
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1');
  text = text.replace(/\*([^*]+)\*/g, '$1');

  // 連続する空白行を1行に圧縮
  text = text.replace(/\n{3,}/g, '\n\n');

  // 先頭の空白行を除去
  text = text.trimStart();

  // 指定文字数で切り詰め
  if (text.length > maxLength) {
    text = text.substring(0, maxLength) + '...';
  }

  return text;
}

/**
 * BuildLog の summary を AI 要約で非同期更新する（fire-and-forget）
 *
 * API 呼び出しに失敗しても、既にフォールバックサマリーが保存されているため
 * ユーザーへの影響はない。エラーはログ出力のみ。
 */
async function updateBuildLogSummaryAsync(
  projectName: string,
  buildNumber: number,
  userId: string,
  output: string,
  execPrompt?: string,
): Promise<void> {
  try {
    const aiSummary = await summarizeBuildOutput(userId, output, execPrompt);
    if (aiSummary) {
      await prisma.buildLog.update({
        where: {
          projectName_buildNumber: { projectName, buildNumber },
        },
        data: { summary: aiSummary },
      });
      console.log(`📋 BuildLog #${buildNumber} summary updated with AI: ${aiSummary}`);
    }
  } catch (err) {
    // fire-and-forget: エラーをログに出すだけ（フォールバックサマリーが残る）
    console.error(`⚠️ Failed to update BuildLog #${buildNumber} summary:`, (err as Error).message);
  }
}

/**
 * BuildLog レコードを作成する
 * projectName ごとの連番 buildNumber をトランザクション内で採番
 * @@unique 制約違反（レースコンディション）時は最大3回リトライ
 */
async function createBuildLog(params: {
  projectName: string;
  projectId: string;
  machineId: string;
  sessionId: string;
  userId: string;
  summary: string;
  prompt?: string;
}): Promise<number> {
  const MAX_RETRIES = 3;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const result = await prisma.$transaction(async (tx) => {
        // 同一 projectName の最大 buildNumber を取得
        const latest = await tx.buildLog.findFirst({
          where: { projectName: params.projectName },
          orderBy: { buildNumber: 'desc' },
          select: { buildNumber: true },
        });

        const nextBuildNumber = (latest?.buildNumber ?? 0) + 1;

        const log = await tx.buildLog.create({
          data: {
            buildNumber: nextBuildNumber,
            projectName: params.projectName,
            projectId: params.projectId,
            machineId: params.machineId,
            sessionId: params.sessionId,
            userId: params.userId,
            summary: params.summary,
            prompt: params.prompt,
          },
        });

        return log.buildNumber;
      });

      return result;
    } catch (err: any) {
      // @@unique 制約違反 = 同時挿入のレースコンディション → リトライ
      if (err.code === 'P2002' && attempt < MAX_RETRIES - 1) {
        console.log(`⚠️ BuildLog race condition, retrying (attempt ${attempt + 1})...`);
        continue;
      }
      throw err;
    }
  }

  throw new Error('Failed to create BuildLog after retries');
}

async function handleAiStatus(payload: { machineId: string; sessionId: string; status: string; error?: string; agreementStatus?: string | boolean }) {
  // Build status message
  let statusMessage = payload.error
    ? `❌ Error: ${payload.error}`
    : `🤖 AI Status: ${payload.status}`;

  // Add agreement status if provided
  if (payload.agreementStatus !== undefined && payload.status === 'running') {
    // 新しい詳細ステータス（'latest', 'outdated', 'none'）または後方互換の boolean
    const status = payload.agreementStatus;
    if (status === 'latest') {
      statusMessage += '\n✅ DevRelay Agreement 対応済み';
    } else if (status === 'outdated') {
      statusMessage += '\n⚠️ DevRelay Agreement 旧版 - `ag` で最新版に更新できます';
    } else if (status === 'none' || status === false) {
      statusMessage += '\n⚠️ DevRelay Agreement 未対応 - `ag` で対応できます';
    } else if (status === true) {
      // 後方互換: true の場合は対応済みとみなす
      statusMessage += '\n✅ DevRelay Agreement 対応済み';
    }
  }

  await broadcastToSession(payload.sessionId, statusMessage, false);
}

async function handleStorageSaved(payload: { machineId: string; sessionId: string; projectPath: string; contentLength: number }) {
  const { sessionId, contentLength } = payload;
  const message = `💾 ストレージコンテキストを保存しました（${contentLength}文字）`;
  await broadcastToSession(sessionId, message, false);
}

async function handleAgentPing(ws: WebSocket, payload: { machineId: string; timestamp: string }) {
  const { machineId, timestamp } = payload;

  // メモリ内の lastSeenMap のみ更新（DB 更新は heartbeat monitor でバッチ処理）
  const now = new Date();
  lastSeenMap.set(machineId, now);

  // キャッシュも更新
  const cached = machineCache.get(machineId);
  if (cached) {
    cached.lastSeen = now;
  }

  // 未配信の設定更新があればリトライ（ping を受信した ws に直接送信）
  const pending = pendingConfigUpdates.get(machineId);
  if (pending) {
    pending.retries++;
    if (pending.retries > MAX_CONFIG_RETRIES) {
      // リトライ上限到達（旧バージョン Agent は ack を返さないため）
      console.log(`⚠️ Config update retry limit reached for ${machineId}, giving up`);
      pendingConfigUpdates.delete(machineId);
    } else {
      console.log(`🔄 Retrying config update for ${machineId} (${pending.retries}/${MAX_CONFIG_RETRIES})`);
      sendToAgent(ws, {
        type: 'server:config:update',
        payload: pending.config,
      });
    }
  }

  // pong 返信
  sendToAgent(ws, {
    type: 'server:pong',
    payload: { timestamp: new Date().toISOString() }
  });
}

async function handleHistoryDates(payload: { machineId: string; projectPath: string; requestId: string; dates: string[] }) {
  const { requestId, dates } = payload;
  const pending = pendingHistoryDatesRequests.get(requestId);

  if (pending) {
    clearTimeout(pending.timeout);
    pendingHistoryDatesRequests.delete(requestId);
    pending.resolve(dates);
    console.log(`📅 History dates received: ${dates.length} dates for request ${requestId}`);
  }
}

async function handleHistoryExport(payload: { machineId: string; projectPath: string; requestId: string; date: string; zipContent: string; error?: string }) {
  const { requestId, zipContent, error } = payload;
  const pending = pendingHistoryExportRequests.get(requestId);

  if (pending) {
    clearTimeout(pending.timeout);
    pendingHistoryExportRequests.delete(requestId);
    if (error) {
      pending.reject(new Error(error));
      console.log(`❌ History export failed for request ${requestId}: ${error}`);
    } else {
      pending.resolve(zipContent);
      console.log(`📦 History export received for request ${requestId}`);
    }
  }
}

/** Agent からのプロジェクトファイル読み取り結果を処理 */
function handleProjectFileContent(payload: { machineId: string; requestId: string; content: string | null; error?: string }) {
  const { requestId, content, error } = payload;
  const pending = pendingFileReadRequests.get(requestId);
  if (pending) {
    clearTimeout(pending.timeout);
    pendingFileReadRequests.delete(requestId);
    if (error) {
      pending.reject(new Error(error));
    } else {
      pending.resolve({ content, error });
    }
  }
}

/** Agent からのプランファイル読み取り結果を処理 */
function handlePlanContent(payload: { machineId: string; requestId: string; filename: string | null; content: string | null; error?: string }) {
  const { requestId, filename, content, error } = payload;
  const pending = pendingPlanRequests.get(requestId);
  if (pending) {
    clearTimeout(pending.timeout);
    pendingPlanRequests.delete(requestId);
    if (error) {
      pending.reject(new Error(error));
    } else {
      pending.resolve({ filename, content });
    }
  }
}

async function handleSessionRestore(ws: WebSocket, payload: { machineId: string; projectPath: string; projectName: string; agreementStatus: string | boolean }) {
  const { machineId, projectPath, projectName, agreementStatus } = payload;

  console.log(`🔄 Session restore request: ${machineId} / ${projectName}`);

  // Find active session for this machine and project
  const session = await prisma.session.findFirst({
    where: {
      machineId,
      status: 'active',
      project: {
        path: projectPath
      }
    },
    include: {
      project: true
    }
  });

  if (session) {
    // Find the chat that was using this session (from ChannelSession)
    const channelSession = await prisma.channelSession.findFirst({
      where: {
        lastProjectId: session.projectId
      }
    });

    if (channelSession) {
      sendToAgent(ws, {
        type: 'server:session:restored',
        payload: {
          sessionId: session.id,
          projectPath,
          chatId: channelSession.chatId,
          platform: channelSession.platform
        }
      });

      console.log(`✅ Session restored: ${session.id} for chat ${channelSession.chatId}`);
    } else {
      console.log(`⚠️ No channel session found for project ${session.projectId}`);
    }
  } else {
    console.log(`⚠️ No active session found for ${machineId} / ${projectPath}`);
  }
}

async function handleAgentAiList(payload: AiListResponsePayload) {
  const { requestId } = payload;
  const pending = pendingAiListRequests.get(requestId);

  if (pending) {
    clearTimeout(pending.timeout);
    pendingAiListRequests.delete(requestId);
    pending.resolve(payload);
    console.log(`🤖 AI list received: ${payload.available.join(', ')} (current: ${payload.currentTool})`);
  }
}

async function handleAgentAiSwitched(payload: AiSwitchedPayload) {
  const { sessionId, aiTool, success, error } = payload;

  // Find pending request by sessionId (we use sessionId as requestId for switch)
  for (const [requestId, pending] of pendingAiSwitchRequests) {
    if (requestId.startsWith(`switch-${sessionId}`)) {
      clearTimeout(pending.timeout);
      pendingAiSwitchRequests.delete(requestId);
      pending.resolve(payload);
      console.log(`🔄 AI switch result: ${aiTool} - ${success ? 'success' : `failed: ${error}`}`);
      return;
    }
  }
}

async function handleSessionAiTool(payload: { machineId: string; sessionId: string; aiTool: AiTool }) {
  const { sessionId, aiTool } = payload;
  console.log(`📋 Session ${sessionId} using AI tool: ${aiTool}`);

  // Update session in DB
  try {
    await prisma.session.update({
      where: { id: sessionId },
      data: { aiTool }
    });
  } catch (err) {
    console.error(`⚠️ Could not update session AI tool:`, err);
  }
}

/** Agent から AI プロセスキャンセル完了の通知を受信 */
async function handleAiCancelled(payload: AiCancelledPayload) {
  const { sessionId } = payload;
  console.log(`⛔ AI process cancelled for session ${sessionId}`);
  await broadcastToSession(sessionId, '⛔ AI プロセスをキャンセルしました', false);
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

export function getConnectedMachines(userId: string): Machine[] {
  // TODO: Filter by userId
  return Array.from(machineCache.values());
}

/**
 * Agent が再接続してセッション再開始が必要かを判定する
 * Agent 再起動後は sessionInfoMap がクリアされるため、server:session:start の再送が必要
 *
 * @param machineId 確認対象のマシンID
 * @returns 再接続後でセッション再開始が必要なら true
 */
export function isAgentRestarted(machineId: string): boolean {
  return needsSessionRestart.has(machineId);
}

/**
 * Agent 再接続フラグをクリアする（セッション再開始完了後に呼び出す）
 *
 * @param machineId クリア対象のマシンID
 */
export function clearAgentRestarted(machineId: string): void {
  needsSessionRestart.delete(machineId);
}

export function getConnectedAgents(): Map<string, WebSocket> {
  return connectedAgents;
}

export function getMachine(machineId: string): Machine | undefined {
  return machineCache.get(machineId);
}

export function isAgentConnected(machineId: string): boolean {
  return connectedAgents.has(machineId);
}

/**
 * マシンの表示名を取得するヘルパー
 * displayName が設定されていれば displayName、なければ name を返す
 *
 * @param machineId マシンID
 * @returns 表示用のマシン名
 */
export function getMachineDisplayName(machineId: string): string | undefined {
  const cached = machineCache.get(machineId);
  if (cached) {
    return cached.displayName ?? cached.name;
  }
  return undefined;
}

export function sendToAgent(machineIdOrWs: string | WebSocket, message: ServerToAgentMessage) {
  const ws = typeof machineIdOrWs === 'string'
    ? connectedAgents.get(machineIdOrWs)
    : machineIdOrWs;

  if (ws && ws.readyState === ws.OPEN) {
    console.log(`📤 sendToAgent: type=${message.type}`);
    ws.send(JSON.stringify(message));
  } else {
    console.log(`📤 sendToAgent FAILED: type=${message.type}, ws=${!!ws}, readyState=${ws?.readyState}`);

    // stale WebSocket を検出 → connectedAgents からクリーンアップ（自己修復）
    // Agent 再接続時に connectedAgents が正しい WebSocket で上書きされるまでの間、
    // CLOSED な参照が残り続けるのを防止する
    if (typeof machineIdOrWs === 'string' && ws) {
      console.log(`🧹 Cleaning up stale WebSocket for ${machineIdOrWs}`);
      connectedAgents.delete(machineIdOrWs);
      machineCache.delete(machineIdOrWs);
      prisma.machine.update({
        where: { id: machineIdOrWs },
        data: { status: 'offline' },
      }).catch(() => {});
    }
  }
}

export async function startSession(
  machineId: string,
  sessionId: string,
  projectName: string,
  projectPath: string,
  aiTool: AiTool
) {
  sendToAgent(machineId, {
    type: 'server:session:start',
    payload: { sessionId, projectName, projectPath, aiTool }
  });
}

export interface MissedMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

export async function sendPromptToAgent(
  machineId: string,
  sessionId: string,
  prompt: string,
  userId: string,
  files?: FileAttachment[],
  missedMessages?: MissedMessage[],
  projectPath?: string,
  aiTool?: AiTool
) {
  // バージョン不足の Agent にはプロンプトを送信しない
  if (outdatedAgents.has(machineId)) {
    throw new Error('⚠️ この Agent は更新が必要です。`u` コマンドで更新してください。');
  }
  sendToAgent(machineId, {
    type: 'server:ai:prompt',
    payload: { sessionId, prompt, userId, files, missedMessages, projectPath, aiTool }
  });
}

/** Agent がプロトコルバージョン不足かどうかを判定する */
export function isAgentOutdated(machineId: string): boolean {
  return outdatedAgents.has(machineId);
}

export async function endSession(machineId: string, sessionId: string) {
  sendToAgent(machineId, {
    type: 'server:session:end',
    payload: { sessionId }
  });
}

/**
 * クロスプロジェクトクエリを実行する
 * ターゲットプロジェクトのエージェントに一時セッションを作成し、質問を送信して回答を待つ
 *
 * @param machineId ターゲットマシン ID
 * @param sessionId 一時セッション ID
 * @param projectName プロジェクト名
 * @param projectPath プロジェクトパス
 * @param aiTool AI ツール
 * @param prompt 質問テキスト
 * @param userId ユーザー ID
 * @param timeoutMs タイムアウト（デフォルト 5 分）
 * @returns AI の回答テキスト
 */
export function executeCrossProjectQuery(
  machineId: string,
  sessionId: string,
  projectName: string,
  projectPath: string,
  aiTool: AiTool,
  prompt: string,
  userId: string,
  timeoutMs: number = 300000,
): Promise<{ output: string; files?: FileAttachment[] }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingCrossQueries.delete(sessionId);
      reject(new Error('Cross-project query timed out'));
    }, timeoutMs);

    // 待機登録
    pendingCrossQueries.set(sessionId, { resolve, reject, timeout });

    // セッション開始 → プロンプト送信
    startSession(machineId, sessionId, projectName, projectPath, aiTool);
    // 少し待ってからプロンプト送信（セッション登録のタイミング確保）
    setTimeout(() => {
      sendPromptToAgent(machineId, sessionId, prompt, userId);
    }, 500);
  });
}

/**
 * クロスプロジェクト実行（teamexec）
 * ask と異なり、exec モード（--dangerously-skip-permissions）で指示を実行する。
 * execConversation() が Agent 側で exec マーカー追加 + handleAiPrompt() 自動呼出を行う。
 *
 * @param machineId ターゲットマシン ID
 * @param sessionId 一時セッション ID（teamexec_ プレフィックス）
 * @param projectName プロジェクト名
 * @param projectPath プロジェクトパス
 * @param aiTool AI ツール
 * @param instruction 実行指示テキスト
 * @param userId ユーザー ID
 * @param timeoutMs タイムアウト（デフォルト 5 分）
 * @returns AI の実行結果テキスト
 */
export function executeCrossProjectExec(
  machineId: string,
  sessionId: string,
  projectName: string,
  projectPath: string,
  aiTool: AiTool,
  instruction: string,
  userId: string,
  timeoutMs: number = 300000,
): Promise<{ output: string; files?: FileAttachment[] }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingCrossQueries.delete(sessionId);
      reject(new Error('Team exec timed out'));
    }, timeoutMs);

    // 待機登録（pendingCrossQueries を共用）
    pendingCrossQueries.set(sessionId, { resolve, reject, timeout });

    // セッション開始 → exec 実行（exec マーカー追加 + プロンプト自動送信）
    startSession(machineId, sessionId, projectName, projectPath, aiTool);
    // 少し待ってから exec 送信（セッション登録のタイミング確保）
    setTimeout(() => {
      execConversation(machineId, sessionId, projectPath, userId, instruction);
    }, 500);
  });
}

/** 実行中の AI プロセスをキャンセルするリクエストを Agent に送信 */
export async function cancelAiProcess(machineId: string, sessionId: string) {
  sendToAgent(machineId, {
    type: 'server:ai:cancel',
    payload: { sessionId }
  });
}

/**
 * Agent に設定更新をリアルタイム配信する
 * Agent がオフラインの場合は何もしない（次回接続時に server:connect:ack で配信される）
 * 送信失敗に備え pendingConfigUpdates に登録し、次回 agent:ping 時にリトライする
 */
export function pushConfigUpdate(machineId: string, config: { projectsDirs?: string[] | null; allowedTools?: string[] | null; skipPermissions?: boolean; disableAsk?: boolean }) {
  // 既存の pending があればマージ（projectsDirs と allowedTools が同時に pending でも欠落しない）
  const existing = pendingConfigUpdates.get(machineId);
  const mergedConfig = existing ? { ...existing.config, ...config } : config;
  pendingConfigUpdates.set(machineId, { config: mergedConfig, retries: 0 });

  sendToAgent(machineId, {
    type: 'server:config:update',
    payload: config,
  });
  console.log(`📤 Config update pushed to ${machineId} (pending until ack)`);
}

/** Agent が設定更新の適用完了を通知（pending を削除） */
function handleConfigAck(machineId: string) {
  if (pendingConfigUpdates.delete(machineId)) {
    console.log(`✅ Config ack received from ${machineId}`);
  }
}

/** Agent からバージョン情報の応答を受信 → pending Promise を解決 */
function handleVersionInfo(payload: AgentVersionInfoPayload) {
  const { machineId } = payload;
  const requestId = `version-${machineId}`;
  const pending = pendingVersionCheckRequests.get(requestId);

  if (pending) {
    clearTimeout(pending.timeout);
    pendingVersionCheckRequests.delete(requestId);
    pending.resolve(payload);
    console.log(`📦 Version info received from ${machineId}: local=${payload.localCommit?.slice(0, 7)}, remote=${payload.remoteCommit?.slice(0, 7)}, hasUpdate=${payload.hasUpdate}`);
  }
}

/** Agent から更新処理のステータスを受信 → エラー時はユーザーに通知 */
async function handleUpdateStatus(payload: AgentUpdateStatusPayload) {
  const { machineId, status, error } = payload;

  if (status === 'started') {
    console.log(`🔄 Agent update started for ${machineId}`);
    // started はログのみ（Agent が再起動して再接続する）
  } else if (status === 'error') {
    console.error(`❌ Agent update failed for ${machineId}: ${error}`);
    // エラー時はリクエスト元のユーザーに通知
    const requestor = pendingUpdateNotify.get(machineId);
    if (requestor) {
      await sendMessage(requestor.platform, requestor.chatId, `❌ Agent 更新に失敗しました: ${error}`, undefined, requestor.projectId);
      pendingUpdateNotify.delete(machineId);
    }
  }
}

/**
 * 指定 OS の全オンライン Agent に allowedTools を配信する
 * Settings ページで allowedTools を変更した際に呼び出す
 */
export async function pushAllowedToolsToAgents(userId: string, os: 'linux' | 'windows', tools: string[] | null) {
  // ユーザーが所有するオンライン Machine を取得
  const machines = await prisma.machine.findMany({
    where: { userId, deletedAt: null },
    select: { id: true, managementInfo: true },
  });

  for (const machine of machines) {
    // Agent がオンラインか確認
    if (!connectedAgents.has(machine.id)) continue;

    // managementInfo.os が一致する Agent のみ配信
    // Linux 設定は linux + darwin（macOS）に配信（handleAgentConnect と同じロジック）
    const info = machine.managementInfo as ManagementInfo | null;
    const isWindowsAgent = info?.os === 'win32';
    if (os === 'windows' && !isWindowsAgent) continue;
    if (os === 'linux' && isWindowsAgent) continue;

    pushConfigUpdate(machine.id, { allowedTools: tools });
  }
}

/** Agent が接続時に報告したローカルの projectsDirs を取得 */
export function getAgentLocalProjectsDirs(machineId: string): string[] | null {
  return agentLocalProjectsDirs.get(machineId) ?? null;
}

// -----------------------------------------------------------------------------
// Agent Version Check / Update API
// -----------------------------------------------------------------------------

const VERSION_CHECK_TIMEOUT = 30000; // 30秒（git fetch に時間がかかる場合あり）

/**
 * Agent にバージョン確認リクエストを送信し、結果を Promise で返す
 * Agent 側で git fetch → ローカル/リモートのコミット比較を実行
 */
export function checkAgentVersion(machineId: string): Promise<AgentVersionInfoPayload> {
  return new Promise((resolve, reject) => {
    const ws = connectedAgents.get(machineId);
    if (!ws || ws.readyState !== ws.OPEN) {
      reject(new Error('Agent がオフラインです'));
      return;
    }

    const requestId = `version-${machineId}`;

    // 既存のリクエストがあればキャンセル
    const existing = pendingVersionCheckRequests.get(requestId);
    if (existing) {
      clearTimeout(existing.timeout);
      pendingVersionCheckRequests.delete(requestId);
    }

    const timeout = setTimeout(() => {
      pendingVersionCheckRequests.delete(requestId);
      reject(new Error('タイムアウト'));
    }, VERSION_CHECK_TIMEOUT);

    pendingVersionCheckRequests.set(requestId, { resolve, reject, timeout });

    sendToAgent(ws, {
      type: 'server:agent:version-check',
      payload: {}
    });
  });
}

/** 更新タイムアウト: 5分以内に Agent が再接続しなければタイムアウト通知 */
const UPDATE_TIMEOUT = 5 * 60 * 1000;

/**
 * Agent に更新実行コマンドを送信する
 * Agent は detached プロセスで git pull + ビルド + 再起動を実行
 * 5分以内に再接続しなければタイムアウト通知を送信
 *
 * @param machineId 更新対象の Agent マシンID
 * @param platform リクエスト元のプラットフォーム（エラー通知用）
 * @param chatId リクエスト元のチャットID（エラー通知用）
 */
export function updateAgent(machineId: string, platform: Platform, chatId: string, projectId?: string) {
  pendingUpdateNotify.set(machineId, { platform, chatId, projectId });

  // タイムアウトで pendingUpdateNotify をクリーンアップし、ユーザーに通知
  setTimeout(() => {
    const entry = pendingUpdateNotify.get(machineId);
    if (entry && entry.platform === platform && entry.chatId === chatId) {
      pendingUpdateNotify.delete(machineId);
      console.log(`⏰ Update timeout for ${machineId}`);
      sendMessage(platform, chatId,
        `⚠️ Agent 更新がタイムアウトしました（5分）。\n\`~/.devrelay/logs/update.log\` を確認してください。`, undefined, entry.projectId);
    }
  }, UPDATE_TIMEOUT);

  sendToAgent(machineId, {
    type: 'server:agent:update',
    payload: {}
  });
}

export async function clearConversation(machineId: string, sessionId: string, projectPath: string) {
  sendToAgent(machineId, {
    type: 'server:conversation:clear',
    payload: { sessionId, projectPath }
  });
}

export async function execConversation(machineId: string, sessionId: string, projectPath: string, userId: string, prompt?: string) {
  // exec 開始時に最新の skipPermissions / disableAsk を DB から取得して再送（config:update 配信失敗のフォールバック）
  const machine = await prisma.machine.findUnique({ where: { id: machineId }, select: { skipPermissions: true, disableAsk: true } });
  sendToAgent(machineId, {
    type: 'server:conversation:exec',
    payload: { sessionId, projectPath, userId, prompt, skipPermissions: machine?.skipPermissions ?? false, disableAsk: machine?.disableAsk ?? false }
  });
}

export async function saveWorkState(machineId: string, sessionId: string, projectPath: string, workState: WorkState) {
  sendToAgent(machineId, {
    type: 'server:workstate:save',
    payload: { sessionId, projectPath, workState }
  });
}

// Agreement 適用コマンドを Agent に送信
// Server 側でプロンプトを生成して配信するため、テンプレート更新は Server のみで完結する
// ユーザーがカスタムテンプレートを設定していればそちらを使用する
export async function applyAgreement(machineId: string, sessionId: string, projectPath: string, userId: string) {
  const customTemplate = await getUserSetting(userId, SettingKeys.AGREEMENT_TEMPLATE);
  const agreementPrompt = buildAgreementApplyPrompt(customTemplate ?? undefined);
  sendToAgent(machineId, {
    type: 'server:agreement:apply',
    payload: { sessionId, projectPath, userId, agreementPrompt }
  });
}

export async function saveStorageContext(machineId: string, sessionId: string, projectPath: string, content: string) {
  sendToAgent(machineId, {
    type: 'server:storage:save',
    payload: { sessionId, projectPath, content }
  });
}

export async function clearStorageContext(machineId: string, sessionId: string, projectPath: string) {
  sendToAgent(machineId, {
    type: 'server:storage:clear',
    payload: { sessionId, projectPath }
  });
}

// -----------------------------------------------------------------------------
// Heartbeat Monitoring
// -----------------------------------------------------------------------------

const HEARTBEAT_CHECK_INTERVAL = 60000; // 60 seconds
const HEARTBEAT_TIMEOUT = 60000; // 60 seconds without ping = offline
let heartbeatMonitorInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Start the heartbeat monitor that checks for stale connections
 * and marks machines as offline if they haven't sent a ping recently
 */
export function startHeartbeatMonitor() {
  if (heartbeatMonitorInterval) {
    console.log('⚠️ Heartbeat monitor already running');
    return;
  }

  console.log('💓 Starting heartbeat monitor (checking every 60s)');

  heartbeatMonitorInterval = setInterval(async () => {
    const now = new Date();
    const cutoffTime = new Date(now.getTime() - HEARTBEAT_TIMEOUT);

    try {
      // lastSeenMap のデータをまとめて DB に書き込み（バッチ更新）
      if (lastSeenMap.size > 0) {
        const entries = Array.from(lastSeenMap.entries());
        lastSeenMap.clear();

        for (const [machineId, lastSeenAt] of entries) {
          try {
            await prisma.machine.update({
              where: { id: machineId },
              data: { lastSeenAt }
            });
          } catch {
            // マシンが DB に存在しない場合は無視（再接続中など）
          }
        }
      }

      // stale チェック: オンラインだが ping が途絶えたマシンを offline に
      const staleMachines = await prisma.machine.findMany({
        where: {
          status: 'online',
          deletedAt: null,
          OR: [
            { lastSeenAt: { lt: cutoffTime } },
            { lastSeenAt: null }
          ]
        }
      });

      if (staleMachines.length > 0) {
        console.log(`💔 Found ${staleMachines.length} stale machine(s), marking offline...`);

        for (const machine of staleMachines) {
          // Update DB
          await prisma.machine.update({
            where: { id: machine.id },
            data: { status: 'offline' }
          });

          // Remove from cache and connected agents
          connectedAgents.delete(machine.id);
          machineCache.delete(machine.id);
          agentLocalProjectsDirs.delete(machine.id);
          pendingConfigUpdates.delete(machine.id);

          console.log(`   - ${machine.name} (${machine.id}) marked offline (last seen: ${machine.lastSeenAt?.toISOString() || 'never'})`);
        }
      }
    } catch (err) {
      console.error('❌ Error in heartbeat monitor:', err);
    }
  }, HEARTBEAT_CHECK_INTERVAL);
}

/**
 * Stop the heartbeat monitor
 */
export function stopHeartbeatMonitor() {
  if (heartbeatMonitorInterval) {
    clearInterval(heartbeatMonitorInterval);
    heartbeatMonitorInterval = null;
    console.log('💔 Heartbeat monitor stopped');
  }
}

// -----------------------------------------------------------------------------
// History Export API
// -----------------------------------------------------------------------------

const HISTORY_REQUEST_TIMEOUT = 120000; // 120 seconds (ZIP creation can take time with many messages)

/**
 * Request available history dates from an agent
 */
export function requestHistoryDates(machineId: string, projectPath: string): Promise<string[]> {
  console.log(`📤 requestHistoryDates: machineId=${machineId}, projectPath=${projectPath}`);

  return new Promise((resolve, reject) => {
    const ws = connectedAgents.get(machineId);
    const hasAgent = connectedAgents.has(machineId);
    console.log(`📤 connectedAgents.has(${machineId}): ${hasAgent}`);
    console.log(`📤 connectedAgents keys: ${Array.from(connectedAgents.keys()).join(', ')}`);
    console.log(`📤 ws.readyState: ${ws?.readyState} (OPEN=1)`);

    if (!ws || ws.readyState !== ws.OPEN) {
      console.log(`📤 Agent not connected or WebSocket not open`);
      reject(new Error('Agent is not connected'));
      return;
    }

    const requestId = `dates-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    console.log(`📤 Sending server:history:dates with requestId=${requestId}`);

    const timeout = setTimeout(() => {
      pendingHistoryDatesRequests.delete(requestId);
      console.log(`📤 Request ${requestId} timed out`);
      reject(new Error('Request timed out'));
    }, HISTORY_REQUEST_TIMEOUT);

    pendingHistoryDatesRequests.set(requestId, { resolve, reject, timeout });

    sendToAgent(ws, {
      type: 'server:history:dates',
      payload: { projectPath, requestId }
    });
  });
}

/**
 * Request history export for a specific date from an agent
 */
export function requestHistoryExport(machineId: string, projectPath: string, date: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = connectedAgents.get(machineId);
    if (!ws || ws.readyState !== ws.OPEN) {
      reject(new Error('Agent is not connected'));
      return;
    }

    const requestId = `export-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    const timeout = setTimeout(() => {
      pendingHistoryExportRequests.delete(requestId);
      reject(new Error('Request timed out'));
    }, HISTORY_REQUEST_TIMEOUT);

    pendingHistoryExportRequests.set(requestId, { resolve, reject, timeout });

    sendToAgent(ws, {
      type: 'server:history:export',
      payload: { projectPath, requestId, date }
    });
  });
}

// -----------------------------------------------------------------------------
// Project File Read API
// -----------------------------------------------------------------------------

const FILE_READ_TIMEOUT = 15000; // 15 seconds

/**
 * Agent にプロジェクト内ファイルの読み取りを要求
 */
export function requestProjectFileRead(
  machineId: string,
  projectPath: string,
  filePath: string,
): Promise<{ content: string | null; error?: string }> {
  return new Promise((resolve, reject) => {
    const ws = connectedAgents.get(machineId);
    if (!ws || ws.readyState !== ws.OPEN) {
      reject(new Error('Agent is not connected'));
      return;
    }

    const requestId = `file-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    const timeout = setTimeout(() => {
      pendingFileReadRequests.delete(requestId);
      reject(new Error('Request timed out'));
    }, FILE_READ_TIMEOUT);

    pendingFileReadRequests.set(requestId, { resolve, reject, timeout });

    sendToAgent(ws, {
      type: 'server:project:file:read',
      payload: { projectPath, filePath, requestId },
    });
  });
}

// -----------------------------------------------------------------------------
// Plan File Read API
// -----------------------------------------------------------------------------

const PLAN_READ_TIMEOUT = 15000; // 15 seconds

/**
 * Agent に最新プランファイルの読み取りを要求
 */
export function requestLatestPlanFile(
  machineId: string,
): Promise<{ filename: string | null; content: string | null }> {
  return new Promise((resolve, reject) => {
    const ws = connectedAgents.get(machineId);
    if (!ws || ws.readyState !== ws.OPEN) {
      reject(new Error('Agent is not connected'));
      return;
    }

    const requestId = `plan-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    const timeout = setTimeout(() => {
      pendingPlanRequests.delete(requestId);
      reject(new Error('Request timed out'));
    }, PLAN_READ_TIMEOUT);

    pendingPlanRequests.set(requestId, { resolve, reject, timeout });

    sendToAgent(ws, {
      type: 'server:plan:latest',
      payload: { requestId },
    });
  });
}

// -----------------------------------------------------------------------------
// AI Tool Switching API
// -----------------------------------------------------------------------------

const AI_REQUEST_TIMEOUT = 10000; // 10 seconds

/**
 * Request AI tool list from an agent
 */
export function getAiToolList(machineId: string, sessionId: string): Promise<AiListResponsePayload> {
  return new Promise((resolve, reject) => {
    const ws = connectedAgents.get(machineId);
    if (!ws || ws.readyState !== ws.OPEN) {
      reject(new Error('Agent is not connected'));
      return;
    }

    const requestId = `list-${sessionId}-${Date.now()}`;

    const timeout = setTimeout(() => {
      pendingAiListRequests.delete(requestId);
      reject(new Error('Request timed out'));
    }, AI_REQUEST_TIMEOUT);

    pendingAiListRequests.set(requestId, { resolve, reject, timeout });

    sendToAgent(ws, {
      type: 'server:ai:list',
      payload: { sessionId, requestId }
    });
  });
}

/**
 * Switch AI tool for a session
 */
export function switchAiTool(machineId: string, sessionId: string, aiTool: AiTool): Promise<AiSwitchedPayload> {
  return new Promise((resolve, reject) => {
    const ws = connectedAgents.get(machineId);
    if (!ws || ws.readyState !== ws.OPEN) {
      reject(new Error('Agent is not connected'));
      return;
    }

    const requestId = `switch-${sessionId}-${Date.now()}`;

    const timeout = setTimeout(() => {
      pendingAiSwitchRequests.delete(requestId);
      reject(new Error('Request timed out'));
    }, AI_REQUEST_TIMEOUT);

    pendingAiSwitchRequests.set(requestId, { resolve, reject, timeout });

    sendToAgent(ws, {
      type: 'server:ai:switch',
      payload: { sessionId, aiTool }
    });
  });
}

// -----------------------------------------------------------------------------
// Tool Approval Protocol
// -----------------------------------------------------------------------------

/** ツール承認タイムアウト（12時間 = 720分。承認忘れ ≠ 拒否なので長めに設定） */
const TOOL_APPROVAL_TIMEOUT = 12 * 60 * 60 * 1000;

/** 保留中のツール承認: requestId → { machineId, sessionId, projectId, toolName, toolInput, userId, timeoutTimer } */
const pendingToolApprovalRequests = new Map<string, {
  machineId: string;
  sessionId: string;
  projectId?: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  isQuestion?: boolean;
  userId?: string;
  timeout: ReturnType<typeof setTimeout>;
}>();

/**
 * Agent からのツール承認リクエストを処理し、セッション参加者に転送する
 */
async function handleToolApprovalRequest(payload: ToolApprovalRequestPayload) {
  const { machineId, sessionId, requestId, toolName, toolInput, title, description, decisionReason, isQuestion } = payload;
  console.log(`${isQuestion ? '❓' : '🔐'} ${isQuestion ? 'User question' : 'Tool approval'} request: ${toolName} (${requestId.substring(0, 8)}...) for session ${sessionId.substring(0, 8)}...`);

  // セッションの projectId を取得（WebUI のタブルーティング用）
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { project: { select: { id: true } } },
  });
  const projectId = session?.project?.id;

  // タイムアウト設定（5分でデフォルト deny）
  const timeout = setTimeout(() => {
    const pending = pendingToolApprovalRequests.get(requestId);
    if (pending) {
      console.log(`⏰ Tool approval timeout: ${toolName} (${requestId.substring(0, 8)}...)`);
      pendingToolApprovalRequests.delete(requestId);

      // DB の status をタイムアウトに更新
      prisma.toolApproval.update({
        where: { requestId },
        data: { status: 'timeout', resolvedAt: new Date() },
      }).catch(err => console.error('Failed to update tool approval timeout:', err));

      // Agent に deny を送信
      sendToAgent(pending.machineId, {
        type: 'server:tool:approval:response',
        payload: { requestId, behavior: 'deny', message: 'タイムアウト: ユーザーが応答しませんでした' },
      });

      // 全参加者に resolved を通知（Web + Discord/Telegram のボタン無効化）
      broadcastToolApprovalToWeb(sessionId, {
        type: 'web:tool:approval:resolved',
        payload: { requestId, behavior: 'deny', projectId },
      });
      resolveToolApprovalOnPlatforms(sessionId, requestId, 'deny');
    }
  }, TOOL_APPROVAL_TIMEOUT);

  // Machine から userId を取得（「常に許可」ルール保存用）
  const machine = await prisma.machine.findUnique({
    where: { id: machineId },
    select: { userId: true },
  });
  const userId = machine?.userId;

  pendingToolApprovalRequests.set(requestId, { machineId, sessionId, projectId, toolName, toolInput, isQuestion, userId, timeout });

  // DB に pending 状態で記録（永続化）
  if (projectId) {
    prisma.toolApproval.create({
      data: { sessionId, projectId, machineId, requestId, toolName, toolInput: toolInput as any, isQuestion: !!isQuestion, status: 'pending' },
    }).catch(err => console.error('Failed to save tool approval request:', err));
  }

  // セッション参加者に承認リクエストを送信（Web + Discord/Telegram）
  const approvalPayload = { requestId, toolName, toolInput, title, description, projectId, isQuestion };
  broadcastToolApprovalToWeb(sessionId, {
    type: 'web:tool:approval',
    payload: approvalPayload,
  });
  broadcastToolApprovalToPlatforms(sessionId, approvalPayload);
}

/**
 * Agent からの自動承認通知を処理し、WebUI に転送する（approveAllMode 時）
 * 応答不要の通知のみ — Approvals タブの履歴表示用
 */
async function handleToolApprovalAuto(payload: ToolApprovalAutoPayload) {
  const { machineId, sessionId, toolName, toolInput } = payload;

  // セッションの projectId を取得（WebUI のタブルーティング用）
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { project: { select: { id: true } } },
  });
  const projectId = session?.project?.id;

  // DB に auto 承認を記録（requestId なし）
  if (projectId) {
    prisma.toolApproval.create({
      data: { sessionId, projectId, machineId, toolName, toolInput: toolInput as any, status: 'auto', resolvedAt: new Date() },
    }).catch(err => console.error('Failed to save auto tool approval:', err));
  }

  // セッション参加者に自動承認通知を送信（Web + Discord/Telegram）
  broadcastToolApprovalToWeb(sessionId, {
    type: 'web:tool:approval:auto',
    payload: { toolName, toolInput, projectId },
  });
  broadcastToolApprovalAutoToPlatforms(sessionId, toolName, toolInput);
}

/**
 * WebUI/Discord/Telegram からのツール承認応答を処理し、Agent に転送する
 * @returns 処理成功なら true、requestId が見つからなければ false
 */
export function handleToolApprovalUserResponse(
  requestId: string,
  response: { behavior: 'allow' | 'deny'; message?: string; approveAll?: boolean; alwaysAllow?: boolean; answers?: Record<string, string> }
): boolean {
  const pending = pendingToolApprovalRequests.get(requestId);
  if (!pending) {
    console.log(`⚠️ Unknown tool approval requestId: ${requestId}`);
    return false;
  }

  // タイムアウト解除・Map からも削除
  clearTimeout(pending.timeout);
  pendingToolApprovalRequests.delete(requestId);

  const logSuffix = response.approveAll ? ' (approve-all)' : response.alwaysAllow ? ' (always-allow)' : '';
  console.log(`🔐 Tool approval response: ${response.behavior}${logSuffix} (${requestId.substring(0, 8)}...)`);

  // DB の status を更新（pending → allow/deny）
  prisma.toolApproval.update({
    where: { requestId },
    data: { status: response.behavior, resolvedAt: new Date() },
  }).catch(err => console.error('Failed to update tool approval status:', err));

  // 「📌 常に許可」: ツールルールを生成して Agent に送信（セッションスコープ）
  const alwaysAllowRule = (response.alwaysAllow && response.behavior === 'allow')
    ? generateToolRule(pending.toolName, pending.toolInput)
    : undefined;

  if (alwaysAllowRule) {
    console.log(`📌 Generated session tool rule: "${alwaysAllowRule}"`);
  }

  // Agent に応答を転送（approveAll フラグ + alwaysAllowRule も含む）
  sendToAgent(pending.machineId, {
    type: 'server:tool:approval:response',
    payload: { requestId, behavior: response.behavior, message: response.message, approveAll: response.approveAll, alwaysAllowRule, answers: response.answers },
  });

  // 全参加者に resolved を通知（他のブラウザタブ + Discord/Telegram のボタン無効化）
  broadcastToolApprovalToWeb(pending.sessionId, {
    type: 'web:tool:approval:resolved',
    payload: { requestId, behavior: response.behavior, projectId: pending.projectId },
  });
  resolveToolApprovalOnPlatforms(pending.sessionId, requestId, response.behavior);

  return true;
}

/**
 * 指定セッションの保留中ツール承認一覧を取得する（WS 再接続時・//connect 時の復元用）
 * メモリ Map から直接ペイロードを構築（DB round-trip 不要、DB 保存失敗時でも復元可能）
 */
export function getPendingToolApprovalsForSession(sessionId: string): ToolApprovalPromptPayload[] {
  const results: ToolApprovalPromptPayload[] = [];
  for (const [requestId, entry] of pendingToolApprovalRequests) {
    if (entry.sessionId === sessionId) {
      results.push({
        requestId,
        toolName: entry.toolName,
        toolInput: entry.toolInput,
        projectId: entry.projectId,
        isQuestion: entry.isQuestion || undefined,
      });
    }
  }
  return results;
}

/**
 * セッションの全 Web 参加者に ServerToWebMessage を送信するヘルパー
 * 参加者が見つからない場合は全 Web クライアントにフォールバックブロードキャスト
 */
function broadcastToolApprovalToWeb(sessionId: string, message: ServerToWebMessage) {
  const participants = getSessionParticipants(sessionId);
  const webParticipants = participants.filter(p => p.platform === 'web');

  if (webParticipants.length > 0) {
    // セッション参加者が見つかった → 対象の Web クライアントに送信
    for (const { chatId } of webParticipants) {
      sendWebRawMessage(chatId, message);
    }
    console.log(`🔐 Tool approval broadcast: ${webParticipants.length} web participant(s) for session ${sessionId.substring(0, 8)}...`);
  } else {
    // 参加者なし → 全 Web クライアントにフォールバック（参加者管理の不整合を回避）
    const sent = broadcastWebRawMessage(message);
    console.log(`⚠️ Tool approval fallback broadcast: ${sent} web client(s) (no participants found for session ${sessionId.substring(0, 8)}...)`);
  }
}

/**
 * セッションの Discord/Telegram 参加者にツール承認リクエストを送信する
 */
function broadcastToolApprovalToPlatforms(sessionId: string, payload: ToolApprovalPromptPayload) {
  const participants = getSessionParticipants(sessionId);
  for (const { platform, chatId } of participants) {
    if (platform === 'discord') {
      sendDiscordToolApproval(chatId, payload).catch(err =>
        console.error('Failed to send Discord tool approval:', err));
    } else if (platform === 'telegram') {
      sendTelegramToolApproval(chatId, payload).catch(err =>
        console.error('Failed to send Telegram tool approval:', err));
    }
  }
}

/**
 * セッションの Discord/Telegram 参加者にツール承認解決を通知する（ボタン/キーボード無効化）
 */
function resolveToolApprovalOnPlatforms(sessionId: string, requestId: string, behavior: 'allow' | 'deny') {
  const participants = getSessionParticipants(sessionId);
  for (const { platform } of participants) {
    if (platform === 'discord') {
      resolveDiscordToolApproval(requestId, behavior).catch(err =>
        console.error('Failed to resolve Discord tool approval:', err));
    } else if (platform === 'telegram') {
      resolveTelegramToolApproval(requestId, behavior).catch(err =>
        console.error('Failed to resolve Telegram tool approval:', err));
    }
  }
}

/**
 * セッションの Discord/Telegram 参加者に自動承認通知を送信する
 */
function broadcastToolApprovalAutoToPlatforms(sessionId: string, toolName: string, toolInput: Record<string, unknown>) {
  const participants = getSessionParticipants(sessionId);
  for (const { platform, chatId } of participants) {
    if (platform === 'discord') {
      sendDiscordToolApprovalAuto(chatId, toolName, toolInput).catch(err =>
        console.error('Failed to send Discord auto approval:', err));
    } else if (platform === 'telegram') {
      sendTelegramToolApprovalAuto(chatId, toolName, toolInput).catch(err =>
        console.error('Failed to send Telegram auto approval:', err));
    }
  }
}
