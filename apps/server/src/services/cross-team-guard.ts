/**
 * クロスユーザー Team（別ユーザーのプロジェクトを招待・承認して ask/teamexec の宛先にする機能）
 * の認可判定ロジック（Phase 1: ask のみ。Phase 2 で exec を解禁）。
 *
 * 外部 import ゼロの純関数のみで構成する（`cross-query-guard.ts` / `permission-policy.ts` /
 * `human-text-fence.ts` と同じ流儀。DB・env は一切見ない。呼び出し側の DB ラッパ
 * （`cross-team-authz.ts`）が候補行を集めてここに渡す）。
 *
 * 設計の芯（詳細は rules/project.md のクロスユーザー Team セクション参照）:
 * - 認可の根拠は「`CrossTeamGrant` が存在し `revokedAt IS NULL`」の 2 条件のみ。
 *   `CrossTeamInvite.status` は pending の持ち場でしかなく、判定には一切使わない
 *   （deny-by-default を構造的に保証するため）。
 * - 同一ユーザー経路（`targetOwnerUserId === callerUserId`）はこのモジュールの対象外。
 *   呼び出し側（`document-api.ts`）で先に分岐し、既存の Team 登録チェックへそのまま進む。
 * - 組織境界（`OrganizationId` 一致）は候補ごとではなく、呼び出し元ユーザーと
 *   宛先所有者の「実ユーザー」単位で 1 回だけ判定する（grant に刻まれた
 *   organizationId スナップショットではなく、呼び出し側が渡す「現在の」組織 ID を使う
 *   ことで、どちらかが組織を抜けた直後に即座に拒否できる）。
 * - 第三者ブリッジ禁止: 発信者がその Team 経由で宛先に到達する資格
 *   （`callerQualified`。Team オーナー本人 or 有効な grant 保持者）が無ければ、
 *   宛先側の grant がいくら有効でも通さない（A のチームに B・C が個別に同意しても、
 *   B から C へは到達できない）。
 */

/** `DEVRELAY_CROSS_TEAM` の既定値解決（既定 OFF。既存キルスイッチの多数派とは逆の方向）。 */
export function isCrossTeamEnabled(raw: string | undefined): boolean {
  return raw === '1';
}

/** `DEVRELAY_CROSS_TEAM_EXEC` の既定値解決（既定 OFF。`DEVRELAY_CROSS_TEAM` と AND）。 */
export function isCrossTeamExecEnabled(raw: string | undefined): boolean {
  return raw === '1';
}

/**
 * `DEVRELAY_CROSS_TEAM_CHAT` の既定値解決（Phase C: 購読/借用プロジェクトを Agents ツリーに
 * 出し WebUI から直接 ask する機能。既定 ON。`DEVRELAY_CROSS_TEAM` との AND で呼び出し側が
 * 判定するため、このモジュール単体では `DEVRELAY_CROSS_TEAM` を見ない）。
 */
export function isCrossTeamChatEnabled(raw: string | undefined): boolean {
  return raw !== '0';
}

/**
 * `DEVRELAY_CROSS_TEAM_CHAT_CONTEXT` の既定値解決（Phase C 案 B: クロス ask のプロンプトに
 * 直近の往復を前置して会話の継続性を持たせる機能。既定 ON。`0` で完全な 1 問 1 答に戻す）。
 */
export function isCrossTeamChatContextEnabled(raw: string | undefined): boolean {
  return raw !== '0';
}

/**
 * サイクルG（クロス ask の既存バグ修正）: `DEVRELAY_CROSS_ASK_ISOLATION` の既定値解決
 * （既定 ON=`!== '0'`。既存キルスイッチの多数派と同じ方向——新しい安全策は黙って ON）。
 *
 * `1` のとき、クロスユーザー ask（別ユーザーのプロジェクトへの質問）に対して:
 * - サーバー側: 宛先 Agent が `'cross-ask-isolation'` capability を未申告なら ask 自体を断る
 *   （Agent 側の隔離コードが無い旧 Agent を黙って通さない）。読み取り専用を権限で強制できない
 *   実効 AI（devin/gemini、または claude+terminalMode）への ask も同様に断る。
 * - Agent へは `statePolicy: 'isolated'` を送る（session-scope.ts の `resolveSessionStatePolicy()`
 *   が解釈し、所有者プロジェクトの状態を一切読み書きしない許可リストに切り替える）。
 *
 * `0` にすると、Agent の隔離コードは常に通りうる旧挙動（`statePolicy` を送らない。同一ユーザー
 * ask と見分けが付かない legacy 扱い）に戻る。同一ユーザー ask にはこのフラグは一切影響しない。
 */
export function isCrossAskIsolationEnabled(raw: string | undefined): boolean {
  return raw !== '0';
}

/**
 * サイクルC2: `DEVRELAY_CROSS_ASK_RESUME` の既定値解決（既定 **OFF**=`raw === '1'`。
 * 新しい信頼境界を黙って開けないため `DEVRELAY_CROSS_TEAM`/`DEVRELAY_CROSS_TEAM_EXEC` と
 * 同じ極性にする——`DEVRELAY_CROSS_ASK_ISOLATION` の既定 ON とは逆方向）。
 *
 * `1` のとき、クロスユーザー ask のうち (a) 宛先 Agent が `'cross-ask-resume-strict'`
 * capability を申告し (b) 読み取り専用を権限で強制できる実効 AI（`decideAskReadOnlyEnforcement()`
 * が true を返す宛先）に限り、`statePolicy:'resumable-scoped'` を送って scope dir
 * （`.devrelay/sessions/crossask-<digest>-g<N>/`）内の会話状態を継続させる
 * （`cross-ask-resume-rules.ts` の `decideCrossAskSessionPlan()` が決定）。
 * それ以外は従来どおり `statePolicy:'isolated'`（G）+ 案B 前置に縮退する。
 *
 * `isCrossAskIsolationEnabled()` が false（G の緊急ロールバック）のときは resume も
 * 意図的に止める（`decideCrossAskSessionPlan()` 側で明示的に判定する。偶然の連動ではない）。
 */
export function isCrossAskResumeEnabled(raw: string | undefined): boolean {
  return raw === '1';
}

/**
 * サイクルC3a-1: `DEVRELAY_CROSS_ASK_RESET` の既定値解決（既定 ON=`!== '0'`。
 * `DEVRELAY_CROSS_TEAM` × `DEVRELAY_CROSS_TEAM_CHAT` との AND は呼び出し側が判定する——
 * 本モジュール単体では `DEVRELAY_CROSS_TEAM`/`DEVRELAY_CROSS_TEAM_CHAT` を見ない
 * （`isCrossTeamChatEnabled()` と同じ流儀）。
 *
 * `0` のとき: 新ルート（`POST /api/cross-team/projects/:projectId/reset`）が 404、
 * `askreset` コマンドは未対応応答、`GET /api/cross-team/ask-targets` の `memory` フィールドは
 * キーごと省略（旧レスポンスと構造同一）、世代+1/明示リセット時の後片付け送信も行わない。
 */
export function isCrossAskResetEnabled(raw: string | undefined): boolean {
  return raw !== '0';
}

/** 受入側を守るクロスユーザー専用のレート閾値（5 分窓）。既存の依頼者基準の閾値とは別に加算する。 */
export const CROSS_USER_ASK_TARGET_LIMIT = 4;
export const CROSS_USER_ASK_EXECUTOR_LIMIT = 6;
export const CROSS_USER_EXEC_TARGET_LIMIT = 2;
export const CROSS_USER_EXEC_CONCURRENCY = 1;

/**
 * 認可判定に使う候補行 1 件（= ある Team 内で、宛先プロジェクトに紐づく `CrossTeamGrant`）。
 * DB ラッパ側で「同じ Team に発信マシンのプロジェクトも属する」ことまでは絞り込んだ上で渡す
 * （既存 `checkCrossTargetAllowed` の `team: { members: { some: { project: { machineId } } } }`
 * と同形のクエリ）。
 */
export interface CrossTeamCandidateGrant {
  teamId: string;
  grantId: string;
  /** grant 作成時点の宛先所有者スナップショット。現在の所有者と食い違えば無効扱いにする */
  granteeUserId: string;
  askAllowed: boolean;
  execAllowed: boolean;
  revoked: boolean;
  /**
   * 発信側の資格（第三者ブリッジ禁止の鍵）。
   * true = 発信者がその Team のオーナー本人、または同じ Team 内で
   * 有効な（revoked でない）grant の granteeUserId に一致する。
   */
  callerQualified: boolean;
}

export interface DecideCrossTeamAccessInput {
  mode: 'ask' | 'exec';
  crossTeamEnabled: boolean;
  crossTeamExecEnabled: boolean;
  /** 依頼者（machine token の持ち主）の現在の組織 ID。組織未所属は null */
  callerOrganizationId: string | null;
  /** 宛先マシン所有者の現在の組織 ID。組織未所属は null */
  targetOwnerOrganizationId: string | null;
  /** 宛先マシンの現在の所有者 userId（grant の granteeUserId スナップショットと一致するか確認する） */
  targetOwnerUserId: string;
  /** DB ラッパが集めた候補行（0 件なら「このユーザーからこの宛先への grant は存在しない」） */
  candidates: CrossTeamCandidateGrant[];
}

export type CrossTeamDenyReason =
  | 'killSwitchOff'
  | 'execKillSwitchOff'
  | 'noOrganization'
  | 'orgMismatch'
  | 'noGrant'
  | 'grantRevoked'
  | 'execNotGranted'
  | 'callerNotQualified'
  | 'granteeOwnerMismatch';

export interface CrossTeamDecision {
  allowed: boolean;
  grantId?: string;
  teamId?: string;
  /** サーバーログ専用。レスポンス本文には絶対に出さない（404 規約: 存在を漏らさない） */
  denyReason?: CrossTeamDenyReason;
}

/**
 * クロスユーザーの ask/exec を許可するかを判定する（判定順は固定。rules/project.md 参照）。
 *
 * 1. キルスイッチ（`DEVRELAY_CROSS_TEAM` / exec はさらに `DEVRELAY_CROSS_TEAM_EXEC`）
 * 2. 組織境界（どちらかが組織未所属、または組織が不一致なら即拒否）
 * 3. 候補行を順に見て、宛先所有者一致 → revoked でない → 発信側資格あり → mode フラグが
 *    立っている、を全て満たす 1 件が見つかれば許可
 * 4. 1 件も満たさなければ、最も説明的な denyReason を優先して返す
 *    （execNotGranted > grantRevoked > callerNotQualified > granteeOwnerMismatch > noGrant）
 */
export function decideCrossTeamAccess(input: DecideCrossTeamAccessInput): CrossTeamDecision {
  if (!input.crossTeamEnabled) {
    return { allowed: false, denyReason: 'killSwitchOff' };
  }
  if (input.mode === 'exec' && !input.crossTeamExecEnabled) {
    return { allowed: false, denyReason: 'execKillSwitchOff' };
  }
  if (!input.callerOrganizationId || !input.targetOwnerOrganizationId) {
    return { allowed: false, denyReason: 'noOrganization' };
  }
  if (input.callerOrganizationId !== input.targetOwnerOrganizationId) {
    return { allowed: false, denyReason: 'orgMismatch' };
  }

  let sawOwnerMismatch = false;
  let sawRevoked = false;
  let sawUnqualifiedCaller = false;
  let sawExecNotGranted = false;

  for (const c of input.candidates) {
    if (c.granteeUserId !== input.targetOwnerUserId) {
      sawOwnerMismatch = true;
      continue;
    }
    if (c.revoked) {
      sawRevoked = true;
      continue;
    }
    if (!c.callerQualified) {
      sawUnqualifiedCaller = true;
      continue;
    }
    if (input.mode === 'ask') {
      if (!c.askAllowed) continue;
      return { allowed: true, grantId: c.grantId, teamId: c.teamId };
    }
    // mode === 'exec'
    if (!c.execAllowed) {
      sawExecNotGranted = true;
      continue;
    }
    return { allowed: true, grantId: c.grantId, teamId: c.teamId };
  }

  if (sawExecNotGranted) return { allowed: false, denyReason: 'execNotGranted' };
  if (sawRevoked) return { allowed: false, denyReason: 'grantRevoked' };
  if (sawUnqualifiedCaller) return { allowed: false, denyReason: 'callerNotQualified' };
  if (sawOwnerMismatch) return { allowed: false, denyReason: 'granteeOwnerMismatch' };
  return { allowed: false, denyReason: 'noGrant' };
}

/**
 * 拒否理由のサーバーログ 1 行を組み立てる（レスポンス本文には使わない。404 規約の対称）。
 */
export function buildCrossTeamDenyLog(input: {
  callerMachineId: string;
  targetProjectName: string;
  mode: 'ask' | 'exec';
  denyReason: CrossTeamDenyReason;
}): string {
  return `🚫 Cross-team ${input.mode} denied (${input.denyReason}): ${input.callerMachineId} → ${input.targetProjectName}`;
}
