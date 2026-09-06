/**
 * Devin モデル選択サイクル・サイクル B（変更4/変更5）: ATIF（`devin --export`）を読み解く純関数群。
 *
 * 旧 `ai-runner.ts` 内の `summarizeAtifEntry()`/`buildDevinStepSummary()` は以下 2 点で
 * 実際の ATIF-v1.7 構造と噛み合っていなかった（Phase0 実測 `federated-snacking-snowglobe.md` 判明11-16）。
 *
 * 1. エントリ配列のキーが `messages` ではなく **`steps`**（判明14）。
 *    `tool_calls[].function_name` + `arguments.command`（判明16、`name`/`function.name` ではない）。
 *    `observation.results[].content` は **絶対にチャットへ出してはいけない**（判明16）。
 * 2. ライブポーラーが「JSON.parse に成功した行」ごとにステップ数をカウントしていたため、
 *    pretty-print された単一 JSON の配列末尾スカラー行（`    "pattern"` 等）も単独で valid JSON
 *    となり誤カウントされていた（8 ステップが 38 と数えられた実測、判明15）。
 *
 * さらに変更5として、モデル名（`agent.model_name` 人間可読 / `steps[].extra.generation_model`
 * 機械可読、判明11）と使用量（`final_metrics`、判明12）を Claude 互換キーへマップして読む。
 *
 * この関数群は **外部 import ゼロ**（`node:test` から直接 `dist/` を import してテストするため。
 * `devin-diagnostics.ts`/`cli-failure.ts`/`session-scope.ts`/`plan-permission.ts` と同じ流儀）。
 * `tChat()` 等の表示整形は一切行わず、構造化データのみを返す（呼び出し側の `ai-runner.ts` が
 * 表示文言を組み立てる。これにより windows の `log.*` 表記差にも影響されず 3 OS で
 * byte-for-byte 同一に保てる）。
 */

/** ATIF 1 ステップの要約（表示用の組み立ては呼び出し側が行う） */
export interface AtifStepSummary {
  tool: string | null;
  title: string | null;
}

/** `final_metrics` を Claude 互換キーへマップしたトークン使用量 */
export interface AtifUsageTotals {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

/** ATIF 全体から読み取った内容のまとめ */
export interface AtifDigest {
  schemaVersion: string | null;
  steps: AtifStepSummary[];
  /** `agent.model_name`（人間可読） */
  modelName: string | null;
  /** `steps[].extra.generation_model`（機械可読、ステップレベルの値を優先） */
  modelId: string | null;
  usage: AtifUsageTotals | null;
  /** 実際のステップ数（`extractAtifEntries()` の長さ。誤カウント是正の中核） */
  totalSteps: number;
  /** `agent.extra.permission_mode`（console ログ専用、チャットには出さない） */
  permissionMode: string | null;
}

/**
 * ATIF の parse 済みオブジェクトから「ステップ配列」を取り出す。
 * 優先順位: `steps`（ATIF-v1.7 の実キー）→ `messages`（旧形式、後方互換）→ 配列そのもの → `[parsed]`。
 * @param parsed JSON.parse 済みの ATIF 全体（単一 JSON）
 * @returns ステップ（またはメッセージ）の配列。**例外を投げない**
 */
export function extractAtifEntries(parsed: unknown): unknown[] {
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.steps)) return obj.steps;
    if (Array.isArray(obj.messages)) return obj.messages;
  }
  if (Array.isArray(parsed)) return parsed;
  return [parsed];
}

/**
 * ATIF 1 エントリを表示用の要約（ツール名 + タイトル）に変換する。
 * 非オブジェクト（pretty-print された配列末尾のスカラー行等）は必ず null を返すため、
 * これ自体がステップ数の誤カウントに対する構造的なガードになる。
 * `observation.results[].content` は一切参照しない（判明16、漏洩防止）。
 * @param entry ATIF の 1 ステップ（または旧形式の 1 メッセージ）
 * @returns 表示用の要約。認識できない/表示すべきでない場合は null
 */
export function summarizeAtifEntry(entry: unknown): AtifStepSummary | null {
  if (!entry || typeof entry !== 'object') return null;
  const e = entry as Record<string, unknown>;

  // system/user のエントリは AI の実行ステップではないため表示しない
  if (e.source === 'system' || e.source === 'user') return null;

  // ATIF-v1.7 の実構造: tool_calls[0].function_name + arguments.command
  if (Array.isArray(e.tool_calls) && e.tool_calls.length > 0) {
    const call = e.tool_calls[0];
    if (call && typeof call === 'object') {
      const c = call as Record<string, unknown>;
      const tool = typeof c.function_name === 'string' && c.function_name ? c.function_name : null;
      if (tool) {
        const args = c.arguments;
        const command = args && typeof args === 'object' && typeof (args as Record<string, unknown>).command === 'string'
          ? ((args as Record<string, unknown>).command as string)
          : null;
        return { tool, title: command ? command.slice(0, 80) : null };
      }
    }
  }

  // レガシー形式（旧 messages 形式で使われていたフィールド名）
  const legacyTool = (typeof e.tool_name === 'string' && e.tool_name)
    || (typeof e.tool === 'string' && e.tool)
    || (typeof e.name === 'string' && e.name)
    || null;
  if (legacyTool) {
    const legacyTitle = (typeof e.title === 'string' && e.title)
      || (typeof e.command === 'string' && e.command)
      || (typeof e.action === 'string' && e.action)
      || null;
    return { tool: legacyTool, title: legacyTitle ? legacyTitle.slice(0, 80) : null };
  }

  // tool_calls を持たない agent エントリ（テキスト応答ステップ）
  if (e.source === 'agent' && typeof e.message === 'string' && e.message) {
    return { tool: null, title: e.message.slice(0, 80) };
  }

  if (typeof e.title === 'string' && e.title) {
    return { tool: null, title: e.title.slice(0, 100) };
  }
  if (typeof e.type === 'string' && e.type) {
    return { tool: null, title: `[${e.type}]` };
  }
  return null;
}

/**
 * 「今回のターンで実行されたステップ」だけを取り出す（#365、無関係な過去ターンの表示防止）。
 *
 * `--export` は turn ではなく **セッション全体**の ATIF を書き出すため（devin session を `-r` で
 * resume すると毎ターン全トラジェクトリが書き直される）、前ターン終了時点のステップ数
 * （オフセット、`session-store.ts` に永続化）との差分を取ることで今回分だけに絞り込む。
 *
 * `offset` が壊れている場合（devin 側でステップが圧縮・再採番された等、`offset <= 0` または
 * `offset >= steps.length`）は **全件を返す**（`omitted: 0`）。壊れたオフセットのせいで
 * 今回のステップが全て消えてしまう事故を避けるためのフォールバック。
 *
 * @param steps `buildAtifDigest()` が返した全ステップ
 * @param offset 前ターン終了時点の累計ステップ数（0 または未保存なら先頭から全件が「今回分」）
 * @returns 今回分のステップと、オフセットにより省かれた件数（フォールバック時は常に 0）
 */
export function sliceStepsFromOffset(steps: AtifStepSummary[], offset: number): { steps: AtifStepSummary[]; omitted: number } {
  if (!Array.isArray(steps) || !Number.isFinite(offset) || offset <= 0 || offset >= steps.length) {
    return { steps: Array.isArray(steps) ? steps : [], omitted: 0 };
  }
  return { steps: steps.slice(offset), omitted: offset };
}

/**
 * ATIF から使用モデル名を抽出する。
 * `agent.model_name`（人間可読）と `steps[].extra.generation_model`（機械可読）は別物であり、
 * 実際に生成へ使われた値である後者を `modelId` として優先的に採用する（判明11）。
 * @param parsed JSON.parse 済みの ATIF 全体
 * @returns 見つからなければ両方 null
 */
export function extractAtifModel(parsed: unknown): { modelName: string | null; modelId: string | null } {
  let modelName: string | null = null;
  let modelId: string | null = null;
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    const agent = obj.agent;
    if (agent && typeof agent === 'object') {
      const a = agent as Record<string, unknown>;
      if (typeof a.model_name === 'string' && a.model_name) modelName = a.model_name;
    }
    // #365: 複数ステップで generation_model が異なる場合、実際に「最後に使われた」値を
    // 採用するため逆順走査に変更（旧実装は先頭から走査し最初の一致で break していたため、
    // 診断用の別モデル呼び出し等が先頭にあると誤ってそちらの値を表示してしまっていた）。
    const steps = Array.isArray(obj.steps) ? obj.steps : [];
    for (let i = steps.length - 1; i >= 0; i--) {
      const step = steps[i];
      if (!step || typeof step !== 'object') continue;
      const extra = (step as Record<string, unknown>).extra;
      if (extra && typeof extra === 'object') {
        const ex = extra as Record<string, unknown>;
        if (typeof ex.generation_model === 'string' && ex.generation_model) {
          modelId = ex.generation_model;
          break;
        }
      }
    }
  }
  return { modelName, modelId };
}

/**
 * ATIF の `final_metrics` を Claude 互換キー（`input_tokens`/`output_tokens`/
 * `cache_read_input_tokens`/`cache_creation_input_tokens`）へマップする（変更5、判明12）。
 * @param parsed JSON.parse 済みの ATIF 全体
 * @returns `final_metrics` が無ければ null。欠落フィールドは 0 埋め
 */
export function extractAtifUsage(parsed: unknown): AtifUsageTotals | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const metrics = obj.final_metrics;
  if (!metrics || typeof metrics !== 'object') return null;
  const m = metrics as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    input_tokens: num(m.total_input_tokens),
    output_tokens: num(m.total_output_tokens),
    cache_read_input_tokens: num(m.total_cache_read_tokens),
    cache_creation_input_tokens: num(m.total_cache_creation_tokens),
  };
}

/**
 * ATIF ファイルの生テキストからダイジェストを構築する。
 * ATIF-v1.7 は「ターン終了時に一括書き出しされる pretty-print された単一 JSON」であるため
 * 単一 JSON としてのパースを優先し、失敗した場合のみ JSONL（1行1エントリ、旧形式）にフォールバックする。
 * `totalSteps` は `extractAtifEntries()` の長さそのもの（誤カウント是正の中核、判明15）。
 * @param content ATIF ファイルの生テキスト
 * @returns ステップ・モデル・使用量のいずれも取得できなければ null。**例外を投げない**
 */
export function buildAtifDigest(content: string): AtifDigest | null {
  const raw = typeof content === 'string' ? content : '';

  let parsed: unknown = null;
  let isSingleJson = false;
  try {
    parsed = JSON.parse(raw);
    isSingleJson = true;
  } catch {
    // 単一 JSON でない → JSONL フォールバックへ
  }

  let entries: unknown[] = [];
  let modelName: string | null = null;
  let modelId: string | null = null;
  let usage: AtifUsageTotals | null = null;
  let permissionMode: string | null = null;
  let schemaVersion: string | null = null;

  if (isSingleJson) {
    entries = extractAtifEntries(parsed);
    const model = extractAtifModel(parsed);
    modelName = model.modelName;
    modelId = model.modelId;
    usage = extractAtifUsage(parsed);
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      if (typeof obj.schema_version === 'string' && obj.schema_version) schemaVersion = obj.schema_version;
      const agent = obj.agent;
      if (agent && typeof agent === 'object') {
        const extra = (agent as Record<string, unknown>).extra;
        if (extra && typeof extra === 'object') {
          const ex = extra as Record<string, unknown>;
          if (typeof ex.permission_mode === 'string' && ex.permission_mode) permissionMode = ex.permission_mode;
        }
      }
    }
  } else {
    // JSONL（1行1エントリ、旧形式互換）
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed));
      } catch {
        // 不完全な行は無視
      }
    }
  }

  const steps: AtifStepSummary[] = [];
  for (const entry of entries) {
    const s = summarizeAtifEntry(entry);
    if (s) steps.push(s);
  }

  if (steps.length === 0 && !usage && !modelName && !modelId) return null;

  return {
    schemaVersion,
    steps,
    modelName,
    modelId,
    usage,
    totalSteps: entries.length,
    permissionMode,
  };
}

/**
 * プランモードの「無言で途中終了」検知（欠陥1の副作用対策）。
 *
 * Devin は config で Exec/Write を deny された際、非対話モードでは拒否テキストを一切出さず
 * exit 0 で終わる（#347 Phase0 実測）。この場合 ATIF の最後のステップは「ツール呼び出し」で
 * 終わっており、そのあとの AI テキスト応答（`tool: null` のステップ）が存在しない。
 *
 * `AtifStepSummary` は既に `tool: string | null` でツール呼び出し/テキスト応答を区別しているため、
 * 新しいパースは不要——最後の要素だけを見れば判定できる。
 */
export function endedWithoutAnswer(steps: AtifStepSummary[]): boolean {
  if (steps.length === 0) return false;
  const last = steps[steps.length - 1];
  return last.tool !== null;
}

/**
 * #364 Phase1（1-A-3）: 失敗ターン（最後がツール呼び出しで終わっている＝`endedWithoutAnswer()` と
 * 同じ構造条件）に限定して、最後のステップの `observation.results[].content` を 300 文字だけ
 * 抜粋する。`summarizeAtifEntry()` 自体は #361 の設計どおり `observation` を一切参照しないため
 * 変更しない——本関数はその例外として新設する別関数であり、既存関数のガードは崩さない。
 *
 * 本モジュールは外部 import ゼロの流儀のため、`devin-diagnostics.ts` の
 * `isDevinToolRejectionText()`（拒否文言のパターン判定）はここでは呼ばない。
 * ここでは「構造的に失敗ターンか」の判定と raw content の抽出のみを行い、
 * 文言パターンでのフィルタは呼び出し側（`ai-runner.ts`、`isDevinToolRejectionText` を
 * 既に import 済み）に委ねる設計。
 *
 * @param content ATIF ファイルの生テキスト（単一 JSON のみ対象、JSONL 旧形式は対象外）
 * @returns 抜粋（最大300文字）。失敗ターンでない/observation が無い等は null。**例外を投げない**
 */
export function extractRejectionEvidence(content: string): string | null {
  const raw = typeof content === 'string' ? content : '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // JSONL（旧形式）は observation を持たない想定のため対象外
    return null;
  }
  const entries = extractAtifEntries(parsed);
  if (entries.length === 0) return null;
  const last = entries[entries.length - 1];
  if (!last || typeof last !== 'object') return null;
  const summary = summarizeAtifEntry(last);
  // テキスト応答（tool === null）で終わっている＝失敗ターンではない
  if (!summary || summary.tool === null) return null;
  const e = last as Record<string, unknown>;
  const observation = e.observation;
  if (!observation || typeof observation !== 'object') return null;
  const results = (observation as Record<string, unknown>).results;
  if (!Array.isArray(results)) return null;
  for (const r of results) {
    if (r && typeof r === 'object' && typeof (r as Record<string, unknown>).content === 'string') {
      const c = (r as Record<string, unknown>).content as string;
      if (c) return c.slice(0, 300);
    }
  }
  return null;
}
