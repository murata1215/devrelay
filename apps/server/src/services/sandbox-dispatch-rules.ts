/**
 * サイクルSB-1b: Sandbox が ON のプロジェクトへ AI 実行の指示を送ってよいかを判定する純関数
 * （外部 import ゼロ。`cross-ask-isolation-rules.ts` と同じ流儀）。
 *
 * 判定の芯（既定は許可——Sandbox が OFF のプロジェクトは常に許可。影響を出さないため）:
 * 1. `sandboxEnabled` が false なら無条件で許可（従来の送信経路に一切影響しない）。
 * 2. `sandboxEnabled` が true のときのみ、宛先 Agent が `'sandbox-host'` capability を
 *    申告しているかを見る。申告していない Agent（Windows 以外・古い版）は
 *    `sandboxEnabled: true` を解釈できず、制限なしでそのまま実行してしまう恐れがあるため、
 *    サーバー側で送信そのものを止める（fail-closed。`cross-ask-isolation` と同じ方針）。
 */

export interface DecideSandboxDispatchInput {
  /** `Project.sandboxEnabled` */
  sandboxEnabled: boolean;
  /** `agentHasCapability(machineId, 'sandbox-host')` の結果 */
  capabilityDeclared: boolean;
}

export type SandboxDispatchDecision =
  | { allowed: true }
  | { allowed: false; reason: 'capability_not_declared' };

/**
 * Sandbox が ON のプロジェクトへ、この宛先 Agent に AI 実行の指示を送ってよいか判定する。
 * `sandboxEnabled` が false なら常に許可（このチェック自体が影響を出さない）。
 */
export function decideSandboxDispatch(input: DecideSandboxDispatchInput): SandboxDispatchDecision {
  if (!input.sandboxEnabled) return { allowed: true };
  if (!input.capabilityDeclared) return { allowed: false, reason: 'capability_not_declared' };
  return { allowed: true };
}
