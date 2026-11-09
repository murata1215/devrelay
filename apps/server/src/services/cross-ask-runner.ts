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
import { executeCrossProjectQuery } from './agent-manager.js';
import {
  validateHumanTextLength,
  neutralizeHumanInputTag,
  buildHumanTextMeta,
  fenceIfHuman,
} from './human-text-fence.js';
import { ASK_QUESTION_MAX_LENGTH, ASK_ANSWER_TIMEOUT_MS } from './ask-guard.js';
import { recordCrossTeamAudit } from './cross-team-audit.js';
import { findInflightCrossQueryRows } from './cross-session-stats.js';
import {
  pickInflightCrossSession,
  decideCrossTarget,
  buildCrossTargetRejectionMessage,
  ASK_INFLIGHT_WINDOW_MS,
} from './cross-query-guard.js';
import { buildCrossAskContextPrefix, type CrossAskHistoryMessage } from './cross-ask-rules.js';
import { isCrossTeamChatContextEnabled } from './cross-team-guard.js';
import { buildCrossAskSessionIdFilter } from './thread-scope.js';

/** `runCrossProjectAsk()` が受け取る宛先プロジェクト（チャット経路・WebUI 経路のどちらの解決結果も代入可能な最小形）。 */
export interface CrossAskTargetProject {
  id: string;
  name: string;
  path: string;
  defaultAi: string;
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
  | { ok: false; kind: 'failed'; message: string; sessionId: string };

/**
 * クロスプロジェクト ask を実行する。
 *
 * 呼び出し順（この順序を変えないこと）:
 * 1. 長さ検証（#335 ゲート⑤。いかなる DB 書き込みより前）
 * 2. 同時実行ガード（宛先プロジェクトに実行中の `crossquery_` があれば targetBusy で即返す。
 *    DB 書き込みより前に行う — セッション作成後に弾くと ended セッションのゴミが残るため）
 * 3. 一時セッション（`crossquery_<uuid>`）作成 + audit `request`
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
    const contextEnabled = input.includeContextPrefix ?? isCrossTeamChatContextEnabled(process.env.DEVRELAY_CROSS_TEAM_CHAT_CONTEXT);
    let contextPrefix = '';
    if (contextEnabled && isCrossUser) {
      const pastMessages = await prisma.message.findMany({
        where: {
          session: {
            projectId: targetProject.id,
            requestedByUserId: requesterUserId,
            ...buildCrossAskSessionIdFilter(),
          },
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
