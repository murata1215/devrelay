/**
 * raw-completion（ゲーム席用の素の completion API）
 *
 * `doc/analysis/ask_raw_mode_investigation.md` §11 の推奨案。既存の ask/teamexec/MCP exec の
 * コードパス・定数・判定順序には一切触れず、専用エンドポイント + `raw_` 接頭辞で完全に分離する
 * （実装プラン §Context 参照）。Phase 1 は Claude SDK 経路のみ（linux/macos の Agent、Windows Electron
 * agent は capability 未申告のため到達しない — D4）。
 *
 * エンドポイント:
 * - POST /api/agent/raw-completion
 *
 * 認証: Authorization: Bearer <machine_token>（`document-api.ts` の `authenticateByMachineTokenFull`
 * を共用。関数自体は 0 行変更、`export` を追加しただけ）。
 *
 * 流量制御・同時実行制御は `raw-completion-guard.ts`（インメモリ、D3）。
 * Server → Agent の送受信は `agent-manager.ts` の `sendRawPromptToAgent`/`agent:raw:result`
 * 専用チャネル（D2）。`handleAiPrompt`/`sendPromptToAgent`/`handleAiOutput` は 0 行変更。
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'crypto';
import { prisma } from '../db/client.js';
import type { RawPromptPayload, RawResultPayload } from '@devrelay/shared';
import {
  sendRawPromptToAgent,
  cancelPendingRawCompletion,
  isAgentConnected,
  agentHasCapability,
  isAgentOutdated,
} from '../services/agent-manager.js';
import { authenticateByMachineTokenFull, checkCrossTargetAllowed } from './document-api.js';
import {
  RAW_MAX_SYSTEM_CHARS,
  RAW_MAX_USER_CHARS,
  RAW_SEAT_CONCURRENCY,
  createRawGuardState,
  normalizeSeatKey,
  resolveRawTimeoutMs,
  buildRawSessionId,
  acquireRawSlot,
  releaseRawSlot,
  type RawGuardState,
} from '../services/raw-completion-guard.js';

/**
 * サーバー予算に対する Agent 側予算の比率（実装プラン「timeout の歪み」対策）。
 * Agent の `finally` 応答が Server 側 timeout より先に確定するよう、Agent には少し短い予算を渡す。
 */
const AGENT_TIMEOUT_RATIO = 0.9;

/**
 * このプロセス内で 1 個だけ保持するインメモリ状態（D3）。`raw-completion-guard.ts` はこの `state` を
 * 一切内部に隠し持たず、呼び出しごとに引数として受け取る純関数のみで構成される。
 */
const rawGuardState: RawGuardState = createRawGuardState();

/**
 * リクエストボディの型（未検証の入力。すべて `unknown` 相当として扱い、下の検証コードで確定させる）。
 */
interface RawCompletionRequestBody {
  targetProjectId?: string;
  system?: string;
  prompt?: string;
  seatKey?: string;
  model?: string;
  timeoutS?: number;
}

export function registerRawCompletionRoutes(app: FastifyInstance) {
  /**
   * POST /api/agent/raw-completion
   * ゲーム席用の素の completion API。DevRelay の前置き・Agreement・プランモード指示を一切付与せず、
   * 指定された system prompt で完全に置換した上で Claude SDK を 1 ターンだけ実行する。
   *
   * Body: { targetProjectId: string, system: string, prompt: string, seatKey: string,
   *         model?: string, timeoutS?: number }
   * 認証: Authorization: Bearer <machine_token>
   * レスポンス: { output, usageData, model, stopReason, agentDurationMs, latencyMs }
   */
  app.post('/api/agent/raw-completion', async (request: FastifyRequest, reply: FastifyReply) => {
    const routeStartedAt = Date.now();
    const auth = await authenticateByMachineTokenFull(request);
    if (!auth) {
      return reply.status(401).send({ error: 'Invalid or missing machine token', code: 'unauthorized' });
    }

    const { targetProjectId, system, prompt, seatKey, model, timeoutS } = (request.body || {}) as RawCompletionRequestBody;
    if (!targetProjectId || typeof system !== 'string' || typeof prompt !== 'string' || !seatKey) {
      return reply.status(400).send({
        error: 'targetProjectId, system, prompt, seatKey are required',
        code: 'aiUnavailable',
      });
    }

    // 入力長の上限（クライアントの誤送信・DoS 的な巨大入力の防御、実装プラン P1-1）
    if (system.length > RAW_MAX_SYSTEM_CHARS || prompt.length > RAW_MAX_USER_CHARS) {
      return reply.status(400).send({
        error: `Input too long (system max ${RAW_MAX_SYSTEM_CHARS} chars, prompt max ${RAW_MAX_USER_CHARS} chars)`,
        code: 'aiUnavailable',
      });
    }

    const normalizedSeatKey = normalizeSeatKey(seatKey);
    if (!normalizedSeatKey) {
      return reply.status(403).send({ error: 'Invalid seatKey', code: 'notAllowed' });
    }

    // ターゲットプロジェクトの存在確認と所有権チェック（ask-member と同じ形）
    const targetProject = await prisma.project.findUnique({
      where: { id: targetProjectId },
      include: { machine: { select: { id: true, userId: true, status: true, deletedAt: true, name: true, displayName: true } } },
    });
    if (!targetProject || targetProject.machine.deletedAt) {
      return reply.status(404).send({ error: 'Target project not found', code: 'notAllowed' });
    }
    if (targetProject.machine.userId !== auth.userId) {
      return reply.status(403).send({ error: 'Target project not owned by this user', code: 'notAllowed' });
    }

    // #295 と同じ Team 登録チェック（クロスプロジェクト系と同じ「宛先は Team 登録済みのみ」の原則）
    const allowed = await checkCrossTargetAllowed(auth.machineId, auth.userId, targetProjectId);
    if (!allowed.allowed) {
      return reply.status(403).send({ error: 'Target project is not registered in a team', code: 'notAllowed' });
    }

    // Phase 1 は Claude SDK 経路のみ（D4: Windows Electron agent は capability 未申告のためここで弾く）
    const machineId = targetProject.machine.id;
    if (targetProject.defaultAi !== 'claude') {
      return reply.status(400).send({ error: `raw-completion only supports Claude (project defaultAi=${targetProject.defaultAi})`, code: 'aiUnavailable' });
    }
    if (targetProject.machine.status !== 'online' || !isAgentConnected(machineId)) {
      return reply.status(400).send({ error: `Agent for ${targetProject.name} is offline`, code: 'aiUnavailable' });
    }
    if (isAgentOutdated(machineId)) {
      return reply.status(400).send({ error: `Agent for ${targetProject.name} needs update ('u')`, code: 'aiUnavailable' });
    }
    if (!agentHasCapability(machineId, 'raw-completion')) {
      return reply.status(400).send({ error: `Agent for ${targetProject.name} does not support raw-completion`, code: 'aiUnavailable' });
    }

    // 流量制御・同時実行制御（D3、インメモリ、判定順は raw-completion-guard.ts 側で固定）
    const rawSessionId = buildRawSessionId(crypto.randomUUID());
    const serverTimeoutMs = resolveRawTimeoutMs(timeoutS);
    const slotDecision = acquireRawSlot(rawGuardState, {
      userId: auth.userId,
      seatKey: normalizedSeatKey,
      sessionId: rawSessionId,
      nowMs: Date.now(),
    });
    if (!slotDecision.ok) {
      const code = slotDecision.reason === 'targetBusy' ? 'targetBusy' : 'rateLimited';
      return reply.status(429).send({ error: `raw-completion rejected: ${slotDecision.reason}`, code });
    }

    // Session 行（usage 記録・スモークテスト検証用、D3）。agentScopeId は付与しない
    // （raw-completion は `.devrelay/sessions/` 配下の会話境界を持たない使い切りターンのため）。
    await prisma.session.create({
      data: {
        id: rawSessionId,
        userId: auth.userId,
        machineId,
        projectId: targetProjectId,
        aiTool: 'claude',
        status: 'active',
        lastActiveAt: new Date(),
      },
    });
    await prisma.message.create({
      data: {
        sessionId: rawSessionId,
        role: 'user',
        content: prompt,
        platform: 'api',
      },
    });

    const payload: RawPromptPayload = {
      requestId: crypto.randomUUID(),
      sessionId: rawSessionId,
      projectPath: targetProject.path,
      system,
      prompt,
      model,
      timeoutMs: Math.floor(serverTimeoutMs * AGENT_TIMEOUT_RATIO),
    };

    // HTTP 切断検知: curl タイムアウト等でクライアントが切断した場合にスロット・待機を解放する
    // （実装プラン D3: `finally` と `request.raw.on('close')` の両方から解放すること）
    let clientDisconnected = false;
    request.raw.on('close', () => {
      if (!reply.sent) {
        clientDisconnected = true;
        releaseRawSlot(rawGuardState, auth.userId, normalizedSeatKey);
        cancelPendingRawCompletion(payload.requestId);
        prisma.session.update({ where: { id: rawSessionId }, data: { status: 'ended', endedAt: new Date() } }).catch(() => {});
      }
    });

    try {
      const result: RawResultPayload = await sendRawPromptToAgent(machineId, payload);
      releaseRawSlot(rawGuardState, auth.userId, normalizedSeatKey);
      if (clientDisconnected) return;

      await prisma.session.update({ where: { id: rawSessionId }, data: { status: 'ended', endedAt: new Date() } });

      if (!result.ok) {
        await prisma.message.create({
          data: {
            sessionId: rawSessionId,
            role: 'system',
            content: result.errorMessage ?? 'raw-completion failed',
            platform: 'api',
          },
        });
        if (result.stopReason === 'timeout') {
          return reply.status(504).send({ error: result.errorMessage ?? 'raw-completion timed out', code: 'timeout' });
        }
        return reply.status(502).send({ error: result.errorMessage ?? 'raw-completion agent error', code: 'agentError' });
      }

      await prisma.message.create({
        data: {
          sessionId: rawSessionId,
          role: 'ai',
          content: result.output ?? '',
          platform: 'api',
          usageData: result.usageData ? (result.usageData as object) : undefined,
        },
      });

      return reply.send({
        output: result.output ?? '',
        usageData: result.usageData,
        model: result.usageData?.model,
        stopReason: result.stopReason,
        agentDurationMs: result.agentDurationMs,
        latencyMs: Date.now() - routeStartedAt,
      });
    } catch (error: any) {
      releaseRawSlot(rawGuardState, auth.userId, normalizedSeatKey);
      await prisma.session.update({ where: { id: rawSessionId }, data: { status: 'ended', endedAt: new Date() } }).catch(() => {});
      if (clientDisconnected) return;
      console.error(`🎮 raw-completion failed: ${error?.message}`);
      return reply.status(504).send({ error: `raw-completion timed out or failed: ${error?.message}`, code: 'timeout' });
    }
  });
}

// Phase 1 の同時実行上限（D3）はテスト・ドキュメント目的の参照用に export しておく
export { RAW_SEAT_CONCURRENCY };
