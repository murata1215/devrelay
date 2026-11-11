/**
 * クロスプロジェクト ask（`ask <project>: <question>` チャット経路 / Phase C `web:cross:ask`
 * WebUI 経路）の実行本体。`command-handler.ts` の `handleAskMember()` から宛先解決後の部分を
 * 抽出したもの（既存チャット ask もこの関数を通るため挙動不変）。
 *
 * #335（ゲート⑤）の長さ検証・#335 の humanTextMeta・クロスユーザー Team の監査記録・
 * `executorUserId`/`requesterUserId` の分離（`rules/project.md` 参照）を、呼び出し元が
 * 個別に再実装して穴を空けないよう、この 1 箇所に集約する。
 */

import crypto from 'crypto';
import type { AiTool, Platform } from '@devrelay/shared';
import { prisma } from '../db/client.js';
import { executeCrossProjectQuery, agentHasCapability, getAgentAvailableAiTools } from './agent-manager.js';
import { pickAvailableAiTool } from './ai-tool-availability.js';
import {
  validateHumanTextLength,
  neutralizeHumanInputTag,
  buildHumanTextMeta,
  fenceIfHuman,
} from './human-text-fence.js';
import { ASK_QUESTION_MAX_LENGTH, ASK_ANSWER_TIMEOUT_MS, decideAskReadOnlyEnforcement, decideAskRateLimit } from './ask-guard.js';
import { recordCrossTeamAudit } from './cross-team-audit.js';
import { findInflightCrossQueryRows, countRecentCrossSessions } from './cross-session-stats.js';
import {
  pickInflightCrossSession,
  decideCrossTarget,
  buildCrossTargetRejectionMessage,
  ASK_INFLIGHT_WINDOW_MS,
} from './cross-query-guard.js';
import { buildCrossAskContextPrefix, type CrossAskHistoryMessage } from './cross-ask-rules.js';
import { isCrossTeamChatContextEnabled, isCrossAskIsolationEnabled, isCrossAskResumeEnabled, isCrossAskResetEnabled, isPlanGateCapabilityCheckEnabled } from './cross-team-guard.js';
import { decideCrossAskIsolation, buildCrossAskIsolationDenialMessage, buildCrossAskIsolationDenyLog } from './cross-ask-isolation-rules.js';
import {
  buildCrossAskScopeIdBase,
  buildCrossAskScopeId,
  parseCrossAskScopeGeneration,
  decideCrossAskSessionPlan,
  decideCrossAskResetRequested,
  resolveCrossAskResumeTtlMs,
  resolveCrossAskResumeMaxTurns,
  buildCrossAskResumeLog,
} from './cross-ask-resume-rules.js';
import { purgeCrossAskScopes } from './cross-ask-scope-cleanup.js';
import { buildCrossAskSessionIdFilter } from './thread-scope.js';

/** 同じ依頼を再送しないよう促す注記（document-api.ts の `NO_RETRY_NOTE` と同文）。 */
const RUNNER_NO_RETRY_NOTE = '同じ依頼を文面を変えて再送しないでください。ユーザーに状況を報告して停止してください。';

/** `runCrossProjectAsk()` が受け取る宛先プロジェクト（チャット経路・WebUI 経路のどちらの解決結果も代入可能な最小形）。 */
export interface CrossAskTargetProject {
  id: string;
  name: string;
  path: string;
  defaultAi: string;
  /** サイクルG（G-7 の一般化）: claude + terminalMode は読み取り専用を権限で強制できないため隔離判定に必要 */
  terminalMode: boolean;
  machine: { id: string; name: string; displayName: string | null; status: string; userId: string };
  crossTeam?: { teamId: string; grantId: string };
}

export interface RunCrossProjectAskInput {
  targetProject: CrossAskTargetProject;
  /** 依頼者（= 監査・requestedByUserId に使う。同一ユーザー経路では executorUserId と同値） */
  requesterUserId: string;
  question: string;
  platform: Platform;
  /** チャットの送信元プロジェクト名（Conversations ページの表示用。WebUI 経路は常に undefined） */
  sourceProjectName?: string | null;
  /** 文脈前置（案 B）を有効にするか。未指定時は env から解決（呼び出し側が未解決なら true 相当） */
  includeContextPrefix?: boolean;
}

export type RunCrossProjectAskResult =
  | { ok: true; output: string; sessionId: string }
  | { ok: false; kind: 'tooLong'; rawLength: number; limit: number }
  | { ok: false; kind: 'busy'; message: string }
  | { ok: false; kind: 'rateLimited'; message: string }
  | { ok: false; kind: 'denied'; message: string; reason: 'agent_outdated' | 'ai_unsafe' }
  | { ok: false; kind: 'failed'; message: string; sessionId: string };

/**
 * クロスプロジェクト ask を実行する。
 *
 * 呼び出し順（この順序を変えないこと）:
 * 1. 長さ検証（#335 ゲート⑤。いかなる DB 書き込みより前）
 * 2. 同時実行ガード（宛先プロジェクトに実行中の `crossquery_` があれば targetBusy で即返す。
 *    DB 書き込みより前に行う — セッション作成後に弾くと ended セッションのゴミが残るため）
 * 2.3. サイクルC2（G-11）: 直近 5 分のクロス ask 件数によるレート制限（DB 読みのみ、書き込みより前）
 * 2.5. サイクルG: 既存バグ修正の隔離判定（capability + 読み取り専用強制可否）
 * 2.7. サイクルC2: resume 昇格判定（世代解決。DB 読みのみ、書き込みより前）
 * 3. 一時セッション（`crossquery_<uuid>`）作成 + audit `request`（`agentScopeId` も記録）
 * 4. 質問メッセージの保存（humanTextMeta 付き）
 * 5. 文脈前置（案 B、有効時のみ）の組み立て + fence
 * 6. `executeCrossProjectQuery()`（15 分タイムアウト）
 * 7. 成否に応じて audit `completed`/`failed` + セッション ended
 */
export async function runCrossProjectAsk(input: RunCrossProjectAskInput): Promise<RunCrossProjectAskResult> {
  const { targetProject, requesterUserId, question, platform, sourceProjectName } = input;

  // 1. #335（ゲート⑤）: 長さ検証は関数の先頭、いかなる状態変更よりも前。
  const askLengthCheck = validateHumanTextLength(question, ASK_QUESTION_MAX_LENGTH);
  if (!askLengthCheck.ok) {
    return { ok: false, kind: 'tooLong', rawLength: askLengthCheck.rawLength, limit: askLengthCheck.limit };
  }

  const isCrossUser = !!targetProject.crossTeam;
  const executorUserId = targetProject.machine.userId;

  // 2. 同時実行ガード（#348 の入口防御と同じ purpose。チャット/WebUI には「発信マシン」の
  // 概念が無いため callerMachineId は空文字で渡す＝自己宛判定は常に unverified になり、
  // targetBusy 判定だけが効く）。
  {
    const inflightRows = await findInflightCrossQueryRows(targetProject.id);
    const inflight = pickInflightCrossSession(inflightRows, Date.now(), ASK_INFLIGHT_WINDOW_MS);
    const decision = decideCrossTarget({
      mode: 'ask',
      callerMachineId: '',
      targetMachineId: targetProject.machine.id,
      callerProjectPath: null,
      targetProjectPath: targetProject.path,
      inflightSessionId: inflight?.id ?? null,
    });
    if (!decision.allowed) {
      return {
        ok: false,
        kind: 'busy',
        message: buildCrossTargetRejectionMessage(decision, {
          mode: 'ask',
          targetProjectName: targetProject.name,
          noRetryNote: '同じ依頼を文面を変えて再送しないでください。ユーザーに状況を報告して停止してください。',
        }),
      };
    }
  }

  // 2.3. サイクルC2（G-11）: チャット/WebUI 経路には直近 5 分のレート制限が無かった
  // （document-api.ts の REST 経路だけが持っていた）既存の穴を塞ぐ。DB 書き込みより前。
  // 既存の ask-member 実績値（ASK_PROJECT_LIMIT/ASK_USER_LIMIT）をそのまま流用する。
  {
    const [projectRecentCount, userRecentCount] = await Promise.all([
      countRecentCrossSessions('crossquery_', requesterUserId, targetProject.id),
      countRecentCrossSessions('crossquery_', requesterUserId),
    ]);
    const rateDecision = decideAskRateLimit({ projectRecentCount, userRecentCount, inflightAskSessionId: null });
    if (!rateDecision.allowed) {
      if (rateDecision.reason === 'projectRate') {
        return {
          ok: false,
          kind: 'rateLimited',
          message: `レート制限: ${targetProject.name} への問い合わせが5分以内に${rateDecision.count}回発生しています（上限${rateDecision.limit}回）。問い合わせがループしている可能性があります。${RUNNER_NO_RETRY_NOTE}`,
        };
      }
      if (rateDecision.reason === 'userRate') {
        return {
          ok: false,
          kind: 'rateLimited',
          message: `レート制限: 問い合わせが5分以内に${rateDecision.count}回発生しています（全プロジェクト合計の上限${rateDecision.limit}回）。問い合わせがプロジェクト間でループしている可能性があります。${RUNNER_NO_RETRY_NOTE}`,
        };
      }
      // projectBusy は上の同時実行ガード（step 2）が inflightAskSessionId:null で渡しているため
      // 到達しないが、型の完全性のため busy として扱う。
      return { ok: false, kind: 'busy', message: `⚠️ ${targetProject.name} は現在処理中です。${RUNNER_NO_RETRY_NOTE}` };
    }
  }

  // 2.5. サイクルG（クロス ask の既存バグ修正）: クロスユーザー ask に限り、
  // (a) 宛先 Agent が 'cross-ask-isolation' capability を申告しているか、
  // (b) 読み取り専用を権限で強制できる実効 AI か（devin/gemini/claude+terminalMode は不可）
  // を Session 作成より前に検証する。許可されれば Agent へ送る statePolicy（'isolated' か
  // undefined）が決まる。DEVRELAY_CROSS_ASK_ISOLATION=0 なら常に許可（旧挙動）。
  const availableAiTools = isCrossUser ? getAgentAvailableAiTools(targetProject.machine.id) : [];
  const resolvedAiTool = isCrossUser
    ? pickAvailableAiTool(targetProject.defaultAi as AiTool, availableAiTools, [])
    : (targetProject.defaultAi as AiTool);
  const readOnlyEnforced = decideAskReadOnlyEnforcement({ aiTool: resolvedAiTool, terminalMode: targetProject.terminalMode }).readOnlyEnforced;
  let crossAskStatePolicy: 'isolated' | 'resumable-scoped' | undefined;
  {
    const isolation = decideCrossAskIsolation({
      isCrossUser,
      isolationEnabled: isCrossAskIsolationEnabled(process.env.DEVRELAY_CROSS_ASK_ISOLATION),
      agentHasIsolationCapability: agentHasCapability(targetProject.machine.id, 'cross-ask-isolation'),
      // サイクルS1（2026-11-12）: プランモードの Bash ゲートを PreToolUse フックで実装済みの
      // Agent（linux/macos）かを見る。未申告（旧 Agent・windows）は fail-closed で断る。
      // DEVRELAY_PLAN_GATE_CAPABILITY=0 なら常に true（このチェックだけの緊急ロールバック）。
      agentHasPlanGateCapability: !isPlanGateCapabilityCheckEnabled(process.env.DEVRELAY_PLAN_GATE_CAPABILITY)
        || agentHasCapability(targetProject.machine.id, 'plan-gate-hook'),
      readOnlyEnforced,
    });
    if (!isolation.allowed) {
      console.log(buildCrossAskIsolationDenyLog({ requesterUserId, targetProjectName: targetProject.name, reason: isolation.reason }));
      if (isCrossUser) {
        recordCrossTeamAudit({
          requesterUserId, executorUserId, teamId: targetProject.crossTeam!.teamId,
          projectId: targetProject.id, mode: 'ask', action: 'denied',
          grantId: targetProject.crossTeam!.grantId, detail: { reason: isolation.reason },
        });
      }
      return {
        ok: false,
        kind: 'denied',
        reason: isolation.reason,
        message: buildCrossAskIsolationDenialMessage(isolation, targetProject.name),
      };
    }
    crossAskStatePolicy = isolation.statePolicy ?? undefined;
  }

  // サイクルC3a-1: 明示リセット（`CrossAskReset.resetAt`）の読み取り。キルスイッチ OFF
  // （既定 ON）または同一ユーザー ask では一切読まない。テーブル未作成（DB マイグレーション未適用）
  // でも既存のクロス ask を壊さないよう fail-open（読み取り失敗時は「リセットなし」として続行し、
  // 1 回だけ警告ログを出す）。
  const resetEnabled = isCrossUser && isCrossAskResetEnabled(process.env.DEVRELAY_CROSS_ASK_RESET);
  let crossAskResetAtMs: number | null = null;
  if (resetEnabled) {
    try {
      const resetRow = await prisma.crossAskReset.findUnique({
        where: { requesterUserId_projectId: { requesterUserId, projectId: targetProject.id } },
        select: { resetAt: true },
      });
      crossAskResetAtMs = resetRow?.resetAt.getTime() ?? null;
    } catch (err: unknown) {
      console.error('⚠️ CrossAskReset read failed (table not migrated yet? falling back to no-reset):', err instanceof Error ? err.message : err);
    }
  }

  // 2.7. サイクルC2: resume 昇格判定。G の isolation 判定に通った（denied されなかった）
  // クロスユーザー ask のうち、resume 対応 Agent + 読み取り専用強制可能な宛先に限り、
  // statePolicy を 'isolated' から 'resumable-scoped' へ昇格させ、決定論的な agentScopeId
  // （世代付き）を割り当てる。DB 書き込みより前（世代解決は読み取りのみ）。
  let resumeAgentScopeId: string | undefined;
  let includeResumeContextPrefix = true;
  {
    const resumeEnabled = isCrossAskResumeEnabled(process.env.DEVRELAY_CROSS_ASK_RESUME);
    const isolationEnabled = isCrossAskIsolationEnabled(process.env.DEVRELAY_CROSS_ASK_ISOLATION);
    const agentSupportsResume = isCrossUser && agentHasCapability(targetProject.machine.id, 'cross-ask-resume-strict');

    let latestGeneration: number | null = null;
    let currentGenerationTurns = 0;
    let lastTurnAtMs: number | null = null;
    let scopeIdBase = '';

    if (isCrossUser && resumeEnabled) {
      scopeIdBase = buildCrossAskScopeIdBase(
        crypto.createHash('sha256').update(`${requesterUserId}\0${targetProject.id}`).digest('hex'),
      );
      // 世代解決: 既存の agentScopeId 群から最大世代を取る。Session 行は起動時スイープで
      // status が 'ended' に変わるだけで削除されないため、status を見ない本クエリの結果は
      // 単調増加のみ（巻き戻らない）。projectId を条件に含めるのは既存 index
      // （@@index([projectId, status, lastActiveAt])）を効かせるため（agentScopeId/
      // requestedByUserId には index が無く、プレフィックス一致のみでは全件スキャンになる）。
      // `take` は時間が経つほど増える旧世代分までは見る必要が無い（新しい世代ほど startedAt が
      // 必ず大きいため desc 先頭から読めば最新世代が先に出る）ための安全上限。
      const rows = await prisma.session.findMany({
        where: { projectId: targetProject.id, agentScopeId: { startsWith: `${scopeIdBase}-g` } },
        select: { agentScopeId: true, startedAt: true },
        orderBy: { startedAt: 'desc' },
        take: 1000,
      });
      for (const row of rows) {
        const gen = parseCrossAskScopeGeneration(row.agentScopeId ?? '', scopeIdBase);
        if (gen === null) continue;
        if (latestGeneration === null || gen > latestGeneration) {
          latestGeneration = gen;
          currentGenerationTurns = 0;
          lastTurnAtMs = row.startedAt.getTime();
        }
        if (gen === latestGeneration) {
          currentGenerationTurns += 1;
        }
      }
    }

    const resetRequested = resetEnabled && decideCrossAskResetRequested(crossAskResetAtMs, lastTurnAtMs);
    const plan = decideCrossAskSessionPlan({
      resumeEnabled,
      isolationEnabled,
      isCrossUser,
      agentSupportsResume,
      readOnlyEnforced,
      isolationStatePolicy: crossAskStatePolicy === 'isolated' ? 'isolated' : null,
      scopeIdBase,
      latestGeneration,
      currentGenerationTurns,
      lastTurnAgeMs: lastTurnAtMs !== null ? Date.now() - lastTurnAtMs : null,
      ttlMs: resolveCrossAskResumeTtlMs(process.env.DEVRELAY_CROSS_ASK_RESUME_TTL_DAYS),
      maxTurns: resolveCrossAskResumeMaxTurns(process.env.DEVRELAY_CROSS_ASK_RESUME_MAX_TURNS),
      resetRequested,
    });
    console.log(buildCrossAskResumeLog(plan, targetProject.name));
    crossAskStatePolicy = plan.statePolicy;
    resumeAgentScopeId = plan.agentScopeId;
    includeResumeContextPrefix = plan.includeContextPrefix;

    // サイクルC3a-1: 世代が +1 された（旧世代が存在した上で新世代に切り替わった）ときだけ、
    // 旧世代 1 件を対象に後片付けを fire-and-forget で送る（ask 本体は待たせない）。
    if (plan.mode === 'resumableFresh' && latestGeneration !== null) {
      const oldScopeId = buildCrossAskScopeId(scopeIdBase, latestGeneration);
      const ttlExceeded = resolveCrossAskResumeTtlMs(process.env.DEVRELAY_CROSS_ASK_RESUME_TTL_DAYS) > 0
        && lastTurnAtMs !== null && (Date.now() - lastTurnAtMs) > resolveCrossAskResumeTtlMs(process.env.DEVRELAY_CROSS_ASK_RESUME_TTL_DAYS);
      const turnsExceeded = resolveCrossAskResumeMaxTurns(process.env.DEVRELAY_CROSS_ASK_RESUME_MAX_TURNS) > 0
        && currentGenerationTurns >= resolveCrossAskResumeMaxTurns(process.env.DEVRELAY_CROSS_ASK_RESUME_MAX_TURNS);
      purgeCrossAskScopes({
        machineId: targetProject.machine.id,
        projectPath: targetProject.path,
        scopeIds: [oldScopeId],
        trigger: resetRequested ? 'manual' : ttlExceeded ? 'ttl' : turnsExceeded ? 'maxTurns' : 'manual',
        requesterUserId,
        executorUserId,
        teamId: targetProject.crossTeam?.teamId,
        projectId: targetProject.id,
        grantId: targetProject.crossTeam?.grantId,
      }).catch((err: unknown) => {
        console.error('🧹 purgeCrossAskScopes (generation rollover) failed:', err instanceof Error ? err.message : err);
      });
    }
  }

  // 3. 一時セッション作成（userId は宛先マシン所有者。requestedByUserId はクロス時のみ記録する）
  const tempSessionId = `crossquery_${crypto.randomUUID()}`;
  await prisma.session.create({
    data: {
      id: tempSessionId,
      userId: executorUserId,
      machineId: targetProject.machine.id,
      projectId: targetProject.id,
      aiTool: targetProject.defaultAi,
      status: 'active',
      lastActiveAt: new Date(),
      ...(isCrossUser ? { requestedByUserId: requesterUserId } : {}),
      ...(resumeAgentScopeId ? { agentScopeId: resumeAgentScopeId } : {}),
    },
  });
  if (isCrossUser) {
    recordCrossTeamAudit({
      requesterUserId, executorUserId, teamId: targetProject.crossTeam!.teamId,
      projectId: targetProject.id, sessionId: tempSessionId, mode: 'ask', action: 'request',
      grantId: targetProject.crossTeam!.grantId,
    });
  }

  // 4. ユーザーの質問を DB に保存（Conversations ページ / クロス履歴 API で表示するため）
  // #335: content は raw text を無切り詰めで保存し、humanTextMeta で監査メタのみ記録する
  const { count: askNeutralizedCount } = neutralizeHumanInputTag(question);
  const askHumanTextMeta = buildHumanTextMeta({
    kind: 'ask',
    rawLength: askLengthCheck.rawLength,
    limit: ASK_QUESTION_MAX_LENGTH,
    neutralized: askNeutralizedCount,
    rawRef: 'message.content',
  });
  await prisma.message.create({
    data: {
      sessionId: tempSessionId,
      role: 'user',
      content: question,
      platform,
      sourceProjectName: sourceProjectName ?? undefined,
      humanTextMeta: askHumanTextMeta,
    },
  });

  try {
    // 5. 文脈前置（案 B）: 同一 (依頼者, プロジェクト) の過去ログから直近 3 往復を取り、
    // fence の外側に「これまでのやりとり（参考）」として前置する。Agent 改修ゼロ・配布不要。
    const contextEnabled = (input.includeContextPrefix ?? isCrossTeamChatContextEnabled(process.env.DEVRELAY_CROSS_TEAM_CHAT_CONTEXT)) && includeResumeContextPrefix;
    let contextPrefix = '';
    if (contextEnabled && isCrossUser) {
      const pastMessages = await prisma.message.findMany({
        where: {
          session: {
            projectId: targetProject.id,
            requestedByUserId: requesterUserId,
            ...buildCrossAskSessionIdFilter(),
          },
          // サイクルC3a-1: 明示リセット以前のメッセージは前置に含めない（旧 Agent・gemini/devin・
          // RESUME=0 では案B前置が唯一の記憶のため、ここを切らないと「リセットしたのに
          // 前の話を覚えている」になる）。resetEnabled=false（キルスイッチ OFF）なら
          // crossAskResetAtMs は常に null なので、この条件自体が付かず挙動は完全に不変。
          ...(crossAskResetAtMs !== null ? { createdAt: { gt: new Date(crossAskResetAtMs) } } : {}),
        },
        orderBy: { createdAt: 'asc' },
        select: { role: true, content: true },
      });
      const normalized: CrossAskHistoryMessage[] = pastMessages.map((m) => ({
        role: m.role,
        // 過去の AI 出力を再入力する経路になるため無害化を適用する
        content: neutralizeHumanInputTag(m.content).text,
      }));
      contextPrefix = buildCrossAskContextPrefix(normalized);
    }

    const promptBody = fenceIfHuman('ask', question, 'human');
    const fullPrompt = contextPrefix ? `${contextPrefix}\n\n${promptBody}` : promptBody;

    // 6. userId は executorUserId を渡す（モデル/言語/API キー解決を宛先マシン所有者の文脈で行う）。
    // タイムアウトを明示（既定 12 時間のままだと WebUI では永久に無反応になる）。
    const result = await executeCrossProjectQuery(
      targetProject.machine.id,
      tempSessionId,
      targetProject.name,
      targetProject.path,
      targetProject.defaultAi as AiTool,
      fullPrompt,
      executorUserId,
      ASK_ANSWER_TIMEOUT_MS,
      crossAskStatePolicy,
      resumeAgentScopeId,
    );

    await prisma.session.update({
      where: { id: tempSessionId },
      data: { status: 'ended', endedAt: new Date() },
    });

    if (isCrossUser) {
      recordCrossTeamAudit({
        requesterUserId, executorUserId, teamId: targetProject.crossTeam!.teamId,
        projectId: targetProject.id, sessionId: tempSessionId, mode: 'ask', action: 'completed',
        grantId: targetProject.crossTeam!.grantId,
      });
    }

    return { ok: true, output: result.output, sessionId: tempSessionId };
  } catch (error: any) {
    await prisma.session.update({
      where: { id: tempSessionId },
      data: { status: 'ended', endedAt: new Date() },
    }).catch(() => {});

    if (isCrossUser) {
      recordCrossTeamAudit({
        requesterUserId, executorUserId, teamId: targetProject.crossTeam!.teamId,
        projectId: targetProject.id, sessionId: tempSessionId, mode: 'ask', action: 'failed',
        grantId: targetProject.crossTeam!.grantId, detail: { message: error?.message },
      });
    }

    return { ok: false, kind: 'failed', message: error?.message ?? String(error), sessionId: tempSessionId };
  }
}
