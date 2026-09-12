/**
 * スレッド管理 サイクル6（事象1〜3 修正）: Agent 再接続時のセッション再確立・`//connect` の
 * ended スレッド復活可否・`web:session_info` 再送要否を決める純関数群。
 * 外部 import ゼロ（node:test から dist/ を直接 import して検証する。thread-routing.ts / thread-clear-guard.ts
 * と同じ流儀）。
 *
 * 背景（devlog 参照）:
 * - 事象1（送信が既定スレッドではなく新規スレッドに入る）: Agent の WebSocket 再接続のたびに
 *   `agent-manager.ts` が無条件で `needsSessionRestart` を立て、`command-handler.ts` の
 *   再確立コードが毎回新しい Session 行を `createSession()` していたのが直接原因だった。
 *   Agent 側は未知の sessionId を自動初期化する自己修復を既に持っており（`connection.ts`）、
 *   同一 sessionId への `session:start` 再送は Agent 側で冪等（`ai-runner.ts`）なので、
 *   サーバー側は新規 Session を作る必要が無い。`decideSessionReactivation` は
 *   「同一 sessionId のまま再利用する。ただし ended なら active に戻す」という決定だけを持つ。
 * - 事象2（生中継が2スレッドに出る）: 再確立経路が `web:session_info` を送っていなかったため、
 *   ブラウザの `tab.sessionId` が古いままになるのが原因だった。`decideSessionInfoPush` は
 *   「処理前後で currentSessionId が変わっていれば再送すべき」という判定だけを持つ
 *   （実際の送信は呼び出し側の `web.ts` が行う）。
 * - 事象3（空 ended セッションの増殖）: `//connect` の候補クエリが `status:'active'` のみを見ており、
 *   Agent オフライン中に全セッションが ended になった直後の `//connect` が候補ゼロと判定して
 *   新規 Session を作ってしまうのが原因だった。`decideEndedRevival` は「ended 候補があっても、
 *   `resolvePreferredThreadId()` の結果とちょうど一致する場合のみ復活させる」という判定を持つ。
 *   「直近アクティブな ended（＝最新の ended）」を無条件に復活させないのが要点で、これにより
 *   24時間アイドルスイープの対象になっている本当に不要な ended スレッドは復活せず掃除され続ける。
 */

/** `decideSessionReactivation` の入力。 */
export interface DecideSessionReactivationInput {
  /** 再確立対象セッションの現在の DB 上の status。 */
  status: string;
}

/** `decideSessionReactivation` の結果。 */
export type SessionReactivationDecision =
  | { shouldReactivate: false }
  | { shouldReactivate: true; data: { status: 'active'; endedAt: null } };

/**
 * Agent 再接続時の再確立で、対象セッションが `ended` なら `active` に戻すべきかを判定する。
 * `ended` 以外（`active` はもちろん、将来 status の値が増えた場合も含む）は何もしない
 * （`active` を無駄に再書き込みしない、未知の status を勝手に上書きしない、の両方を満たす）。
 */
export function decideSessionReactivation(
  input: DecideSessionReactivationInput
): SessionReactivationDecision {
  if (input.status !== 'ended') return { shouldReactivate: false };
  return { shouldReactivate: true, data: { status: 'active', endedAt: null } };
}

/** `decideEndedRevival` の入力。 */
export interface DecideEndedRevivalInput {
  /** `resolvePreferredThreadId()` の結果（呼び出し側のタブが直前に開いていたスレッド）。 */
  preferredThreadId: string | null;
  /** 同一ユーザー・同一プロジェクト・同一マシンの `ended` 状態の候補セッション ID 一覧。 */
  endedCandidateIds: string[];
  /**
   * 【サイクルC・optional】対象マシンの Agent が現在オンラインかどうか。
   * 省略、または `true` の場合は従来どおり（`preferredThreadId` に一致する ended のみ復活）。
   * これにより「(無題)」大量発生の根治 サイクルC の対象外呼び出し（オンライン経路）は
   * 69bcd3e の挙動と数学的に同一のまま維持される。
   */
  machineOnline?: boolean;
  /**
   * 【サイクルC・optional】`machineOnline === false` のときのみ参照する、
   * 直近アクティブだった（`lastActiveAt` 降順の先頭）ended 候補の ID。
   * オンライン経路では一切参照しない（24h アイドルスイープを殺さないという
   * 69bcd3e の設計意図をオンライン経路で完全に保つため）。
   */
  mostRecentEndedId?: string | null;
}

/** `decideEndedRevival` の結果。 */
export type EndedRevivalDecision =
  | { action: 'revive'; sessionId: string }
  | { action: 'createNew' };

/**
 * `//connect` で active 候補が無かった場合に、ended 候補を復活させてよいかを判定する。
 *
 * `preferredThreadId` と一致する ended 候補が `endedCandidateIds` にある場合のみ復活し、
 * それ以外（`preferredThreadId` が null、または一致するものが無い）は必ず新規作成する。
 * 「最新の ended を復活」させないのが意図的な設計: 24時間アイドルスイープの対象である
 * 古い ended スレッドまで無条件に復活させると、スイープが機能しなくなってしまう。
 *
 * 【サイクルC】上記①（`preferredThreadId` 一致）で復活できなかった場合のみ、
 * `machineOnline === false`（Agent がオフライン）なら②として `mostRecentEndedId` を復活させる。
 * オフライン中に新規 Session を作っても `startAgentSession` が実質失敗して空 ended セッションの
 * 抜け殻が増えるだけで価値が無いため、「オフラインなら作らない」を優先する
 * （`POST /api/threads` が既にオフライン時 409 を返す設計＝`thread-api-guard.ts` と整合）。
 * `machineOnline` 省略/`true` のときはこの②に一切到達しない＝オンライン経路は①と `createNew`
 * しか通らず 69bcd3e と数学的に同一（24h アイドルスイープを殺さないという意図を完全維持）。
 */
export function decideEndedRevival(input: DecideEndedRevivalInput): EndedRevivalDecision {
  if (input.preferredThreadId && input.endedCandidateIds.includes(input.preferredThreadId)) {
    return { action: 'revive', sessionId: input.preferredThreadId };
  }
  if (input.machineOnline === false && input.mostRecentEndedId) {
    return { action: 'revive', sessionId: input.mostRecentEndedId };
  }
  return { action: 'createNew' };
}

/** `decideSessionInfoPush` の入力。 */
export interface DecideSessionInfoPushInput {
  /** `web:command` 処理を開始する前の `context.currentSessionId`。 */
  beforeSessionId: string | null;
  /** コマンド処理（再確立 / hintProjectId フォールバック / handleContinue 等）後の `context.currentSessionId`。 */
  afterSessionId: string | null;
}

/** `decideSessionInfoPush` の結果。 */
export interface SessionInfoPushDecision {
  shouldPush: boolean;
}

/**
 * `web:command` 処理の前後で `currentSessionId` が変わっていれば、
 * `web:session_info` を再送すべきと判定する（ブラウザ側の `tab.sessionId` の取りこぼし対策）。
 * `afterSessionId` が無い（未接続のまま）場合は再送不要。前後で同じ場合ももちろん再送不要。
 */
export function decideSessionInfoPush(input: DecideSessionInfoPushInput): SessionInfoPushDecision {
  if (!input.afterSessionId) return { shouldPush: false };
  if (input.afterSessionId === input.beforeSessionId) return { shouldPush: false };
  return { shouldPush: true };
}
