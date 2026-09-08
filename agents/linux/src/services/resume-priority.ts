/**
 * core#336: plan/exec の resume 判定を統一する純関数モジュール。
 *
 * サイクル A では以下の優先順位を connection.ts / ai-runner.ts の SDK 経路・PTY 経路に
 * それぞれインラインで書いていたが、3 OS 分書き写すことになりテストも書けないため
 * 外部 import ゼロの純関数として切り出した（session-scope.ts / plan-permission.ts /
 * git-guard-core.ts / running-code-stale.ts と同じ流儀）。
 *
 * 優先順位:
 *   1. explicitResumeSessionId 指定あり（サーバー明示指定 = approve_implementation 等）
 *      → forceNewSession に関わらず必ずそれを resume。スコープ内保存ファイルは読まない
 *   2. 指定なし + forceNewSession === true → resume しない（保存済み ID を使わない）
 *   3. 指定なし + forceNewSession !== true → 従来どおりスコープ内保存 ID を resume
 *
 * agents/linux と agents/macos と agents/windows で byte-for-byte 同一内容を維持すること。
 */

/** resume 判定の根拠（ログ・テストでの分岐確認に使う） */
export type ResumeSource = 'explicit' | 'none' | 'stored';

export interface ResumeDecision {
  /** 実際に resume すべきセッション ID（resume しない場合は undefined） */
  resumeSessionId?: string;
  /** どの優先順位で決定したか */
  source: ResumeSource;
  /**
   * true の場合、呼び出し側はスコープ内の保存済みセッション ID ファイル
   * （loadClaudeSessionId 等）を読んではいけない（読んでも使わないため無駄、かつ
   * 意図せぬファイル I/O のログノイズになる）。
   */
  skipStoredLookup: boolean;
}

/**
 * resume 優先順位を判定する。
 *
 * @param input.explicitResumeSessionId サーバーから明示指定された resume 先（approve_implementation 等）
 * @param input.forceNewSession MCP submit 等、常に新規セッションを要求するフラグ
 * @param input.storedSessionId スコープ内保存ファイルから読み込んだセッション ID（未読み込みなら呼び出し前に省略してよい）
 */
export function decideResume(input: {
  explicitResumeSessionId?: string;
  forceNewSession?: boolean;
  storedSessionId?: string;
}): ResumeDecision {
  if (input.explicitResumeSessionId) {
    return { resumeSessionId: input.explicitResumeSessionId, source: 'explicit', skipStoredLookup: true };
  }
  if (input.forceNewSession === true) {
    return { resumeSessionId: undefined, source: 'none', skipStoredLookup: true };
  }
  return { resumeSessionId: input.storedSessionId, source: 'stored', skipStoredLookup: false };
}
