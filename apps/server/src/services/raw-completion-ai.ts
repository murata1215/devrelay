/**
 * raw-completion（ゲーム席用の素の completion API、`POST /api/agent/raw-completion`）の
 * Phase 2: 呼び出しごとの AI 選択（`ai: "claude" | "codex"`）に関する純関数群。
 *
 * `raw-completion-guard.ts`（流量制御）・`raw-completion-response.ts`（レスポンス整形）と同じ
 * 単一責務の原則で分離する。外部 import ゼロ（#332 `permission-policy.ts` 等と同じ流儀）。
 *
 * Phase 1 まではプロジェクトの `defaultAi` が `'claude'` でなければ 400 だったが、Phase 2 では
 * **リクエストの `ai`（省略時 `'claude'`）で経路を決める**（Claude 席と Codex 席を同じ試合に
 * 混ぜるため、`defaultAi` には依存させない）。Claude 側の判定・許可リストはこのファイルの追加に
 * 一切影響しない（`ai==='claude'` は素通りする設計）。
 */

/** raw-completion がサポートする AI 種別 */
export type RawAi = 'claude' | 'codex';

/** `ai` 未指定時の既定値 */
export const RAW_AI_DEFAULT: RawAi = 'claude';

/** 値が `RawAi` として妥当かどうかを判定する */
export function isRawAi(value: unknown): value is RawAi {
  return value === 'claude' || value === 'codex';
}

export type ResolveRawAiResult =
  | { ok: true; ai: RawAi }
  | { ok: false; error: string };

/**
 * リクエストボディの `ai` フィールドを解決する。
 * 未指定・空文字は既定値 `'claude'` にフォールバックする（後方互換、Phase 1 呼び出し元は
 * `ai` を送らないため挙動不変）。`'claude'`/`'codex'` 以外の値は 400 相当のエラーにする。
 *
 * @param rawAiValue リクエストボディの `ai`（未検証）
 */
export function resolveRawAi(rawAiValue: unknown): ResolveRawAiResult {
  if (rawAiValue === undefined || rawAiValue === null || rawAiValue === '') {
    return { ok: true, ai: RAW_AI_DEFAULT };
  }
  if (!isRawAi(rawAiValue)) {
    return { ok: false, error: `Invalid ai: ${JSON.stringify(rawAiValue)} (must be "claude" or "codex")` };
  }
  return { ok: true, ai: rawAiValue };
}

/** `decideRawAiGate` の入力 */
export interface RawAiGateInput {
  /** 解決済みの `ai` */
  ai: RawAi;
  /** 対象マシンが Agent 接続時に申告した `availableAiTools`（`agent-manager.ts` のインメモリ保持） */
  availableAiTools: readonly string[];
  /** 対象マシンが `raw-completion-codex` capability を申告しているか */
  hasCodexCapability: boolean;
}

export type RawAiGateDecision = { ok: true } | { ok: false; error: string };

/**
 * `ai` に応じた追加ゲートを判定する。
 *
 * `ai === 'claude'` の場合は何も追加しない（既存の Claude 席ゲート — online / capability
 * `raw-completion` / outdated 判定 — は呼び出し元 `raw-completion-api.ts` がこの関数の外で
 * 従来どおり行う。この関数はそこに一切触れない＝ Claude 経路の挙動不変を保証する設計）。
 *
 * `ai === 'codex'` の場合、以下の両方を要求する（**自動フォールバック禁止**、人間指示どおり）:
 *   1. 対象 Agent が `availableAiTools` に `'codex'` を含む（Codex CLI がインストール・設定済み）
 *   2. 対象 Agent が `raw-completion-codex` capability を申告している（Phase 2 対応版へ `u` 済み。
 *      旧 Agent は `payload.ai` を無視して黙って Claude を実行してしまう「無言フォールバック」の
 *      危険があるため、capability 未申告なら明示的に 400 で弾く）
 *
 * @param input 判定に必要な入力
 */
export function decideRawAiGate(input: RawAiGateInput): RawAiGateDecision {
  if (input.ai === 'claude') {
    return { ok: true };
  }
  if (!input.availableAiTools.includes('codex')) {
    return { ok: false, error: 'Target Agent does not have Codex CLI installed/configured' };
  }
  if (!input.hasCodexCapability) {
    return { ok: false, error: "Target Agent does not support raw-completion for Codex (run 'u' on the target machine to update)" };
  }
  return { ok: true };
}

export type ValidateRawCodexModelResult = { ok: true } | { ok: false; error: string };

/**
 * Codex 席向けのモデル ID を検証する（`ai==='codex'` の場合のみ呼び出すこと。Claude 側の
 * 許可リスト・検証ロジックには一切触れない）。
 *
 * @param model リクエストボディの `model`（未指定可。未指定時は CLI 既定モデルにフォールバックするため OK）
 * @param catalogIds 許可するモデル ID の一覧（呼び出し元が `AI_MODEL_CATALOG.codex.map(m => m.id)` を渡す。
 *   単一情報源を `packages/shared` の `AI_MODEL_CATALOG` に保つため、本ファイルはカタログ自体を import しない）
 */
export function validateRawCodexModel(model: string | undefined, catalogIds: readonly string[]): ValidateRawCodexModelResult {
  if (model === undefined || model === '') {
    return { ok: true };
  }
  if (/["'`;$\n\r]/.test(model) || /\s/.test(model)) {
    return { ok: false, error: `Invalid model: ${JSON.stringify(model)} (contains unsafe characters)` };
  }
  if (!catalogIds.includes(model)) {
    return { ok: false, error: `Unknown Codex model: ${JSON.stringify(model)}` };
  }
  return { ok: true };
}
