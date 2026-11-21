/**
 * サイクルC2: クロス ask のセッション継続（resume）のサーバー側判定を外部 import ゼロの
 * 純関数として切り出したモジュール（`cross-ask-isolation-rules.ts` / `cross-query-guard.ts` /
 * `ask-guard.ts` と同じ流儀）。
 *
 * 設計の芯:
 * - resume を許可してよいかの判定は、G の `decideCrossAskIsolation()` の**出力**
 *   （`DEVRELAY_CROSS_ASK_ISOLATION` キルスイッチの値）ではなく、その判定が使っている
 *   **入力**（読み取り専用を権限で強制できる実効 AI か、対応 Agent か）を直接受け取って
 *   独立に判定する。ただし `isolationEnabled` が false（G の緊急ロールバック）のときは
 *   resume も意図的に止める——「クロス ask を G 以前の挙動へ戻す」スイッチを ON にしたのに
 *   resume だけ中途半端に残る状態を作らないため（本ファイル内の 1 行として明示し、
 *   偶然の連動ではなくテストで固定する）。
 * - scope id は決定論的（`sha256(requesterUserId + '\0' + projectId)` の先頭 32 桁 + 世代）。
 *   DB に永続化された `crossquery_` Session 行から世代を解決するため、Agent 側は
 *   一切の状態を持たずに同じ scope を再現できる。
 * - 世代は **単調増加のみ**（巻き戻らない）。`Session` 行は `teamexec_`/`crossquery_` を
 *   `status:'ended'` に変える起動時スイープ（`index.ts`）の対象だが、**削除はされない**
 *   （`deleteMany` は `ChannelSession` のみが対象。`Session` 本体の削除経路は存在しない）。
 *   世代解決クエリは `status` を一切見ず、既存の `agentScopeId` 値から最大世代を取るだけなので、
 *   起動時スイープの前後で世代が巻き戻ることは構造的に起きない。
 * - resumable のとき、案B（直近 3 往復の前置）と resume（scope dir 内の会話継続）が
 *   同時に効くことは型で禁止する（`mode:'resumable'` は `includeContextPrefix:false` の
 *   リテラルしか取れない）。世代が新しくなった初回ターンだけ（scope dir が構造的に空のため）
 *   `mode:'resumableFresh'` で前置を 1 回だけ許可する。
 */

/** `isValidAgentScopeId`（agents/*\/scope-dir.ts）と同じ正規表現。本モジュールも重複定義する
 *  （「外部 import ゼロ」規約を維持するため。1 行の正規表現なので重複コストは小さい）。 */
const AGENT_SCOPE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * scope id のプレフィックス（既存の `crossquery_`（アンダースコア）ピンとは意図的に別記号系＝ハイフン）。
 * サイクルC3a-1: `GET /api/cross-team/ask-targets` が「どの projectId 配下の Session 行が
 * クロス ask の scope を持つか」を 1 クエリで絞り込むために export する（base 突合は呼び出し側で行う）。
 */
export const CROSS_ASK_SCOPE_ID_PREFIX = 'crossask-';
const SCOPE_ID_PREFIX = CROSS_ASK_SCOPE_ID_PREFIX;

/**
 * digest（呼び出し側が `sha256(requesterUserId + '\0' + projectId)` で計算した16進文字列）から
 * scope id のベース部分を組み立てる。digest の先頭32桁だけを使う（`AGENT_SCOPE_ID_PATTERN` の
 * 上限128桁に対して十分な長さを確保しつつ、世代サフィックスの分の余裕を残すため）。
 */
export function buildCrossAskScopeIdBase(digestHex: string): string {
  return `${SCOPE_ID_PREFIX}${digestHex.slice(0, 32)}`;
}

/** scope id のベース部分と世代番号から完全な scope id を組み立てる。 */
export function buildCrossAskScopeId(base: string, generation: number): string {
  return `${base}-g${generation}`;
}

/**
 * 完全な scope id から世代番号を取り出す。`base` に一致しない・形式が不正な場合は null。
 * （世代解決クエリで DB から取得した既存の `agentScopeId` 群を走査するときに使う）
 */
export function parseCrossAskScopeGeneration(scopeId: string, base: string): number | null {
  const prefix = `${base}-g`;
  if (!scopeId.startsWith(prefix)) return null;
  const rest = scopeId.slice(prefix.length);
  if (!/^[0-9]+$/.test(rest)) return null;
  const n = Number(rest);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

/** `DEVRELAY_CROSS_ASK_RESUME_TTL_DAYS` のパース（既定 14 日、`0` で無効、clamp 1〜365 日）。
 *  戻り値はミリ秒。`0` を返す場合のみ「無効（TTL チェックをしない）」を意味する。 */
export function resolveCrossAskResumeTtlMs(raw: string | undefined): number {
  const DAY_MS = 24 * 60 * 60 * 1000;
  if (raw === '0') return 0;
  const n = raw === undefined ? 14 : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 14 * DAY_MS;
  const clamped = Math.min(365, Math.max(1, Math.floor(n)));
  return clamped * DAY_MS;
}

/** `DEVRELAY_CROSS_ASK_RESUME_MAX_TURNS` のパース（既定 40、`0` で無効、clamp 2〜500）。 */
export function resolveCrossAskResumeMaxTurns(raw: string | undefined): number {
  if (raw === '0') return 0;
  const n = raw === undefined ? 40 : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 40;
  return Math.min(500, Math.max(2, Math.floor(n)));
}

/**
 * サイクルC3a-1: `decideCrossAskSessionPlan` に渡す `resetRequested` を算出する。
 * 「明示リセット（`CrossAskReset.resetAt`）が現世代の最終ターンより新しいか」だけを見る
 * 純関数（ミリ秒の number で比較。呼び出し側が Date → number への変換を行う）。
 *
 * - `resetAtMs` が null（リセット行が無い、または対象外）→ 常に false
 * - `lastTurnAtMs` が null（新規ペア、まだ世代が無い）→ リセット行があれば true
 *   （次に見る `noExistingGeneration` と結果的に同じ分岐へ合流するが、意味としては
 *   「リセットされているので新規に作る」を明示するため独立した入力として扱う）
 * - それ以外は `resetAtMs > lastTurnAtMs` のときのみ true
 */
export function decideCrossAskResetRequested(resetAtMs: number | null, lastTurnAtMs: number | null): boolean {
  if (resetAtMs === null) return false;
  if (lastTurnAtMs === null) return true;
  return resetAtMs > lastTurnAtMs;
}

/** `decideCrossAskSessionPlan` の入力。 */
export interface DecideCrossAskSessionPlanInput {
  /** `isCrossAskResumeEnabled(process.env.DEVRELAY_CROSS_ASK_RESUME)` の結果 */
  resumeEnabled: boolean;
  /** `isCrossAskIsolationEnabled(process.env.DEVRELAY_CROSS_ASK_ISOLATION)` の結果。
   *  false（G の緊急ロールバック）のときは resume も意図的に止める。 */
  isolationEnabled: boolean;
  /** `targetProject.crossTeam` の有無と同じ判定（同一ユーザー ask は resume 対象外） */
  isCrossUser: boolean;
  /** `agentHasCapability(machineId, 'cross-ask-resume-strict')` の結果 */
  agentSupportsResume: boolean;
  /** `decideAskReadOnlyEnforcement({ aiTool, terminalMode }).readOnlyEnforced`（ask-guard.ts） */
  readOnlyEnforced: boolean;
  /** G の判定結果（`decideCrossAskIsolation()` の `statePolicy`）。resume しない場合そのまま返す。 */
  isolationStatePolicy: 'isolated' | null;
  /** `buildCrossAskScopeIdBase(sha256(requesterUserId + '\0' + projectId))` */
  scopeIdBase: string;
  /** 既存 Session 行から解決した最新世代（無ければ null＝新規ペア） */
  latestGeneration: number | null;
  /** 最新世代の中で消費済みのターン数（Session 行数） */
  currentGenerationTurns: number;
  /** 最新世代の最終ターンからの経過ミリ秒（無ければ null） */
  lastTurnAgeMs: number | null;
  /** `resolveCrossAskResumeTtlMs()` の結果（0 = 無効） */
  ttlMs: number;
  /** `resolveCrossAskResumeMaxTurns()` の結果（0 = 無効） */
  maxTurns: number;
  /**
   * サイクルC3a-1: `CrossAskReset.resetAt` が現世代の最終ターンより新しい（= 明示リセットが
   * 最後のターンより後に起きた）かどうか。呼び出し側が
   * `resetAt !== null && (lastTurnAt === null || resetAt > lastTurnAt)` で算出して渡す。
   * true のとき TTL・上限ターンと同じ扱いで強制的に世代を +1 する
   * （`resumable` に落ちることは絶対にない——リセットしたのに前の世代を継続する事故を防ぐ）。
   */
  resetRequested: boolean;
}

export type CrossAskSessionPlan =
  | { mode: 'resumable'; agentScopeId: string; statePolicy: 'resumable-scoped'; includeContextPrefix: false }
  | { mode: 'resumableFresh'; agentScopeId: string; statePolicy: 'resumable-scoped'; includeContextPrefix: true }
  | {
      mode: 'contextPrefix';
      agentScopeId: undefined;
      statePolicy: 'isolated' | undefined;
      includeContextPrefix: true;
      reason: 'featureOff' | 'isolationOff' | 'notCrossUser' | 'agentOutdated' | 'aiUnsafe';
    };

/**
 * クロス ask を resume させてよいか、resume する場合の scope id（世代）を決定する。
 *
 * 判定順（許可は明示的に 1 段ずつ、既定は非 resume）:
 * 1. `resumeEnabled`/`isolationEnabled`/`isCrossUser` のいずれかが false → 非 resume（理由付き）
 * 2. `agentSupportsResume` が false（capability 未申告の旧 Agent）→ 非 resume（`agentOutdated`）
 * 3. `readOnlyEnforced` が false（devin/gemini/claude+terminalMode）→ 非 resume（`aiUnsafe`）
 * 4. TTL 超過 or 上限ターン超過 or 既存 scope が無い → 新しい世代で `resumableFresh`
 * 5. それ以外 → 既存世代を継続する `resumable`
 */
export function decideCrossAskSessionPlan(input: DecideCrossAskSessionPlanInput): CrossAskSessionPlan {
  if (!input.resumeEnabled) {
    return { mode: 'contextPrefix', agentScopeId: undefined, statePolicy: input.isolationStatePolicy ?? undefined, includeContextPrefix: true, reason: 'featureOff' };
  }
  if (!input.isolationEnabled) {
    return { mode: 'contextPrefix', agentScopeId: undefined, statePolicy: input.isolationStatePolicy ?? undefined, includeContextPrefix: true, reason: 'isolationOff' };
  }
  if (!input.isCrossUser) {
    return { mode: 'contextPrefix', agentScopeId: undefined, statePolicy: input.isolationStatePolicy ?? undefined, includeContextPrefix: true, reason: 'notCrossUser' };
  }
  if (!input.agentSupportsResume) {
    return { mode: 'contextPrefix', agentScopeId: undefined, statePolicy: input.isolationStatePolicy ?? undefined, includeContextPrefix: true, reason: 'agentOutdated' };
  }
  if (!input.readOnlyEnforced) {
    return { mode: 'contextPrefix', agentScopeId: undefined, statePolicy: input.isolationStatePolicy ?? undefined, includeContextPrefix: true, reason: 'aiUnsafe' };
  }

  const ttlExceeded = input.ttlMs > 0 && input.lastTurnAgeMs !== null && input.lastTurnAgeMs > input.ttlMs;
  const turnsExceeded = input.maxTurns > 0 && input.currentGenerationTurns >= input.maxTurns;
  const noExistingGeneration = input.latestGeneration === null;

  if (noExistingGeneration || ttlExceeded || turnsExceeded || input.resetRequested) {
    const nextGeneration = (input.latestGeneration ?? 0) + 1;
    const agentScopeId = buildCrossAskScopeId(input.scopeIdBase, nextGeneration);
    return { mode: 'resumableFresh', agentScopeId, statePolicy: 'resumable-scoped', includeContextPrefix: true };
  }

  // この分岐に来るのは noExistingGeneration===false のときのみ＝ latestGeneration は必ず number。
  const agentScopeId = buildCrossAskScopeId(input.scopeIdBase, input.latestGeneration as number);
  return { mode: 'resumable', agentScopeId, statePolicy: 'resumable-scoped', includeContextPrefix: false };
}

/** サーバーログ用の 1 行（`buildCrossAskIsolationDenyLog()` と同じ流儀）。 */
export function buildCrossAskResumeLog(plan: CrossAskSessionPlan, targetProjectName: string): string {
  if (plan.mode === 'contextPrefix') {
    return `🧵 Cross-ask resume: mode=contextPrefix reason=${plan.reason} target=${targetProjectName}`;
  }
  return `🧵 Cross-ask resume: mode=${plan.mode} scope=${plan.agentScopeId} prefix=${plan.includeContextPrefix ? 'on' : 'off'} target=${targetProjectName}`;
}

/**
 * `AGENT_SCOPE_ID_PATTERN` を満たすかどうかの自己検証用ヘルパー（テストで使う。
 * 本モジュールが生成する scope id が常にこの正規表現を満たすことを回帰的に固定するため）。
 */
export function isValidCrossAskScopeId(scopeId: string): boolean {
  return AGENT_SCOPE_ID_PATTERN.test(scopeId);
}
