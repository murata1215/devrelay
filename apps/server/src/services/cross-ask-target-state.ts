/**
 * サイクルC3a-1: `GET /api/cross-team/ask-targets` が返す `memory` フィールド
 * （askable/remembers/turns）の解決を 1 本化する純関数群。
 *
 * 外部 import は同ディレクトリの `cross-ask-isolation-rules.js` / `cross-ask-resume-rules.js`
 * のみ（`thread-clear-guard.ts` が `thread-scope.js` だけを import する流儀と同じ。
 * どちらも DB・env を一切見ない外部 import ゼロの純関数モジュールのため、本ファイルも
 * 間接的に「DB・env を見ない」を保つ）。既存の isolation（G）/ resume（C2）判定を
 * **複製せず呼ぶだけ**にすることで、runner と API の判定がずれないようにする
 * （`cross-ask-resume-plan.md` の「二重実装を作らない」方針）。
 *
 * ターン前（候補一覧の表示時点）に DB だけで評価できる「見込み」であり、実際にそのターンで
 * resume が成立するか（宛先 Agent が resume に失敗して案B 前置に落ちる等）までは保証しない
 * （devlog の残課題に明記する）。
 */

import { decideCrossAskIsolation, type CrossAskIsolationDecision } from './cross-ask-isolation-rules.js';
import { decideCrossAskSessionPlan, buildCrossAskScopeIdBase, parseCrossAskScopeGeneration } from './cross-ask-resume-rules.js';

/** `decideCrossAskTargetMemoryState` の入力（`cross-ask-runner.ts` の 2.5〜2.7 と同じ入力）。 */
export interface DecideCrossAskTargetMemoryStateInput {
  /** `isCrossAskIsolationEnabled(process.env.DEVRELAY_CROSS_ASK_ISOLATION)` の結果 */
  isolationEnabled: boolean;
  /** `isCrossAskResumeEnabled(process.env.DEVRELAY_CROSS_ASK_RESUME)` の結果 */
  resumeEnabled: boolean;
  /** `agentHasCapability(machineId, 'cross-ask-isolation')` の結果 */
  agentHasIsolationCapability: boolean;
  /** サイクルS1（2026-11-12）: `agentHasCapability(machineId, 'plan-gate-hook')` の結果 */
  agentHasPlanGateCapability: boolean;
  /** `agentHasCapability(machineId, 'cross-ask-resume-strict')` の結果 */
  agentHasResumeCapability: boolean;
  /** `decideAskReadOnlyEnforcement({ aiTool, terminalMode }).readOnlyEnforced` */
  readOnlyEnforced: boolean;
}

export type CrossAskMemoryReason = 'featureOff' | 'isolationOff' | 'agentOutdated' | 'aiUnsafe';

export interface CrossAskTargetMemoryState {
  /** false = 質問自体が G の隔離判定で断られる見込み（`decideCrossAskIsolation` と同じ判定） */
  askable: boolean;
  askDenyReason?: 'agent_outdated' | 'ai_unsafe';
  /** true = resume が効く見込み（宛先が覚えている） */
  remembers: boolean;
  reason?: CrossAskMemoryReason;
}

/**
 * ダミーの scope digest（`decideCrossAskSessionPlan` は DB に依存する世代情報を
 * 一切見ない分岐（featureOff/isolationOff/agentOutdated/aiUnsafe/resumableFresh）でしか
 * 使わないため、どの値でも結果に影響しない。実際の scope id 計算には使わない）。
 */
const DUMMY_SCOPE_DIGEST = '0'.repeat(64);

/**
 * クロス ask 候補 1 件について、`askable`（質問自体が断られないか）と `remembers`
 * （resume が効く見込み）を判定する。
 *
 * - `askable` は `decideCrossAskIsolation()` をそのまま呼ぶ（G の判定と完全に同じ）。
 * - `remembers` は `decideCrossAskSessionPlan()` を DB 依存部分だけダミー値で呼び、
 *   戻り値の `mode` が `'contextPrefix'` かどうかだけを見る。TTL/上限ターン超過は
 *   `'resumable'`/`'resumableFresh'` のどちらに倒れても remembers=true という結果は
 *   変わらないため、ダミー値（latestGeneration:null 等）を渡しても結果は狂わない
 *   （実際の世代・ターン数の表示は `countLatestGenerationTurns()` で別途解決する）。
 */
export function decideCrossAskTargetMemoryState(
  input: DecideCrossAskTargetMemoryStateInput,
): CrossAskTargetMemoryState {
  const isolation: CrossAskIsolationDecision = decideCrossAskIsolation({
    isCrossUser: true,
    isolationEnabled: input.isolationEnabled,
    agentHasIsolationCapability: input.agentHasIsolationCapability,
    agentHasPlanGateCapability: input.agentHasPlanGateCapability,
    readOnlyEnforced: input.readOnlyEnforced,
  });

  // askable=false（G が断る）のときは、実際の runner.ts でも isolation 判定（2.5）が resume 判定
  // （2.7）より前で早期 return するため、resume 判定は構造的に到達しない。この関数でも
  // decideCrossAskSessionPlan を呼ばずに remembers=false を確定する（isolation の拒否理由を
  // そのまま remembers の reason にマッピングする。'agent_outdated'→'agentOutdated',
  // 'ai_unsafe'→'aiUnsafe' で語彙が一致する）。
  if (!isolation.allowed) {
    const reason: CrossAskMemoryReason = isolation.reason === 'agent_outdated' ? 'agentOutdated' : 'aiUnsafe';
    return { askable: false, askDenyReason: isolation.reason, remembers: false, reason };
  }

  const plan = decideCrossAskSessionPlan({
    resumeEnabled: input.resumeEnabled,
    isolationEnabled: input.isolationEnabled,
    isCrossUser: true,
    agentSupportsResume: input.agentHasResumeCapability,
    readOnlyEnforced: input.readOnlyEnforced,
    isolationStatePolicy: isolation.statePolicy,
    scopeIdBase: buildCrossAskScopeIdBase(DUMMY_SCOPE_DIGEST),
    latestGeneration: null,
    currentGenerationTurns: 0,
    lastTurnAgeMs: null,
    ttlMs: 0,
    maxTurns: 0,
    resetRequested: false,
  });

  const remembers = plan.mode !== 'contextPrefix';
  // 'notCrossUser' はここでは構造的に起きない（isCrossUser:true 固定）が、型の完全性のため
  // CrossAskMemoryReason に含まれない値はそのまま undefined に落とす。
  const reason: CrossAskMemoryReason | undefined =
    plan.mode === 'contextPrefix' && plan.reason !== 'notCrossUser' ? plan.reason : undefined;

  return { askable: true, remembers, reason };
}

/** `countLatestGenerationTurns` が受け取る 1 行（projectId ごとに 1 クエリで取得した Session 行）。 */
export interface CrossAskSessionScopeRow {
  agentScopeId: string | null;
}

export interface CrossAskGenerationStats {
  /** 最新世代番号（対象の scope id を持つ Session 行が 1 件も無ければ null） */
  latestGeneration: number | null;
  /** 最新世代の往復数（Session 行数） */
  turns: number;
}

/**
 * 1 プロジェクト分の `agentScopeId` 群（`scopeIdBase` 配下のみ）から最新世代と往復数を集計する。
 * 表示専用の集計のため、`cross-ask-runner.ts` の世代解決ループと異なり開始時刻の順序は見ない
 * （世代番号の大小だけで「最新」を決める。世代は単調増加のみなので十分）。
 */
export function countLatestGenerationTurns(
  rows: CrossAskSessionScopeRow[],
  scopeIdBase: string,
): CrossAskGenerationStats {
  let latestGeneration: number | null = null;
  let turns = 0;
  for (const row of rows) {
    const gen = parseCrossAskScopeGeneration(row.agentScopeId ?? '', scopeIdBase);
    if (gen === null) continue;
    if (latestGeneration === null || gen > latestGeneration) {
      latestGeneration = gen;
      turns = 0;
    }
    if (gen === latestGeneration) {
      turns += 1;
    }
  }
  return { latestGeneration, turns };
}
