/**
 * クロスプロジェクト連携（ask-member / teamexec-member）の「入口の防御」（#348）
 *
 * 2026-09-01 の輻輳事故（Windows CLI Agent 機で `ask --project pixblog` が自マシンの
 * 自プロジェクトに一致し、AI が自分自身に質問を送り続けた事故）を受けて追加。
 *
 * 外部 import ゼロの純関数のみで構成する（#332 `permission-policy.ts` / #334 `human-text-fence.ts` /
 * #337 `progress-timeout.ts` / #339 `claude-login-code.ts` と同じ流儀）。
 * `packages/shared` ではなく `apps/server` に置くのは意図的:
 * #310 で shared パッケージを web バンドルに引き込んで本番を白画面にした前例があり、
 * サーバー専用ロジックを shared に置く理由が無いため。
 *
 * ここで扱うのは「入口」の防御のみ（層 A）。同一 projectPath の状態共有そのものを断つ
 * 「直交化」（層 B）は Agent 側（`session-scope.ts` 等）の役割であり、本ファイルの対象外。
 */

/**
 * projectPath を比較可能な形に正規化する。
 *
 * - 前後の空白を除去
 * - バックスラッシュを `/` に統一（Windows パス対応）
 * - 末尾スラッシュを除去（ルート `/` 自身は除く）
 * - Windows パス（バックスラッシュを含む、またはドライブレター形式 `C:/...`）は
 *   大文字小文字を無視する比較のため小文字化する。POSIX パスは大文字小文字を区別するため
 *   小文字化しない
 *
 * @param raw 比較対象のパス（未指定・null・空文字は空文字として扱う）
 */
export function normalizeProjectPath(raw: string | null | undefined): string {
  if (!raw) return '';
  let p = raw.trim();
  if (p.length === 0) return '';

  const hasBackslash = p.includes('\\');
  p = p.replace(/\\/g, '/');

  while (p.length > 1 && p.endsWith('/')) {
    p = p.slice(0, -1);
  }

  const looksLikeWindowsDrive = /^[a-zA-Z]:\//.test(p);
  const isWindowsPath = hasBackslash || looksLikeWindowsDrive;
  return isWindowsPath ? p.toLowerCase() : p;
}

/** 実行中判定の対象になる cross セッションの最小情報 */
export interface InflightCrossSessionRow {
  id: string;
  startedAt: Date;
}

/**
 * 実行中とみなせる cross セッションを 1 件返す（無ければ null）。
 *
 * `rows` は呼び出し側（document-api.ts）が `status: 'active'` かつ対象プレフィックス
 * （`crossquery_` または `teamexec_`）で絞り込んだものを渡す想定。窓は mode ごとに異なるため
 * （crossquery=15分 / teamexec=既存 65 分）、呼び出し側が mode に応じた `windowMs` を渡す。
 * 複数件が窓内にある場合は最新（`startedAt` が最大）のものを返す。
 *
 * @param rows 実行中候補のセッション一覧
 * @param nowMs 現在時刻（ミリ秒、テスト容易性のため注入）
 * @param windowMs 「実行中」とみなす経過時間の上限（ミリ秒）
 */
export function pickInflightCrossSession(
  rows: InflightCrossSessionRow[],
  nowMs: number,
  windowMs: number,
): InflightCrossSessionRow | null {
  const cutoff = nowMs - windowMs;
  let best: InflightCrossSessionRow | null = null;
  for (const row of rows) {
    const t = row.startedAt.getTime();
    if (t < cutoff) continue;
    if (!best || t > best.startedAt.getTime()) {
      best = row;
    }
  }
  return best;
}

/** ask の実行中判定の窓（15 分）。teamexec は document-api.ts の既存 `CROSS_INFLIGHT_WINDOW_MS`（65 分）を再利用する */
export const ASK_INFLIGHT_WINDOW_MS = 15 * 60 * 1000;

export interface CrossTargetGuardInput {
  mode: 'ask' | 'teamexec';
  callerMachineId: string;
  targetMachineId: string;
  /** 発信元 Agent の自己申告 projectPath（#348 で `DEVRELAY_PROJECT` から新設）。未指定なら自己判定できない */
  callerProjectPath?: string | null;
  targetProjectPath: string;
  /** 呼び出し側が `pickInflightCrossSession()` で事前に解決した実行中セッション ID */
  inflightSessionId?: string | null;
}

export type CrossTargetDecision =
  | { allowed: true; selfCheck: 'verifiedDifferent' | 'unverified' }
  | { allowed: false; status: 400; reason: 'selfTarget' }
  | { allowed: false; status: 429; reason: 'targetBusy'; inflightSessionId: string };

/**
 * ask / teamexec の宛先を許可するか判定する。
 *
 * 判定順（この順序を変えないこと。テストで固定している）:
 * 1. Rule A（selfTarget → 400）: 同一マシン **かつ** 正規化後の projectPath が一致すれば拒否。
 *    `callerProjectPath` が空なら判定不能のため `unverified` で通す（fail-open）。
 *    旧 Agent は `callerProjectPath` を送らないため、ここを fail-close にすると全 ask が壊れる。
 * 2. Rule B（targetBusy → 429）: 同一宛先プロジェクトに実行中の cross セッションが 1 本でもあれば拒否。
 *    同時実行は 1 本まで。
 * 3. それ以外は allow。
 *
 * 400 と 429 が同時に成立する場合は 400 が勝つ（自己宛は永久に間違いであり、時間が解決する
 * 429 より優先して知らせるべきため）。
 */
export function decideCrossTarget(input: CrossTargetGuardInput): CrossTargetDecision {
  const { callerMachineId, targetMachineId, callerProjectPath, targetProjectPath, inflightSessionId } = input;
  const sameMachine = callerMachineId === targetMachineId;

  // Rule A: selfTarget（400）
  if (sameMachine && callerProjectPath) {
    const normCaller = normalizeProjectPath(callerProjectPath);
    const normTarget = normalizeProjectPath(targetProjectPath);
    if (normCaller && normCaller === normTarget) {
      return { allowed: false, status: 400, reason: 'selfTarget' };
    }
  }

  // Rule B: targetBusy（429）
  if (inflightSessionId) {
    return { allowed: false, status: 429, reason: 'targetBusy', inflightSessionId };
  }

  // allow
  if (!sameMachine) {
    // マシンが異なる時点で別プロジェクトであることは確定している
    return { allowed: true, selfCheck: 'verifiedDifferent' };
  }
  if (callerProjectPath) {
    // 同一マシンだが projectPath 比較で「別プロジェクト」と確認できた
    return { allowed: true, selfCheck: 'verifiedDifferent' };
  }
  // 同一マシンだが callerProjectPath 未申告のため自己判定できない（旧 Agent）
  return { allowed: true, selfCheck: 'unverified' };
}

/**
 * 拒否時にチャットへ返す文言を組み立てる。
 *
 * `noRetryNote`（#294 の `NO_RETRY_NOTE`）を必ず含める。理由だけを返すと AI は
 * 「失敗したから」と文面を変えて即座に再送し、輻輳を再発させることが #294 で実証済みのため。
 *
 * このファイル（document-api.ts）は i18n を一切使っていない（`grep -c "tChat\|i18n"` が 0）。
 * 既存の文言スタイル（日本語ハードコード＋絵文字なし）に合わせ、新規に i18n を持ち込まない。
 */
export function buildCrossTargetRejectionMessage(
  decision: CrossTargetDecision,
  ctx: { mode: 'ask' | 'teamexec'; targetProjectName: string; noRetryNote: string },
): string {
  if (decision.allowed) {
    throw new Error('buildCrossTargetRejectionMessage: decision must be a rejection (allowed=false)');
  }
  const actionLabel = ctx.mode === 'ask' ? '問い合わせ' : '実行依頼';

  if (decision.reason === 'selfTarget') {
    return `宛先エラー: '${ctx.targetProjectName}' はこのマシン自身のプロジェクトです。`
      + `自分自身への${actionLabel}はできません（何度やり直しても正しくなりません。設定を確認してください）。`
      + `${ctx.noRetryNote}`;
  }

  // targetBusy
  return `混雑エラー: '${ctx.targetProjectName}' は現在別の${actionLabel}を処理中です`
    + `（同時に受け付けられるのは1件までです）。完了を待ってから改めて送信してください。`
    + `${ctx.noRetryNote}`;
}
