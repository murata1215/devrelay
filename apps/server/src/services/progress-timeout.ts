/**
 * 進捗タイムアウト（5分無出力タイムアウトの誤検知対策）の判定ロジック。
 *
 * 背景: 従来は Agent からの出力が5分間来なければ即座にタイムアウト確定していたが、
 * Claude SDK 経路は「アシスタントのテキスト」と「ツール開始時」しか出力を出さないため、
 * 1個のツール呼び出しが長時間かかる間は出力が完全にゼロになり誤タイムアウトが発生していた
 * （Devin/Codex/PTY 端末モードには既に30秒ハートビートがあるが Claude SDK 経路にだけ無かった）。
 *
 * 判定軸を「出力が来たか」から「エージェントが生きているか」へ変更する。
 * マシンの生存は `agent:ping`（30秒ごと）由来の `Machine.status` を利用する。
 *
 * 外部 import ゼロ（DB/ネットワーク非依存）に保ち、コンパイル済み dist を直接
 * `node --test` から import して単体検証できるようにする
 * （human-text-fence.ts / permission-policy.ts / approval-prompt.ts と同じ流儀）。
 */

/** 満了時の判定結果 */
export type ProgressTimeoutAction = 'extend' | 'finalize';

/** decideProgressTimeoutAction() の判定理由 */
export type ProgressTimeoutReason = 'hardTimeout' | 'machineOffline' | 'machineUnknown' | 'agentAlive';

export interface ProgressTimeoutDecision {
  action: ProgressTimeoutAction;
  reason: ProgressTimeoutReason;
}

export interface ProgressTimeoutInput {
  /** セッション開始からの経過ミリ秒（ソフトタイムアウト発火時点の値） */
  elapsedSinceStartMs: number;
  /** ハードタイムアウトの上限ミリ秒（これを超えたら machineStatus に関わらず finalize） */
  hardTimeoutMs: number;
  /** マシンの生存状態。'online' | 'offline' | null（不明・未取得） */
  machineStatus: string | null;
}

/**
 * ソフトタイムアウト（無出力 N 分）発火時の動作を判定する。
 *
 * 優先順位:
 * 1. ハードタイムアウト超過 → 無条件で finalize（暴走・無限ハングの安全網）
 * 2. マシンが online → extend（誤検知を防ぐためタイマーを再武装するだけ）
 * 3. マシンが offline → finalize（従来どおりの挙動）
 * 4. マシンの状態が不明（null） → finalize（fail-safe = 現行挙動を維持）
 */
export function decideProgressTimeoutAction(input: ProgressTimeoutInput): ProgressTimeoutDecision {
  if (input.elapsedSinceStartMs >= input.hardTimeoutMs) {
    return { action: 'finalize', reason: 'hardTimeout' };
  }
  if (input.machineStatus === 'online') {
    return { action: 'extend', reason: 'agentAlive' };
  }
  if (input.machineStatus === 'offline') {
    return { action: 'finalize', reason: 'machineOffline' };
  }
  return { action: 'finalize', reason: 'machineUnknown' };
}
