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

// -----------------------------------------------------------------------------
// サイクル SB-2.1.5: 反映待ちの時間判定（純関数）
//
// hp630g9（SB-2.1.4、commit 992ae26）実機確認で発覚: `reconcileSandboxAllowDestinations()`
// はタスク起動後 10 秒しか `state.json` を待たず、実機のファイアウォール操作（
// Remove-NetFirewallRule / New-NetFirewallRule）はそれより時間がかかるため、Agent がタスクを
// 起動して待つ経路は一度も成功していなかった（直後に確認すると反映自体は成功していた）。
// 「基本 60 秒・タスクが実行中なら最大 180 秒まで待つ」判定をここに集約する。
// -----------------------------------------------------------------------------

/** 基本の待ち時間（決定3の「最大 10 秒」を撤回し 60 秒へ。SB-2.1.5） */
export const SANDBOX_ALLOW_APPLY_WAIT_MS = 60_000;
/** タスクが実行中と観測できている間だけ延長してよい上限（SB-2.1.5） */
export const SANDBOX_ALLOW_APPLY_MAX_WAIT_MS = 180_000;
/** `schtasks /Run` 直後はタスクの State がまだ `Ready` に見える可能性があるため、
 *  この猶予の間は「終了済み」という probe 結果を信用しない（SB-2.1.5） */
export const SANDBOX_ALLOW_TASK_START_GRACE_MS = 5_000;

export type SandboxAllowTaskState = 'running' | 'finished' | 'unknown';

/**
 * `Get-ScheduledTask ... | Select State` の出力（`State` 列挙名、英語固定）を解釈する。
 * `schtasks /Query` の「状態: 実行中」は日本語 Windows で localize されるため使わない
 * （probe コマンド自体は `sandbox-allow-apply.ts` 側で `Get-ScheduledTask` を使う設計にする）。
 * 失敗・空・未知の文字列は `'unknown'`（fail-open: probe 失敗は待ち続ける側に倒す。
 * 全体の可否は digest 一致のみで決める fail-closed のまま変わらない）。
 */
export function interpretSandboxAllowTaskState(stdout: string): SandboxAllowTaskState {
  const trimmed = stdout.trim();
  if (trimmed === 'Running' || trimmed === 'Queued') return 'running';
  if (trimmed === 'Ready' || trimmed === 'Disabled') return 'finished';
  return 'unknown';
}

/** `state.json` の `appliedAt`（ISO 文字列）が `sinceMs` より後に書かれたものかどうか。
 *  パース不能・null は false（fail-closed: 「新しい結果が出た」と誤認して早期に諦めない）。 */
export function isSandboxAllowStateFresherThan(state: SandboxAllowState | null, sinceMs: number): boolean {
  if (state === null || state.appliedAt === null) return false;
  const appliedAtMs = Date.parse(state.appliedAt);
  if (Number.isNaN(appliedAtMs)) return false;
  return appliedAtMs > sinceMs;
}

export type SandboxAllowWaitDecision = 'done' | 'wait' | 'give-up';

export interface SandboxAllowWaitInput {
  /** 今回の判定が `decideSandboxAllowReconcile()` で `match` になるか（digest 一致 かつ `result: 'ok'`） */
  stateMatched: boolean;
  /** `state.json` の `appliedAt` が今回 `request.json` を書いた時刻より後か
   *  （`isSandboxAllowStateFresherThan()`。新しい結果が出たのに不一致なら、待っても変わらない） */
  stateFresh: boolean;
  /** タスク起動後の経過時間（ms） */
  elapsedMs: number;
  /** タスク状態の probe 結果（`'unknown'` は probe 失敗または未実施） */
  taskState: SandboxAllowTaskState;
  /** これまでに `taskState === 'running'` を一度でも観測したか
   *  （`/Run` 直後の「まだ Ready に見える」誤判定を区別するため） */
  observedRunning: boolean;
}

/**
 * タスク起動後、結果ファイルの反映を待ち続けるべきかを判定する（SB-2.1.5）。
 * 優先順位: 一致 → 新しい結果が出たのに不一致（待っても変わらない） → 最大待ち超過 →
 *   タスク終了済み（起動直後の猶予は除く） → 基本待ち超過かつ実行中でない → それ以外は待つ。
 */
export function decideSandboxAllowWait(input: SandboxAllowWaitInput): SandboxAllowWaitDecision {
  if (input.stateMatched) return 'done';
  if (input.stateFresh) return 'give-up';
  if (input.elapsedMs >= SANDBOX_ALLOW_APPLY_MAX_WAIT_MS) return 'give-up';
  if (
    input.taskState === 'finished' &&
    (input.observedRunning || input.elapsedMs >= SANDBOX_ALLOW_TASK_START_GRACE_MS)
  ) {
    return 'give-up';
  }
  if (input.elapsedMs >= SANDBOX_ALLOW_APPLY_WAIT_MS && input.taskState !== 'running') {
    return 'give-up';
  }
  return 'wait';
}

export type SandboxAllowApplyOutcome = 'applied' | 'pending' | 'failed';

export interface SandboxAllowApplyOutcomeInput {
  /** 最終的な一致判定（`decideSandboxAllowReconcile()` の結果が `'match'` か） */
  matched: boolean;
  /** 読み取れた最新の `state.json` */
  state: SandboxAllowState | null;
  /** `state.json` の `appliedAt` が今回の要求より後か（`isSandboxAllowStateFresherThan()`） */
  stateFresh: boolean;
  /** タスク起動コマンド自体の失敗（`schtasks`/`/Run` が例外を投げた） */
  taskRunError: string | null;
  /** 待っている間に `taskState === 'running'` を一度でも観測したか */
  observedRunning: boolean;
}

/**
 * 反映結果を「成功」「反映中（まだ分からない。再送を促す）」「失敗（これ以上待っても無駄）」の
 * 3 つに分類する（SB-2.1.5）。チャット向けの拒否文言を 2 種類に分けるための判定。
 */
export function classifySandboxAllowApplyOutcome(input: SandboxAllowApplyOutcomeInput): SandboxAllowApplyOutcome {
  if (input.matched) return 'applied';
  if (input.state !== null && (input.state.result === 'error' || input.state.result === 'rejected')) {
    // 今回の要求に対する結果だと確信できる場合のみ failed とする（古い error が残っているだけの
    // 可能性があるなら pending 側に倒す）。
    if (input.stateFresh) return 'failed';
  }
  if (input.taskRunError !== null && !input.observedRunning) return 'failed';
  return 'pending';
}

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
