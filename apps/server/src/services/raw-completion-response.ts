/**
 * raw-completion（ゲーム席用の素の completion API、`POST /api/agent/raw-completion`）の
 * HTTP レスポンス組み立て専用ロジック。`raw-completion-guard.ts`（流量制御）とは単一責務の原則で
 * 分離する（あちらは「入口の防御」、こちらは「出口の整形」）。
 *
 * 外部 import ゼロの純関数のみで構成する（#332 `permission-policy.ts` / #348 `cross-query-guard.ts` /
 * `raw-completion-guard.ts` と同じ流儀）。`AiUsageData` 等の型も import せず、必要な形だけを
 * ローカルの duck-typing インターフェースで受ける（本ファイル自体を単体テスト対象として独立させるため）。
 *
 * Phase 1.1（HTTP レスポンス契約の確定）: 新契約のキーは常に存在する（`text`/`usage`/`deniedTools`/
 * `stopReason`/`sessionId` は undefined を返さない）。失敗時（`ok:false` 相当）も同じ形の superset を
 * 返し、呼び出し元が `ok`/`error` の有無だけで分岐できるようにする。
 *
 * `mapRawUsage()`（agents 側の削除済み死コード、Phase 1.1 要件3）の後継。ai-runner.ts の
 * `result.usageData`（`{usage,modelUsage,durationMs,model,rateLimits}`）を HTTP 契約の
 * `{input,output,cacheRead,cacheWrite}` へ変換するのは Agent の関心ではなくサーバーの関心
 * （HTTP レスポンスの表現）であるため、ここに新設する。
 */

/** `AiUsageData`（`packages/shared`）の一部だけを duck-typing で受ける（外部 import ゼロを維持） */
export interface RawUsageDataLike {
  /** per-request トークン情報。SDK 実キー: input_tokens / output_tokens / cache_read_input_tokens / cache_creation_input_tokens */
  usage?: Record<string, unknown>;
  /** モデル別セッション累積トークン。キーがモデル名 */
  modelUsage?: Record<string, unknown>;
  /** 使用モデル名 */
  model?: string;
}

/** `buildRawCompletionResponse()` が返す `usage` フィールドの形（新 HTTP 契約） */
export interface RawUsageSummary {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * 数値として安全に解釈できない値（欠落・非数値・NaN・負値）を 0 に丸める。
 * 小数は切り捨てる（トークン数は整数のはずだが、SDK の将来変化に対する保険）。
 */
function toSafeCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

/**
 * `usageData.usage`（SDK 実キー）を新 HTTP 契約の `{input,output,cacheRead,cacheWrite}` へ写像する。
 * キーの欠落・非数値・NaN・負値はすべて 0 埋めする（例外を投げない、キーを落とさない）。
 *
 * @param usageData `AiRunResult.usageData` 相当（未指定・null も許容）
 */
export function summarizeRawUsage(usageData?: RawUsageDataLike | null): RawUsageSummary {
  const usage = usageData?.usage ?? {};
  return {
    input: toSafeCount(usage.input_tokens),
    output: toSafeCount(usage.output_tokens),
    cacheRead: toSafeCount(usage.cache_read_input_tokens),
    cacheWrite: toSafeCount(usage.cache_creation_input_tokens),
  };
}

/**
 * レスポンスに載せる `model` を解決する。優先順:
 * 1. `usageData.model`（SDK が報告した実際の使用モデル）
 * 2. `usageData.modelUsage` の先頭キー（`model` が欠落していても modelUsage はあるケースへの保険）
 * 3. リクエストで指定された `model`（実行前の希望値。実際に使われた保証は無いが無いよりまし）
 * 4. すべて無ければ `undefined`
 *
 * @param usageData `AiRunResult.usageData` 相当（未指定・null も許容）
 * @param requestedModel リクエストボディの `model`（未指定可）
 */
export function resolveRawModel(usageData?: RawUsageDataLike | null, requestedModel?: string): string | undefined {
  if (usageData?.model && usageData.model.trim().length > 0) {
    return usageData.model;
  }
  const modelUsageKeys = usageData?.modelUsage ? Object.keys(usageData.modelUsage) : [];
  if (modelUsageKeys.length > 0) {
    return modelUsageKeys[0];
  }
  if (requestedModel && requestedModel.trim().length > 0) {
    return requestedModel;
  }
  return undefined;
}

/** 重複を除去しつつ入力順を保つ（`Set` の挿入順保証を利用）。入力配列そのものは変更しない */
function dedupeDeniedTools(tools?: readonly string[]): string[] {
  if (!tools || tools.length === 0) return [];
  return [...new Set(tools)];
}

/**
 * `buildRawCompletionResponse()` の入力。`RawResultPayload`（`packages/shared`）の一部を
 * duck-typing で受ける（外部 import ゼロを維持するため）。
 */
export interface RawCompletionResponseInput {
  /** Agent 側の実行結果（`agent:raw:result` の payload そのものを渡すことを想定） */
  result: {
    ok: boolean;
    /** 新 Agent（Phase 1.1 以降）が送る本文。旧 Agent は送らない（`undefined` が検知シグナル） */
    text?: string;
    /** @deprecated 旧 Agent 互換の別名。`text` が無い場合のみ参照する */
    output?: string;
    usageData?: RawUsageDataLike | null;
    stopReason?: string;
    errorMessage?: string;
    deniedTools?: string[];
    agentDurationMs?: number;
  };
  /** 作成済みの `raw_` セッション ID（DB の `Session.id`） */
  sessionId: string;
  /** リクエストボディで指定されたモデル（`resolveRawModel` のフォールバック用） */
  requestedModel?: string;
  /** ルートハンドラの開始時刻からの経過ミリ秒 */
  latencyMs: number;
}

/** `buildRawCompletionResponse()` が返す HTTP レスポンスボディ（新契約、常に全キーが存在する） */
export interface RawCompletionResponseBody {
  text: string;
  /** @deprecated 旧クライアント互換の別名。`text` と同値 */
  output: string;
  model?: string;
  usage: RawUsageSummary;
  latencyMs: number;
  agentDurationMs: number;
  stopReason: string;
  sessionId: string;
  /** `ok:false` 相当、または旧 Agent 検知時にのみ設定する */
  error?: string;
  deniedTools: string[];
}

/**
 * Agent の実行結果から新 HTTP 契約のレスポンスボディを組み立てる。例外は投げない。
 *
 * 3つの分岐（この順序で判定する）:
 *   1. `result.ok === false` … SDK 実行自体が失敗。`text`/`output` は空文字にし `error` を必ず設定する
 *   2. `result.ok === true` かつ `typeof result.text !== 'string'` … 旧 Agent（Phase 1.1 より前、
 *      `u` 未実行）を検知。無言の空文字ではなく `error` に明示する（呼び出し元が `pm2 logs` 無しで
 *      原因を特定できるようにするため）
 *   3. それ以外（新 Agent の成功） … `text`（無ければ `output`、両方無ければ空文字）を採用する
 *
 * `stopReason` は空・未指定なら `ok` に応じて `'success'`/`'error'` に正規化する（無言の切り詰めを
 * 隠さない、#325 の踏襲）。`deniedTools` は常に配列（重複除去済み）を返す。
 */
export function buildRawCompletionResponse(input: RawCompletionResponseInput): RawCompletionResponseBody {
  const { result, sessionId, requestedModel, latencyMs } = input;
  const usage = summarizeRawUsage(result.usageData);
  const model = resolveRawModel(result.usageData, requestedModel);
  const agentDurationMs = toSafeCount(result.agentDurationMs);
  const deniedTools = dedupeDeniedTools(result.deniedTools);
  const safeLatencyMs = toSafeCount(latencyMs);

  const normalizedStopReason = (reason: string | undefined, fallback: 'success' | 'error'): string =>
    reason && reason.trim().length > 0 ? reason : fallback;

  // 分岐1: SDK 実行自体の失敗
  if (!result.ok) {
    return {
      text: '',
      output: '',
      model,
      usage,
      latencyMs: safeLatencyMs,
      agentDurationMs,
      stopReason: normalizedStopReason(result.stopReason, 'error'),
      sessionId,
      error: result.errorMessage && result.errorMessage.trim().length > 0
        ? result.errorMessage
        : 'raw-completion failed',
      deniedTools,
    };
  }

  // 分岐2: 旧 Agent 検知（`text` フィールド自体が無い＝ Phase 1.1 より前のバージョン）
  if (typeof result.text !== 'string') {
    return {
      text: '',
      output: '',
      model,
      usage,
      latencyMs: safeLatencyMs,
      agentDurationMs,
      stopReason: normalizedStopReason(result.stopReason, 'success'),
      sessionId,
      error: 'Agent response is missing `text` (outdated agent — run `u` on the target machine to update)',
      deniedTools,
    };
  }

  // 分岐3: 新 Agent の成功（`text` が唯一の正。空文字も正常な値として採用する）
  const text = result.text;
  return {
    text,
    output: text,
    model,
    usage,
    latencyMs: safeLatencyMs,
    agentDurationMs,
    stopReason: normalizedStopReason(result.stopReason, 'success'),
    sessionId,
    deniedTools,
  };
}
