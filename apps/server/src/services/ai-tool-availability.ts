import type { AiTool } from '@devrelay/shared';

/**
 * 2026-10-02 実機で確認した事故の対策: サーバーは要求された AI ツール（`claude` 等）のまま
 * モデル設定を解決するが、Agent 側は接続時に申告した `availableAiTools`
 * （`agent-manager.ts` の `agentAvailableAiTools`、接続ハンドラで保持）に基づき
 * `resolveEffectiveAiTool()`（`agents/*\/src/services/connection.ts`）で実際にインストール
 * されているツールへ**サーバーに無断で**差し替えてしまう。
 *
 * 例: `Project.defaultAi='claude'` だが Agent 機に Claude Code が入っておらず Devin のみ
 * インストール済み → サーバーは `claude_model_plan`（未設定）を解決して `model: undefined` を
 * 送る → Agent は devin へ差し替えて起動するが `--model` フラグ無しで動くため、Devin 自身の
 * 既定モデル（例: swe-2）が使われ、組織 AI デフォルト（devin 用に設定した Opus 5.5 等）が
 * 一切反映されない。
 *
 * この純粋関数は Agent 側 `resolveEffectiveAiTool()` と**同じ判定方針**（要求ツールが実在すれば
 * 尊重し、無ければ優先順位に従ってフォールバックする）をサーバー側でも行い、モデル解決・
 * Agent へ送る `aiTool` を実態に合わせる。Agent 側は「最後に手動選択したツール」を保持して
 * いるが、サーバー側はそれを持たないため、呼び出し側が渡す `fallbacks`（通常は
 * `[Session.aiTool, Project.defaultAi]` の順）で代替する。
 *
 * - `available` が空配列（Agent が `availableAiTools` を申告しない旧バージョン、または
 *   未接続）の場合は**差し替えない**（後方互換。情報が無いのに憶測で上書きしない）。
 * - `requested` が `available` に含まれていればそのまま尊重する。
 * - 含まれていなければ `fallbacks` を先頭から順に試し、`available` に含まれる最初の値を採用する。
 * - どれも該当しなければ `available` の先頭（Agent 側 `resolveEffectiveAiTool()` の
 *   最終フォールバックと同じ）を採用する。
 */
export function pickAvailableAiTool(
  requested: AiTool,
  available: readonly AiTool[],
  fallbacks: readonly (AiTool | null | undefined)[],
): AiTool {
  if (available.length === 0) return requested;
  if (available.includes(requested)) return requested;
  for (const fb of fallbacks) {
    if (fb && available.includes(fb)) return fb;
  }
  return available[0];
}
