import type { Platform, UserContext, Session, FileAttachment, Language } from '@devrelay/shared';
import { tChat, DEFAULT_CHAT_LANGUAGE } from '@devrelay/shared';
import { prisma } from '../db/client.js';
import { resolveSessionLanguage } from './user-settings.js';
import {
  sendDiscordMessage,
  startTypingIndicator as startDiscordTyping,
  stopTypingIndicator as stopDiscordTyping,
  sendDiscordMessageWithId,
  editDiscordMessage
} from '../platforms/discord.js';
import {
  sendTelegramMessage,
  startTypingIndicator as startTelegramTyping,
  stopTypingIndicator as stopTelegramTyping,
  sendTelegramMessageWithId,
  editTelegramMessage
} from '../platforms/telegram.js';
import {
  sendWebMessage,
  startTypingIndicator as startWebTyping,
  stopTypingIndicator as stopWebTyping,
  sendWebMessageWithId,
  editWebMessage
} from '../platforms/web.js';
import { sendPushNotificationForSession } from './push-notification-service.js';
import { sendFcmNotificationForSession } from './fcm-service.js';
import { createNotification } from './notification-service.js';
import { decideProgressTimeoutAction } from './progress-timeout.js';
import { isEphemeralSessionId, decideNewSessionScopeId, resolveOutboundAgentScopeId, inheritScopeForReestablishedSession } from './thread-scope.js';
import { resolveChatSessionId } from './thread-routing.js';
// import { sendLineMessage } from '../platforms/line.js';

// Active sessions: sessionId -> Session participants
const sessionParticipants = new Map<string, Array<{ platform: Platform; chatId: string }>>();

/** 指定セッションの参加者一覧を取得 */
export function getSessionParticipants(sessionId: string): Array<{ platform: Platform; chatId: string }> {
  return sessionParticipants.get(sessionId) || [];
}

/**
 * chatId が参加している全セッション ID を返す（候補が複数ありうることを前提にした逆引き）。
 * スレッド管理 cycle1: 1 chatId が複数プロジェクトタブとして複数セッションに参加するのは
 * 意図された挙動（web.ts）であるため、呼び出し側はこの結果を「1件に確定できるとは限らない」
 * ものとして扱うこと（`resolveChatSessionId()` 参照）。
 */
export function getSessionIdCandidatesByChatId(chatId: string): string[] {
  const candidates: string[] = [];
  for (const [sessionId, participants] of sessionParticipants) {
    if (participants.some(p => p.chatId === chatId)) candidates.push(sessionId);
  }
  return candidates;
}

/**
 * chatId が参加しているセッション ID を逆引きする。
 * スレッド管理 cycle1: 候補が複数ある場合は **null を返す（推測しない）**。
 * 旧実装は Map 走査の「最初の1件」を無条件に返しており、これが S1〜S8（他プロジェクトタブへの
 * 誤配送・承認カードの誤復元）の実体だった（`thread-routing.ts` の `resolveChatSessionId` 参照）。
 */
export function getSessionIdByChatId(chatId: string): string | null {
  const candidates = getSessionIdCandidatesByChatId(chatId);
  return resolveChatSessionId({ contextSessionId: null, fallbackCandidates: candidates });
}

// Progress tracking for streaming output
interface MessageInfo {
  messageId: string | number;  // string for Discord, number for Telegram
  platform: Platform;
}
interface ProgressTracker {
  messages: Map<string, MessageInfo>;  // chatId -> { messageId, platform }
  outputBuffer: string;
  contextInfo: string;  // Context usage info to prepend to final message
  startTime: number;
  updateInterval: NodeJS.Timeout | null;
  timeoutTimer: NodeJS.Timeout | null;  // タイムアウト自動クリーンアップ用
  projectId: string | null;  // Web クライアントへのルーティング用
  language: Language;  // #318: 進捗表示メッセージの言語（開始時に1回だけ解決してキャッシュ）
  machineId: string | null;  // #337: ソフトタイムアウト満了時にマシン生存確認するため
}
const progressTrackers = new Map<string, ProgressTracker>();

/** sessionId → projectId のキャッシュ（DB クエリ不要で projectId を取得するため） */
const sessionProjectMap = new Map<string, string>();

/** sessionId → machineId のキャッシュ（#337、sessionProjectMap と同じ流儀） */
const sessionMachineMap = new Map<string, string>();

/**
 * sessionId → agentScopeId（DB 保存値。string | null）のキャッシュ。
 * スレッド管理 cycle1: sessionProjectMap と同じ流儀。値が Map に無い（未キャッシュ）場合と
 * 「DB 上 null（従来スレッド）」の場合を区別するため、キャッシュヒット時は必ず
 * `string | null` を格納する（`undefined` を格納しない）。
 */
const sessionScopeMap = new Map<string, string | null>();

const PROGRESS_UPDATE_INTERVAL = 8000; // 8 seconds
const MAX_OUTPUT_LINES = 15;
/**
 * エージェント無応答時のソフトタイムアウト（既定5分）。
 * #337: このタイマー満了時、マシンが online なら誤検知として再武装するだけでチャットには出さない
 * （decideProgressTimeoutAction() 参照）。env で調整可能（#321 の DEVRELAY_TOKEN_WARN_SLOW_* の流儀）。
 */
const PROGRESS_TIMEOUT = Number(process.env.DEVRELAY_PROGRESS_TIMEOUT_MS) || 300_000;
/** #337: ハードタイムアウト（既定150分）。マシンが online でも無条件でタイムアウト確定する安全網。
 *  #366: Agent 側 loop-guard の wall-clock（既定120分）より必ず後に発火させること。 */
const PROGRESS_HARD_TIMEOUT = Number(process.env.DEVRELAY_PROGRESS_HARD_TIMEOUT_MS) || 9_000_000;

// Restore session participants from ChannelSession on server startup
export async function restoreSessionParticipants() {
  // Get all ChannelSession records with active sessions
  const channelSessions = await prisma.channelSession.findMany({
    where: {
      currentSessionId: { not: null }
    }
  });

  let restoredCount = 0;
  let reactivatedCount = 0;
  for (const cs of channelSessions) {
    if (cs.currentSessionId) {
      // Check if session exists and get machine status
      const session = await prisma.session.findUnique({
        where: { id: cs.currentSessionId },
        include: { machine: true }
      });

      if (session) {
        // sessionId → projectId / machineId / agentScopeId キャッシュを更新
        sessionProjectMap.set(session.id, session.projectId);
        sessionMachineMap.set(session.id, session.machineId);
        sessionScopeMap.set(session.id, session.agentScopeId);
        // Restore if machine is online (regardless of session status)
        if (session.machine.status === 'online') {
          addParticipant(cs.currentSessionId, cs.platform as Platform, cs.chatId);
          restoredCount++;
          console.log(`✅ Restored session participant: ${cs.platform}:${cs.chatId} -> ${cs.currentSessionId}`);

          // Reactivate ended sessions when machine is back online
          if (session.status === 'ended') {
            await prisma.session.update({
              where: { id: cs.currentSessionId },
              data: { status: 'active', endedAt: null }
            });
            reactivatedCount++;
            console.log(`🔄 Reactivated session: ${cs.currentSessionId}`);
          }
        } else {
          // マシンがオフライン: クリアせず保持（Agent 再接続時に復元される）
          // サーバー起動時は全マシンが offline のため、ここでクリアすると全セッションが失われる
          console.log(`⏳ Machine offline, keeping session for later: ${cs.platform}:${cs.chatId}`);
        }
      } else {
        // Session no longer exists, clear ChannelSession
        await prisma.channelSession.update({
          where: { id: cs.id },
          data: {
            currentSessionId: null,
            currentMachineId: null
          }
        });
        console.log(`🧹 Cleared stale session: ${cs.platform}:${cs.chatId}`);
      }
    }
  }

  console.log(`📋 Restored ${restoredCount} session participant(s), reactivated ${reactivatedCount} session(s)`);
}

/**
 * 特定マシンのセッション参加者を復元する
 * Agent再接続時に呼び出し、ChannelSessionからセッションを復元する
 *
 * @param machineId 復元対象のマシンID
 */
export async function restoreSessionParticipantsForMachine(machineId: string) {
  // このマシンに関連する ChannelSession を取得
  const channelSessions = await prisma.channelSession.findMany({
    where: {
      currentSessionId: { not: null },
      currentMachineId: machineId
    }
  });

  let restoredCount = 0;
  for (const cs of channelSessions) {
    if (cs.currentSessionId) {
      const session = await prisma.session.findUnique({
        where: { id: cs.currentSessionId }
      });

      if (session) {
        sessionProjectMap.set(session.id, session.projectId);
        sessionMachineMap.set(session.id, session.machineId);
        sessionScopeMap.set(session.id, session.agentScopeId);
        addParticipant(cs.currentSessionId, cs.platform as Platform, cs.chatId);
        restoredCount++;

        // ended のセッションを active に戻す
        if (session.status === 'ended') {
          await prisma.session.update({
            where: { id: cs.currentSessionId },
            data: { status: 'active', endedAt: null }
          });
          console.log(`🔄 Reactivated session: ${cs.currentSessionId}`);
        }
      }
    }
  }

  if (restoredCount > 0) {
    console.log(`📋 Restored ${restoredCount} session participant(s) for machine ${machineId}`);
  }
}

/**
 * スレッド管理 cycle1: createSession() の追加オプション。
 * 未指定（従来の呼び出し）の場合、`agentScopeId` は一切採番せず null のまま
 * （＝完全に後方互換。既存 5 箇所の呼び出しはこのオプションを渡さないため無変更で動く）。
 */
export interface CreateSessionOptions {
  /**
   * 作成経路。
   * - 'interactive': 対話経路（`//connect` 等）での新規スレッド作成。
   *   `DEVRELAY_THREADS_SCOPE_INTERACTIVE`（既定 '1'）が有効な場合のみ、
   *   自身の Session id を agentScopeId として採番する
   * - 'mcp': MCP `submit_instruction` 経由。呼び出し元は既にワイヤ上で
   *   `agentScopeId = sessionId` を agent に送っている（#331 以前から）ため、
   *   ここでは DB にもその事実を記録するだけ（ワイヤ上の変更はゼロ）
   */
  origin?: 'interactive' | 'mcp';
  /** スレッド表示名（あれば Session.title に保存） */
  title?: string | null;
  /**
   * agent 再起動等でセッションを再確立する経路で、旧 Session の agentScopeId を
   * そのまま引き継がせたい場合に渡す（null 可＝従来スレッドはそのまま null で引き継ぐ）。
   * 指定された場合は `origin` の値に関わらずこちらが最優先される（新規採番しない。R2 対策）。
   */
  inheritAgentScopeId?: string | null;
}

export async function createSession(
  userId: string,
  machineId: string,
  projectId: string,
  aiTool: string,
  options?: CreateSessionOptions
): Promise<string> {
  const session = await prisma.session.create({
    data: {
      userId,
      machineId,
      projectId,
      aiTool,
      status: 'active',
      title: options?.title ?? undefined,
      // スレッド一覧（GET /api/threads）は `lastActiveAt desc nulls last` で DB 側ソートするため、
      // NULL のまま作られたスレッドは take の外に落ち、一覧から永久に見えなくなる（fail-closed）。
      // そのため全 create 経路で必ず初期化する。
      // startedAt は DB の CURRENT_TIMESTAMP、こちらは app サーバーのクロックなので数 ms ずれるが、
      // lastActiveAt はソートキーと表示にしか使わないため影響しない。
      // 【非不変条件】`lastActiveAt >= startedAt` は成立を仮定してはならない。
      lastActiveAt: new Date(),
    }
  });

  sessionParticipants.set(session.id, []);
  sessionProjectMap.set(session.id, projectId);
  sessionMachineMap.set(session.id, machineId);

  // agentScopeId の決定（バックフィル禁止の不変条件: options 未指定なら常に null のまま）
  let agentScopeId: string | null = null;
  if (options?.inheritAgentScopeId !== undefined) {
    agentScopeId = inheritScopeForReestablishedSession({ oldAgentScopeId: options.inheritAgentScopeId });
  } else if (options?.origin === 'interactive') {
    const interactiveScopeEnabled = process.env.DEVRELAY_THREADS_SCOPE_INTERACTIVE !== '0';
    agentScopeId = decideNewSessionScopeId({ newSessionId: session.id, interactiveScopeEnabled });
  } else if (options?.origin === 'mcp') {
    agentScopeId = session.id;
  }

  sessionScopeMap.set(session.id, agentScopeId);
  if (agentScopeId !== null) {
    await prisma.session.update({ where: { id: session.id }, data: { agentScopeId } });
  }

  return session.id;
}

/**
 * 指定セッションへ agent プロンプト送信時に付与する scope オプションを解決する。
 * `sendPromptToAgent` / `execConversation` の呼び出し元はこの関数の戻り値をそのまま
 * `scopeOptions` にスプレッドすることで、agentScopeId の DB→wire 変換ロジックを
 * 一箇所（`resolveOutboundAgentScopeId`）に集約する。
 *
 * キャッシュ（sessionScopeMap）にヒットしない場合は DB から解決してキャッシュする
 * （sessionProjectMap と同じ流儀。サーバー再起動直後等でキャッシュが空でも動作する）。
 */
export async function resolveScopeOptionsForSession(
  sessionId: string
): Promise<{ agentScopeId?: string }> {
  let stored = sessionScopeMap.get(sessionId);
  if (stored === undefined) {
    try {
      const session = await prisma.session.findUnique({
        where: { id: sessionId },
        select: { agentScopeId: true },
      });
      stored = session?.agentScopeId ?? null;
      sessionScopeMap.set(sessionId, stored);
    } catch (err) {
      console.error(`Failed to resolve agentScopeId for session ${sessionId}:`, err);
      stored = null;
    }
  }
  const agentScopeId = resolveOutboundAgentScopeId(stored);
  return agentScopeId !== undefined ? { agentScopeId } : {};
}

/**
 * セッションの最終アクティビティ時刻（`lastActiveAt`）を更新する（fire-and-forget）。
 * `teamexec_` / `crossquery_` 等の一時セッションは一覧に出さないため更新をスキップする。
 * 呼び出し元は await しない（プロンプト送信の応答性を lastActiveAt の DB 書き込みで
 * 遅延させないため。失敗してもチャット機能には影響しない）。
 */
export function touchSessionActivity(sessionId: string): void {
  if (isEphemeralSessionId(sessionId)) return;
  prisma.session
    .update({ where: { id: sessionId }, data: { lastActiveAt: new Date() } })
    .catch((err: unknown) => {
      console.error(`Failed to touch lastActiveAt for session ${sessionId}:`, err);
    });
}

export function addParticipant(sessionId: string, platform: Platform, chatId: string) {
  const participants = sessionParticipants.get(sessionId) || [];
  
  // Avoid duplicates
  if (!participants.some(p => p.platform === platform && p.chatId === chatId)) {
    participants.push({ platform, chatId });
    sessionParticipants.set(sessionId, participants);
  }
}

export function removeParticipant(sessionId: string, platform: Platform, chatId: string) {
  const participants = sessionParticipants.get(sessionId) || [];
  const filtered = participants.filter(p => !(p.platform === platform && p.chatId === chatId));
  sessionParticipants.set(sessionId, filtered);
}

/**
 * 指定した Web chatId を全セッションの参加者リストから除去する
 * WS 切断時に呼び出し、stale 参加者の蓄積を防止する
 * インメモリ + DB（ChannelSession）の両方をクリーンアップ
 */
export async function removeWebParticipantFromAllSessions(chatId: string): Promise<void> {
  // インメモリから除去
  for (const [sessionId, participants] of sessionParticipants) {
    const filtered = participants.filter(p => !(p.platform === 'web' && p.chatId === chatId));
    if (filtered.length !== participants.length) {
      sessionParticipants.set(sessionId, filtered);
    }
  }
  // DB（ChannelSession）からも除去（サーバー再起動時の復元を防止）
  try {
    await prisma.channelSession.deleteMany({
      where: { platform: 'web', chatId },
    });
  } catch (e: any) {
    console.warn(`ChannelSession cleanup warning for ${chatId}:`, e.message);
  }
}

export async function endSession(sessionId: string) {
  await prisma.session.update({
    where: { id: sessionId },
    data: { status: 'ended', endedAt: new Date() }
  });
  
  sessionParticipants.delete(sessionId);
}

export async function broadcastToSession(sessionId: string, message: string, isComplete: boolean, files?: FileAttachment[]) {
  const participants = sessionParticipants.get(sessionId) || [];
  let projectId = sessionProjectMap.get(sessionId);

  // キャッシュにない場合は DB から取得（複数エージェント同時実行時のレースコンディション対策）
  if (!projectId) {
    try {
      const session = await prisma.session.findUnique({
        where: { id: sessionId },
        select: { projectId: true },
      });
      if (session?.projectId) {
        projectId = session.projectId;
        sessionProjectMap.set(sessionId, projectId);
        console.log(`📍 projectId resolved from DB for session ${sessionId.substring(0, 8)}...: ${projectId.substring(0, 8)}...`);
      }
    } catch (err) {
      console.error(`Failed to resolve projectId for session ${sessionId}:`, err);
    }
  }

  for (const { platform, chatId } of participants) {
    // Stop typing indicator when response is complete
    if (isComplete) {
      if (platform === 'discord') {
        stopDiscordTyping(chatId);
      } else if (platform === 'telegram') {
        stopTelegramTyping(chatId);
      } else if (platform === 'web') {
        stopWebTyping(chatId);
      }
    }
    // Web クライアントには projectId / sessionId を含めてルーティング可能にする
    // （sessionId はサイクル3のクライアント側ルーティング用。配送先自体は従来どおり participant ベース）
    if (platform === 'web') {
      await sendWebMessage(chatId, message, files, projectId, undefined, sessionId);
    } else {
      await sendMessage(platform, chatId, message, files);
    }
  }
}

export async function startTypingForSession(sessionId: string) {
  const participants = sessionParticipants.get(sessionId) || [];

  for (const { platform, chatId } of participants) {
    if (platform === 'discord') {
      await startDiscordTyping(chatId);
    } else if (platform === 'telegram') {
      await startTelegramTyping(chatId);
    } else if (platform === 'web') {
      await startWebTyping(chatId);
    }
  }
}

// Start progress tracking for a session
export async function startProgressTracking(sessionId: string) {
  const participants = sessionParticipants.get(sessionId) || [];

  // Clean up any existing tracker
  stopProgressTracking(sessionId);

  // projectId / machineId をキャッシュから取得（どちらか欠けていれば DB から同時に解決、#337）
  let projectId = sessionProjectMap.get(sessionId) ?? null;
  let machineId = sessionMachineMap.get(sessionId) ?? null;
  if (!projectId || !machineId) {
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      select: { projectId: true, machineId: true },
    });
    if (session) {
      projectId = session.projectId;
      machineId = session.machineId;
      sessionProjectMap.set(sessionId, projectId);
      sessionMachineMap.set(sessionId, machineId);
    }
  }

  // #318/#319: 進捗表示の言語は開始時に1回だけ解決してトラッカーにキャッシュ（毎更新の DB アクセスを避ける）
  // 解決ロジックは resolveSessionLanguage() に単一情報源化（agent-manager.ts と共用、#304/#306/#309 と同種の再発防止）
  const language: Language = await resolveSessionLanguage(sessionId);

  const tracker: ProgressTracker = {
    messages: new Map(),
    outputBuffer: '',
    contextInfo: '',
    startTime: Date.now(),
    updateInterval: null,
    timeoutTimer: null,
    projectId,
    language,
    machineId,
  };

  // Send initial progress message to all participants
  for (const { platform, chatId } of participants) {
    if (platform === 'discord') {
      const messageId = await sendDiscordMessageWithId(chatId, formatProgressMessage('', 0, language));
      if (messageId) {
        tracker.messages.set(chatId, { messageId, platform });
      }
    } else if (platform === 'telegram') {
      const messageId = await sendTelegramMessageWithId(chatId, formatProgressMessage('', 0, language));
      if (messageId) {
        tracker.messages.set(chatId, { messageId, platform });
      }
    } else if (platform === 'web') {
      const messageId = await sendWebMessageWithId(chatId, formatProgressMessage('', 0, language), projectId, sessionId);
      if (messageId) {
        tracker.messages.set(chatId, { messageId, platform });
      }
    }
  }

  // Start periodic updates
  tracker.updateInterval = setInterval(() => {
    updateProgressMessages(sessionId);
  }, PROGRESS_UPDATE_INTERVAL);

  // tracker を登録してからタイマーを武装する（armProgressTimeout は progressTrackers から引くため）
  progressTrackers.set(sessionId, tracker);
  armProgressTimeout(sessionId);
}

/**
 * #337: 進捗タイムアウトタイマーを（再）武装する。
 * 従来は startProgressTracking() と appendSessionOutput() に同じ setTimeout がコピーされていた
 * （#304/#319 と同種の同期漏れ予備軍）ため、ここに一本化した。
 */
function armProgressTimeout(sessionId: string): void {
  const tracker = progressTrackers.get(sessionId);
  if (!tracker) return;
  if (tracker.timeoutTimer) {
    clearTimeout(tracker.timeoutTimer);
  }
  tracker.timeoutTimer = setTimeout(() => {
    onProgressTimeout(sessionId);
  }, PROGRESS_TIMEOUT);
}

/**
 * #337: ソフトタイムアウト（無出力 PROGRESS_TIMEOUT）満了時のハンドラ。
 * マシンが online なら「エージェントが生きている」とみなしチャットには何も出さずタイマーを再武装する。
 * offline / 不明、またはセッション開始からのハードタイムアウト超過時は従来どおり finalize する。
 */
async function onProgressTimeout(sessionId: string): Promise<void> {
  const tracker = progressTrackers.get(sessionId);
  if (!tracker) return;

  let machineStatus: string | null = null;
  try {
    if (tracker.machineId) {
      const machine = await prisma.machine.findUnique({
        where: { id: tracker.machineId },
        select: { status: true },
      });
      machineStatus = machine?.status ?? null;
    }
  } catch (err) {
    console.error(`Failed to resolve machine status for session ${sessionId}:`, err);
  }

  const decision = decideProgressTimeoutAction({
    elapsedSinceStartMs: Date.now() - tracker.startTime,
    hardTimeoutMs: PROGRESS_HARD_TIMEOUT,
    machineStatus,
  });

  if (decision.action === 'extend') {
    console.log(`⏳ Progress soft-timeout for session ${sessionId} (${PROGRESS_TIMEOUT / 1000}s since last output), agent online, extending`);
    armProgressTimeout(sessionId);
    return;
  }

  console.warn(`⏱️ Progress timeout for session ${sessionId} (${PROGRESS_TIMEOUT / 1000}s since last output, reason=${decision.reason})`);
  const minElapsed = Math.round(PROGRESS_TIMEOUT / 60000);
  finalizeProgress(sessionId, tChat(tracker.language, 'progress.timeout', { min: minElapsed }));
}

// Add output to the buffer
export function appendSessionOutput(sessionId: string, output: string) {
  const tracker = progressTrackers.get(sessionId);
  if (tracker) {
    // タイムアウトタイマーをリセット（最後の出力から PROGRESS_TIMEOUT に延長、#337 で一本化）
    armProgressTimeout(sessionId);

    // Check if this is context info (starts with 📊)
    if (output.startsWith('📊') && tracker.contextInfo === '') {
      tracker.contextInfo = output;
      console.log(`📊 Context info captured: ${output.trim()}`);
    } else {
      tracker.outputBuffer += output;
      console.log(`📝 Buffer updated: ${tracker.outputBuffer.length} chars total`);
    }
  } else {
    console.log(`⚠️ No tracker found for session ${sessionId}`);
  }
}

// Update progress messages
async function updateProgressMessages(sessionId: string) {
  const tracker = progressTrackers.get(sessionId);
  if (!tracker) return;

  const elapsed = Math.floor((Date.now() - tracker.startTime) / 1000);
  const content = formatProgressMessage(tracker.outputBuffer, elapsed, tracker.language);

  for (const [chatId, { messageId, platform }] of tracker.messages) {
    if (platform === 'discord') {
      await editDiscordMessage(chatId, messageId as string, content);
    } else if (platform === 'telegram') {
      await editTelegramMessage(chatId, messageId as number, content);
    } else if (platform === 'web') {
      const elapsed = Math.floor((Date.now() - (progressTrackers.get(sessionId)?.startTime ?? Date.now())) / 1000);
      await editWebMessage(chatId, messageId as string, content, elapsed, tracker.projectId, sessionId);
    }
  }
}

// Format the progress message
function formatProgressMessage(output: string, elapsedSeconds: number, language: Language = DEFAULT_CHAT_LANGUAGE): string {
  const lines = output.split('\n').filter(line => line.trim());
  const lastLines = lines.slice(-MAX_OUTPUT_LINES);

  const elapsedLabel = elapsedSeconds < 60
    ? tChat(language, 'progress.elapsedSec', { n: elapsedSeconds })
    : tChat(language, 'progress.elapsedMin', { n: Math.floor(elapsedSeconds / 60) });

  let content = `${tChat(language, 'progress.processing')}\n`;
  content += `⏱️ ${elapsedLabel}\n`;

  if (lastLines.length > 0) {
    content += `\`\`\`\n`;
    content += lastLines.join('\n');
    content += `\n\`\`\``;
  }

  return content;
}

/**
 * 指定 chatId にアクティブな進捗トラッカーがあれば最新状態を返す
 * WS 再接続時に進捗表示を即座に復元するために使用
 */
export function getActiveProgressForChatId(chatId: string): { output: string; elapsed: number; projectId?: string | null } | null {
  for (const [sessionId, participants] of sessionParticipants.entries()) {
    if (!participants.some(p => p.chatId === chatId)) continue;
    const tracker = progressTrackers.get(sessionId);
    if (!tracker) continue;
    const elapsed = Math.floor((Date.now() - tracker.startTime) / 1000);
    const content = formatProgressMessage(tracker.outputBuffer, elapsed, tracker.language);
    return { output: content, elapsed, projectId: tracker.projectId };
  }
  return null;
}

// Stop progress tracking and clean up
export function stopProgressTracking(sessionId: string) {
  const tracker = progressTrackers.get(sessionId);
  if (tracker) {
    if (tracker.updateInterval) {
      clearInterval(tracker.updateInterval);
    }
    if (tracker.timeoutTimer) {
      clearTimeout(tracker.timeoutTimer);
    }
    progressTrackers.delete(sessionId);
  }
}

/**
 * セッションで AI 応答が進行中か判定する（#296 自動更新のアイドル判定用）
 * progressTracker が存在する = 応答待ちの実行が走っている
 */
export function isSessionRunning(sessionId: string): boolean {
  return progressTrackers.has(sessionId);
}

/** セッションの contextInfo（📊 Rate Limit 等）を取得する */
export function getSessionContextInfo(sessionId: string): string {
  return progressTrackers.get(sessionId)?.contextInfo || '';
}

/**
 * セッションの contextInfo に文字列を追記する（📊 Rate Limit 等の前置情報）
 * finalizeProgress が contextInfo を最終メッセージの先頭に前置するため、
 * ここで足した内容は DB 保存・各プラットフォーム配信の両方に一貫して乗る。tracker 無しは no-op。
 */
export function appendSessionContextInfo(sessionId: string, text: string): void {
  const tracker = progressTrackers.get(sessionId);
  if (tracker) tracker.contextInfo += text;
}

// Finalize progress with final message
export async function finalizeProgress(sessionId: string, finalMessage: string, files?: FileAttachment[], messageId?: string) {
  const tracker = progressTrackers.get(sessionId);
  const participants = sessionParticipants.get(sessionId) || [];

  // Stop the update interval and timeout timer
  if (tracker?.updateInterval) {
    clearInterval(tracker.updateInterval);
  }
  if (tracker?.timeoutTimer) {
    clearTimeout(tracker.timeoutTimer);
  }

  // Prepend context info to final message if available
  let messageToSend = finalMessage;
  if (tracker?.contextInfo) {
    messageToSend = tracker.contextInfo + finalMessage;
  }

  // Delete progress messages and send final response
  for (const { platform, chatId } of participants) {
    const msgInfo = tracker?.messages.get(chatId);

    if (platform === 'discord') {
      stopDiscordTyping(chatId);

      // Edit progress message to show completion, or send new message
      if (msgInfo && !files?.length) {
        // Edit existing message with final content
        await editDiscordMessage(chatId, msgInfo.messageId as string, messageToSend);
      } else {
        // Delete progress message and send new one with files
        if (msgInfo) {
          await editDiscordMessage(chatId, msgInfo.messageId as string, tChat(tracker?.language ?? DEFAULT_CHAT_LANGUAGE, 'progress.complete'));
        }
        await sendDiscordMessage(chatId, messageToSend, files);
      }
    } else if (platform === 'telegram') {
      stopTelegramTyping(chatId);

      // Edit progress message to show completion, or send new message
      if (msgInfo && !files?.length) {
        // Edit existing message with final content
        await editTelegramMessage(chatId, msgInfo.messageId as number, messageToSend);
      } else {
        // Delete progress message and send new one with files
        if (msgInfo) {
          await editTelegramMessage(chatId, msgInfo.messageId as number, tChat(tracker?.language ?? DEFAULT_CHAT_LANGUAGE, 'progress.complete'));
        }
        await sendTelegramMessage(chatId, messageToSend, files);
      }
    } else if (platform === 'web') {
      stopWebTyping(chatId);
      // tracker の projectId がない場合は sessionProjectMap からフォールバック
      const finalProjectId = tracker?.projectId ?? sessionProjectMap.get(sessionId);
      await sendWebMessage(chatId, messageToSend, files, finalProjectId, messageId, sessionId);
    }
  }

  progressTrackers.delete(sessionId);

  // プッシュ通知（タブが閉じていても届く）
  sendPushNotificationForSession(sessionId, messageToSend).catch(() => {});
  // FCM プッシュ通知（モバイルアプリ用）
  sendFcmNotificationForSession(sessionId, messageToSend).catch(() => {});

  // 通知レコード作成（モバイルアプリの通知一覧用）
  prisma.session.findUnique({ where: { id: sessionId }, include: { project: true } })
    .then(session => {
      if (session) {
        const projectName = session.project?.displayName || session.project?.name || 'Unknown';
        // 切り詰めは createNotification 側（truncateSafe）に任せる。ここで slice すると絵文字を分断する
        createNotification(session.userId, 'response', session.projectId, projectName, `✅ ${projectName}`, messageToSend).catch(() => {});
      }
    })
    .catch(() => {});
}

export async function sendMessage(platform: Platform, chatId: string, message: string, files?: FileAttachment[], projectId?: string | null, sessionId?: string) {
  switch (platform) {
    case 'discord':
      await sendDiscordMessage(chatId, message, files);
      break;
    case 'telegram':
      await sendTelegramMessage(chatId, message, files);
      break;
    case 'web':
      await sendWebMessage(chatId, message, files, projectId, undefined, sessionId);
      break;
    case 'line':
      // await sendLineMessage(chatId, message, files);
      console.log(`[LINE] ${chatId}: ${message}`);
      break;
    case 'slack':
      // await sendSlackMessage(chatId, message, files);
      console.log(`[Slack] ${chatId}: ${message}`);
      break;
  }
}

export async function getRecentSessions(userId: string, limit: number = 5) {
  return prisma.session.findMany({
    where: { userId },
    orderBy: { startedAt: 'desc' },
    take: limit,
    include: {
      machine: true,
      project: true,
      _count: { select: { messages: true } }
    }
  });
}

export async function getSessionMessages(sessionId: string, limit: number = 10) {
  return prisma.message.findMany({
    where: { sessionId },
    orderBy: { createdAt: 'desc' },
    take: limit
  });
}

// Clear all sessions for a specific machine (called when machine goes offline)
export async function clearSessionsForMachine(machineId: string) {
  const sessionsToClear: string[] = [];

  for (const [sessionId, participants] of sessionParticipants.entries()) {
    // Get session info from DB to check if it belongs to this machine
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      select: { machineId: true },
    });

    if (session && session.machineId === machineId) {
      sessionsToClear.push(sessionId);

      // Notify participants that the session ended
      const lang = await resolveSessionLanguage(sessionId);
      const offlineMessage = tChat(lang, 'session.machineOffline');
      for (const { platform, chatId } of participants) {
        await sendMessage(platform, chatId, offlineMessage);
      }
    }
  }

  // Clear the sessions
  for (const sessionId of sessionsToClear) {
    sessionParticipants.delete(sessionId);

    // Update DB session status
    await prisma.session.update({
      where: { id: sessionId },
      data: { status: 'ended', endedAt: new Date() },
    }).catch(() => {
      // Ignore errors if session doesn't exist
    });
  }

  if (sessionsToClear.length > 0) {
    console.log(`[SessionManager] Cleared ${sessionsToClear.length} sessions for machine ${machineId}`);
  }
}

/**
 * 指定マシンのアクティブセッション参加者全員に通知を送る（セッションは終了させない）。
 * `clearSessionsForMachine` と同じ「sessionParticipants を machineId で絞り込む」方式を踏襲するが、
 * こちらはセッション自体を終了させない（Claude ログイン切れ検知など、マシン単位のイベントを
 * チャットへ流すための汎用ヘルパー。Phase1 #claude-auth で新設）。
 * 参加者ごとに `resolveSessionLanguage()` で言語を解決してから buildMessage を呼ぶため、
 * 同じマシンでも言語設定が異なる参加者には別々の文言が届く。
 */
export async function notifySessionsForMachine(machineId: string, buildMessage: (lang: Language) => string): Promise<void> {
  for (const [sessionId, participants] of sessionParticipants.entries()) {
    if (participants.length === 0) continue;
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      select: { machineId: true },
    });
    if (session && session.machineId === machineId) {
      const lang = await resolveSessionLanguage(sessionId);
      const message = buildMessage(lang);
      for (const { platform, chatId } of participants) {
        await sendMessage(platform, chatId, message);
      }
    }
  }
}

// Get all active sessions (in-memory sessions with participants)
/**
 * メモリ内のアクティブセッション（参加者がいるセッション）を取得
 * displayName が設定されている場合は machineDisplayName に反映
 */
export async function getActiveSessions() {
  const activeSessions: Array<{
    sessionId: string;
    machineName: string;
    machineDisplayName: string;
    projectName: string;
    aiTool: string;
    participants: Array<{ platform: Platform; chatId: string }>;
    startedAt: Date;
  }> = [];

  for (const [sessionId, participants] of sessionParticipants.entries()) {
    if (participants.length === 0) continue;

    // Get session info from DB
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      include: {
        machine: true,
        project: true,
      },
    });

    if (session && session.status === 'active') {
      activeSessions.push({
        sessionId,
        machineName: session.machine.name,
        machineDisplayName: session.machine.displayName ?? session.machine.name,
        projectName: session.project.name,
        aiTool: session.aiTool,
        participants,
        startedAt: session.startedAt,
      });
    }
  }

  return activeSessions;
}
