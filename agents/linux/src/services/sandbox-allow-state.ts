/**
 * Sandbox 許可リスト（IP とポート）の digest 計算と、設定 vs 実際の反映結果の一致判定
 * （`node:crypto` のみ import、他は純関数）。
 *
 * サイクル SB-2.1。設計・決定事項は `doc/sandbox/SB-2.0_investigation.md` の E-3 節・決定3。
 */

import { createHash } from 'node:crypto';

/** 特権タスク（apply-sandbox-allowlist.ps1）が書く host.json / state.json のプロトコル版 */
export const SANDBOX_ALLOW_RECONCILER_VERSION = 1;
/** Agent が書く request.json のバージョン（タスク側が理解できない版は拒否する） */
export const SANDBOX_ALLOW_REQUEST_VERSION = 1;

/** canonical 文字列（`buildCanonicalAllowDestinations()` の戻り値）から digest（sha256 16進小文字）を作る */
export function digestSandboxAllowDestinations(canonical: string): string {
  return createHash('sha256').update(canonical, 'utf-8').digest('hex');
}

export interface SandboxAllowRejectedEntry {
  index: number;
  reason: string;
}

export interface SandboxAllowState {
  reconcilerVersion: number;
  result: 'ok' | 'rejected' | 'error';
  appliedAt: string | null;
  digest: string | null;
  applied: Array<{ ip: string; port: number }>;
  rejectedCount: number;
  rejected: SandboxAllowRejectedEntry[];
  ruleNames: string[];
  error: string | null;
}

/** `state.json` の内容を検証付きでパースする。壊れた JSON・型不正は null（呼び出し側は fail-closed で扱う） */
export function parseSandboxAllowState(raw: string | null): SandboxAllowState | null {
  if (raw === null) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const obj = data as Record<string, unknown>;
  if (typeof obj.reconcilerVersion !== 'number') return null;
  if (obj.result !== 'ok' && obj.result !== 'rejected' && obj.result !== 'error') return null;
  if (!Array.isArray(obj.applied) || !Array.isArray(obj.rejected) || !Array.isArray(obj.ruleNames)) return null;
  return {
    reconcilerVersion: obj.reconcilerVersion,
    result: obj.result,
    appliedAt: typeof obj.appliedAt === 'string' ? obj.appliedAt : null,
    digest: typeof obj.digest === 'string' ? obj.digest : null,
    applied: obj.applied as Array<{ ip: string; port: number }>,
    rejectedCount: typeof obj.rejectedCount === 'number' ? obj.rejectedCount : obj.rejected.length,
    rejected: obj.rejected as SandboxAllowRejectedEntry[],
    ruleNames: obj.ruleNames as string[],
    error: typeof obj.error === 'string' ? obj.error : null,
  };
}

export type SandboxAllowReconcileDecision = 'match' | 'apply-needed' | 'mismatch';

export interface SandboxAllowReconcileInput {
  /** `resolveSandboxAllowDestinations()` が返した件数（0 なら未設定/空） */
  configuredCount: number;
  /** 設定から計算した期待 digest（`configuredCount === 0` のときは無視してよい） */
  expectedDigest: string;
  /** 読み取れた `state.json`（無ければ null） */
  state: SandboxAllowState | null;
  /** 既にこのターンで 1 回再反映を試みたか（2 回目の呼び出しで true にする） */
  alreadyRetried: boolean;
}

/**
 * 設定と実際の反映結果が一致しているか判定する（決定3）。
 * - 未設定/空 かつ state.json 無し → 一致として扱う（既存 PC を止めない）
 * - それ以外は digest を比較する。不一致なら、まだ再反映を試みていなければ `apply-needed`
 *   （呼び出し側はタスクを 1 回起動し、再読込後にもう一度この関数を呼ぶこと）。
 *   再反映済みでも不一致なら `mismatch`（方向を問わず拒否）。
 */
export function decideSandboxAllowReconcile(input: SandboxAllowReconcileInput): SandboxAllowReconcileDecision {
  if (input.configuredCount === 0 && input.state === null) {
    return 'match';
  }
  if (input.state !== null && input.state.digest === input.expectedDigest && input.state.result === 'ok') {
    return 'match';
  }
  if (input.alreadyRetried) {
    return 'mismatch';
  }
  return 'apply-needed';
}
