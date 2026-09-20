/**
 * bg-task: Claude Agent SDK のバックグラウンドタスク（background Agent 等）と result メッセージの
 * 「途中 result」を判定する、外部 import ゼロの純関数モジュール
 * （sdk-loop-guard.ts / sdk-stop-reason.ts と同じ流儀。linux/macos で byte-for-byte 同一）。
 *
 * 背景（2026-09-20 実測、Claude Code 2.1.278 / SDK 0.3.278、stream-json 入力モード）:
 * 1. モデルが Agent ツールをバックグラウンドで起動し「完了を待っています」で end_turn すると、
 *    SDK は **その時点で result(result_index=0) を出す**。ai-runner.ts は従来これを終端とみなして
 *    return していたため、SDK プロセスが終了しサブエージェントは未完のまま殺されていた。
 *    対話 CLI ではタスク完了通知でモデルが再起動され result(result_index=1) が出るのが本来の動き。
 * 2. その状態で `--resume` すると Claude Code は孤児サブエージェントの
 *    `<task-notification status=stopped>` を合成し、**モデルを呼ばずに
 *    `result{num_turns:0, result:'', duration_api_ms:0, subtype:'success'}` を先に出す**。
 *    ai-runner.ts はこれを終端とみなし fullOutput=0 → `(No response from AI)` を返していた。
 *    読み続ければ数秒後に本物の応答（result_index=1）が来ることを再現で確認済み。
 *
 * 本モジュールは (a) `system/task_started` `system/background_tasks_changed` `system/task_notification`
 * から「まだ生きているバックグラウンドタスク」を追跡し、(b) result を終端扱いしてよいかを判定する。
 * 判定を待つ間に SDK が何も送ってこない場合の保険（アイドルタイムアウト）と、
 * 無限に待ち続けないための延期回数上限も持つ。
 *
 * sdk.d.ts（0.3.278）の SDKBackgroundTasksChangedMessage コメントに従い、
 * background_tasks_changed は REPLACE セマンティクス（集合を丸ごと置き換える）、
 * `ambient: true` のタスクは活動とみなさない。
 *
 * 例外を一切投げない（不正な env 値・想定外のメッセージ形は無視または既定値へフォールバックする）。
 */

/** `process.env` 相当の最小型（Node 型定義への依存を避けるため独自定義） */
type EnvLike = Record<string, string | undefined>;

/**
 * 途中 result を延期した後、SDK から次のメッセージが何も来ない状態が続いたら諦める時間（ms）。
 * env DEVRELAY_SDK_BG_TASK_IDLE_MS で上書き可能。
 * サブエージェント稼働中は task_progress 等が定期的に届くため「無音」は異常の兆候。
 */
export const DEFAULT_BG_TASK_IDLE_MS = 10 * 60 * 1000;

/**
 * 1 ターン内で途中 result を延期できる最大回数。env DEVRELAY_SDK_BG_TASK_MAX_DEFERRALS で上書き可能。
 * 「Agent 起動 → 待つ → 通知で再起動 → また Agent 起動」の繰り返しで result が複数回出るのは
 * 正常だが、無限には延期しないための安全弁。
 */
export const DEFAULT_BG_TASK_MAX_DEFERRALS = 20;

/**
 * env 文字列を正の整数として解釈する。未設定・空文字・非数値・0以下は fallback を返す
 * （例外は投げない）。sdk-loop-guard.ts の parseEnvInt と同一実装（意図的な複製。理由は sdk-stop-reason.ts 冒頭コメント参照）。
 */
function parseEnvInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  if (n <= 0) return fallback;
  return Math.floor(n);
}

export interface BackgroundTaskConfig {
  idleTimeoutMs: number;
  maxDeferrals: number;
}

export function resolveBackgroundTaskConfig(env: EnvLike): BackgroundTaskConfig {
  return {
    idleTimeoutMs: parseEnvInt(env.DEVRELAY_SDK_BG_TASK_IDLE_MS, DEFAULT_BG_TASK_IDLE_MS),
    maxDeferrals: parseEnvInt(env.DEVRELAY_SDK_BG_TASK_MAX_DEFERRALS, DEFAULT_BG_TASK_MAX_DEFERRALS),
  };
}

export interface BackgroundTaskState {
  /** 現在生きている（活動とみなす）バックグラウンドタスクの task_id */
  pending: Set<string>;
  /** このターンで途中 result を延期した回数 */
  deferrals: number;
  /** 空の resume result（num_turns=0・本文なし）を一度読み飛ばしたか。1 ターンに 1 回だけ許す */
  emptyResultSkipped: boolean;
}

export function createBackgroundTaskState(): BackgroundTaskState {
  return { pending: new Set<string>(), deferrals: 0, emptyResultSkipped: false };
}

/** observeBackgroundTaskEvent に渡す SDK メッセージの最小形（system メッセージ以外は無視される） */
export interface BackgroundTaskEventLike {
  type?: unknown;
  subtype?: unknown;
  task_id?: unknown;
  status?: unknown;
  tasks?: unknown;
}

/**
 * SDK メッセージを 1 件観測し、バックグラウンドタスク集合を更新する。
 * - task_started: task_id を追加
 * - background_tasks_changed: 集合を tasks（ambient 以外）で置き換える（REPLACE）
 * - task_notification: task_id を削除（completed / failed / stopped いずれも「もう生きていない」）
 * それ以外のメッセージは無視する。戻り値は集合が変化したかどうか。
 */
export function observeBackgroundTaskEvent(state: BackgroundTaskState, m: BackgroundTaskEventLike): boolean {
  if (!m || m.type !== 'system') return false;
  if (m.subtype === 'task_started') {
    if (typeof m.task_id !== 'string' || m.task_id === '') return false;
    if (state.pending.has(m.task_id)) return false;
    state.pending.add(m.task_id);
    return true;
  }
  if (m.subtype === 'task_notification') {
    if (typeof m.task_id !== 'string') return false;
    return state.pending.delete(m.task_id);
  }
  if (m.subtype === 'background_tasks_changed') {
    if (!Array.isArray(m.tasks)) return false;
    const next = new Set<string>();
    for (const t of m.tasks as Array<{ task_id?: unknown; ambient?: unknown }>) {
      if (!t || typeof t.task_id !== 'string' || t.task_id === '') continue;
      if (t.ambient === true) continue;
      next.add(t.task_id);
    }
    let changed = next.size !== state.pending.size;
    if (!changed) {
      for (const id of next) {
        if (!state.pending.has(id)) { changed = true; break; }
      }
    }
    state.pending = next;
    return changed;
  }
  return false;
}

/** decideResultDeferral に渡す result メッセージの要約 */
export interface ResultDeferralInput {
  /** result.is_error */
  isError: boolean;
  /** result.num_turns（旧 SDK では undefined） */
  numTurns: number | undefined;
  /** result.result（本文。旧 SDK / エラー時は undefined） */
  resultText: string | undefined;
  /** このターンでここまでにストリームされた assistant テキストの長さ */
  fullOutputLength: number;
}

export type ResultDeferralReason = 'backgroundTasks' | 'emptyResult';

export interface ResultDeferralDecision {
  /** true なら、この result は終端ではないので読み続ける */
  defer: boolean;
  reason?: ResultDeferralReason;
  /** ログ用: 延期時点で生きているタスク id */
  pendingTaskIds: string[];
}

/**
 * result メッセージを終端として扱ってよいか判定する。延期する場合は state.deferrals を進める。
 * - is_error の result は延期しない（エラーはそのまま既存経路へ）
 * - 延期回数が上限に達していたら延期しない（安全弁）
 * - 生きているバックグラウンドタスクがあれば延期（reason=backgroundTasks）
 * - num_turns===0 かつ本文なし（result も fullOutput も空）は、1 ターンに 1 回だけ延期
 *   （reason=emptyResult。resume 時の孤児タスク通知で出る空 result）
 */
export function decideResultDeferral(
  state: BackgroundTaskState,
  input: ResultDeferralInput,
  config: BackgroundTaskConfig
): ResultDeferralDecision {
  const pendingTaskIds = Array.from(state.pending);
  if (input.isError) return { defer: false, pendingTaskIds };
  if (state.deferrals >= config.maxDeferrals) return { defer: false, pendingTaskIds };
  if (pendingTaskIds.length > 0) {
    state.deferrals += 1;
    return { defer: true, reason: 'backgroundTasks', pendingTaskIds };
  }
  const isEmpty = input.numTurns === 0 && (input.resultText ?? '') === '' && input.fullOutputLength === 0;
  if (isEmpty && !state.emptyResultSkipped) {
    state.emptyResultSkipped = true;
    state.deferrals += 1;
    return { defer: true, reason: 'emptyResult', pendingTaskIds };
  }
  return { defer: false, pendingTaskIds };
}
