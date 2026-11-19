/**
 * Usage 累計補正サイクル（2026-11-19）: Devin の usage が「セッション累計」で記録された行を
 * 「ターン分（前ターンとの差分）」に直すための純関数（外部 import なし。dist を node:test で直接テストする）。
 *
 * 背景: Agent は ATIF の `final_metrics` をそのまま 1 ターン分として記録していた。resume で ATIF が
 * 過去ターンを含む環境（例: PC45/exuser59）では累計になり、合算した金額が実請求の十数倍になった。
 * Agent 側は `resolveAtifTurnUsage()`（agents/*\/src/services/devin-atif.ts）で修正済み。ここは記録済み行の補正。
 *
 * 補正は「機体を指定して」行う（累計型かどうかは 1 行では判別できないため、機体ごとの単調増加率を
 * dry-run で見てから人が選ぶ）。
 */

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

const KEYS: (keyof TokenUsage)[] = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];

/** usageData の usage（など）を TokenUsage に正規化する。input/output が無ければ null。 */
export function toTokenUsage(raw: unknown): TokenUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const input = n(r.input_tokens);
  const output = n(r.output_tokens);
  if (input === null || output === null) return null;
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: n(r.cache_read_input_tokens) ?? 0,
    cache_creation_input_tokens: n(r.cache_creation_input_tokens) ?? 0,
  };
}

/** cur が prev の「続きの累計」に見えるか（全項目が前回以上、かつ入力か出力が増えている）。 */
export function looksCumulative(prev: TokenUsage, cur: TokenUsage): boolean {
  return KEYS.every((k) => cur[k] >= prev[k]) && (cur.input_tokens > prev.input_tokens || cur.output_tokens > prev.output_tokens);
}

export interface FixTurnInput {
  id: string;
  usageData: unknown;
}

export interface FixTurnPlan {
  id: string;
  /** 補正後の 1 ターン分 */
  turnUsage: TokenUsage;
  /** 補正の基になった累計値 */
  cumulative: TokenUsage;
  /** usageData を書き換える必要があるか（既に同じ値で補正済みなら false） */
  changed: boolean;
}

/**
 * 1 スレッド（DevRelay の Session）内の Devin ターン（古い順）から、各ターンの「ターン分」を求める。
 * - 累計は `usageData.cumulativeUsage`（補正済み・新 Agent の行）→ `usageData.usage` の順で取る（再実行しても同じ結果）
 * - 新 Agent が既にターン分を記録した行（usageMode 'delta' / 'steps'）は書き換えず、累計だけ次の基準に使う
 * - 前ターンの累計より減っている項目があれば新しいトラジェクトリとみなし、その行の累計をそのままターン分にする
 * - usage の無い行（金額不明）は飛ばし、基準も変えない
 */
export function planCumulativeFix(turns: FixTurnInput[]): FixTurnPlan[] {
  const out: FixTurnPlan[] = [];
  let prev: TokenUsage | null = null;
  for (const t of turns) {
    const d = (t.usageData && typeof t.usageData === 'object' ? t.usageData : {}) as Record<string, unknown>;
    const usage = toTokenUsage(d.usage);
    const cumulative = toTokenUsage(d.cumulativeUsage) ?? usage;
    if (!usage || !cumulative) continue;
    if (d.usageMode === 'delta' || d.usageMode === 'steps') {
      prev = cumulative;
      continue;
    }
    let turnUsage: TokenUsage;
    if (prev && KEYS.every((k) => cumulative[k] >= prev![k])) {
      turnUsage = { ...cumulative };
      for (const k of KEYS) turnUsage[k] = cumulative[k] - prev[k];
    } else {
      turnUsage = { ...cumulative };
    }
    const changed = KEYS.some((k) => usage[k] !== turnUsage[k]);
    out.push({ id: t.id, turnUsage, cumulative, changed });
    prev = cumulative;
  }
  return out;
}

/** 補正後の usageData（元の他フィールドは保持。modelUsage の値もターン分に揃える）。 */
export function applyFixToUsageData(usageData: unknown, plan: FixTurnPlan): Record<string, unknown> {
  const d = { ...((usageData && typeof usageData === 'object' ? usageData : {}) as Record<string, unknown>) };
  d.usage = { ...plan.turnUsage };
  const mu = d.modelUsage;
  if (mu && typeof mu === 'object') {
    const next: Record<string, unknown> = {};
    for (const key of Object.keys(mu as Record<string, unknown>)) next[key] = { ...plan.turnUsage };
    d.modelUsage = next;
  }
  d.usageMode = 'delta-fixed';
  d.cumulativeUsage = { ...plan.cumulative };
  return d;
}
