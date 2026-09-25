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
 *
 * Phase 1.4: `resolveRawModel()` の優先順位を Agent 側 `resolveRawUsedModel()`
 * （`agents/{linux,macos}/src/services/raw-completion-mode.ts`）と整合させた。旧実装は
 * `usageData.modelUsage` の**先頭キー**を第2候補にしていたが、SDK が毎ターン付随的に行う
 * セッションタイトル生成（Haiku 内部呼び出し）が先に列挙されると誤ったモデルを報告する事故が
 * あった（2.1.278 実測）。新しい Agent は `usageData.model` に正しい値を送るため（分岐1）
 * このサーバー側ロジックは主に旧 Agent との後方互換・保険として機能する。
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

/** `usageData.modelUsage` の1エントリから `outputTokens` を安全に数値として取り出す（欠落・非数値は 0） */
function readModelUsageOutputTokens(entry: unknown): number {
  if (entry && typeof entry === 'object' && 'outputTokens' in entry) {
    const v = (entry as { outputTokens?: unknown }).outputTokens;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return 0;
}

/**
 * 前方一致の残り部分が「日付スナップショット接尾辞」形式（`-YYYYMMDD`、8桁）かどうかを判定する。
 * Opus 5.5 追加サイクルで発見: 単純な `startsWith()` だと `claude-opus-5` が
 * `claude-opus-5-5`（別モデル・Claude Opus 5.5）にも前方一致してしまい、誤ったモデル名を
 * 報告しうる。日付スナップショット接尾辞のみを許容することで、この種の「新モデルの ID が
 * 旧モデルの ID を接頭辞として含む」ケースを排除する。
 */
function isDateSnapshotSuffix(remainder: string): boolean {
  return /^-\d{8}$/.test(remainder);
}

/**
 * `modelUsage` のキーのうち `requestedModel` と完全一致するもの、無ければ前方一致するものを探す
 * （例: 指定 `claude-opus-5` に対し `claude-opus-5-20260301` を許容）。前方一致は残り部分が
 * 日付スナップショット接尾辞（`-YYYYMMDD`）の場合のみ許容する（`claude-opus-5` に対し
 * `claude-opus-5-5` のような**別モデル**は許容しない）。前方一致が複数あれば
 * 最も短いキーを優先する（Agent 側 `findModelUsageKeyMatchingRequest()` と同じロジック）。
 */
function findModelUsageKeyMatchingRequest(modelUsage: Record<string, unknown>, requestedModel: string): string | undefined {
  const keys = Object.keys(modelUsage);
  if (keys.includes(requestedModel)) return requestedModel;
  const prefixMatches = keys.filter((k) => k.startsWith(requestedModel) && isDateSnapshotSuffix(k.slice(requestedModel.length)));
  if (prefixMatches.length === 0) return undefined;
  return prefixMatches.reduce((shortest, k) => (k.length < shortest.length ? k : shortest));
}

/** `modelUsage` のうち `outputTokens` が最大のキーを返す（同点は先に列挙された方を優先） */
function findModelUsageKeyWithMaxOutputTokens(modelUsage: Record<string, unknown>): string | undefined {
  let best: string | undefined;
  let bestTokens = -1;
  for (const [key, entry] of Object.entries(modelUsage)) {
    const tokens = readModelUsageOutputTokens(entry);
    if (tokens > bestTokens) {
      best = key;
      bestTokens = tokens;
    }
  }
  return best;
}

/**
 * レスポンスに載せる `model` を解決する（Phase 1.4 で優先順位を是正、本ファイル冒頭 JSDoc 参照）。
 * 優先順:
 * 1. `usageData.model`（新 Agent が `resolveRawUsedModel()` で判定した実際の使用モデル）
 * 2. `requestedModel` と一致する `usageData.modelUsage` キー（完全一致 → 前方一致の順。
 *    旧 Agent が `model` を送らない場合への保険）
 * 3. `usageData.modelUsage` のうち `outputTokens` が最大のキー（最終手段。セッションタイトル生成等の
 *    内部呼び出しを先頭キーとして誤って拾わないよう、これを第一候補にはしない）
 * 4. リクエストで指定された `model`（実行前の希望値。実際に使われた保証は無いが無いよりまし）
 * 5. すべて無ければ `undefined`
 *
 * @param usageData `AiRunResult.usageData` 相当（未指定・null も許容）
 * @param requestedModel リクエストボディの `model`（未指定可）
 */
export function resolveRawModel(usageData?: RawUsageDataLike | null, requestedModel?: string): string | undefined {
  if (usageData?.model && usageData.model.trim().length > 0) {
    return usageData.model;
  }
  const modelUsage = usageData?.modelUsage;
  if (modelUsage && typeof modelUsage === 'object') {
    if (requestedModel && requestedModel.trim().length > 0) {
      const matched = findModelUsageKeyMatchingRequest(modelUsage, requestedModel);
      if (matched !== undefined) return matched;
    }
    const maxOutput = findModelUsageKeyWithMaxOutputTokens(modelUsage);
    if (maxOutput !== undefined) return maxOutput;
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
  /** Phase 2: このリクエストが実際に使った AI（`raw-completion-ai.ts` の `resolveRawAi()` で解決済み） */
  ai: 'claude' | 'codex';
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
  /** Phase 2: このリクエストが実際に使った AI（常に存在する） */
  ai: 'claude' | 'codex';
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
  const { result, sessionId, requestedModel, latencyMs, ai } = input;
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
      ai,
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
      ai,
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
    ai,
  };
}
