/**
 * raw-completion（ゲーム席用の素の completion API）
 *
 * `doc/analysis/ask_raw_mode_investigation.md` §11 の推奨案。既存の ask/teamexec/MCP exec の
 * コードパス・定数・判定順序には一切触れず、専用エンドポイント + `raw_` 接頭辞で完全に分離する
 * （実装プラン §Context 参照）。Phase 1 は Claude SDK 経路のみ、Phase 2 で Codex CLI 経路を追加した
 * （linux/macos の Agent のみ。Windows Electron agent は capability 未申告のため到達しない — D4）。
 *
 * Phase 2: リクエストの `ai`（`"claude"|"codex"`、省略時 `"claude"`）で経路を選択する。
 * プロジェクトの `defaultAi` には依存しない（Claude 席と Codex 席を同じ試合に混ぜるため、
 * `defaultAi=codex` のプロジェクトでも `ai:"claude"` を指定すれば Claude 席として使える）。
 * `ai==='codex'` は対象 Agent が `availableAiTools` に `codex` を含み、かつ `raw-completion-codex`
 * capability を申告している場合のみ許可する（`raw-completion-ai.ts` の `decideRawAiGate()`。
 * 自動フォールバック禁止 — 人間指示どおり、未対応なら常に 400 で明示的に弾く）。
 *
 * エンドポイント:
 * - POST /api/agent/raw-completion
 *
 * 認証: Authorization: Bearer <machine_token>（`document-api.ts` の `authenticateByMachineTokenFull`
 * を共用。関数自体は 0 行変更、`export` を追加しただけ）。
 *
 * 流量制御・同時実行制御は `raw-completion-guard.ts`（インメモリ、D3）。`ai` 選択の追加ゲート・
 * モデル検証は `raw-completion-ai.ts`（Phase 2 新設）。Server → Agent の送受信は `agent-manager.ts` の
 * `sendRawPromptToAgent`/`agent:raw:result` 専用チャネル（D2）。
 * `handleAiPrompt`/`sendPromptToAgent`/`handleAiOutput` は 0 行変更。
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'crypto';
import { prisma } from '../db/client.js';
import type { RawPromptPayload, RawResultPayload } from '@devrelay/shared';
import { AI_MODEL_CATALOG } from '@devrelay/shared';
import {
  sendRawPromptToAgent,
  cancelPendingRawCompletion,
  isAgentConnected,
  agentHasCapability,
  isAgentOutdated,
  getAgentAvailableAiTools,
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
import { buildRawCompletionResponse } from '../services/raw-completion-response.js';
import { resolveRawAi, decideRawAiGate, validateRawCodexModel } from '../services/raw-completion-ai.js';

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
  /** Phase 2: 使用する AI（`"claude"|"codex"`、省略時 `"claude"`） */
  ai?: string;
}

export function registerRawCompletionRoutes(app: FastifyInstance) {
  /**
   * POST /api/agent/raw-completion
   * ゲーム席用の素の completion API。DevRelay の前置き・Agreement・プランモード指示を一切付与せず、
   * `ai`（既定 claude）に応じて Claude SDK または Codex CLI を 1 ターンだけ実行する。Claude は
   * system prompt を完全置換、Codex は `-c developer_instructions` に system を渡す
   * （base instructions 自体の置換手段が無いため。既知の制約は README 参照）。
   *
   * Body: { targetProjectId: string, system: string, prompt: string, seatKey: string,
   *         model?: string, timeoutS?: number, ai?: "claude"|"codex" }
   * 認証: Authorization: Bearer <machine_token>
   * レスポンス: { text, output, model, usage, latencyMs, agentDurationMs, stopReason, sessionId, deniedTools, ai }
   */
  app.post('/api/agent/raw-completion', async (request: FastifyRequest, reply: FastifyReply) => {
    const routeStartedAt = Date.now();
    const auth = await authenticateByMachineTokenFull(request);
    if (!auth) {
      return reply.status(401).send({ error: 'Invalid or missing machine token', code: 'unauthorized' });
    }

    const { targetProjectId, system, prompt, seatKey, model, timeoutS, ai: rawAiValue } = (request.body || {}) as RawCompletionRequestBody;
    if (!targetProjectId || typeof system !== 'string' || typeof prompt !== 'string' || !seatKey) {
      return reply.status(400).send({
        error: 'targetProjectId, system, prompt, seatKey are required',
        code: 'aiUnavailable',
      });
    }

    // Phase 2: `ai` の解決（未指定は 'claude'、不正値は 400）
    const aiResolution = resolveRawAi(rawAiValue);
    if (!aiResolution.ok) {
      return reply.status(400).send({ error: aiResolution.error, code: 'aiUnavailable' });
    }
    const ai = aiResolution.ai;

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

    // Phase 2: 経路の選択は defaultAi ではなくリクエストの `ai` で決める（D4: Windows Electron agent は
    // capability 未申告のためここで弾く）。
    const machineId = targetProject.machine.id;
    if (targetProject.machine.status !== 'online' || !isAgentConnected(machineId)) {
      return reply.status(400).send({ error: `Agent for ${targetProject.name} is offline`, code: 'aiUnavailable' });
    }
    if (isAgentOutdated(machineId)) {
      return reply.status(400).send({ error: `Agent for ${targetProject.name} needs update ('u')`, code: 'aiUnavailable' });
    }
    if (!agentHasCapability(machineId, 'raw-completion')) {
      return reply.status(400).send({ error: `Agent for ${targetProject.name} does not support raw-completion`, code: 'aiUnavailable' });
    }
    // ai==='codex' の追加ゲート（自動フォールバック禁止、未対応なら 400）。ai==='claude' は何も追加しない。
    const aiGate = decideRawAiGate({
      ai,
      availableAiTools: getAgentAvailableAiTools(machineId),
      hasCodexCapability: agentHasCapability(machineId, 'raw-completion-codex'),
    });
    if (!aiGate.ok) {
      return reply.status(400).send({ error: `${aiGate.error} (project=${targetProject.name})`, code: 'aiUnavailable' });
    }
    if (ai === 'codex') {
      const modelCheck = validateRawCodexModel(model, AI_MODEL_CATALOG.codex.map((m) => m.id));
      if (!modelCheck.ok) {
        return reply.status(400).send({ error: modelCheck.error, code: 'aiUnavailable' });
      }
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
        aiTool: ai,
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
      ai,
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

      // Phase 1.1: レスポンス組み立ては raw-completion-response.ts に一本化（新 HTTP 契約、常に全キーを持つ）
      const body = buildRawCompletionResponse({
        result,
        sessionId: rawSessionId,
        requestedModel: model,
        latencyMs: Date.now() - routeStartedAt,
        ai,
      });

      // 要件4: deny されたツール名の可観測性（`agent.log` が読めない問題の恒久対策として
      // サーバーログ + DB の二重記録にする）
      if (body.deniedTools.length > 0) {
        console.warn(
          `🛑 raw-completion: ${body.deniedTools.length} 件のツール呼び出しを deny しました ` +
          `(ai=${ai}, machineId=${machineId}, sessionId=${rawSessionId}, seatKey=${normalizedSeatKey}): ${body.deniedTools.join(', ')}`
        );
        await prisma.message.create({
          data: {
            sessionId: rawSessionId,
            role: 'system',
            content: `⚠️ raw-completion: denied tool calls: ${body.deniedTools.join(', ')}`,
            platform: 'api',
          },
        }).catch(() => {});
      }

      if (body.error) {
        // 「SDK が本当に失敗した」のか「配線が壊れた（旧 Agent 等）」のかを pm2 logs 1行で切り分けられるようにする
        console.warn(`🎮 raw-completion error (ai=${ai}, machineId=${machineId}, sessionId=${rawSessionId}): ${body.error}`);
        await prisma.message.create({
          data: { sessionId: rawSessionId, role: 'system', content: body.error, platform: 'api' },
        }).catch(() => {});

        const code = body.stopReason === 'timeout'
          ? 'timeout'
          : (body.error.includes('outdated agent') ? 'outdatedAgent' : 'agentError');
        const status = body.stopReason === 'timeout' ? 504 : 502;
        return reply.status(status).send({ ...body, code });
      }

      // text が空で error も無い場合も「SDK が本当に無言」か「配線が壊れた」かを pm2 logs 1行で切り分けられるようにする
      if (body.text.trim().length === 0) {
        console.warn(`🎮 raw-completion: 本文が空でした（error 無し）(ai=${ai}, machineId=${machineId}, sessionId=${rawSessionId}, stopReason=${body.stopReason})`);
      }

      await prisma.message.create({
        data: {
          sessionId: rawSessionId,
          role: 'ai',
          content: body.text,
          platform: 'api',
          usageData: result.usageData ? (result.usageData as object) : undefined,
        },
      });

      return reply.send(body);
    } catch (error: any) {
      releaseRawSlot(rawGuardState, auth.userId, normalizedSeatKey);
      await prisma.session.update({ where: { id: rawSessionId }, data: { status: 'ended', endedAt: new Date() } }).catch(() => {});
      if (clientDisconnected) return;
      console.error(`🎮 raw-completion failed: ${error?.message}`);
      const body = buildRawCompletionResponse({
        result: { ok: false, errorMessage: `raw-completion timed out or failed: ${error?.message}`, stopReason: 'timeout' },
        sessionId: rawSessionId,
        requestedModel: model,
        latencyMs: Date.now() - routeStartedAt,
        ai,
      });
      return reply.status(504).send({ ...body, code: 'timeout' });
    }
  });
}

// Phase 1 の同時実行上限（D3）はテスト・ドキュメント目的の参照用に export しておく
export { RAW_SEAT_CONCURRENCY };
