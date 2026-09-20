/**
 * raw-completion Phase 2（Codex 経路）の Agent 側モード定義。`raw-completion-mode.ts`（Claude 側）と
 * 同じ流儀: 外部 import ゼロの純関数群のみで構成し、`node --test` から `../dist/...` を直接 import して
 * テストできるようにする。I/O 実体（`spawn`/stdin/stdout）は `raw-codex-runner.ts` に分離する。
 *
 * ## system prompt の扱い（Claude 経路との最大の差）
 * Codex CLI には Claude Agent SDK の `systemPrompt`（built-in instructions の完全置換）に相当する
 * 検証済みの手段が無い（devlog `2026-09-20_042939.md` §Phase 0 の実測）。本サイクルの再調査
 * （`codex debug prompt-input` によるオフライン描画、devlog `2026-09-20_230123.md` 参照）で
 * `-c developer_instructions="<TOML basic string>"` が developer ロールの**先頭**に載ることを実測し、
 * これを「席の system 指示」を渡すチャネルとして採用した（`composeRawCodexPrompt()` は Claude 側
 * `composeRawPrompt()` と同じ恒等関数のまま、system は `buildRawCodexArgs()` の `-c developer_instructions`
 * に渡す設計。`[SYSTEM]` を user prompt へ前置する方式は不採用 — 人間承認済み）。
 *
 * ## 混入除去（実測済みフラグのみ採用。除去手段が無いものは残存＝既知の制約として README に明記）
 * - `<environment_context>`（cwd/OS/shell/日付）: `include_environment_context=false`
 * - `<skills_instructions>`（**`/home/<user>/.codex/skills/...` パス＝ユーザー名漏洩源**）:
 *   `skills.include_instructions=false`
 * - `<recommended_plugins>`: `features.tool_suggest=false`
 * - `<apps_instructions>`: `include_apps_instructions=false`
 * - プロジェクト AGENTS.md: `project_doc_max_bytes=0`（**`$CODEX_HOME/AGENTS.md` グローバルは消せない**。
 *   DevRelay は AGENTS.md を書かないため通常は存在しない前提）
 * - MCP: `mcp_servers={}`
 * - web_search ツール: `tools.web_search=false`
 * - rollout（会話履歴の永続化）: `--ephemeral`（未対応バージョンなら外す、`probeRawCodexSupport` 参照）
 *   + `history.persistence="none"`
 * - **除去手段が無く残存**（実測、既知の制約）: `<permissions instructions>`（sandbox 説明、約340字）、
 *   multi-agent 定型「You are `/root`, the primary agent in a team...」（約2.5K字、`features.multi_agent`
 *   等すべて無効化しても消えない）
 *
 * ## ツールの deny（Claude 経路との差 = Codex には `canUseTool` 相当が無い）
 * Claude 経路は `tools:[]` + `disallowedTools` + `canUseTool` 無条件 deny の3層防御で「呼ばれる前に
 * 100% 阻止」できるが、Codex exec には allow/deny リストという概念自体が無い（Phase 0 実測）。
 * `sandbox_mode="read-only"` + `approval_policy="never"` により**書き込み・ネットワークは失敗する**が、
 * 読み取り系のシェルコマンド（`cat`/`ls` 等）は cwd 内で成立しうる。このため本ファイルは事後検出方式を
 * 採る: `consumeRawCodexLine()` が `item.completed` で実行系アイテム型（`RAW_CODEX_EXECUTED_ITEM_TYPES`）
 * を観測したら記録し、`resolveRawCodexResult()` は非空ならエラーにして本文を返さない（`ok:false`）。
 * この防御は cwd を `raw-cwd.ts` の中立ディレクトリ（`/tmp/seat`、プロジェクトファイルを含まない）に
 * 限定していることが前提（`raw-codex-runner.ts` が `ensureRawCwd()` を呼ぶ）。
 */

/** `-c` に渡す固定の config 上書き（順序固定、テストで検証する） */
export const RAW_CODEX_CONFIG_OVERRIDES: readonly string[] = [
  'sandbox_mode="read-only"',
  'approval_policy="never"',
  'project_doc_max_bytes=0',
  'include_environment_context=false',
  'skills.include_instructions=false',
  'include_apps_instructions=false',
  'features.tool_suggest=false',
  'features.multi_agent=false',
  'mcp_servers={}',
  'tools.web_search=false',
  'history.persistence="none"',
];

/** `codex exec` に渡す固定フラグ（`--ephemeral` は `probeRawCodexSupport()` 非対応なら除外する） */
export const RAW_CODEX_BASE_FLAGS: readonly string[] = ['--json', '--skip-git-repo-check'];

/** `--ephemeral` フラグ（rollout をディスクに残さない。旧バージョンには存在しないため条件付き） */
export const RAW_CODEX_EPHEMERAL_FLAG = '--ephemeral';

/**
 * `item.completed` の `item.type` のうち「実際にツールが実行された」とみなす型（事後検出方式の対象）。
 * `agent_message`（テキスト応答）・`reasoning`（思考、非公開）・`todo_list`（ツール実行を伴わない
 * メモ）は含めない。
 */
export const RAW_CODEX_EXECUTED_ITEM_TYPES: readonly string[] = [
  'command_execution',
  'file_change',
  'mcp_tool_call',
  'collab_tool_call',
  'web_search',
];

/**
 * TOML basic string（ダブルクォート文字列）としてエスケープする。
 * `-c key="<value>"` に渡す値は TOML パーサを通るため、`\`/`"` に加えて制御文字も安全にエスケープする
 * 必要がある（`developer_instructions` に呼び出し元の `system`（任意文字列）をそのまま渡すため）。
 *
 * @param value エスケープ対象の生文字列
 * @returns ダブルクォートで囲んだ TOML basic string リテラル（囲み文字込み）
 */
export function toTomlBasicString(value: string): string {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    switch (ch) {
      case '\\':
        out += '\\\\';
        break;
      case '"':
        out += '\\"';
        break;
      case '\n':
        out += '\\n';
        break;
      case '\t':
        out += '\\t';
        break;
      case '\r':
        out += '\\r';
        break;
      case '\b':
        out += '\\b';
        break;
      case '\f':
        out += '\\f';
        break;
      default:
        if (code < 0x20 || code === 0x7f) {
          out += `\\u${code.toString(16).padStart(4, '0')}`;
        } else {
          out += ch;
        }
    }
  }
  return `"${out}"`;
}

/**
 * raw-completion 用の Codex モデル ID を検証する（サーバー側 `validateRawCodexModel()` と同じ
 * 危険文字判定。Agent 側でも二重に防御する、`safeModelArg()`（`ai-runner.ts`）と同じ思想）。
 *
 * @param model 未検証のモデル ID（未指定なら undefined）
 * @returns 安全なモデル ID、または undefined（未指定 or 危険な値）
 */
export function safeRawCodexModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  if (/["'`;$\n\r]/.test(model) || /\s/.test(model)) return undefined;
  return model;
}

/** `buildRawCodexArgs()` の入力 */
export interface BuildRawCodexArgsInput {
  /** 席の system 指示（`-c developer_instructions=` に渡す。空文字も許容） */
  system: string;
  /** モデル指定（未指定なら `-c model=` を付けず CLI 既定モデルに委ねる） */
  model?: string;
  /** `probeRawCodexSupport()` の結果（`--ephemeral` 対応可否） */
  supportsEphemeral: boolean;
}

/**
 * `codex exec` の引数列を組み立てる（純関数。実際の spawn は `raw-codex-runner.ts`）。
 * 引数の順序は固定する（テストで検証、`codex exec --help` の記法に準拠）。
 * プロンプトは stdin から読む（`-` を必ず最後に置く、既存 `ai-runner.ts` の codex 分岐と同じ規約）。
 *
 * @param input 引数組み立てに必要な入力
 */
export function buildRawCodexArgs(input: BuildRawCodexArgsInput): string[] {
  const { system, model, supportsEphemeral } = input;
  const args: string[] = ['exec', ...RAW_CODEX_BASE_FLAGS];
  if (supportsEphemeral) {
    args.push(RAW_CODEX_EPHEMERAL_FLAG);
  }
  for (const override of RAW_CODEX_CONFIG_OVERRIDES) {
    args.push('-c', override);
  }
  const safeModel = safeRawCodexModel(model);
  if (safeModel) {
    args.push('-c', `model=${toTomlBasicString(safeModel)}`);
  }
  args.push('-c', `developer_instructions=${toTomlBasicString(system)}`);
  args.push('-'); // プロンプトは stdin から読む（必ず最後の引数）
  return args;
}

/**
 * raw-completion 用の user プロンプトを組み立てる。恒等関数（Claude 側 `composeRawPrompt()` と同じ
 * 契約表明のシーム。system は `buildRawCodexArgs()` 側の `developer_instructions` に渡すため、
 * ここでは user prompt に何も前置・混入させない）。
 *
 * @param userPrompt リクエストの user プロンプト
 */
export function composeRawCodexPrompt(userPrompt: string): string {
  return userPrompt;
}

/**
 * raw-completion 用の env を組み立てる（Codex コマンドのディレクトリを PATH に追加するのみ）。
 * 既存の対話経路（`ai-runner.ts` の codex 分岐）と異なり、`DEVRELAY`/`DEVRELAY_SESSION_ID`/
 * `DEVRELAY_PROJECT` は**付けない**（raw-cwd が対象プロジェクトと無関係の中立ディレクトリのため、
 * これらの値を渡すこと自体がプロジェクト名・セッション ID の混入経路になりうる）。
 *
 * @param baseEnv マージ元の env（通常は `process.env` + proxy 環境変数）
 * @param codexDir `codex` コマンドの親ディレクトリ
 * @param pathSep OS のパス区切り文字（`;` on Windows, `:` on POSIX）
 */
export function buildRawCodexEnv(
  baseEnv: Record<string, string | undefined>,
  codexDir: string,
  pathSep: string
): Record<string, string | undefined> {
  const existingPath = baseEnv.PATH;
  const newPath = existingPath ? `${codexDir}${pathSep}${existingPath}` : codexDir;
  return { ...baseEnv, PATH: newPath };
}

/**
 * `turn.completed` の `usage` から写像した Claude 互換キー。
 * インデックスシグネチャを持たせているのは `AiUsageData.usage`（`packages/shared`、
 * `Record<string, number>`）へ構造的に代入可能にするため（`raw-codex-runner.ts` が
 * `RawCodexResult.usageData` を `RawResultPayload.usageData: AiUsageData` にそのまま渡す）。
 */
export interface RawCodexUsage {
  [key: string]: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

/** `consumeRawCodexLine()` が蓄積する状態（`createRawCodexAccumulator()` で生成） */
export interface RawCodexAccumulator {
  /** `agent_message` アイテムのテキストを連結したもの */
  text: string;
  /** `RAW_CODEX_EXECUTED_ITEM_TYPES` に該当したアイテム型（重複あり得る、呼び出し順） */
  executedTools: string[];
  /** `turn.completed.usage` から写像した usage（複数回来たら最後を採用） */
  usage?: RawCodexUsage;
  /** `turn.failed`/`error` イベントのメッセージ（最初の1件のみ保持） */
  failedMessage?: string;
  /** `thread.started` の `thread_id`（raw-completion では resume しないため参照専用） */
  threadId?: string;
  /** JSON パースに失敗した行（プレーンテキストへの劣化時の保険。本文には混ぜない） */
  plainLines: string[];
}

/** 空の `RawCodexAccumulator` を作る */
export function createRawCodexAccumulator(): RawCodexAccumulator {
  return { text: '', executedTools: [], plainLines: [] };
}

/**
 * `codex exec --json` の JSONL 1 行を解析し、`acc` へ破壊的に反映する（例外は投げない）。
 * `ai-runner.ts` 既存の codex 分岐（対話セッション向け）とスキーマ解釈は同じだが、進捗表示・
 * session-store への thread_id 保存等の対話向け副作用は一切行わない（raw は使い切りターンのため）。
 *
 * @param acc `createRawCodexAccumulator()` で生成した状態（破壊的に更新される）
 * @param line JSONL の 1 行（末尾改行なし想定、空行は呼び出し元でスキップすること）
 */
export function consumeRawCodexLine(acc: RawCodexAccumulator, line: string): void {
  let json: any;
  try {
    json = JSON.parse(line);
  } catch {
    if (line.trim()) acc.plainLines.push(line.trim());
    return;
  }

  switch (json?.type) {
    case 'thread.started': {
      if (typeof json.thread_id === 'string') acc.threadId = json.thread_id;
      break;
    }
    case 'item.completed': {
      const item = json.item;
      if (!item || typeof item.type !== 'string') break;
      if (item.type === 'agent_message' && typeof item.text === 'string') {
        acc.text += item.text;
      } else if (RAW_CODEX_EXECUTED_ITEM_TYPES.includes(item.type)) {
        acc.executedTools.push(item.type);
      }
      // 'reasoning' / 'todo_list' / 未知の型は無視（進捗表示は raw では行わない）
      break;
    }
    case 'turn.completed': {
      const usage = json.usage;
      if (usage) {
        acc.usage = {
          input_tokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : 0,
          output_tokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : 0,
          cache_read_input_tokens: typeof usage.cached_input_tokens === 'number' ? usage.cached_input_tokens : 0,
          cache_creation_input_tokens: typeof usage.cache_write_input_tokens === 'number' ? usage.cache_write_input_tokens : 0,
        };
      }
      break;
    }
    case 'turn.failed': {
      if (!acc.failedMessage) {
        acc.failedMessage = json.error?.message || 'unknown turn.failed error';
      }
      break;
    }
    case 'error': {
      if (!acc.failedMessage) {
        acc.failedMessage = json.message || json.error?.message || 'unknown error event';
      }
      break;
    }
    default:
      // thread.started 以外の管理イベント（turn.started 等）は無視
      break;
  }
}

/** `resolveRawCodexResult()` の入力 */
export interface ResolveRawCodexResultInput {
  acc: RawCodexAccumulator;
  /** プロセスの終了コード（`null` は signal で終了した場合） */
  exitCode: number | null;
  /** 終了シグナル（`null` は signal 無しで終了） */
  signal: NodeJS.Signals | null;
  /** Agent 側タイムアウトで SIGTERM/SIGKILL を送った場合 true */
  timedOut: boolean;
  /** stderr の末尾（デバッグ用、500 文字程度を想定） */
  stderrTail: string;
  /** リクエストで指定されたモデル（`turn.completed` の JSONL にモデル名が無いため、レスポンスへの
   *  エコーバック用にそのまま使う。本ファイル冒頭 JSDoc 参照） */
  requestedModel?: string;
}

/** `resolveRawCodexResult()` の出力（`RawResultPayload` に直結する形、Claude 側 `RawCompletionRunResult` と同形） */
export interface RawCodexResult {
  ok: boolean;
  text: string;
  stopReason: string;
  errorMessage?: string;
  deniedTools: string[];
  usageData?: { usage: RawCodexUsage; modelUsage: Record<string, RawCodexUsage>; model?: string };
}

/**
 * Codex の実行結果を判定する（5 分岐、この順で評価する）。
 *   1. `timedOut` → `ok:false, stopReason:'timeout'`
 *   2. `executedTools` 非空 → `ok:false, stopReason:'error'`。ツールが実際に実行された痕跡がある
 *      場合、本文を返さない（`raw-codex-mode.ts` 冒頭 JSDoc「ツールの deny」節参照。`deniedTools` に
 *      `codex:<item.type>` 形式で記録する）
 *   3. `failedMessage` あり → `ok:false, stopReason:'error'`
 *   4. `exitCode` が非ゼロかつ `usage` 未受信（＝ `turn.completed` に到達していない） → `ok:false`
 *   5. それ以外 → `ok:true, stopReason:'success'`
 *
 * @param input 判定に必要な入力
 */
export function resolveRawCodexResult(input: ResolveRawCodexResultInput): RawCodexResult {
  const { acc, exitCode, timedOut, stderrTail, requestedModel } = input;
  const deniedTools = acc.executedTools.map((t) => `codex:${t}`);

  if (timedOut) {
    return { ok: false, text: '', stopReason: 'timeout', errorMessage: 'raw-completion (codex) timed out on agent side', deniedTools };
  }

  if (acc.executedTools.length > 0) {
    return {
      ok: false,
      text: '',
      stopReason: 'error',
      errorMessage: `raw mode: Codex executed a tool (${[...new Set(acc.executedTools)].join(', ')})`,
      deniedTools,
    };
  }

  if (acc.failedMessage) {
    return { ok: false, text: '', stopReason: 'error', errorMessage: acc.failedMessage, deniedTools };
  }

  if (exitCode !== 0 && !acc.usage) {
    const tail = stderrTail.trim();
    return {
      ok: false,
      text: '',
      stopReason: 'error',
      errorMessage: tail ? `codex exec exited with code ${exitCode}: ${tail}` : `codex exec exited with code ${exitCode}`,
      deniedTools,
    };
  }

  const usageData = acc.usage
    ? {
        usage: acc.usage,
        modelUsage: { [requestedModel ?? 'codex']: acc.usage },
        model: requestedModel,
      }
    : undefined;

  return { ok: true, text: acc.text, stopReason: 'success', deniedTools, usageData };
}
