/**
 * Devin 料金可視化サイクル: モデル単価の構造化 + メッセージ単位のコスト解決。
 *
 * 【背景】`Message.usageData`（`AiUsageData`、types.ts）には Claude Agent SDK が返す実額
 * `modelUsage[model].costUSD` が既に保存されている（実 DB 実測: aiTool='claude' の 97% に存在、
 * 累計 $59,625.64 相当）。一方 Devin はローカル CLI 実行のため金額 API を持たず、ATIF
 * （`devin --export`）のトークン数 × 公開単価から**推定**する以外に手段が無い
 * （self-serve/Team プランは ACU 表記が廃止され「included quota + 超過分は API pricing」に
 * 移行済みのため、この近似は実課金にかなり近い）。
 *
 * 【単価の正は description】単価の数値そのものは `constants.ts` の `AI_MODEL_CATALOG.devin`
 * の description 文字列（`devin models list --format json` 実測、2026-09-28）が正。
 * ここではそれを機械可読な構造体として複製する。二重管理は `model-pricing.test.mjs` が
 * description との数値一致を検査することで防止する。
 *
 * 【方針: 未知単価への fallback は禁止】カタログに無いモデル（DB 実測で確認された
 * `kimi-k2-7` / `swe-1-7-*` / `MODEL_PRIVATE_11` 等）や、CLI 選択用のエイリアス ID
 * （`opus`/`sonnet`/`gpt`/`gemini`/`swe`/`codex` — ATIF が実際に報告するのは解決後の
 * 具体モデル名であり、これらのエイリアスが `usageData.model` に現れることは無い）には
 * 単価を追加しない。未知の単価に近似値を当てるとコストが静かに誤った値になるため、
 * 該当モデルは常に「単価不明」として扱う（`resolveMessageCost` が `usd: null` を返す）。
 *
 * この関数群は `packages/shared` の既存流儀（Node API 非依存、純関数のみ）を守る。
 */

import type { AiUsageData } from './types.js';

/** USD per 1,000,000 トークンの単価。`free: true` は「単価不明」ではなく「確定で無料」を表す */
export interface ModelPrice {
  /** 入力トークン単価（USD / 1M tokens） */
  input: number;
  /** キャッシュ読み込みトークン単価（USD / 1M tokens） */
  cacheRead: number;
  /** 出力トークン単価（USD / 1M tokens） */
  output: number;
  /** true の場合コストは常に $0（無料枠。単価不明の undefined とは明確に区別する） */
  free?: boolean;
}

/**
 * Devin モデルの単価テーブル（USD per 1M tokens）。
 * キーは `AI_MODEL_CATALOG.devin` の family slug（ドット表記、例: `claude-opus-5.5`）と一致させる。
 * `-fast` 版は単価が別（`claude-opus-5.5` の description に明記されている1件のみ判明）なので
 * 独立したキー `<id>-fast` として持つ。それ以外のモデルの `-fast` 単価は不明のため追加しない。
 *
 * 値の出典: `packages/shared/src/constants.ts` の `AI_MODEL_CATALOG.devin` 各 description。
 * 数値を変更する場合は description 側も同時に更新すること（`model-pricing.test.mjs` が検査する）。
 */
export const DEVIN_MODEL_PRICING: Record<string, ModelPrice> = {
  'claude-opus-5.5': { input: 4, cacheRead: 0.2, output: 20 },
  'claude-opus-5.5-fast': { input: 8, cacheRead: 0.4, output: 40 },
  'claude-opus-5': { input: 5, cacheRead: 0.5, output: 25 },
  'claude-fable-5.1': { input: 10, cacheRead: 0.25, output: 50 },
  'claude-sonnet-5': { input: 2, cacheRead: 0.2, output: 10 },
  'claude-haiku-4.5': { input: 1, cacheRead: 0.1, output: 5 },
  'gpt-6-sol': { input: 2, cacheRead: 0.2, output: 10 },
  'gpt-6-astra': { input: 10, cacheRead: 1, output: 50 },
  'gpt-6-luna': { input: 0.1, cacheRead: 0.01, output: 0.5 },
  'gpt-5.6-terra': { input: 2, cacheRead: 0.2, output: 12 },
  'gpt-5.6-luna': { input: 0.2, cacheRead: 0.02, output: 1.2 },
  'gpt-5.3-codex': { input: 1.75, cacheRead: 0.17, output: 14 },
  'gemini-3.8-flash': { input: 0.75, cacheRead: 0.08, output: 3.75 },
  'gemini-3.1-pro': { input: 2, cacheRead: 0.2, output: 12 },
  'swe-2': { input: 0, cacheRead: 0, output: 0, free: true },
  'glm-5.3': { input: 1.4, cacheRead: 0.26, output: 4.4 },
  'deepseek-v4.1-flash': { input: 0.22, cacheRead: 0.01, output: 0.66 },
};

/** `normalizeDevinModelId` の戻り値 */
export interface NormalizedDevinModelId {
  /** 正規化後の ID（`DEVIN_MODEL_PRICING` 照合用）。判別できなければ元の値に近い形をそのまま返す */
  id: string;
  /** `-fast` サフィックスが付いていたか（単価が別のため呼び出し側で個別に解決する） */
  fast: boolean;
  /** `[1m]` 等の長文脈サフィックスが付いていたか（現状 pricing への反映は無し。将来拡張用の記録） */
  longContext: boolean;
}

/** 推論量サフィックス（単価は変わらないため単純に取り除く。`swe-1-7-lightning` 等の実測込み） */
const EFFORT_SUFFIX_RE = /-(low|medium|high|xhigh|max|lightning|priority)$/;
/** ハイフン区切りの2桁バージョン番号をドット表記へ復元（例: `gpt-5-6-luna` → `gpt-5.6-luna`） */
const DIGIT_DASH_DIGIT_RE = /(\d)-(\d)(?=-|$)/g;

/**
 * DB 実測（15種）で確認された Devin の実際の `usageData.model` 表記をカタログ照合用に正規化する。
 * 例: `claude-sonnet-5-medium` → `claude-sonnet-5`、`gpt-5-6-luna-medium` → `gpt-5.6-luna`、
 * `claude-opus-4-6[1m]` → `claude-opus-4.6`（カタログに無いため結果的に単価不明のまま）。
 * @param raw ATIF 由来の生のモデル ID 文字列
 */
export function normalizeDevinModelId(raw: string): NormalizedDevinModelId {
  let id = typeof raw === 'string' ? raw.trim() : '';
  let longContext = false;
  let fast = false;

  // [1m] 等の角括弧サフィックスを剥がす（例: claude-opus-4-6[1m]）
  const bracketMatch = id.match(/\[[^\]]*\]$/);
  if (bracketMatch) {
    longContext = true;
    id = id.slice(0, -bracketMatch[0].length);
  }

  // -fast サフィックス（単価が別。剥がした上で呼び出し側が `<id>-fast` を個別に照合する）
  if (id.endsWith('-fast')) {
    fast = true;
    id = id.slice(0, -'-fast'.length);
  }

  // 推論量サフィックス（単価は変わらないので単純に剥がす）
  id = id.replace(EFFORT_SUFFIX_RE, '');

  // ハイフン区切りのバージョン番号をドット表記へ復元
  id = id.replace(DIGIT_DASH_DIGIT_RE, '$1.$2');

  return { id, fast, longContext };
}

/**
 * 正規化済み ID から Devin の単価を引く。`-fast` は専用エントリが無ければ
 * **非 fast の単価を流用しない**（-fast は通常より高額と判明しているため、
 * 流用すると過小評価になる。単価不明として扱うほうが安全）。
 * @param rawModelId ATIF 由来の生のモデル ID（null/undefined も許容）
 * @returns 単価が判明していれば `ModelPrice`、不明なら `undefined`
 */
export function resolveDevinModelPrice(rawModelId: string | null | undefined): ModelPrice | undefined {
  if (!rawModelId) return undefined;
  const { id, fast } = normalizeDevinModelId(rawModelId);
  if (fast) {
    return DEVIN_MODEL_PRICING[`${id}-fast`];
  }
  return DEVIN_MODEL_PRICING[id];
}

/**
 * 2026-10-02 実機事故（組織デフォルト Opus 5.5 設定済みの devin 機で swe-2 が使われた）対策。
 *
 * 「最新に自動追従する」エイリアス（`AI_MODEL_CATALOG.devin` のエイリアス系エントリ）は
 * CLI バージョンによって無警告で解決先が変わる仕様（rules/project.md 参照）であり、
 * 要求モデルと実モデルが一致しなくて当然のため比較対象から除外する。
 * `adaptive` も品質/コストを動的選択する専用モデルのため同様に除外する。
 */
const DEVIN_MODEL_TRACKING_ALIASES = new Set(['adaptive', 'opus', 'sonnet', 'haiku', 'gpt', 'codex', 'gemini', 'swe']);

/**
 * `--model` で要求した Devin モデルと、ターン終了後に ATIF から実測できた実際のモデルが
 * 食い違っているかどうかを判定する（`normalizeDevinModelId()` で family slug + fast フラグへ
 * 正規化して比較）。
 *
 * 2026-10-02 実機事故の教訓: Devin が要求モデルを黙って別モデルへ振り替えても（アカウント未解放・
 * レート制限等）DevRelay 側はそれを検知する手段が無く、「組織デフォルトを設定したのに反映されない」
 * ことに利用者が気づくまで放置される。この関数はその不一致を検出するためだけに存在し、
 * 価格解決（`resolveDevinModelPrice`）には使わない。
 *
 * - `requestedModel` が未指定（`--model` を付けずに起動した、または追従エイリアスを指定した）
 *   場合や、`actualModel` が ATIF から取得できなかった場合は、比較不能として `false` を返す
 *   （静かなフォールバック禁止の原則上「不明」と「不一致」は意味が異なるため、不明を不一致として
 *   誤報しない）。
 * - `-fast` の有無が違う場合も不一致として扱う（単価が別のため実質別モデル）。
 *
 * @param requestedModel Agent が devin に `--model` で渡した値（渡さなかった場合は undefined/null）
 * @param actualModel ATIF（`devin --export`）から実測できたモデル ID（取得できなければ undefined/null）
 */
export function detectDevinModelMismatch(
  requestedModel: string | null | undefined,
  actualModel: string | null | undefined,
): boolean {
  if (!requestedModel || !actualModel) return false;
  if (DEVIN_MODEL_TRACKING_ALIASES.has(requestedModel.trim().toLowerCase())) return false;
  const requested = normalizeDevinModelId(requestedModel);
  const actual = normalizeDevinModelId(actualModel);
  return requested.id !== actual.id || requested.fast !== actual.fast;
}

/** コスト計算に使う4種のトークン数（Claude 互換キーの `usage` から取り出した後の形） */
export interface UsageTokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/**
 * トークン数 × 単価で USD を計算する。
 * `cacheCreation`（キャッシュ書き込み）は Devin の公開単価表に列が無い。Anthropic の実測
 * （料金可視化サイクルでの校正: 実 `costUSD` の残差から「入力単価 × 1.25」相当と確認済み
 * — 実例: `costUSD=1.5069985` の in/cacheRead/out 3項合計 $0.129 を差し引いた残差 $1.378 が
 * cache-write 220,462 トークン分 ≒ $6.25/MTok = 入力単価 $5 × 1.25 と一致）を初期値として
 * Devin モデルにも同倍率を適用する。UI 側では「仮定値」であることを明示すること。
 * @param price モデル単価
 * @param tokens トークン数（4種）
 */
export function estimateCostUsd(price: ModelPrice, tokens: UsageTokenCounts): number {
  if (price.free) return 0;
  const MTOK = 1_000_000;
  const cacheWritePrice = price.input * 1.25;
  return (
    (tokens.inputTokens / MTOK) * price.input +
    (tokens.cacheReadTokens / MTOK) * price.cacheRead +
    (tokens.outputTokens / MTOK) * price.output +
    (tokens.cacheCreationTokens / MTOK) * cacheWritePrice
  );
}

/** コストの出所。`enterprise` は Devin Enterprise API 連携（未実装）用に予約済み */
export type CostSource = 'sdk' | 'estimate' | 'enterprise' | 'unknown';

/** `resolveMessageCost` の戻り値 */
export interface ResolvedMessageCost {
  /** 推定/実測コスト（USD）。不明時は null（`0` と区別する） */
  usd: number | null;
  source: CostSource;
  /** 参照したモデル ID（`usageData.model`。無ければ null） */
  model: string | null;
}

/**
 * `Message.usageData` から表示用のコストを解決する。優先順位:
 * 1. Claude Agent SDK が返す実額 `modelUsage[model].costUSD`（`source: 'sdk'`）
 * 2. `usageData.tool === 'devin'` かつ単価が判明しているモデル（`source: 'estimate'`）
 * 3. それ以外は `source: 'unknown'`（`usd: null`。**`0` にしない**）
 *
 * 【`usageData.tool` を厳密に要求する理由】`Session.aiTool` は `l` コマンドでセッション横断に
 * 上書きされる可変値のため、ツール切替後のセッションには過去ターンの実ツールが残る
 * （実 DB で確認済み: `aiTool='devin'` のセッションに Claude 時代の行が混入）。
 * `Session.aiTool` を信用して Devin 推定を当てると、実は Claude だった行を誤って
 * Devin 単価で計算してしまう恐れがあるため、**`usageData.tool` が明示的に `'devin'` の
 * ときのみ**推定コストを計算する。この明示フィールドは料金可視化サイクル以降の新しい
 * ターンにのみ付与されるため、既存の古い Devin メッセージ（今回の ATIF バグ修正前に
 * 記録されたもの）は Agent 更新後の新しいターンが記録されるまで `unknown` のままになる
 * （これは意図した挙動。壊れたゼロ値を推定コストとして表示しないため）。
 * @param usageData `Message.usageData`（null/undefined も許容）
 */
export function resolveMessageCost(usageData: AiUsageData | null | undefined): ResolvedMessageCost {
  if (!usageData) return { usd: null, source: 'unknown', model: null };

  const model = usageData.model ?? null;

  // 1. SDK 実測値（Claude）
  if (model && usageData.modelUsage && typeof usageData.modelUsage === 'object') {
    const entry = (usageData.modelUsage as Record<string, unknown>)[model];
    const costUSD = entry && typeof entry === 'object' ? (entry as Record<string, unknown>).costUSD : undefined;
    if (typeof costUSD === 'number' && Number.isFinite(costUSD)) {
      return { usd: costUSD, source: 'sdk', model };
    }
  }

  // 2. Devin 推定値（usageData.tool が明示的に 'devin' の場合のみ）
  if (usageData.tool === 'devin' && model) {
    const price = resolveDevinModelPrice(model);
    if (price) {
      const usage = usageData.usage ?? {};
      const usd = estimateCostUsd(price, {
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        cacheReadTokens: usage.cache_read_input_tokens ?? 0,
        cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
      });
      return { usd, source: 'estimate', model };
    }
  }

  // 3. 単価不明・ツール不明・データ無し
  return { usd: null, source: 'unknown', model };
}
