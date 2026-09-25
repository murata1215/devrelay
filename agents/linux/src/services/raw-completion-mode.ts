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
 * 手段。ただし SDK のバージョン変化に備え、以下 3 層で多重防御する:
 *   1. `tools: []`（本命）
 *   2. `disallowedTools`（`RAW_DISALLOWED_TOOLS`、明示リスト。tools:[] が効かない SDK バージョンへの保険）
 *   3. `canUseTool` 無条件 deny（`isRawToolDenied` は常に true を返す。SDK 版が上がっても不変の最後の砦）
 * さらに `mcpServers: {}` + `strictMcpConfig: true` を重ねる（`tools:[]` 後に MCP サーバーがツールを
 * 再導入しうる唯一の経路のため）。`systemPrompt` は完全置換（DevRelay の前置き・Agreement 文言を
 * 一切混入させない契約）、`settingSources: []`（CLAUDE.md 等のプロジェクト設定を読み込ませない）。
 *
 * `permissionMode` は `'default'` 固定（Phase 1.2 で `'plan'` から変更）。SDK 内蔵 cli.js
 * （`@anthropic-ai/claude-agent-sdk` 同梱、`pathToClaudeCodeExecutable` 未指定時に使われる自前
 * バンドル）を実測したところ、`permissionMode:'plan'` は `toolPermissionContext.mode==="plan"` を
 * ガードに「Plan mode is active. The user indicated that they do not want you to execute yet --
 * you MUST NOT make any edits ...」という plan-mode reminder を会話メッセージへ `isMeta:true` で
 * 注入する（`systemPrompt` の完全置換では消えない別経路）。raw-completion はゲーム席用の素の
 * completion API であり、AI がこの reminder を読んで「Plan モードで動いている」と自称する事故
 * （Phase 1 再スモーク (b) で実測）につながるため、`'plan'` を使わない。ツールが 1 個も無い
 * raw 経路では `'plan'` に期待していた「編集系ツールを実行しない」保険としての価値は
 * `canUseTool` 無条件 deny（第3層）が既に肩代わりしており、実効上の防御力低下は無い。
 *
 * maxTurns はプラン仕様の `1` ではなく `2` を採用する（実装プランのリスク欄参照）。SDK のターン計上が
 * 入口/出口どちらを指すか不明であり、off-by-one だと全コールが `error_max_turns` になるおそれがある。
 * `tools:[]` の下では 2 ターン目に到達する手段（ツール呼び出し）が無いため、`2` にしてもコストはゼロ。
 *
 * Phase 1.3（auto-memory 遮断、CLAUDE.md・rules・MEMORY.md・auto-memory のいずれも注入されない契約）:
 * `settingSources: []` は CLAUDE.md/rules（プロジェクト設定）を止めるが、SDK 内蔵の auto-memory 注入
 * （`~/.claude/projects/<sanitized-cwd>/memory/MEMORY.md` を読み書きする機能）は別経路で、
 * `settingSources` に依らず動く。同梱 cli.js を実測したところ、有効化ゲートは次の優先順で評価される:
 *   1. `process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY` が truthy → 無効化（最優先、他の全てに勝つ）
 *   2. `process.env.CLAUDE_CODE_REMOTE` が truthy かつ `CLAUDE_CODE_REMOTE_MEMORY_DIR` 未設定 → 無効化
 *   3. `settings.autoMemoryEnabled`（flag settings 層）が定義済みならその値
 *   4. 上記いずれにも該当しなければ既定で有効
 * これを受け、raw-completion は 3 層で遮断する:
 *   1. env `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`（`RAW_ENV_OVERRIDES` / `buildRawEnv()`。ゲートが
 *      最優先で読むため最も確実。`ai-runner.ts` 側で `sdkOptions.env` にマージする、本ファイルの
 *      `buildRawSdkOverrides()` は env を返さない — 理由は下記）
 *   2. `settings.autoMemoryEnabled: false`（`buildRawSdkOverrides()` の `settings`）。SDK の
 *      `Options.settings` はインラインオブジェクトを受け付け、`--settings <json>` として CLI へ渡る。
 *      cli.js の設定ソース一覧は `settingSources` に依らず `flagSettings`（= `--settings`）を
 *      無条件で追加するため、`settingSources: []` と併存しても効く
 *   3. `settings.autoMemoryDirectory: RAW_AUTO_MEMORY_DIR`。万一 1・2 が両方破れても、既定の
 *      `~/.claude/projects/<sanitized-cwd>/memory/` という「対象プロジェクトの MEMORY.md」への
 *      注入元を、raw 専用の共有ディレクトリへそらす最後の砦
 *
 * 実装プランは当初「raw の cwd を呼び出しごとの空の一時ディレクトリにし完了後に削除する」案だったが、
 * 上記 3 層防御で同じ隔離をゼロ実行コストで達成できるため意図的に不採用とした。一時ディレクトリ方式は
 * (a) cwd がトランスクリプトのスラッグも兼ねるため `~/.claude/projects/<slug>/` が呼び出しごとに
 * 増殖する、(b) SDK の子プロセス終了は非同期（SIGTERM 後 5 秒で SIGKILL）なので `finally` での
 * 削除が本質的に racy、(c) 未知の cwd は Claude Code の workspace-trust プロンプトの典型的な
 * トリガーであり、SDK 大幅更新と同一サイクルに持ち込むと不確実性が積み重なる、という欠点があり
 * この場では採らない。Phase 1.4 以降で `persistSession: false` によりトランスクリプト書き込み
 * 自体を止める方が cwd 汚染の本筋の解であり、そちらに委ねる。
 *
 * `buildRawSdkOverrides()` が `env` キーを一切返さない理由: 呼び出し元（`ai-runner.ts`）は
 * `Object.assign(sdkOptions, buildRawSdkOverrides(...))` で戻り値を丸ごと展開する。`env` を
 * 含めてしまうと `sdkOptions.env` 全体（`process.env` 由来の PATH/HOME/OAuth・API キー、
 * `proxyEnv`、`DEVRELAY_*`）が丸ごと置換されてしまうため、env のマージは呼び出し元の責務として
 * 明確に分離し、本ファイルは `buildRawEnv()` という「マージ後の新しいオブジェクトを返す」純関数
 * のみを提供する。
 *
 * Phase 1.4（model 誤判定 + 環境情報混入の是正、2.1.278 実測に基づく）:
 * (1) `usageData.model` に `modelUsage` の**先頭キー**を使っていたため、SDK が毎ターン付随的に行う
 *     セッションタイトル生成（Haiku、`generate_session_title`、`querySource` で識別できる内部呼び出し）
 *     が先に列挙され `claude-haiku-4-5-...` が「使用モデル」として報告される事故があった。
 *     `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1`（公式 env）でこのタイトル生成呼び出し自体が発生しなく
 *     なることを実測済みだが、SDK バージョン変化への保険として `resolveRawUsedModel()`（本ファイル
 *     後方）で「テキストを生成した assistant メッセージの model」を最優先する判定に是正した。
 * (2) raw 経路の cwd が対象プロジェクト（DevRelay 管理下の git リポジトリ）のままだったため、
 *     SDK が自動注入する `type:"environment"` アタッチメント（cwd・OS・シェル・日付・モデル名）に
 *     プロジェクトパスがそのまま載っていた。`connection.ts` 側で `raw-cwd.ts` の中立ディレクトリ
 *     （`/tmp/seat` 等）に差し替えることで解消する（本ファイルの責務外、`raw-cwd.ts` 参照）。
 * (3) 上記アタッチメントとは別に、SDK は OAuth アカウントのメールアドレスを `userEmail` という
 *     userContext ブロックとして注入する（cwd/git とは無関係の経路）。調査の結果 SDK オプション・
 *     env のいずれからも抑止する手段が無いことを確認した（既知の制約。対象機の Claude ログイン
 *     アカウントを変更するか、`system` プロンプト側で開示禁止を明示する運用でのみ回避可能）。
 * (4) `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1`（公式 env）を保険として追加した。custom systemPrompt
 *     下では git status ブロック自体が注入されないことを実測済みだが、SDK バージョン変化への保険。
 * (5) `persistSession: false` を追加し、raw 呼び出しがトランスクリプトを一切ディスクに書かない
 *     （`~/.claude/projects/<slug>/` にスラッグを作らない）ようにした。中立 cwd と組み合わせることで
 *     呼び出しごとのスラッグ増殖を構造的にゼロにする。
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
 * raw-completion モードで SDK 実行時の env にマージする上書き分（auto-memory 遮断・第1層 +
 * Phase 1.4 の追加2キー）。値はすべて文字列 `'1'` にすること（同梱 CLI 側の判定は小文字化した
 * 文字列に対する真偽判定であり、boolean を渡すとそちら側で `.toLowerCase()` が失敗する）。
 *
 * - `CLAUDE_CODE_DISABLE_AUTO_MEMORY`: 同梱 CLI のゲート関数が最優先で読む公式キルスイッチ。
 * - `CLAUDE_CODE_DISABLE_TERMINAL_TITLE`（Phase 1.4）: セッションタイトル生成（Haiku 内部呼び出し）
 *   を止める公式 env。2.1.278 実測でこの env により `modelUsage` からタイトル生成キーが消えることを
 *   確認済み（本ファイル冒頭 JSDoc「Phase 1.4」節参照）。
 * - `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS`（Phase 1.4）: git status/commit 指示の注入を止める公式
 *   env。custom systemPrompt 下では現状未注入だが、SDK バージョン変化への保険として追加。
 */
export const RAW_ENV_OVERRIDES: Readonly<Record<string, string>> = {
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1',
  CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '1',
};

/**
 * raw-completion 専用の auto-memory ディレクトリ（auto-memory 遮断・第3層）。
 * 第1・第2層が両方破れた場合でも、既定の `~/.claude/projects/<sanitized-cwd>/memory/`
 * （＝対象プロジェクトの MEMORY.md）への注入経路をそらすための最後の砦。`~/` は SDK 内蔵
 * cli.js 側で展開される（`Settings.autoMemoryDirectory` の型 JSDoc に明記されている仕様）。
 */
export const RAW_AUTO_MEMORY_DIR = '~/.devrelay/raw-memory';

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

/**
 * SDK に渡す `env`（`Options['env']` と構造互換。本ファイルは SDK 型を import しないため
 * 独自に定義する）。値に `undefined` を許すのは `process.env` がそのまま渡ってくることを
 * 想定するため。
 */
export type RawEnv = Record<string, string | undefined>;

/**
 * raw-completion 用の env オーバーライドをベース env にマージする（auto-memory 遮断・第1層）。
 * 恒等関数ではない点が `composeRawPrompt` と異なる: `RAW_ENV_OVERRIDES` を**後勝ち**で上書きする。
 * ベース env に `CLAUDE_CODE_DISABLE_AUTO_MEMORY=0` のような値が既に入っていても `'1'` に強制する
 * 契約（Agent 起動時の環境変数に依存させない）。
 *
 * 呼び出し元の `baseEnv` オブジェクトは変更しない（新しいオブジェクトを返す）。この関数の戻り値を
 * `sdkOptions.env` へ代入する形で使うこと（`buildRawSdkOverrides()` が `env` を返さない理由は
 * ファイル冒頭 JSDoc の Phase 1.3 節を参照）。
 *
 * @param baseEnv マージ元の env（通常は `sdkOptions.env`）
 */
export function buildRawEnv(baseEnv: RawEnv): RawEnv {
  return { ...baseEnv, ...RAW_ENV_OVERRIDES };
}

/** `buildRawSdkOverrides()` が `settings` として返す raw 専用の auto-memory 設定（第2・第3層） */
export interface RawSettingsOverride {
  autoMemoryEnabled: false;
  autoMemoryDirectory: string;
}

/** `buildRawSdkOverrides()` が返す SDK query() オプションの部分集合 */
export interface RawSdkOverrides {
  systemPrompt: string;
  settingSources: never[];
  tools: never[];
  disallowedTools: readonly string[];
  permissionMode: 'default';
  mcpServers: Record<string, never>;
  strictMcpConfig: true;
  maxTurns: number;
  settings: RawSettingsOverride;
  /** Phase 1.4: トランスクリプトをディスクに書かない（`~/.claude/projects/<slug>/` を作らない） */
  persistSession: false;
}

/**
 * raw-completion モードの SDK query() オプション上書き分を組み立てる（D1 の 3 層防御のうち
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
    permissionMode: 'default',
    mcpServers: {},
    strictMcpConfig: true,
    maxTurns: RAW_MAX_TURNS,
    settings: { autoMemoryEnabled: false, autoMemoryDirectory: RAW_AUTO_MEMORY_DIR },
    persistSession: false,
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

/**
 * `resolveRawUsedModel()` が受け取る `modelUsage` の1エントリ（`ModelUsage` 相当）を duck-typing で
 * 受ける。外部 import ゼロを維持するため、必要な `outputTokens` のみを見る。
 */
export interface RawModelUsageEntryLike {
  outputTokens?: unknown;
}

/**
 * `resolveRawUsedModel()` の入力。`ai-runner.ts` の raw 分岐が SDK result メッセージ・
 * assistant メッセージの観測結果から集めて渡す。
 */
export interface RawModelResolutionInput {
  /**
   * 返却テキストを生成した最後の assistant メッセージの `message.model`。
   * SDK はエラー系メッセージで `"<synthetic>"` を返すことがあるため、この値は無効値として扱う
   * （呼び出し元でのフィルタ漏れに備え、本関数側でも防御的に弾く）。
   */
  lastAssistantModel?: string;
  /** リクエストで指定された model（`RawPromptPayload.model`） */
  requestedModel?: string;
  /** SDK result の `modelUsage`（キー=モデル名） */
  modelUsage?: Record<string, RawModelUsageEntryLike | unknown>;
}

/** `<synthetic>` 等、SDK がプレースホルダとして使う無効な model 文字列を弾く */
function isValidModelName(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !value.startsWith('<');
}

/** `modelUsage` エントリから `outputTokens` を安全に数値として取り出す（欠落・非数値は 0） */
function readOutputTokens(entry: unknown): number {
  if (entry && typeof entry === 'object' && 'outputTokens' in entry) {
    const v = (entry as RawModelUsageEntryLike).outputTokens;
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
 * `modelUsage` のキーのうち、`requestedModel` と完全一致するもの、無ければ前方一致するものを探す
 * （例: 指定 `claude-opus-5` に対し `claude-opus-5-20260301` を許容）。前方一致は残り部分が
 * 日付スナップショット接尾辞（`-YYYYMMDD`）の場合のみ許容する（`claude-opus-5` に対し
 * `claude-opus-5-5` のような**別モデル**は許容しない）。前方一致が複数あれば、
 * 最も短いキー（＝最も具体性の低い一般名に近いもの）を優先する。
 */
function findModelUsageKeyMatchingRequest(
  modelUsage: Record<string, unknown>,
  requestedModel: string
): string | undefined {
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
    const tokens = readOutputTokens(entry);
    if (tokens > bestTokens) {
      best = key;
      bestTokens = tokens;
    }
  }
  return best;
}

/**
 * raw-completion の HTTP レスポンス `model` 欄に載せる「実際に応答テキストを生成したモデル」を
 * 判定する（Phase 1.4、空レスポンス根治と同じ「無言の誤判定を許さない」思想）。
 *
 * 背景: 旧実装は `Object.keys(m.modelUsage)[0]`（`modelUsage` の**先頭キー**）を使用モデルと
 * 決め打ちしていたが、SDK は毎ターン付随的にセッションタイトル生成（Haiku）等の内部呼び出しを
 * 行うことがあり、その内部呼び出しが `modelUsage` に先に列挙されると誤った model が報告される
 * （2.1.278 実測、本ファイル冒頭 JSDoc「Phase 1.4」節参照）。
 *
 * 優先順位（この順で最初に解決できた値を採用）:
 *   1. `lastAssistantModel`（テキストを生成した最後の assistant メッセージの model。`<synthetic>`
 *      等の無効値は除外）
 *   2. `requestedModel` と一致する `modelUsage` キー（完全一致 → 前方一致の順）
 *   3. `modelUsage` のうち `outputTokens` が最大のキー（最終手段。応答が数トークンしかない場合に
 *      Haiku 内部呼び出しの output の方が多くなり再発しうるため、これを第一候補にはしない）
 *   4. 上記いずれも解決できなければ `undefined`
 *
 * 例外は一切投げない。
 */
export function resolveRawUsedModel(input: RawModelResolutionInput): string | undefined {
  if (isValidModelName(input.lastAssistantModel)) {
    return input.lastAssistantModel;
  }

  const modelUsage = input.modelUsage;
  if (modelUsage && typeof modelUsage === 'object') {
    if (isValidModelName(input.requestedModel)) {
      const matched = findModelUsageKeyMatchingRequest(modelUsage, input.requestedModel);
      if (matched !== undefined) return matched;
    }
    const maxOutput = findModelUsageKeyWithMaxOutputTokens(modelUsage);
    if (maxOutput !== undefined) return maxOutput;
  }

  return undefined;
}
