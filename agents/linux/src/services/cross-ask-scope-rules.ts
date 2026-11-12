/**
 * サイクルS2a（2026-11-12）: クロスユーザー ask（statePolicy が 'isolated' / 'resumable-scoped'）
 * のセッションで、AI が読める範囲・使えるツールを「貸されたプロジェクトの中身（秘密を除く）」に
 * 限定する deny-only 判定の純関数群。`plan-permission.ts`（#332/#333）・`raw-completion-mode.ts`
 * と同じ流儀（外部 import ゼロ。`node --test` から `../dist/...` を直接 import してテストできる）。
 *
 * 背景: 2026-11-11 22:37 JST、別ユーザーが askreset 直後に ask したところ、貸す側の AI が
 * `~/.claude/projects/<slug>/*.jsonl`（Claude 自身の会話記録）を読んでリセット前の内容を全部答え、
 * 同じターンで `ls -lt ~/.claude/projects/` も通り所有者の全プロジェクト名が見えた。
 * `decidePlanPermission()`（plan-permission.ts）の方針は Read/Glob/Grep/WebFetch/WebSearch を
 * 引数検査ゼロで無条件 allow し、Bash は argv0 単位の allowlist（パス検査なし）のため、
 * クロスユーザー ask にはこの既存ゲートでは不十分（`doc/cross-ask-scope-plan.md` 参照）。
 *
 * 本モジュールはクロス ask スコープのときだけ `ai-runner.ts` の PreToolUse フック内で
 * `decidePlanPermission()` より**前**に呼ばれ、deny-only で判定する。1 つでも deny があれば
 * そこで確定し、`decidePlanPermission()` は呼ばれない（クロス ask では到達しない設計）。
 *
 * パスの実体解決（realpath）は fs を要するため本ファイルでは行わない。`isPathAllowed` という
 * 呼び出し元注入のコールバック経由で受け取る（`scope-dir.ts` が `session-scope.ts` から
 * path 処理を分離しているのと同じ理由。fs 依存の実装は `cross-ask-path-guard.ts` を参照）。
 */

/** decideCrossAskToolPermission の判定結果。plan-permission.ts の PlanPermissionDecision と
 *  同じ形だが、本ファイルは外部 import ゼロの規約のため型を再定義する（意図的な重複）。 */
export type CrossAskPermissionDecision =
  | { behavior: 'allow' }
  | { behavior: 'deny'; reason: string; detail?: string };

/**
 * クロス ask セッションで SDK に渡す「利用可能なビルトインツールの基底集合」（`Options.tools`）。
 * Bash/WebFetch/WebSearch/Task/Agent/ToolSearch/Skill/NotebookRead/Write 系は一切列挙しない
 * （未知の新ツール名に対しても fail-closed = 列挙されていないツールは生えない）。
 */
export const CROSS_ASK_TOOLS: readonly string[] = ['Read', 'Grep', 'Glob'];

/**
 * クロス ask 専用の自動メモリ退避先（auto-memory 遮断・第3層。`raw-completion-mode.ts` の
 * `RAW_AUTO_MEMORY_DIR` と同じ考え方。第1・第2層が両方破れた場合の最後の砦）。
 */
export const CROSS_ASK_AUTO_MEMORY_DIR = '~/.devrelay/cross-ask-memory';

/**
 * `tools` が効かない SDK バージョンへの保険として明示 deny するツール名（`Options.disallowedTools`）。
 * `disallowedTools` はモデルのコンテキストから除去され、harness 内部の直接呼び出しもブロックする
 * （`sdk.d.ts` の `toolAliases` JSDoc が明記）。
 */
export const CROSS_ASK_DISALLOWED_TOOLS: readonly string[] = [
  'Bash', 'BashOutput', 'KillShell',
  'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'NotebookRead',
  'WebFetch', 'WebSearch',
  'Task', 'Agent', 'ToolSearch', 'Skill',
  'TodoWrite', 'ExitPlanMode', 'AskUserQuestion',
];

/**
 * クロス ask で allow する各ツールの入力キー whitelist。未知のキーが来た場合は無条件 deny する
 * （新発見⑥: `NotebookRead` のパス引数が `file_path` ではなく `notebook_path` であるような
 * 「引数キーの網羅漏れ」対策。将来 SDK が新しい引数を追加しても、ここに追記するまでは
 * fail-closed になる）。
 */
const ALLOWED_INPUT_KEYS: Readonly<Record<string, readonly string[]>> = {
  Read: ['file_path', 'offset', 'limit'],
  Grep: ['pattern', 'path', 'glob', 'type', 'output_mode', '-A', '-B', '-C', '-n', '-i', 'multiline', 'head_limit'],
  Glob: ['pattern', 'path'],
};

/** パスとして realpath 判定すべき引数キー（ツールごと）。 */
const PATH_ARGUMENT_KEYS: Readonly<Record<string, readonly string[]>> = {
  Read: ['file_path'],
  Grep: ['path'],
  Glob: ['path'],
};

/**
 * 「相対パスのみ許可」で判定すべき引数キー（グロブ・フィルタパターン）。
 * `Grep.pattern`（検索対象の正規表現。パスではない）はここに含めない。
 * `Glob.pattern`（グロブそのもの。絶対パスや `..` を書けるため要検査）と
 * `Grep.glob`（フィルタ用グロブ）のみ対象。
 */
const RELATIVE_GLOB_ARGUMENT_KEYS: Readonly<Record<string, readonly string[]>> = {
  Grep: ['glob'],
  Glob: ['pattern'],
};

/**
 * Glob/Grep の相対パターン引数が安全（絶対パス・ホーム展開・`..`・シェル変数展開を含まない）かを判定する。
 * 新発見②と同じ理由で「引数から判定するが抜け道を広げない」形（グロブは相対のみ許可）。
 */
export function isSafeRelativeGlobArgument(value: string): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value.startsWith('/') || value.startsWith('~')) return false;
  if (value.includes('..')) return false;
  if (value.includes('$')) return false;
  if (/^[A-Za-z]:[\\/]/.test(value)) return false; // Windows ドライブ形式の絶対パスも保険で拒否
  return true;
}

/**
 * プロジェクト内でも読ませない既定のパス一覧（§A の既定一覧）。
 * `posixRelPath`（プロジェクトルートからの相対パス、`/` 区切りに正規化済み）に対して判定する。
 */
export const CROSS_ASK_DENIED_PATH_SEGMENTS: readonly RegExp[] = [
  // DevRelay 内部
  /^\.devrelay(\/|$)/,
  /^\.devrelay-output(-history)?(\/|$)/,
  /^\.devrelay-files(\/|$)/,
  // 環境・設定
  /(^|\/)\.env(\.|$)/,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.netrc$/,
  /(^|\/)\.pgpass$/,
  /(^|\/)\.htpasswd$/,
  /(^|\/)\.git-credentials$/,
  // git 内部（config だけでなく logs/HEAD・packed-refs・hooks・objects も情報源になるため全体を deny）
  /^\.git(\/|$)/,
  // 鍵・証明書
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
  /(^|\/)id_(rsa|ed25519|ecdsa)(\.pub)?$/,
  /\.(asc|gpg)$/i,
  // 資格情報
  /credentials.*\.json$/i,
  /.*service-account.*\.json$/i,
  /.*-firebase-adminsdk-.*\.json$/i,
  /(^|\/)\.aws(\/|$)/,
  /(^|\/)\.ssh(\/|$)/,
  /(^|\/)\.gnupg(\/|$)/,
  /(^|\/)\.config\/gcloud(\/|$)/,
  // ツール設定・DB ダンプ・IaC 状態
  /(^|\/)\.claude\/settings\.local\.json$/,
  /(^|\/)\.claude\/\.credentials\.json$/,
  /(^|\/)\.mcp\.json$/,
  /\.sqlite3?$/i,
  /(^|\/)\.terraform(\/|$)/,
  /(^|\/)\.venv(\/|$)/,
];

/**
 * プロジェクトルートからの相対パス（`/` 区切り）が既定の deny 一覧に当たるかを判定する。
 * 先頭の `./` は正規化のうえで比較する。
 */
export function isDeniedProjectRelativePath(posixRelPath: string): boolean {
  const normalized = posixRelPath.replace(/^\.\//, '');
  return CROSS_ASK_DENIED_PATH_SEGMENTS.some((re) => re.test(normalized));
}

/** `decideCrossAskToolPermission` の入力。 */
export interface DecideCrossAskToolPermissionParams {
  /** SDK から渡されるツール名（PreToolUse フックの `tool_name`） */
  toolName: string;
  /** SDK から渡されるツール入力（PreToolUse フックの `tool_input`） */
  input: Record<string, unknown>;
  /** `hookInput.mcp_server` が存在するか（存在すれば MCP 経由のツール呼び出し） */
  hasMcpServer: boolean;
  /** `hookInput.agent_id` が存在するか（存在すればサブエージェント発の呼び出し） */
  hasAgentId: boolean;
  /**
   * パス引数（`file_path`/`path`）が「プロジェクト配下かつ deny 一覧に当たらない」かを
   * 呼び出し元（`cross-ask-path-guard.ts` 経由）が realpath 判定して返すコールバック。
   * true を返した場合のみ allow する。
   */
  isPathAllowed: (rawValue: string) => boolean;
}

function deny(reason: string, detail: string): CrossAskPermissionDecision {
  return { behavior: 'deny', reason, detail };
}

/**
 * クロス ask スコープの PreToolUse 判定本体。判定順:
 * ① MCP 経由 → deny ② サブエージェント発 → deny ③ ツール名が許可集合（Read/Grep/Glob）に無い → deny
 * ④ 未知の引数キーがある → deny（新発見⑥） ⑤ パス引数がプロジェクト外または deny 一覧に当たる → deny
 * ⑥ グロブ系引数が相対以外 → deny ⑦ すべて通過 → allow
 */
export function decideCrossAskToolPermission(params: DecideCrossAskToolPermissionParams): CrossAskPermissionDecision {
  const { toolName, input, hasMcpServer, hasAgentId, isPathAllowed } = params;

  if (hasMcpServer) {
    return deny('crossAskPolicy:mcpServer', 'MCP 経由のツールはこの質問では使用できません。');
  }
  if (hasAgentId) {
    return deny('crossAskPolicy:subagent', 'サブエージェント経由のツール呼び出しはこの質問では使用できません。');
  }
  if (!CROSS_ASK_TOOLS.includes(toolName)) {
    return deny('crossAskPolicy:notInAllowlist', `この質問では使用できないツールです: ${toolName}`);
  }

  const allowedKeys = ALLOWED_INPUT_KEYS[toolName] ?? [];
  for (const key of Object.keys(input)) {
    if (!allowedKeys.includes(key)) {
      return deny('crossAskPolicy:unknownArgument', `未知の引数キーです: ${toolName}.${key}`);
    }
  }

  const pathKeys = PATH_ARGUMENT_KEYS[toolName] ?? [];
  for (const key of pathKeys) {
    const value = input[key];
    if (typeof value !== 'string') continue;
    if (!isPathAllowed(value)) {
      return deny('crossAskPolicy:pathOutsideProject', `プロジェクトの外、または貸せないパスです: ${toolName}.${key}`);
    }
  }

  const globKeys = RELATIVE_GLOB_ARGUMENT_KEYS[toolName] ?? [];
  for (const key of globKeys) {
    const value = input[key];
    if (typeof value !== 'string') continue;
    if (!isSafeRelativeGlobArgument(value)) {
      return deny('crossAskPolicy:unsafeGlobPattern', `相対パス以外の ${key} は使用できません: ${toolName}.${key}`);
    }
  }

  return { behavior: 'allow' };
}

/** `buildCrossAskSdkOverrides()` が `settings` として返す設定の部分集合。 */
export interface CrossAskSettingsOverride {
  autoMemoryEnabled: false;
  autoMemoryDirectory: string;
  disableClaudeAiConnectors: true;
  disableBundledSkills: true;
  enabledPlugins: Record<string, never>;
}

/** `buildCrossAskSdkOverrides()` が返す SDK query() オプションの部分集合。 */
export interface CrossAskSdkOverrides {
  tools: readonly string[];
  disallowedTools: readonly string[];
  mcpServers: Record<string, never>;
  strictMcpConfig: true;
  skills: readonly string[];
  settingSources: readonly string[];
  settings: CrossAskSettingsOverride;
}

/**
 * クロス ask スコープの SDK query() オプション上書き分を組み立てる（`raw-completion-mode.ts` の
 * `buildRawSdkOverrides()` と同じ流儀）。`ai-runner.ts` はこの戻り値を `sdkOptions` へ
 * `Object.assign` するだけで、SDK オプションの組み立てロジック自体は本ファイルに閉じ込める。
 *
 * `settingSources: []` を採用した理由（Step 0 実測・Plan フェーズの敵対的レビューで確定）:
 * `['project']` だと貸したプロジェクトの `CLAUDE.md` は読めるが、同時にプロジェクト
 * `.claude/settings.json`/`.claude/settings.local.json` の `permissions.allow`・プロジェクト
 * hooks・`.claude/agents`/`.claude/commands`/`.claude/skills` の `allowed-tools` frontmatter・
 * `.mcp.json` という 5 系統の注入経路が同時に開く。`[]` にして CLAUDE.md は Agent 側で
 * 自前で読んで注入する（`buildCrossAskClaudeMdPrompt()` 参照、パスゲート + `@` 行除去 + サイズ上限）。
 *
 * `persistSession` は本サイクル（S2a/S2b）では変更しない（記録の後片付けは別サイクル S2c の
 * スコープ。既存どおり `~/.claude/projects/<slug>/*.jsonl` は書かれ続けるが、本モジュールの
 * パスゲートにより当該ディレクトリはクロス ask から読めなくなる＝今回の実被害事例の再現は防げる）。
 *
 * @param autoMemoryDirectory 自動メモリの注入元をそらす先（最後の砦。実際には `autoMemoryEnabled:false`
 *   で読み書き自体を止めるため到達しない想定だが、raw-completion-mode.ts と同じ3層防御に揃える）
 */
export function buildCrossAskSdkOverrides(autoMemoryDirectory: string): CrossAskSdkOverrides {
  return {
    tools: CROSS_ASK_TOOLS,
    disallowedTools: CROSS_ASK_DISALLOWED_TOOLS,
    mcpServers: {},
    strictMcpConfig: true,
    skills: [],
    settingSources: [],
    settings: {
      autoMemoryEnabled: false,
      autoMemoryDirectory,
      disableClaudeAiConnectors: true,
      disableBundledSkills: true,
      enabledPlugins: {},
    },
  };
}

/**
 * クロス ask 専用の env 上書き（auto-memory 遮断・第1層。`raw-completion-mode.ts` の
 * `RAW_ENV_OVERRIDES`/`buildRawEnv()` と同じ3層防御の考え方）。
 */
export const CROSS_ASK_ENV_OVERRIDES: Readonly<Record<string, string>> = {
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1',
  CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '1',
};

/**
 * ベース env にクロス ask 専用の上書きをマージする（`buildRawEnv()` と同じ契約: 呼び出し元の
 * オブジェクトは変更せず新しいオブジェクトを返す。丸ごと置換すると PATH/proxy/DEVRELAY_* を失うため、
 * `buildCrossAskSdkOverrides()` は env キーを返さず本関数で別途マージする）。
 */
export function buildCrossAskEnv(baseEnv: Record<string, string | undefined>): Record<string, string | undefined> {
  return { ...baseEnv, ...CROSS_ASK_ENV_OVERRIDES };
}

/**
 * SDK の `system/init` メッセージ（`SDKSystemMessage`）がクロス ask の想定どおりの構成かを
 * 実行時に検証する（新発見⑤: `settings` インライン注入が静かに無視される・将来の SDK 更新で
 * fail-open するケースを機械検出する最後の砦。1 つでも外れたらターンを中断すべき）。
 * `skills` は `disableBundledSkills:true` でも一部のビルトインスキル名が残ることを実測済み
 * （Skill ツール自体は `disallowedTools` で使用不可のため実害は無い）ため、本関数の対象外とする。
 *
 * @param init SDK から受け取った `system/init` メッセージの一部（`tools`/`mcp_servers`/
 *   `permissionMode`/`cwd`）
 * @param expectedCwdReal realpath 済みのプロジェクトルート（`init.cwd` と一致するはずの値）
 */
export function decideCrossAskInitAssertion(
  init: { tools?: string[]; mcp_servers?: Array<{ name: string }>; permissionMode?: string; cwd?: string },
  expectedCwdReal: string,
): { ok: true } | { ok: false; reason: string } {
  const unexpectedTools = (init.tools ?? []).filter((t) => !CROSS_ASK_TOOLS.includes(t));
  if (unexpectedTools.length > 0) {
    return { ok: false, reason: `init.tools に想定外のツールが含まれる: ${unexpectedTools.join(',')}` };
  }
  if ((init.mcp_servers ?? []).length > 0) {
    return { ok: false, reason: `init.mcp_servers が空でない: ${(init.mcp_servers ?? []).map((s) => s.name).join(',')}` };
  }
  if (init.permissionMode !== 'plan') {
    return { ok: false, reason: `init.permissionMode が plan でない: ${init.permissionMode}` };
  }
  if (init.cwd !== undefined && init.cwd !== expectedCwdReal) {
    return { ok: false, reason: `init.cwd がプロジェクトルートと一致しない: ${init.cwd} !== ${expectedCwdReal}` };
  }
  return { ok: true };
}
