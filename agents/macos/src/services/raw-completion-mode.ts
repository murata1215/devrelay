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

/** `mapRawUsage()` の入力（SDK `result` メッセージのうち使用量に関わる部分のみ） */
export interface RawUsageInput {
  usage?: Record<string, unknown>;
  modelUsage?: Record<string, unknown>;
  durationMs?: number;
}

/** `mapRawUsage()` の出力（Message.usageData に保存する正規化済み形） */
export interface RawUsageOutput {
  usage?: Record<string, unknown>;
  modelUsage?: Record<string, unknown>;
  durationMs?: number;
  model?: string;
}

/**
 * SDK の `result` メッセージから抽出した使用量情報を、DB 保存用の正規化された形へ写像する。
 * `ai-runner.ts` の通常経路（`result.usageData = { usage: m.usage, modelUsage: m.modelUsage,
 * durationMs: m.duration_ms, model: ..., rateLimits: ... } `）と同じキー構造だが、raw-completion は
 * `rateLimits` を持たない（対話セッションの rate limit 集計とは無関係のため）。
 *
 * @param input SDK result メッセージから抜き出した usage/modelUsage/durationMs
 */
export function mapRawUsage(input: RawUsageInput): RawUsageOutput {
  return {
    usage: input.usage,
    modelUsage: input.modelUsage,
    durationMs: input.durationMs,
    model: input.modelUsage ? Object.keys(input.modelUsage)[0] : undefined,
  };
}
