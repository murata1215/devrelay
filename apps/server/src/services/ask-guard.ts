/**
 * MCP ask サイクル: `ask_project` / `get_answer` / `cancel_submission` の
 * 判定ロジックを外部 import ゼロの純関数として切り出したモジュール
 * （`permission-policy.ts` / `cross-query-guard.ts` / `raw-completion-guard.ts` と同じ流儀）。
 *
 * `packages/shared` ではなく `apps/server` に置くのは同じ理由（#310 白画面事故の回避、
 * サーバー専用ロジックを web バンドルに巻き込まない）。
 *
 * fenceHumanText 等の外部依存はここに持ち込まない。プロンプト組み立ての「接頭辞テキスト」だけを
 * 純関数として提供し、実際の fence 適用は呼び出し側（tools.ts）が行う。
 */

/** `Session.kind` に書き込む唯一の値（質問ターン）。null = 従来の指示（instruction） */
export const SESSION_KIND_QUESTION = 'question';

/** ask_project の question 引数の長さ上限（UTF-16 コードユニット数基準） */
export const ASK_QUESTION_MAX_LENGTH = 4000;

/** レート制限のスライディング窓（5 分。ask-member の実績値を流用） */
export const ASK_RATE_WINDOW_MS = 5 * 60 * 1000;

/** プロジェクトあたりのレート上限（窓あたり。ask-member の ASK_TARGET_LIMIT と同値） */
export const ASK_PROJECT_LIMIT = 8;

/** ユーザー全体のレート上限（窓あたり。ask-member の ASK_USER_LIMIT と同値） */
export const ASK_USER_LIMIT = 20;

/**
 * 質問の回答待ちタイムアウト（15分）。
 * - 実行中判定の窓（同一プロジェクトの同時実行 1 件ガード）
 * - `deriveAskState()` の `failed`（応答なしタイムアウト）判定
 * の両方に使う単一の値。
 */
export const ASK_ANSWER_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * プラン相の書き込み不可が「権限レベルで構造的に強制される」AI ツール。
 * - claude (Agent SDK): canUseTool + PLAN_WRITE_TOOLS の最終防衛線
 * - codex: CLI `-c sandbox_mode="read-only"`
 * ここに devin/gemini を追加してはならない（回帰ガードでテスト固定する）。
 * claude であっても `Project.terminalMode` が true の場合は PTY 経由の素の `claude --continue` が
 * 起動し `--permission-mode plan` が適用されないため、強制対象から外れる
 * （`decideAskReadOnlyEnforcement` 参照）。
 */
export const ENFORCED_READONLY_AI_TOOLS = ['claude', 'codex'] as const;

/**
 * 質問ターンの書き込み不可が権限レベルで強制されるかどうかを判定する。
 * 2026-09-26 承認サイクルの人間判断: devin / terminalMode（および将来の gemini）へは
 * AI の差し替えを行わず、そのままの AI で実行する。その代わり、権限で強制できない経路では
 * `buildAskPromptPrefix()` の固定禁止文をプロンプト先頭に必ず付与し、応答の `readOnlyEnforced`
 * で「権限で強制」か「プロンプト指示のみ」かを呼び出し元に明示する。
 */
export function decideAskReadOnlyEnforcement(input: { aiTool: string; terminalMode: boolean }): { readOnlyEnforced: boolean } {
  const toolEnforced = (ENFORCED_READONLY_AI_TOOLS as readonly string[]).includes(input.aiTool);
  return { readOnlyEnforced: toolEnforced && !input.terminalMode };
}

/**
 * 質問プロンプトの先頭に付与する固定の禁止文（権限で強制できない経路専用）。
 * 2026-09-26 承認サイクルでの人間指示の文言をそのまま使う。
 */
export const ASK_MODE_PROHIBITION_TEXT =
  'これは質問です。ファイルの作成・編集・削除、コマンドによる変更、git操作など一切の書き込みを行わず、調査と回答のみ行ってください。';

/**
 * 質問ターン全般（権限で強制される経路も含む）に付与するモードの説明文。
 * Agent 側の `PLAN_MODE_INSTRUCTION`（`e`/`exec` を送るよう案内する）は
 * `isPlanTurn` から自動的に付与されてしまう（Agent 側は無変更のため抑止できない）。
 * このテキストは payload.prompt の一部として送られ、Agent 側の合成順序
 * （`effectiveModeInstruction + ... + promptWithFiles`）により PLAN_MODE_INSTRUCTION より
 * 後方に置かれるため、より新しい・具体的な指示として実質的に上書きする（Agent 側を変えない
 * ための意図的な選択）。
 */
export const ASK_MODE_INSTRUCTION = [
  '【質問モード】',
  '以下は質問です。実装・ファイル変更・コミットは不要です。プランの立案も不要です。',
  '調査・確認のうえ、質問への回答のみを返してください。「e」「exec」等の実行承認の案内も不要です。',
].join('\n');

/**
 * ask_project が Agent に送るプロンプトの接頭辞を組み立てる（質問本文はここに含めない。
 * 呼び出し側が `fenceHumanText('askProject', question)` と連結する）。
 *
 * @param readOnlyEnforced `decideAskReadOnlyEnforcement()` の判定結果
 */
export function buildAskPromptPrefix(readOnlyEnforced: boolean): string {
  const prohibition = readOnlyEnforced ? '' : `【重要】${ASK_MODE_PROHIBITION_TEXT}\n\n`;
  return `${prohibition}${ASK_MODE_INSTRUCTION}`;
}

/** 実行中とみなせる ask セッションの最小情報（同一プロジェクトの同時実行 1 件ガード用） */
export interface InflightAskSessionRow {
  id: string;
  startedAt: Date;
  /** role='ai' の Message が既に存在するか（true なら回答済み = 実行中ではない） */
  hasAnswer: boolean;
}

/**
 * 実行中とみなせる ask セッションを 1 件返す（無ければ null）。
 * `cross-query-guard.ts` の `pickInflightCrossSession` と同じ設計（複数件が窓内にある場合は
 * 最新のものを返す）。回答済み（hasAnswer=true）の行は実行中とみなさない。
 */
export function pickInflightAskSession(rows: InflightAskSessionRow[], nowMs: number, windowMs: number): string | null {
  const cutoff = nowMs - windowMs;
  let best: InflightAskSessionRow | null = null;
  for (const row of rows) {
    if (row.hasAnswer) continue;
    const t = row.startedAt.getTime();
    if (t < cutoff) continue;
    if (!best || t > best.startedAt.getTime()) {
      best = row;
    }
  }
  return best?.id ?? null;
}

export type AskRateLimitDecision =
  | { allowed: true }
  | { allowed: false; reason: 'projectBusy'; inflightSessionId: string }
  | { allowed: false; reason: 'projectRate'; count: number; limit: number }
  | { allowed: false; reason: 'userRate'; count: number; limit: number };

/**
 * ask_project の宛先を許可するか判定する。
 *
 * 判定順（この順序を変えないこと。テストで固定している）:
 * 1. projectBusy（429 相当）: 同一プロジェクトに実行中（未回答）の質問が 1 本でもあれば拒否
 * 2. projectRate（429 相当）: 同一プロジェクトへの直近 5 分の質問数が上限以上
 * 3. userRate（429 相当）: ユーザー全体の直近 5 分の質問数が上限以上
 * 4. それ以外は allow
 */
export function decideAskRateLimit(input: {
  projectRecentCount: number;
  userRecentCount: number;
  inflightAskSessionId?: string | null;
}): AskRateLimitDecision {
  if (input.inflightAskSessionId) {
    return { allowed: false, reason: 'projectBusy', inflightSessionId: input.inflightAskSessionId };
  }
  if (input.projectRecentCount >= ASK_PROJECT_LIMIT) {
    return { allowed: false, reason: 'projectRate', count: input.projectRecentCount, limit: ASK_PROJECT_LIMIT };
  }
  if (input.userRecentCount >= ASK_USER_LIMIT) {
    return { allowed: false, reason: 'userRate', count: input.userRecentCount, limit: ASK_USER_LIMIT };
  }
  return { allowed: true };
}

export type AskState = 'queued' | 'running' | 'answered' | 'failed' | 'cancelled';

/**
 * get_answer の状態を導出する。
 *
 * 優先順位（この順序を変えないこと。テストで固定している）:
 * cancelled → answered → running → failed（タイムアウト超過）→ queued
 *
 * - `hasAiMessage`: role='ai' の Message が存在するか。isComplete===true のときだけ作られる
 *   ため（`agent-manager.ts` の `handleAiOutput`）、これが true なら部分テキストではなく
 *   確定した完了報告であることが構造的に保証される。
 * - `hasActiveProgress`: `getActiveProgressForChatId()` のトラッカーが存在するか（実行中の目印）。
 */
export function deriveAskState(input: {
  cancelledAt: Date | null;
  hasAiMessage: boolean;
  hasActiveProgress: boolean;
  startedAtMs: number;
  nowMs: number;
  timeoutMs: number;
}): { state: AskState; elapsedSeconds: number } {
  const elapsedSeconds = Math.max(0, Math.floor((input.nowMs - input.startedAtMs) / 1000));
  if (input.cancelledAt) {
    return { state: 'cancelled', elapsedSeconds };
  }
  if (input.hasAiMessage) {
    return { state: 'answered', elapsedSeconds };
  }
  if (input.hasActiveProgress) {
    return { state: 'running', elapsedSeconds };
  }
  if (input.nowMs - input.startedAtMs > input.timeoutMs) {
    return { state: 'failed', elapsedSeconds };
  }
  return { state: 'queued', elapsedSeconds };
}

/** cancel_submission が拒否する場合の理由コード */
export type CancelRejectCode = 'notFound' | 'userMismatch' | 'projectMismatch' | 'alreadyCancelled' | 'alreadyApproved';

/**
 * cancel_submission の所有検証 + 状態検証。
 *
 * 判定順（この順序を変えないこと。テストで固定している）:
 * notFound → userMismatch → projectMismatch → alreadyCancelled → alreadyApproved → ok
 *
 * `alreadyCancelled` は呼び出し側で「エラーではなく冪等成功」として扱うこと
 * （LLM のリトライに優しい設計。#294 の思想を踏襲）。
 * `alreadyApproved` は 2026-09-26 承認サイクルの人間判断により拒否固定（実行中/完了済みの
 * exec を途中で切ると作業ツリーが半端に壊れるため。force オプションは設けない）。
 */
export function decideCancel(input: {
  session: { userId: string; projectId: string; approvedAt: Date | null; cancelledAt: Date | null } | null;
  requestedUserId: string;
  requestedProjectId?: string;
}): { ok: true } | { ok: false; code: CancelRejectCode; message: string } {
  const { session, requestedUserId, requestedProjectId } = input;

  if (!session) {
    return { ok: false, code: 'notFound', message: 'Submission not found' };
  }
  if (session.userId !== requestedUserId) {
    return { ok: false, code: 'userMismatch', message: 'Submission does not belong to this user' };
  }
  if (requestedProjectId && session.projectId !== requestedProjectId) {
    return { ok: false, code: 'projectMismatch', message: 'Submission does not belong to this project' };
  }
  if (session.cancelledAt) {
    return { ok: false, code: 'alreadyCancelled', message: 'This submission was already cancelled.' };
  }
  if (session.approvedAt) {
    return {
      ok: false,
      code: 'alreadyApproved',
      message: 'Cannot cancel: this submission has already been approved. Implementation is in progress or completed.',
    };
  }
  return { ok: true };
}

/**
 * cancel_submission の atomic claim 用 where 句を組み立てる。
 * `approvedAt: null` と `cancelledAt: null` の両方を条件にすることで、approve と cancel が
 * 同一行を争ったとき DB の行単位 UPDATE の直列化により必ずどちらか一方だけが count===1 になる
 * （approve 側の claim も同じサイクルで `cancelledAt: null` を条件に追加する。submission-guard.ts 参照）。
 */
export function buildCancelClaimWhere(submissionId: string): { id: string; approvedAt: null; cancelledAt: null } {
  return { id: submissionId, approvedAt: null, cancelledAt: null };
}

/**
 * `DEVRELAY_MCP_ASK` 環境変数を解釈する。
 * 既定 ON（'0' が明示されたときのみ無効）。`DEVRELAY_PLAN_STRICT_CHAT` と同じ流儀。
 */
export function isMcpAskEnabled(raw: string | undefined): boolean {
  return raw !== '0';
}
