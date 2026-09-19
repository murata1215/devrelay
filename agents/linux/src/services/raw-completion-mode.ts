/**
 * raw-completion（ゲーム席用の素の completion API、`server:raw:prompt` / `agent:raw:result`）の
 * Agent 側モード定義。`ai-runner.ts` の raw 分岐から呼ばれる、外部 import ゼロの純関数群。
 *
 * `apps/server/src/services/raw-completion-guard.ts` と同じ流儀（#332 `permission-policy.ts` /
 * #348 `cross-query-guard.ts`）: 外部 import ゼロにすることで node --test から `../dist/...` を
 * 直接 import してテストできる。`packages/shared` ではなく agent 側の `src/services/` に置くのは、
 * SDK の型（`@anthropic-ai/claude-agent-sdk`）を一切 import しないことで、本ファイル自体を
 * pure ロジックの単体テスト対象として独立させるため（`sdk-loop-guard.ts` と同じ理由）。
 *
 * D1（実装プランの判断）: `allowedTools: []` はツールを無効化しない（「プロンプト無しで自動許可する
 * ツール名」であり絞り込み用途ではない）。`tools: []` が「ビルトインツールを全無効化する」本来の
 * 手段。ただし SDK のバージョン変化や `permissionMode:'plan'` の既定挙動（Read/Grep/Glob/WebFetch
 * を調査目的で許可する設計）に備え、以下 4 層で多重防御する:
 *   1. `tools: []`（本命）
 *   2. `disallowedTools`（`RAW_DISALLOWED_TOOLS`、明示リスト。tools:[] が効かない SDK バージョンへの保険）
 *   3. `canUseTool` 無条件 deny（`isRawToolDenied` は常に true を返す。SDK 版が上がっても不変の最後の砦）
 *   4. `permissionMode: 'plan'`（万一 1-3 が全て漏れても、plan モードは編集系ツールを実行しない）
 * さらに `mcpServers: {}` + `strictMcpConfig: true` を重ねる（`tools:[]` 後に MCP サーバーがツールを
 * 再導入しうる唯一の経路のため）。`systemPrompt` は完全置換（DevRelay の前置き・Agreement 文言を
 * 一切混入させない契約）、`settingSources: []`（CLAUDE.md 等のプロジェクト設定を読み込ませない）。
 *
 * maxTurns はプラン仕様の `1` ではなく `2` を採用する（実装プランのリスク欄参照）。SDK のターン計上が
 * 入口/出口どちらを指すか不明であり、off-by-one だと全コールが `error_max_turns` になるおそれがある。
 * `tools:[]` の下では 2 ターン目に到達する手段（ツール呼び出し）が無いため、`2` にしてもコストはゼロ。
 */

/** raw-completion モードのターン数上限（1 ではなく 2。理由は本ファイル冒頭 JSDoc 参照） */
export const RAW_MAX_TURNS = 2;

/**
 * raw-completion で明示的に disallow するビルトインツール名（D1 第2層）。
 * `tools: []` が正しく効いていれば到達しないが、SDK バージョン変化への保険として列挙する。
 */
export const RAW_DISALLOWED_TOOLS: readonly string[] = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'NotebookEdit',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'Task',
  'AskUserQuestion',
  'ExitPlanMode',
  'TodoWrite',
  'BashOutput',
  'KillShell',
];

/**
 * raw-completion 用のユーザープロンプトを組み立てる。
 *
 * 恒等関数（入力をそのまま返す）。「DevRelay の前置き（Agreement / プランモード指示 / 出力先指示）を
 * 一切付けない」契約を、テストで表明するための名前付きシーム（呼び出し元を将来変更する際も、この
 * 関数のテストが壊れれば契約違反に気付ける）。
 *
 * @param userPrompt リクエストの user プロンプト（クランプ済みを想定、本関数はクランプしない）
 */
export function composeRawPrompt(userPrompt: string): string {
  return userPrompt;
}

/** `buildRawSdkOverrides()` が返す SDK query() オプションの部分集合 */
export interface RawSdkOverrides {
  systemPrompt: string;
  settingSources: never[];
  tools: never[];
  disallowedTools: readonly string[];
  permissionMode: 'plan';
  mcpServers: Record<string, never>;
  strictMcpConfig: true;
  maxTurns: number;
}

/**
 * raw-completion モードの SDK query() オプション上書き分を組み立てる（D1 の 4 層防御のうち
 * canUseTool を除く静的な部分）。`ai-runner.ts` はこの戻り値を `sdkOptions` へ spread するだけで、
 * SDK オプションの組み立てロジック自体は本ファイルに閉じ込める（テスト容易性のため）。
 *
 * @param systemPrompt 完全置換する system prompt（リクエストの `system` フィールドをそのまま渡すこと）
 */
export function buildRawSdkOverrides(systemPrompt: string): RawSdkOverrides {
  return {
    systemPrompt,
    settingSources: [],
    tools: [],
    disallowedTools: RAW_DISALLOWED_TOOLS,
    permissionMode: 'plan',
    mcpServers: {},
    strictMcpConfig: true,
    maxTurns: RAW_MAX_TURNS,
  };
}

/**
 * raw-completion モードの `canUseTool` 判定（D1 第3層・無条件 deny）。
 * `tools: []` / `disallowedTools` が万一漏れても、ツール呼び出しは常に deny する最後の砦。
 * 引数を取らない（ツール名を問わず常に true）のは「何が来ても deny」という設計を型で表すため。
 */
export function isRawToolDenied(): true {
  return true;
}

/**
 * `isRawToolDenied()` が deny した際に SDK の `canUseTool` へ返す拒否メッセージを組み立てる。
 *
 * @param toolName 拒否されたツール名（ログ・デバッグ用にメッセージへ含める）
 */
export function buildRawDenyMessage(toolName: string): string {
  return `raw mode: tool calls are disabled (denied: ${toolName})`;
}

/**
 * `resolveRawCompletionResult()` の入力（`ai-runner.ts` の `AiRunResult` と `handleRawPrompt` の
 * `onOutput` コールバック観測結果から集めたもの）。
 *
 * Phase 1.1 で判明した空レスポンスバグの根本原因: `ai-runner.ts` の最終 `onOutput` 呼び出し
 * （`isComplete: true`）は本文を渡さない仕様（出力ありなら空文字、無しなら
 * `'(No response from AI)'`）。本文の連結（`fullOutput`）は `sendPromptToAiSdk` の関数ローカルに
 * 閉じているため、呼び出し元は `AiRunResult.rawOutput` 経由でしか本文を取得できない。
 */
export interface RawCompletionRunInput {
  /**
   * `AiRunResult.rawOutput`。完了経路（SDK result ハンドラ / 自然終了フォールバック）でのみ
   * `rawMode` 時に設定される。`undefined` は「完了経路に到達せずエラー分岐で早期 return した」
   * ことを表す構造的シグナル（ai-runner.ts の JSDoc と対）。
   */
  rawOutput?: string;
  /** `isComplete: true` の `onOutput` 呼び出しで渡されたテキスト（一度も発火しなければ空文字） */
  completionText: string;
  /** `isComplete: true` の `onOutput` が一度でも呼ばれたか */
  completionSeen: boolean;
  /** `isComplete: true` の `onOutput` の第5引数（stopReason）。実値が入るのは限られた経路のみ */
  stopReason?: string;
  /** `AiRunResult.rawDeniedTools`（`canUseTool` が deny したツール名。重複あり得る） */
  deniedTools?: readonly string[];
}

/** `resolveRawCompletionResult()` の出力（`agent:raw:result` の `RawResultPayload` に直結する形） */
export interface RawCompletionRunResult {
  /** false: 応答本文ではなく `errorMessage` を見るべき状態（SDK 実行自体の失敗） */
  ok: boolean;
  /** AI の応答本文（連結済み）。エラー時は空文字 */
  text: string;
  /** 'success' | 'max_turns' | 'error' | 'aborted' 等。無言の切り詰めを隠さないため必ず設定する（#325） */
  stopReason: string;
  /** `ok: false` 時、および `ok: true` でも異常を申告すべき場合のメッセージ */
  errorMessage?: string;
  /** deny されたツール名（重複除去済み・入力順維持）。常に配列を返す（`undefined` にしない） */
  deniedTools: string[];
}

/** 重複を除去しつつ入力順を保つ（`Set` の挿入順保証を利用）。入力配列そのものは変更しない */
function dedupeDeniedTools(tools?: readonly string[]): string[] {
  if (!tools || tools.length === 0) return [];
  return [...new Set(tools)];
}

/**
 * `ai-runner.ts` の実行結果（`AiRunResult` + `onOutput` の観測）から raw-completion の最終結果を
 * 導出する。3 経路を明示的に区別する（この分岐が Phase 1.1 の「空ボディ」バグの根治点）:
 *
 *   A. `rawOutput` あり … 完了経路（SDK result ハンドラ / 自然終了フォールバック）に到達した。
 *      本文は `rawOutput` が唯一の正（最終 `onOutput` が渡す空文字ではない）。
 *      `stopReason` が `'error'` なら `ok:false`、`'max_turns'`/`'aborted'` は `ok:true` のまま
 *      部分出力と `stopReason` を返す（切り詰めを隠さない、#325 の踏襲）。
 *   B. `rawOutput` 無し + 完了シグナルあり … ai-runner のエラー分岐（プロンプト長超過・未ログイン・
 *      OAuth 期限切れ・SDK 例外等）で早期 return したケース。この `onOutput` テキストは
 *      「AI の回答」ではなくエラー本文そのものなので `errorMessage` へ回す。
 *   C. `rawOutput` 無し + 完了シグナルも無し（`resumeFailed` 等） … raw では通常到達しないが、
 *      無言で成功扱いにはしない。
 *
 * 例外は一切投げない。
 */
export function resolveRawCompletionResult(input: RawCompletionRunInput): RawCompletionRunResult {
  const deniedTools = dedupeDeniedTools(input.deniedTools);

  // 経路A: 完了経路に到達済み。本文は rawOutput が唯一の正。
  if (input.rawOutput !== undefined) {
    const stopReason = input.stopReason && input.stopReason !== '' ? input.stopReason : 'success';
    if (stopReason === 'error') {
      // SDK が error subtype を返したケース。部分出力があれば握りつぶさず errorMessage に載せる
      const message = input.rawOutput.trim().length > 0
        ? input.rawOutput
        : (input.completionText.trim().length > 0 ? input.completionText : 'SDK returned an error result');
      return { ok: false, text: input.rawOutput, stopReason, errorMessage: message, deniedTools };
    }
    // 'max_turns' / 'aborted' 等は ok:true のまま部分出力と stopReason を返す（切り詰めを隠さない）
    return { ok: true, text: input.rawOutput, stopReason, deniedTools };
  }

  // 経路B: 完了経路手前のエラー分岐で早期 return。onOutput のテキストはエラー本文。
  if (input.completionSeen) {
    const stopReason = input.stopReason && input.stopReason !== '' ? input.stopReason : 'error';
    const message = input.completionText.trim().length > 0
      ? input.completionText
      : 'AI run ended without output';
    return { ok: false, text: '', stopReason, errorMessage: message, deniedTools };
  }

  // 経路C: 完了シグナル自体が来なかった（resumeFailed 等）。無言の success にしない。
  return {
    ok: false,
    text: '',
    stopReason: 'error',
    errorMessage: 'AI run ended without a completion signal',
    deniedTools,
  };
}
