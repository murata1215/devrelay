// =============================================================================
// Claude 認証状態の優先度判定（BUG A 最小修正、#326 Phase2 と同時実施）
// =============================================================================
//
// 背景（#338 で判明した既知の制限）: 15分ポーリング checkAndReportClaudeAuth() は
// 資格情報が存在すれば常に ok:true を送るため、runtime 検知が立てた ok:false は
// 最大15分で無条件に上書きされる。`login` 成功の ok:true とポーリングの弱い ok:true が
// 区別できないと「login が効いたか」を検証できないため、source 優先度を導入する。
//
// 外部 import ゼロの純関数（#335/#337 と同じ流儀）。

export type ClaudeAuthSource = 'runtime' | 'poll' | 'login' | undefined;

export interface DecideClaudeAuthUpdateInput {
  /** 現在 DB に保存されている Machine.claudeAuthOk（未観測なら null） */
  previousOk: boolean | null;
  /** 今回 Agent から報告された ok */
  reportedOk: boolean;
  /** 今回の報告の由来。未指定（旧 Agent）は常に採用（fail-open、非退行） */
  source: ClaudeAuthSource;
}

export interface DecideClaudeAuthUpdateResult {
  /** 今回採用する ok の値（採用しない場合は previousOk をそのまま維持） */
  nextOk: boolean;
  /** true 未→false 遷移（切れた）を通知すべきか */
  notifyExpired: boolean;
  /** false→true 遷移（復旧した）を通知すべきか */
  notifyRecovered: boolean;
}

/**
 * `source` に応じた優先度で Claude 認証状態の更新可否を判定する。
 *
 * 優先度表:
 * - runtime: ok:false/true とも常に採用（実際の AI ターンの成否という直接証拠）
 * - poll:    ok:false は採用（資格情報なしは強い根拠）。ok:true は previousOk===false のとき不採用
 *            （runtime/login が立てた false を弱い証拠で上書きしない）
 * - login:   ok:true のみ想定（呼び出し側は失敗時に呼ばない設計）。常に採用
 * - undefined（旧 Agent）: 常に採用（従来どおり、fail-open）
 */
export function decideClaudeAuthUpdate(input: DecideClaudeAuthUpdateInput): DecideClaudeAuthUpdateResult {
  const { previousOk, reportedOk, source } = input;

  const shouldSuppress = source === 'poll' && reportedOk === true && previousOk === false;
  const nextOk = shouldSuppress ? false : reportedOk;

  // 初回観測（previousOk が null）は通知しない。#338 と同じ「変化したときだけ通知」方針。
  const isFirstObservation = previousOk === null;
  const notifyExpired = !isFirstObservation && !shouldSuppress && previousOk === true && nextOk === false;
  const notifyRecovered = !isFirstObservation && !shouldSuppress && previousOk === false && nextOk === true;

  return { nextOk, notifyExpired, notifyRecovered };
}
