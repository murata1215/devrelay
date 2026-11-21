/**
 * サイクルG（クロス ask の既存バグ修正）: クロスユーザー ask（別ユーザーのプロジェクトへの質問）
 * に限って適用する隔離判定を外部 import ゼロの純関数として切り出したモジュール
 * （`ask-guard.ts` / `cross-query-guard.ts` / `cross-team-guard.ts` と同じ流儀）。
 *
 * 判定の芯（4 条件 AND、既定は許可——同一ユーザー ask とキルスイッチ OFF は常に通す）:
 * 1. `isCrossUser`（クロスユーザー ask か）が false なら無条件で許可（`statePolicy` は送らない）。
 *    同一ユーザーの ask-member / teamexec-member / MCP `ask_project` の既存の使い方
 *    （成果物添付・storageContext・Codex/Devin 会話継続）を一切変えないため。
 * 2. `isolationEnabled`（`DEVRELAY_CROSS_ASK_ISOLATION`）が false なら無条件で許可
 *    （キルスイッチ OFF ＝旧挙動に戻す）。
 * 3. クロスユーザー ask かつキルスイッチ ON のときのみ、以下 3 点を順に検証する:
 *    a. 宛先 Agent が `'cross-ask-isolation'` capability を申告しているか
 *       （申告していない旧 Agent は `statePolicy: 'isolated'` を解釈できず legacy 扱いに
 *       縮退してしまうため、サーバー側で明示的に断る＝ fail-closed）。
 *    b. サイクルS1（2026-11-12）: 宛先 Agent が `'plan-gate-hook'` capability を申告しているか
 *       （申告していない旧 Agent はプランモードの Bash ゲートが SDK 0.3 系の auto-mode classifier
 *       に乗っ取られたまま＝「読み取り専用のはずの質問ターン」で実際には書き込み・外部送信が
 *       可能な状態。cross-ask-isolation と同じ fail-closed 方針で断る）。
 *    c. 読み取り専用を権限で強制できる実効 AI か（`ask-guard.ts` の
 *       `decideAskReadOnlyEnforcement()` の結果を呼び出し側が渡す。devin/gemini/
 *       claude+terminalMode は false になる）。
 */

/** 判定に必要な入力。`readOnlyEnforced` は `ask-guard.ts` の `decideAskReadOnlyEnforcement()` の結果を渡す。 */
export interface DecideCrossAskIsolationInput {
  /** クロスユーザー ask か（`targetProject.crossTeam` の有無、既存の `isCrossUser` と同じ判定） */
  isCrossUser: boolean;
  /** `isCrossAskIsolationEnabled(process.env.DEVRELAY_CROSS_ASK_ISOLATION)` の結果 */
  isolationEnabled: boolean;
  /** `agentHasCapability(machineId, 'cross-ask-isolation')` の結果 */
  agentHasIsolationCapability: boolean;
  /**
   * サイクルS1（2026-11-12）: `agentHasCapability(machineId, 'plan-gate-hook')` の結果。
   * 未申告（旧 Agent または `agents/windows`）なら `agentHasIsolationCapability` と同じ
   * `reason:'agent_outdated'` で断る（プランモードの Bash ゲートが機能していない宛先へ
   * クロスユーザー ask を通さないため）。
   */
  agentHasPlanGateCapability: boolean;
  /** `decideAskReadOnlyEnforcement({ aiTool, terminalMode }).readOnlyEnforced`（ask-guard.ts） */
  readOnlyEnforced: boolean;
}

export type CrossAskIsolationDecision =
  | { allowed: true; statePolicy: 'isolated' | null }
  | { allowed: false; reason: 'agent_outdated' }
  | { allowed: false; reason: 'ai_unsafe' };

/**
 * クロスユーザー ask を実行してよいか、実行する場合は Agent へ送る `statePolicy` を決定する。
 * 既定は許可（`statePolicy: null` ＝従来どおり送らない）。許可は明示的に 1 段ずつ、
 * 拒否理由は最初に当たった条件（capability 不足を先に見る。isolation → plan-gate-hook → AI 安全性）。
 */
export function decideCrossAskIsolation(input: DecideCrossAskIsolationInput): CrossAskIsolationDecision {
  if (!input.isCrossUser) return { allowed: true, statePolicy: null };
  if (!input.isolationEnabled) return { allowed: true, statePolicy: null };
  if (!input.agentHasIsolationCapability) return { allowed: false, reason: 'agent_outdated' };
  if (!input.agentHasPlanGateCapability) return { allowed: false, reason: 'agent_outdated' };
  if (!input.readOnlyEnforced) return { allowed: false, reason: 'ai_unsafe' };
  return { allowed: true, statePolicy: 'isolated' };
}

/**
 * 依頼者向けの拒否メッセージを組み立てる（`cross-query-guard.ts` の
 * `buildCrossTargetRejectionMessage()` と同じ流儀。`decision.allowed` が true の場合は呼び出し側の
 * 誤用のため throw する）。
 */
export function buildCrossAskIsolationDenialMessage(
  decision: CrossAskIsolationDecision,
  targetProjectName: string,
): string {
  if (decision.allowed) {
    throw new Error('buildCrossAskIsolationDenialMessage: decision must be a rejection (allowed=false)');
  }
  if (decision.reason === 'agent_outdated') {
    return `❌ '${targetProjectName}' への質問を送れません: 相手側の Agent が古く、クロスユーザーの質問に安全に対応できません。相手側に Agent の更新（u）を依頼してください。`;
  }
  return `❌ '${targetProjectName}' への質問を送れません: 宛先プロジェクトが使用する AI では、クロスユーザーの質問に対して読み取り専用を保証できません。プロジェクトの所有者に直接確認してください。`;
}

/** サーバーログ用の 1 行ラベル（`cross-team-guard.ts` の `buildCrossTeamDenyLog()` と同じ流儀）。 */
export function buildCrossAskIsolationDenyLog(input: {
  requesterUserId: string;
  targetProjectName: string;
  reason: 'agent_outdated' | 'ai_unsafe';
}): string {
  return `🚫 Cross-ask isolation denied (${input.reason}): ${input.requesterUserId} → ${input.targetProjectName}`;
}
