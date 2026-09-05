import { spawn, ChildProcess, execSync } from 'child_process';
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { DEFAULT_ALLOWED_TOOLS_LINUX, PLAN_READONLY_TOOLS, PLAN_READONLY_BASH_COMMANDS, PLAN_WRITE_BASH_COMMANDS, PLAN_WRITE_TOOLS, isUnsafeModelId, tChat, DEFAULT_CHAT_LANGUAGE } from '@devrelay/shared';
import type { AiTool, AiUsageData, ScreenAnalysis, Language } from '@devrelay/shared';
import type { AgentConfig } from './config.js';
import { getBinDir } from './config.js';
import { parseStreamJsonLine, formatContextUsage, isContextWarning, getContextWarningMessage, type ContextUsage } from './output-parser.js';
import { matchesToolRule, isAllowedByRules, decidePlanPermission } from './plan-permission.js';
import { classifyCliFailure, isWorkspaceTrustError } from './cli-failure.js';
import { buildDevinCapabilityDetail, formatDevinFlagList, isDevinBannerLine, isDevinToolRejectionText } from './devin-diagnostics.js';
import { buildDevinPlanConfig, resolveDevinPlanPermissionMode } from './devin-plan-config.js';
import { buildAtifDigest, summarizeAtifEntry, endedWithoutAnswer, type AtifStepSummary } from './devin-atif.js';
import { isNoisyChangedPath, DEFAULT_FILE_WATCH_NOTICE_LIMIT } from './devin-file-watch.js';
import { saveClaudeSessionId, saveContextUsage, loadClaudeSessionId, clearClaudeSessionId, loadDevinSessionId, saveDevinSessionId, clearDevinSessionId, loadDevinModel, saveDevinModel, clearDevinModel, loadSessionMeta, loadCodexSessionId, saveCodexSessionId, clearCodexSessionId } from './session-store.js';
import { getServerSkipPermissions, reportClaudeAuthExpiredFromRuntime, reportClaudeAuthOkFromRuntime } from './connection.js';
import { buildClaudeLookupCommand, claudeFallbackCandidates } from './claude-locator.js';
import { resolveLoopGuardConfig, createLoopGuardState, observeLoopGuardEvent, checkWallClock } from './sdk-loop-guard.js';
// terminal-runner は node-pty / @xterm/headless に依存するネイティブ寄りモジュール。
// 端末モード未使用時はロードしない（node-pty のネイティブビルド欠落でも Agent 全体は起動できる）
type TerminalRunnerModule = typeof import('./terminal-runner.js');
let terminalRunnerModule: TerminalRunnerModule | null = null;
async function loadTerminalRunner(): Promise<TerminalRunnerModule> {
  if (!terminalRunnerModule) {
    terminalRunnerModule = await import('./terminal-runner.js');
  }
  return terminalRunnerModule;
}
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';

interface AiSession {
  sessionId: string;
  process: ChildProcess;
  projectPath: string;
  aiTool: AiTool;
}

// #276: Devin の `--export`（ATIF 形式で各ステップをファイル書き出し）対応可否キャッシュ。
// v2026.5.26-0 で追加されたバージョン依存フラグのため、初回に `devin --help` でプローブして判定する。
// null=未判定 / true=対応 / false=非対応
let devinSupportsExport: boolean | null = null;

// #308: Codex CLI（`codex exec`）のフラグ対応可否キャッシュ。バージョンによって
// `--json`（構造化出力）や `resume` サブコマンドの有無が変わるため、初回に `--help` でプローブする。
let codexCapabilitiesCache: { json: boolean; resume: boolean } | null = null;

// #309: Gemini CLI / Devin CLI の `--model` フラグ対応可否キャッシュ（plan/exec モデル分離用）。
// 旧バージョンで未対応の場合、引数を付けずに CLI デフォルトへ劣化させる。
let geminiCapabilitiesCache: { model: boolean } | null = null;
// #344: `ok:false`（probe 失敗）の場合は全フラグ true と楽観的に仮定して cache する（理由は関数 JSDoc 参照）。
// 楽観キャッシュは TTL 付き（devinCapabilitiesFailedAt と併用）で、devin が後から PATH に現れても
// Agent プロセスを再起動しなくても再検出できるようにする。`ok:true`（実際に probe 成功）は無期限キャッシュ。
let devinCapabilitiesCache: {
  model: boolean;
  agentConfig: boolean;
  config: boolean;
  permissionMode: boolean;
  // 本サイクル: `--permission-mode` の選択肢一覧に `smart` が含まれるか（#347 の罠の再発防止として
  // devinCapabilitiesCache 型注釈にも必ず追加。probeDevinCapabilities() の戻り値型・成功/失敗
  // 両方の代入箇所とあわせて計3箇所を同時に直す必要がある）。
  permissionModeSmart: boolean;
  promptFile: boolean;
  export: boolean;
  respectWorkspaceTrust: boolean;
  version: string;
  helpBytes: number;
  // #346: help から抽出した `--xxx` 一覧。チャットへの「このマシンで使えるフラグ」通知
  // （devinFlagListNotified/devin.flagList）用。probe 失敗時は空配列。
  flags: string[];
  ok: boolean;
  reason?: string;
} | null = null;
let devinCapabilitiesFailedAt: number | null = null;
// #344: probe 失敗（ok:false）の警告はプロセス寿命中 1 回だけ出す（毎ターン繰り返さない）。
let devinProbeFailedWarned = false;
// #345: `--agent-config` が「非対応」と判定されたときの `--help` 全文ダンプは
// H-A（別バイナリ解決）/H-B（config差）切り分けの証拠採取用。プロセス寿命中 1 回だけ出す。
let devinAgentConfigHelpDumped = false;
// #346: `--agent-config` 非対応時、チャットへの「このマシンで使えるフラグ一覧」通知は
// プロセス寿命中 1 回だけ出す（devinAgentConfigHelpDumped と同じ流儀）。
let devinFlagListNotified = false;
// このサイクル: `--model` が指定されているのに devin CLI が非対応の場合、
// 従来は黙って無視していた（#325「静かなフォールバック禁止」違反）。
// 警告はプロセス寿命中 1 回だけ出す（devinFlagListNotified と同じ流儀）。
let devinModelUnsupportedWarned = false;
// Devin モデル選択サイクル・サイクル B（変更4）: ATIF-v1.7 はターン終了時に一括書き出しされるため、
// `maxSteps` コストガード（ライブポーラー経由）は原理的に機能しない（正直な但し書き、プラン参照）。
// devin 起動時（`devinMaxSteps > 0`）に1回だけ console 警告を出す（プロセス寿命中1回、毎ターン繰り返さない）。
let devinMaxStepsWarned = false;

// #287: SDK 内蔵 cli.js 欠落時のフォールバック用ログ抑制フラグ（同じ警告を毎回出さない）。
let claudeFallbackLogged = false;

/**
 * システムにインストールされた claude CLI の実行パスを解決する。
 * PATH（Windows は `where claude`、それ以外は `command -v claude`、#350）を最優先し、
 * 見つからなければ OS 別の既知パスを順に探す（判定ロジックは claude-locator.ts に集約）。
 * `stdio` は `pipe`（stderr も捨てる）+ `windowsHide: true` で、コンソール無し起動時に
 * 新規コンソール窓が開いたり agent.log へ生の cmd エラーが漏れたりしないようにする。
 * @returns 実在する claude のフルパス、無ければ null
 */
export function resolveSystemClaude(): string | null {
  try {
    const lookupCmd = buildClaudeLookupCommand(process.platform);
    const raw = execSync(lookupCmd, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
    // `where` は複数行を返すことがあるため最初の行のみ使う（resolveClaudePath と同じ扱い）
    const p = raw.split(/\r?\n/)[0]?.trim();
    if (p && fs.existsSync(p)) return p;
  } catch {
    // PATH に無い場合は既知パスへフォールバック
  }
  for (const candidate of claudeFallbackCandidates(process.platform, os.homedir())) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore
    }
  }
  return null;
}

/**
 * Claude Agent SDK が spawn する実行ファイルを解決する（#287）。
 *
 * SDK は `pathToClaudeCodeExecutable` 未指定時、自前バンドルの `<SDK dir>/cli.js` を使う。
 * このファイルが不完全インストール等で欠落していると全 AI コマンドが
 * 「Claude Code executable not found」で失敗する（pixdata 機で発生）。
 * その場合はシステムにインストールされた claude へフォールバックさせる。
 *
 * @returns フォールバック先の claude パス。内蔵 cli.js が健全なら null（＝内蔵版を使う）
 */
export function getClaudeExecutableFallback(): string | null {
  try {
    const _require = createRequire(import.meta.url);
    // SDK のエントリ（sdk.mjs）を解決 → その隣の cli.js が内蔵実行ファイル
    const sdkEntry = _require.resolve('@anthropic-ai/claude-agent-sdk');
    const bundledCli = path.join(path.dirname(sdkEntry), 'cli.js');
    if (fs.existsSync(bundledCli)) {
      return null; // 内蔵版が健全 → 従来どおり SDK 既定に委ねる
    }
    // 内蔵 cli.js 欠落 → システム claude へフォールバック
    const sys = resolveSystemClaude();
    if (!claudeFallbackLogged) {
      if (sys) {
        console.warn(`⚠️ [SDK] bundled cli.js missing at ${bundledCli} → falling back to system claude: ${sys}`);
      } else {
        console.error(`❌ [SDK] bundled cli.js missing at ${bundledCli} and no system claude found. Run a clean reinstall in ~/.devrelay/agent (rm -rf node_modules/@anthropic-ai/claude-agent-sdk && pnpm install)`);
      }
      claudeFallbackLogged = true;
    }
    return sys;
  } catch {
    // 解決に失敗した場合は内蔵版に委ねる（従来動作を壊さない）
    return null;
  }
}

/**
 * 起動時セルフチェック（#287・B-2）。SDK 内蔵 cli.js の状態を agent.log に 1 度だけ明示する。
 * 欠落時は毎コマンドの暗号的エラーを待たず、起動直後に状況とフォールバック先を通知する。
 */
export function logClaudeExecutableStatus(): void {
  try {
    const _require = createRequire(import.meta.url);
    const sdkEntry = _require.resolve('@anthropic-ai/claude-agent-sdk');
    const bundledCli = path.join(path.dirname(sdkEntry), 'cli.js');
    if (fs.existsSync(bundledCli)) {
      console.log('🩺 [SDK] bundled Claude Code cli.js: OK');
      return;
    }
    const sys = resolveSystemClaude();
    if (sys) {
      console.warn(`🩺 [SDK] bundled cli.js MISSING → will use system claude: ${sys}`);
    } else {
      console.error('🩺 [SDK] bundled cli.js MISSING and no system claude found — AI commands will fail. Reinstall the agent SDK.');
    }
  } catch {
    // 解決失敗時は無視（従来どおり実行時に SDK 既定で判定される）
  }
}

/**
 * Devin CLI が `--export` フラグに対応しているか `--help` の出力で判定する（結果はキャッシュ）。
 * 途中経過表示（ATIF テイル）のベストエフォート機能であり、失敗時は false（機能を使わない）に倒す。
 * @param command devin コマンドのフルパス
 * @returns 対応していれば true
 */
function probeDevinExportSupport(command: string): boolean {
  // #329: 実体は probeDevinCapabilities() に統合済み（--help 呼び出しを1回に集約）。
  // 既存の呼び出し側とログ行を変えないための薄いラッパー。
  if (devinSupportsExport !== null) return devinSupportsExport;
  devinSupportsExport = probeDevinCapabilities(command).export;
  console.log(`[devin] 🔎 --export support: ${devinSupportsExport}`);
  return devinSupportsExport;
}

/**
 * Codex CLI（`codex exec`）が `--json`（構造化出力）と `resume` サブコマンドに対応しているか
 * `codex exec --help` の出力で判定する（結果はキャッシュ）。
 * v0.147.0 で `--full-auto` が削除された等フラグの変化が速いため、決め打ちにせずプローブする。
 * 失敗時は両方 false に倒し、プレーンテキスト実行・resume 無効で安全側に倒す。
 * @param command codex コマンドのフルパス
 * @returns `{ json, resume }` 対応可否
 */
function probeCodexCapabilities(command: string): { json: boolean; resume: boolean } {
  if (codexCapabilitiesCache !== null) return codexCapabilitiesCache;
  try {
    const help = execSync(`${command} exec --help`, { encoding: 'utf-8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const json = /--json\b/.test(help);
    const resume = /\bresume\b/.test(help);
    codexCapabilitiesCache = { json, resume };
    console.log(`[codex] 🔎 capabilities: --json=${json}, resume=${resume}`);
  } catch (err) {
    codexCapabilitiesCache = { json: false, resume: false };
    console.warn(`[codex] exec --help probe failed, using minimal flags:`, (err as Error).message);
  }
  return codexCapabilitiesCache;
}

/**
 * Gemini CLI が `-m/--model` フラグに対応しているか `gemini --help` の出力で判定する（結果はキャッシュ）。
 * 失敗時は false に倒し、モデル引数を付けずに CLI デフォルトへ劣化させる。
 * @param command gemini コマンドのフルパス
 * @returns `{ model }` 対応可否
 */
function probeGeminiCapabilities(command: string): { model: boolean } {
  if (geminiCapabilitiesCache !== null) return geminiCapabilitiesCache;
  try {
    const help = execSync(`${command} --help`, { encoding: 'utf-8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const model = /-m,?\s*--model\b|--model\b/.test(help);
    geminiCapabilitiesCache = { model };
    console.log(`[gemini] 🔎 capabilities: --model=${model}`);
  } catch (err) {
    geminiCapabilitiesCache = { model: false };
    console.warn(`[gemini] --help probe failed, disabling --model:`, (err as Error).message);
  }
  return geminiCapabilitiesCache;
}

/**
 * Devin CLI のフラグ対応可否を `devin --help` の出力で一括判定する（結果はキャッシュ、#329）。
 * バージョンによって `--agent-config`/`--permission-mode`/`--prompt-file` の有無が異なり、
 * 非対応フラグを渡すと clap が exit code 2 で即死し fullOutput 空 → 汎用「(No response from AI)」に
 * 落ちて実際のエラーが届かない問題があったため、--model/--export と同じ probe 方式に統一する。
 *
 * #344: 失敗時の扱いを「全て false（悲観）」から「全て true（楽観）」に反転した。
 * 悲観側は「実際は devin が正しく `--agent-config` 等に対応しているのに probe だけが
 * （PATH 不在・更新直後のキャッシュ汚染・`--help` の非 0 終了等で）失敗した」場合に、
 * 誤った非対応警告 + 危険な引数フォールバック（#344 で廃止）を静かに発動させてしまう。
 * 楽観側に倒しても、実際に非対応だった場合は `unexpected argument` を検出する既存の
 * 自動リトライ（最大3回、フラグを1つずつ外す）が安全網として受け止める。
 * 失敗キャッシュのみ `DEVRELAY_DEVIN_PROBE_TTL_MS`（既定60000ms）で期限切れにし、
 * 成功キャッシュは Agent プロセス寿命いっぱい保持する。
 *
 * #345: `--respect-workspace-trust`（workspace trust 拒否対策）を追加。また、`--agent-config` が
 * 実機の `devin --help` には存在するのに false と判定される事例（#345 §40）の切り分け用に
 * `devin --version` と `helpBytes`（help 文字数）も 1 回だけ計測して診断ログ・診断メッセージに使う
 * （version/helpBytes 自体は probe の成否や各フラグ判定に一切影響しない）。
 * @param command devin コマンドのフルパス
 * @returns 各フラグの対応可否 + 診断情報（version/helpBytes/flags）+ `ok`（probe 自体が成功したか）+ 失敗時の `reason`
 */
function probeDevinCapabilities(command: string): {
  model: boolean;
  agentConfig: boolean;
  config: boolean;
  permissionMode: boolean;
  permissionModeSmart: boolean;
  promptFile: boolean;
  export: boolean;
  respectWorkspaceTrust: boolean;
  version: string;
  helpBytes: number;
  flags: string[];
  ok: boolean;
  reason?: string;
} {
  if (devinCapabilitiesCache !== null) {
    const ttlMs = Number(process.env.DEVRELAY_DEVIN_PROBE_TTL_MS) || 60000;
    const cacheExpired = !devinCapabilitiesCache.ok &&
      devinCapabilitiesFailedAt !== null &&
      Date.now() - devinCapabilitiesFailedAt >= ttlMs;
    if (!cacheExpired) return devinCapabilitiesCache;
  }
  try {
    const help = execSync(`${command} --help`, { encoding: 'utf-8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const model = /--model\b/.test(help);
    const agentConfig = /--agent-config\b/.test(help);
    // #347: --agent-config は廃止済み（#346）で、後継が --config（グローバル引数、Phase 0 実測で確認済み）。
    const configFlag = /--config\b/.test(help);
    const permissionMode = /--permission-mode\b/.test(help);
    // 本サイクル: `devin --help` の `--permission-mode` 選択肢の説明文中に `"smart"` が
    // 現れるかで判定する（3000.6.7 実測の逐語: `"smart" additionally auto-runs actions a
    // fast model judges safe`）。誤検出で存在しない値を CLI に渡すと未知の引数エラーに
    // なるため、緩い `/smart/i` ではなくこの特定フレーズにマッチさせる。
    const permissionModeSmart = /"smart"\s+additionally auto-runs/i.test(help);
    const promptFile = /--prompt-file\b/.test(help);
    const exportFlag = /--export\b/.test(help);
    const respectWorkspaceTrust = /--respect-workspace-trust\b/.test(help);
    let version = 'unknown';
    try {
      // #345: 診断専用の 1 行取得。失敗しても probe 自体（フラグ判定）は失敗させない。
      version = execSync(`${command} --version`, { encoding: 'utf-8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim().split('\n')[0] || 'unknown';
    } catch {
      // バージョン取得は診断用のため失敗は無視（version は 'unknown' のまま）
    }
    const helpBytes = help.length;
    // #346: フラグ一覧を先に計算してキャッシュに含める（チャットへの「使えるフラグ」通知に使う）
    const detectedFlags = Array.from(new Set(help.match(/--[a-z][a-z-]*/gi) ?? [])).sort();
    devinCapabilitiesCache = { model, agentConfig, config: configFlag, permissionMode, permissionModeSmart, promptFile, export: exportFlag, respectWorkspaceTrust, version, helpBytes, flags: detectedFlags, ok: true };
    devinCapabilitiesFailedAt = null;
    console.log(`[devin] 🔎 capabilities: --model=${model} --agent-config=${agentConfig} --config=${configFlag} --permission-mode=${permissionMode} --permission-mode-smart=${permissionModeSmart} --prompt-file=${promptFile} --export=${exportFlag} --respect-workspace-trust=${respectWorkspaceTrust} version=${version} helpBytes=${helpBytes}`);
    console.log(`[devin] 🔎 detected flags: ${detectedFlags.join(' ')}`);
    if (!agentConfig && !configFlag && !devinAgentConfigHelpDumped) {
      // #345: --agent-config/--config どちらも「非対応」と判定された場合のみ、H-A/H-B 切り分けのため help 全文を 1 回だけ dump
      devinAgentConfigHelpDumped = true;
      console.log(`[devin] 🔎 --agent-config/--config not detected, full --help dump:\n${help}`);
    }
  } catch (err) {
    // permissionModeSmart のみ他フラグと異なり楽観 true にしない: 他フラグは「実は対応しているのに
    // 誤って非対応判定」しても実行時に `unexpected argument` エラーで #329 の自動リトライ安全網が
    // 拾えるが、`--permission-mode smart` は値が enum 制約のため異なるエラー文言になりうる。
    // probe 失敗時は安全側の 'auto' に倒す（resolveDevinPlanPermissionMode 参照）。
    devinCapabilitiesCache = { model: true, agentConfig: true, config: true, permissionMode: true, permissionModeSmart: false, promptFile: true, export: true, respectWorkspaceTrust: true, version: 'unknown', helpBytes: 0, flags: [], ok: false, reason: (err as Error).message };
    devinCapabilitiesFailedAt = Date.now();
    console.warn(`[devin] --help probe failed, assuming all flags supported (optimistic, TTL applies):`, (err as Error).message);
  }
  return devinCapabilitiesCache;
}

/**
 * #309: モデル ID の二重サニタイズ（server 側で既に検証済みだが、MCP 等 server を経由しない
 * 将来の呼び出し経路への保険として Agent 側でも検証する）。
 * 引用符・空白・セミコロン・ドルサイン・バッククォート・改行を含む値は危険とみなし、
 * CLI インジェクション（TOML/シェル）を避けるため無視して undefined を返す。
 * @param model 未検証のモデル ID（未指定なら undefined）
 * @returns 安全なモデル ID、または undefined（未指定 or 危険な値）
 */
function safeModelArg(model: string | undefined): string | undefined {
  if (!model) return undefined;
  if (isUnsafeModelId(model)) {
    console.warn(`⚠️ 危険な文字を含むモデル ID を無視: ${JSON.stringify(model)}`);
    return undefined;
  }
  return model;
}

/**
 * Codex CLI（`--json`）の `item.completed` イベント（`agent_message`/`reasoning` 以外）を
 * 人間可読な短い進捗要約に変換する。フィールド名はベストエフォート（未知フィールドは type のみ表示）。
 * @param item `item.completed` イベントの `item` オブジェクト
 * @returns 「⏳ 」なしの要約文字列（呼び出し側で ⏳ prefix を付与）。認識不能なら null
 */
function summarizeCodexItem(item: any, lang: Language = DEFAULT_CHAT_LANGUAGE): string | null {
  const type = item?.type;
  if (!type) return null;
  switch (type) {
    case 'command_execution':
      return tChat(lang, 'progress.codexCommand', { cmd: item.command || item.cmd || '' }).trim();
    case 'file_change':
      return tChat(lang, 'progress.codexFile', { path: item.path || item.file || '' });
    case 'web_search':
      return tChat(lang, 'progress.codexSearch', { query: item.query || '' });
    case 'mcp_tool_call':
      return tChat(lang, 'progress.usingTool', { tool: item.tool_name || item.tool || tChat(lang, 'progress.mcpTool') });
    default:
      return `[${type}]`;
  }
}

/**
 * Devin モデル選択サイクル・サイクル B（変更4）: `AtifStepSummary`（`devin-atif.ts` の構造化データ）を
 * 表示用文字列へ整形する（旧 `summarizeAtifEntry()` の表示部分のみを残したもの）。
 * パース自体は `devin-atif.ts` の純関数群に委譲済みのため、ここでは文字列組み立てのみ行う。
 * @param s `summarizeAtifEntry()`（devin-atif.ts 側）の戻り値
 * @param lang 表示言語
 * @returns 表示用文字列。`tool`/`title` とも無ければ null
 */
function formatAtifStepSummary(s: AtifStepSummary, lang: Language = DEFAULT_CHAT_LANGUAGE): string | null {
  if (s.tool && s.title) return `${s.tool}: ${s.title}`;
  if (s.tool) return tChat(lang, 'progress.devinStep', { tool: s.tool });
  if (s.title) return s.title;
  return null;
}

/** Devin ATIF ダイジェストの読み取り結果（`ai-runner.ts` 側で使う表示済み文字列 + 生データ） */
interface DevinTurnDigest {
  summaryText: string;
  modelName: string | null;
  modelId: string | null;
  usage: import('./devin-atif.js').AtifUsageTotals | null;
  totalSteps: number;
  permissionMode: string | null;
  /** 欠陥1対策: 最後のステップがツール呼び出しで終わっている（＝テキスト応答が無い無言終了）か */
  endedWithoutAnswer: boolean;
}

/**
 * #281→変更4/5: ATIF エクスポートファイル全体を読み、実行ステップ要約・モデル名・使用量を読み取る。
 * devin は turn 終了時に ATIF を一括書き出しする（「Exports after each turn」）ため、
 * 実行中の live tail はゼロ件になる。そこで完了時にまとめて読み、最終回答の末尾へ
 * 「🧭 実行ステップ (N件): ...」として添付し、「何をやったか」を可視化する。
 * パース本体（steps 抽出・tool_calls 対応・モデル/使用量マッピング）は `devin-atif.ts` の
 * `buildAtifDigest()` に委譲し、ここでは fs I/O と表示用文字列の組み立てのみ行う。
 * @param exportPath ATIF ファイルパス
 * @param lang 表示言語
 * @returns ステップ要約文字列・モデル名・使用量・実ステップ数。読み取れなければ null
 */
function readDevinTurnDigest(exportPath: string, lang: Language = DEFAULT_CHAT_LANGUAGE): DevinTurnDigest | null {
  let content: string;
  try {
    content = fs.readFileSync(exportPath, 'utf-8');
  } catch {
    return null;
  }
  const digest = buildAtifDigest(content);
  if (!digest) {
    // スキーマ不一致の可能性 → 先頭を記録（v2 パーサ修正用）
    console.log(`[devin] ATIF parsed 0 steps; head sample: ${content.slice(0, 500)}`);
    return null;
  }
  const formatted: string[] = [];
  for (const s of digest.steps) {
    const f = formatAtifStepSummary(s, lang);
    if (f) formatted.push(f);
  }
  let summaryText = '';
  if (formatted.length > 0) {
    const shown = formatted.slice(0, 10);
    const more = formatted.length > shown.length ? `（他${formatted.length - shown.length}件）` : '';
    summaryText = `\n\n🧭 実行ステップ (${formatted.length}件): ${shown.join(' → ')}${more}\n`;
  }
  return {
    summaryText,
    modelName: digest.modelName,
    modelId: digest.modelId,
    usage: digest.usage,
    totalSteps: digest.totalSteps,
    permissionMode: digest.permissionMode,
    endedWithoutAnswer: endedWithoutAnswer(digest.steps),
  };
}

/**
 * #282: devin の toolbox ログ（CHISEL_LOG_STDERR=1 で stderr に流れる内部ログ）を
 * 日本語の進捗表示に変換する。既知パターンは日本語、未知パターンは原文（英語）のまま返す。
 * devin バイナリのログ文字列は英語ハードコードのためプロンプトでは変えられず、Agent 側で変換する。
 */
function formatDevinToolLog(toolName: string, message: string): string {
  // #283: session_manager はコマンド実行行だけ拾い、それ以外（ロック取得/PTY 準備等）はノイズとして非表示
  if (toolName === 'session_manager') {
    // Rust Debug 表記の shell=... { ... command: "..." ... } から command を抽出
    const c = message.match(/command:\s*"((?:[^"\\]|\\.)*)"/);
    if (c) return `💻 コマンド実行中: ${c[1].replace(/\\\\/g, '\\')}`;
    return ''; // 空文字 = 呼び出し側で表示スキップ
  }
  // #283: glob: "Searching for files matching pattern: <pat> in <dir>"（実機ログで書式確認済み）
  let m = message.match(/^Searching for files matching pattern:\s*(.+?)\s+in\s+(.+)$/i);
  if (m) return `🔍 ${m[2]} で ${m[1]} を検索中...`;
  // write: "Writing to file: <path>"（実機サンプルで書式確認済み）
  m = message.match(/^Writing to file:\s*(.+)$/i);
  if (m) return `📝 ${m[1]} に書き込み中...`;
  // read 系: "Reading file: <path>" 等（実機ログで書式確認済み）
  m = message.match(/^Reading(?: file)?:?\s*(.+)$/i);
  if (m) return `📖 ${m[1]} を読み込み中...`;
  // exec 系: "Executing command: <cmd>" / "Running: <cmd>" 等
  m = message.match(/^(?:Executing(?: command)?|Running):?\s*(.+)$/i);
  if (m) return `💻 コマンド実行中: ${m[1]}`;
  // 未知パターン: 原文のまま（英語）。実ログを見て変換表を拡充する
  return `🔧 [${toolName}] ${message}`;
}

/** レートリミット情報（rate_limit_event から取得） */
interface RateLimitEntry {
  utilization: number;
  resetsAt?: number;
  status: string;
}

export interface AiRunResult {
  extractedSessionId?: string;
  contextUsage?: ContextUsage;
  resumeFailed?: boolean;  // True if --resume failed (exit code 1 + no output)
  /** Claude Code result メッセージから抽出した使用量データ */
  usageData?: AiUsageData;
  /** レートリミット情報（SDK の rate_limit_event から取得） */
  rateLimits?: {
    fiveHour?: RateLimitEntry;
    sevenDay?: RateLimitEntry;
  };
  /**
   * #355: sdk-loop-guard により auto-compact 無限ループ等を検知し、
   * このターンでセッションを強制打ち切り・破棄した場合に true。
   * true の場合、呼び出し元（connection.ts）は claudeResumeSessionId を
   * ファイル・メモリ両方から破棄し、次ターンを新規セッションで開始しなければならない
   * （resume すると肥大したサマリごと復活し即座に再発するため）。
   */
  sessionDiscarded?: boolean;
}

// #355: activeSdkAborts — 実行中の Claude SDK クエリを外部から中断するための
// AbortController レジストリ（sessionId 単位）。cancelAiSession() の `c` コマンド経路と
// sdk-loop-guard によるタイムアウト強制打ち切りの両方から使用する。
const activeSdkAborts = new Map<string, AbortController>();

// Active AI sessions: sessionId -> AiSession
const activeSessions = new Map<string, AiSession>();

/** AI出力コールバック。isComplete=true の場合、usageData に使用量データが含まれる */
type OutputCallback = (output: string, isComplete: boolean, usageData?: AiUsageData) => void;

export async function startAiSession(
  sessionId: string,
  projectPath: string,
  aiTool: AiTool,
  config: AgentConfig,
  onOutput: OutputCallback
): Promise<void> {
  // 新しい会話（Claude Code インスタンス）開始時に「以降すべて許可」モードをリセット
  // 前の会話で approveAllMode が有効でも、新会話では改めて承認を要求する
  resetApproveAllMode();

  // Check if session already exists (race condition between session:start and ai:prompt)
  if (activeSessions.has(sessionId)) {
    console.log(`⚠️ Session already exists, skipping duplicate start: ${sessionId}`);
    return;
  }

  // Get AI tool command
  const command = getAiCommand(aiTool, config);
  if (!command) {
    throw new Error(`AI tool not configured: ${aiTool}`);
  }

  console.log(`🚀 Session ready for ${aiTool} in ${projectPath}`);

  // Don't spawn process here - we'll use -p mode for each prompt
  // Just register the session
  const session: AiSession = {
    sessionId,
    process: null as any, // No persistent process
    projectPath,
    aiTool,
  };

  activeSessions.set(sessionId, session);
}

/**
 * プランモード中に許可する読み取り専用 Bash コマンドのデフォルトリスト
 * Server DB（UserSettings）から配信された値がある場合はそちらを優先する
 * @deprecated connection.ts の serverAllowedTools を使用。これは後方互換用の re-export
 */
export const PLAN_MODE_ALLOWED_TOOLS = DEFAULT_ALLOWED_TOOLS_LINUX;

/** ツール承認リクエストのペイロード（Agent → Server 経由でユーザーに送信） */
export interface ToolApprovalRequest {
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  title?: string;
  description?: string;
  decisionReason?: string;
  /** AskUserQuestion の場合 true */
  isQuestion?: boolean;
}

/** ツール承認レスポンス（ユーザー → Server 経由で Agent に返却） */
export interface ToolApprovalResponse {
  behavior: 'allow' | 'deny';
  message?: string;
  /** true の場合、以降の全ツール実行を自動許可する */
  approveAll?: boolean;
  /** セッション内で常時許可するツールルール（例: "Edit", "Bash(git *)"） */
  alwaysAllowRule?: string;
  /** AskUserQuestion の回答（question → selected label のマップ） */
  answers?: Record<string, string>;
}

/**
 * 「以降すべて許可」フラグ（セッション単位）
 * ユーザーが「以降すべて許可」を選んだ場合に true になり、以降の canUseTool は即座に allow を返す
 */
let approveAllMode = false;

/**
 * セッション内で「📌 常に許可」されたツールルールの Set（セッション単位）
 * 例: Set { "Edit", "Bash(git *)" }
 * exec 開始時にリセットされる
 */
const sessionApprovedTools = new Set<string>();

/**
 * セッション内の常時許可ルールにマッチするかチェックする
 * （matchesToolRule は #332 で ./plan-permission.js に抽出済み。ロジック重複を作らないため import して使う）
 * @returns マッチした場合 true
 */
function isToolSessionApproved(toolName: string, input: Record<string, unknown>): boolean {
  if (sessionApprovedTools.size === 0) return false;
  for (const rule of sessionApprovedTools) {
    if (matchesToolRule(rule, toolName, input)) return true;
  }
  return false;
}

/** 「以降すべて許可」モードかどうかを確認する（canUseTool コールバック内で使用） */
export function isApproveAllMode(): boolean {
  return approveAllMode;
}

/** 「以降すべて許可」モード + セッション許可ツールをリセットする（新セッション開始時に呼び出す） */
export function resetApproveAllMode(): void {
  approveAllMode = false;
  sessionApprovedTools.clear();
}

/**
 * 保留中のツール承認リクエストを管理する Map
 * requestId → { resolve, reject, input }
 */
const pendingToolApprovals = new Map<string, {
  resolve: (value: PermissionResult) => void;
  reject: (reason: Error) => void;
  input: Record<string, unknown>;
}>();

/**
 * 端末モードの承認応答 resolver。
 * SDK の pendingToolApprovals と並列で存在し、端末モードは PTY に書き戻すための
 * シンプルな関数（optionIndex → PTY に "N\r" 書き込み）を登録する。
 * options を保存して QuestionCard からの応答（ラベルテキスト）→ index 逆引きに使う。
 */
const terminalApprovalResolvers = new Map<string, { respond: (optionIndex: number) => void; options: string[] }>();

/**
 * AI 画面解析の pending resolver Map。
 * terminal-runner が requestId を登録し、connection.ts 経由で Server からの
 * レスポンスが到着したら resolve する。
 */
const pendingScreenAnalyses = new Map<string, (analysis: import('@devrelay/shared').ScreenAnalysis) => void>();

/**
 * AI 画面解析の resolver を登録する（connection.ts から呼ばれる）
 */
export function registerScreenAnalysisResolver(requestId: string, resolve: (analysis: import('@devrelay/shared').ScreenAnalysis) => void) {
  pendingScreenAnalyses.set(requestId, resolve);
}

/**
 * AI 画面解析の resolver を削除する（タイムアウト時に呼ばれる）
 */
export function unregisterScreenAnalysisResolver(requestId: string) {
  pendingScreenAnalyses.delete(requestId);
}

/**
 * 応答要約の pending resolver Map。
 * terminal-runner が requestId を登録し、Server からのレスポンスが到着したら resolve する。
 */
const pendingResponseSummaries = new Map<string, (summary: string) => void>();

/** 応答要約の resolver を登録する */
export function registerResponseSummaryResolver(requestId: string, resolve: (summary: string) => void) {
  pendingResponseSummaries.set(requestId, resolve);
}

/** 応答要約の resolver を削除する（タイムアウト時） */
export function unregisterResponseSummaryResolver(requestId: string) {
  pendingResponseSummaries.delete(requestId);
}

/** Server からの応答要約レスポンスを解決する */
export function resolveResponseSummary(requestId: string, summary: string) {
  const resolver = pendingResponseSummaries.get(requestId);
  if (resolver) {
    pendingResponseSummaries.delete(requestId);
    resolver(summary);
  }
}

/**
 * Server からの画面解析レスポンスを受け取り、pending resolver を解決する
 * connection.ts から呼び出される
 */
export function resolveScreenAnalysis(requestId: string, analysis: import('@devrelay/shared').ScreenAnalysis) {
  const resolver = pendingScreenAnalyses.get(requestId);
  if (resolver) {
    pendingScreenAnalyses.delete(requestId);
    resolver(analysis);
  } else {
    console.warn(`⚠️ [screen-analyze] no pending resolver for requestId: ${requestId.slice(0, 8)}`);
  }
}

/**
 * Server からのツール承認レスポンスを受け取り、保留中の Promise を解決する
 * connection.ts から呼び出される
 */
export function resolveToolApproval(requestId: string, response: ToolApprovalResponse): boolean {
  // 端末モードの resolver があれば優先（PTY に番号を書き戻す）
  const entry = terminalApprovalResolvers.get(requestId);
  if (entry) {
    terminalApprovalResolvers.delete(requestId);
    let optionIndex = 0;
    if (response.answers) {
      // QuestionCard からの回答: 選択されたラベルから options index を逆引き
      const selectedLabel = Object.values(response.answers)[0];
      if (selectedLabel) {
        const idx = entry.options.indexOf(selectedLabel);
        optionIndex = idx >= 0 ? idx : 0;
      }
      console.log(`📥 [terminal-mode] resolving question ${requestId.slice(0, 8)} → "${selectedLabel}" (option ${optionIndex + 1})`);
    } else {
      // 従来の Allow/Deny マッピング（フォールバック）
      optionIndex = response.behavior === 'allow' ? 0 : 1;
      console.log(`📥 [terminal-mode] resolving approval ${requestId.slice(0, 8)} → ${response.behavior} (option ${optionIndex + 1})`);
    }
    entry.respond(optionIndex);
    return true;
  }

  const pending = pendingToolApprovals.get(requestId);
  if (!pending) {
    console.log(`⚠️ Unknown tool approval requestId: ${requestId}`);
    return false;
  }
  pendingToolApprovals.delete(requestId);

  // 「以降すべて許可」フラグを設定
  if (response.approveAll) {
    approveAllMode = true;
    console.log(`🔓 Approve-all mode activated (all subsequent tools will be auto-approved)`);
  }

  // 「📌 常に許可」ルールをセッション許可ツールに追加
  if (response.alwaysAllowRule) {
    sessionApprovedTools.add(response.alwaysAllowRule);
    console.log(`📌 Session-approved tool rule added: "${response.alwaysAllowRule}" (total: ${sessionApprovedTools.size})`);
  }

  // AskUserQuestion の回答: deny-with-answer パターンで Claude に回答を返す
  if (response.answers && Object.keys(response.answers).length > 0) {
    const answerLines = Object.entries(response.answers)
      .map(([q, a]) => `Q: ${q}\nA: ${a}`)
      .join('\n\n');
    console.log(`❓ User answered question(s): ${Object.values(response.answers).join(', ')}`);
    pending.resolve({
      behavior: 'deny',
      message: `User answered the questions:\n\n${answerLines}`,
    });
    return true;
  }

  if (response.behavior === 'allow') {
    pending.resolve({ behavior: 'allow', updatedInput: pending.input });
  } else {
    pending.resolve({ behavior: 'deny', message: response.message || 'ユーザーが拒否しました' });
  }
  return true;
}

/**
 * OAuth トークン期限切れ（`OAuth access token has expired`）または再ログイン要求
 * （`Please run /login`）のメッセージかどうかを判定する（Claude ログイン切れ検知、Phase1）。
 * `formatAiErrorMessage`（catch ブロックの例外パス）と assistant テキストブロックの
 * 両方から参照する単一情報源（#338: `claude auth status --json` はローカルの資格情報の
 * 有無しか見ておらずこのケースを検知できないため、実行時のメッセージ検知が唯一確実な経路）。
 */
function isClaudeAuthExpiredMessage(message: string): boolean {
  return /OAuth access token has expired|Please run \/login/i.test(message);
}

/**
 * AI 実行時エラーメッセージを整形する（Claude ログイン切れ検知の実行時併用、リモート再ログイン中継 Phase1）。
 * SDK/CLI が投げる生のエラーに `OAuth access token has expired` / `Please run /login` が含まれる場合、
 * ユーザーには生エラーではなく「login で復旧できます」という実行可能なヒントを返す。
 * それ以外のエラーは従来どおり `Error: {message}` のまま返す（挙動を変えない）。
 */
function formatAiErrorMessage(message: string, lang: Language = DEFAULT_CHAT_LANGUAGE): string {
  if (isClaudeAuthExpiredMessage(message)) {
    return tChat(lang, 'claudeAuth.runtimeExpiredHint');
  }
  return `Error: ${message}`;
}

export interface SendPromptOptions {
  /** Claude session ID to resume (from previous execution) */
  resumeSessionId?: string;
  /** Use plan mode (--permission-mode plan) instead of skip-permissions */
  usePlanMode?: boolean;
  /** プランモード中に許可する読み取り専用ツール（--allowedTools） */
  allowedTools?: string[];
  /** 全ツール自動許可モード（true = --dangerously-skip-permissions 相当） */
  skipPermissions?: boolean;
  /** AskUserQuestion 無効化（true = SDK disallowedTools で除去） */
  disableAsk?: boolean;
  /**
   * 端末インタフェースモード（PTY 経由で claude --continue を起動）
   * true かつ aiTool === 'claude' の場合、Agent SDK ではなく PTY ランナーを使う
   */
  terminalMode?: boolean;
  /**
   * ツール承認リクエストのコールバック（Agent SDK 経由の exec モードで使用）
   * 設定されている場合、canUseTool で WebSocket 経由のユーザー承認を行う
   * 未設定の場合は全ツール自動許可（後方互換）
   */
  onToolApprovalRequest?: (request: ToolApprovalRequest) => void;
  /** 「以降すべて許可」モードで自動承認した際の通知コールバック */
  onAutoApproved?: (info: { toolName: string; toolInput: Record<string, unknown> }) => void;
  /**
   * AI 画面解析リクエスト送信コールバック（Terminal Mode 用）。
   * ヒューリスティックで画面状態を判定できなかった場合に Server 経由で Claude Haiku を呼ぶ。
   * connection.ts で sendMessage を使って配線される。未設定の場合は AI フォールバックなし。
   */
  onScreenAnalyzeRequest?: (screenText: string, context: string, sessionId: string) => Promise<import('@devrelay/shared').ScreenAnalysis | null>;
  /**
   * 応答要約リクエスト送信コールバック（Terminal Mode 用）。
   * 完了時に JSONL テキストを Server 経由で Haiku に要約させる。
   */
  onResponseSummarizeRequest?: (assistantText: string, sessionId: string) => Promise<string>;
  /** MCP 経由の新規 submit: 前回セッションの resume をスキップ */
  forceNewSession?: boolean;
  /**
   * AI モデル指定（#309: claude/codex/gemini/devin 共通）。
   * claude: 'sonnet', 'opus', 'haiku' 等（Claude SDK にそのまま渡す）
   * codex: `-c model="..."` で渡す（例: 'gpt-5.5'）
   * gemini: `-m` で渡す（例: 'gemini-3.1-pro'）
   * devin: `--model` で渡す（fuzzy 名可、例: 'opus'）
   * 省略時は各 CLI のデフォルト
   */
  model?: string;
  /**
   * Devin プランモード内部フォールバックフラグ（#274）。
   * true の場合、plan の agent-config（Read only, Write/Exec deny）ではなく
   * `--permission-mode auto`（安全ツールのみ自動承認）で実行する。
   * agent-config の deny で Devin が「A tool was rejected」→ 出力ゼロになる問題の回避用。
   * 内部リトライでのみ設定され、無限ループを防ぐガードも兼ねる。
   */
  devinAutoPermFallback?: boolean;
  /**
   * #329: 「unexpected argument」で拒否された Devin CLI フラグ名のリスト。
   * close ハンドラの自動リトライでのみ設定され、無限ループを防ぐガード（上限2個）も兼ねる。
   */
  devinDroppedFlags?: string[];
  /**
   * w コマンド（ドキュメント更新 + git commit/push）実行フラグ（#312）。
   * Codex の workspace-write サンドボックスは .git を read-only にするため commit が
   * `Unable to create '.git/index.lock': Read-only file system` で失敗する。
   * true の場合、Codex の sandbox_mode を danger-full-access に切り替える。
   */
  isWCommand?: boolean;
  /**
   * #316: チャット表示言語。'en' の場合、AI への指示文の末尾に「英語で応答して」という
   * 追加指示を付与し、AI 自身の返答言語をユーザーの選択言語に追従させる。
   * 未指定・'ja' の場合は従来どおり何も付与しない（既存挙動を変えないため）。
   */
  language?: import('@devrelay/shared').Language;
  /**
   * #332: plan モードの strictReadonly ポリシー（MCP submit_instruction 経由）。
   * true の場合、plan モードの canUseTool で allowlist（allowedTools の Bash パターン + PLAN_READONLY_TOOLS）
   * 外のツールを skipPermissions の値に関係なく聞かずに deny する。exec モードには一切影響しない。
   */
  strictReadonly?: boolean;
  /**
   * #332: strictReadonly により plan モードでツールが deny された際の通知コールバック。
   * ToolApproval への監査記録・WebUI/Discord/Telegram への通知に使う。
   */
  onPolicyDenied?: (info: { toolName: string; toolInput: Record<string, unknown>; reason: string }) => void;
  /**
   * #348: projectPath 上の永続状態（claude-session-id / context-usage）を書き込むかどうか。
   * 既定 true（従来どおり）。一時セッション（ask-member/teamexec-member/askDesc）は
   * connection.ts 側で false を渡し、他セッションの resume 先やコンテキスト表示を汚染しないようにする。
   */
  persistProjectState?: boolean;
}

/**
 * Agent SDK を使用して Claude Code にプロンプトを送信する
 * spawn('claude', ['-p', ...]) の代わりに SDK の query() を使用
 *
 * @param sessionId DevRelay セッション ID
 * @param prompt 送信するプロンプト
 * @param projectPath プロジェクトディレクトリ
 * @param claudeSessionId Claude Code セッション ID（resume 用）
 * @param config Agent 設定
 * @param onOutput 出力コールバック
 * @param options 送信オプション
 * @returns AI 実行結果
 */
async function sendPromptToAiSdk(
  sessionId: string,
  prompt: string,
  projectPath: string,
  claudeSessionId: string,
  config: AgentConfig,
  onOutput: OutputCallback,
  options: SendPromptOptions = {}
): Promise<AiRunResult> {
  const result: AiRunResult = {};
  let fullOutput = '';
  // 完了シグナルを二重送信しないためのフラグ（result ハンドラで送信済みならループ後の送信をスキップ）
  let completionSent = false;

  /** config.proxy がある場合、AI プロセスにもプロキシ環境変数を注入 */
  const proxyEnv: Record<string, string> = {};
  if (config.proxy?.url) {
    const proxyUrl = config.proxy.url;
    proxyEnv.HTTP_PROXY = proxyUrl;
    proxyEnv.HTTPS_PROXY = proxyUrl;
    proxyEnv.http_proxy = proxyUrl;
    proxyEnv.https_proxy = proxyUrl;
  }

  /** SDK query のオプション構築 */
  const sdkOptions: Parameters<typeof query>[0]['options'] = {
    cwd: projectPath,
    maxTurns: 200,
    settingSources: ['user', 'project'],
    env: {
      ...process.env,
      ...proxyEnv,
      DEVRELAY: '1',
      DEVRELAY_SESSION_ID: sessionId,
      DEVRELAY_PROJECT: projectPath,
    },
    // Claude SDK モデル指定（ユーザー設定 `l` コマンドで変更可能）
    model: options.model,
    // #355: `c`（キャンセル）と sdk-loop-guard の両方から実際にプロセスを止められるようにする。
    // `return` だけでは claude サブプロセスが死なない（cleanup/transport.close が走らない）ため、
    // abort() で確実に SIGTERM を送る（sdk.mjs 実測: signal は spawn() に渡され、
    // 明示的な 'abort' リスナーが SIGTERM を送る）。
    abortController: new AbortController(),
  };
  if (options.model) {
    console.log(`🧠 [SDK] Using model: ${options.model}`);
  }
  // #355: このセッションの中断ハンドルをレジストリに登録（cancelAiSession() から参照する）。
  const sdkAbortController = sdkOptions.abortController as AbortController;
  activeSdkAborts.set(sessionId, sdkAbortController);

  // #287: SDK 内蔵 cli.js が欠落している場合はシステム claude へフォールバック。
  // 内蔵版が健全なら null → pathToClaudeCodeExecutable を設定せず従来どおり内蔵版を使う。
  const claudeFallback = getClaudeExecutableFallback();
  if (claudeFallback) {
    sdkOptions.pathToClaudeCodeExecutable = claudeFallback;
    console.log(`🩹 [SDK] Using fallback Claude executable: ${claudeFallback}`);
  }

  // ツール除去（SDK レベル）: AskUserQuestion（disableAsk）/ ExitPlanMode（plan モード時）
  // #303: ExitPlanMode はプランモードの「正規の脱出ハッチ」。対話版 CLI では人間が確認して初めて
  // 解除されるが、DevRelay の canUseTool がその確認を代行して無条件 allow していたため、
  // モデルが自発的に ExitPlanMode を呼ぶだけでプランモードが自己解除される事故があった
  // （mimamori-server 2026-08-15）。disallowedTools でツール自体を除去し、解除経路をユーザーの
  // e/exec（usePlanMode=false）だけに限定する。
  const disallowedTools: string[] = [];
  if (options.disableAsk) disallowedTools.push('AskUserQuestion');
  if (options.usePlanMode) disallowedTools.push('ExitPlanMode');
  if (disallowedTools.length > 0) {
    sdkOptions.disallowedTools = disallowedTools;
    console.log(`🚫 [SDK] disallowedTools: ${disallowedTools.join(', ')}`);
  }

  // パーミッションモード設定
  if (options.usePlanMode) {
    sdkOptions.permissionMode = 'plan';
    if (options.allowedTools && options.allowedTools.length > 0) {
      sdkOptions.allowedTools = options.allowedTools;
      console.log(`📋 [SDK] Using plan mode with ${options.allowedTools.length} allowed tools`);
    } else {
      console.log(`📋 [SDK] Using plan mode`);
    }

    // plan モードでも skipPermissions と AskUserQuestion をインターセプト
    if (options.onToolApprovalRequest) {
      const onApprovalRequest = options.onToolApprovalRequest;
      sdkOptions.canUseTool = async (toolName, input, opts) => {
        // #303: disallowedTools を素通りするケースへの保険。ExitPlanMode は skip-permissions
        // モードでも絶対に許可しない（自動承認＝編集の許可であって、プラン解除の許可ではない）
        if (toolName === 'ExitPlanMode') {
          console.warn('🛑 [SDK] Blocked ExitPlanMode in plan mode (user must send e/exec)');
          return {
            behavior: 'deny',
            message: 'プランモードは ExitPlanMode では解除できません。ユーザーが e / exec を送信するまで実装を開始せず、プランの提示のみ行ってください。',
          };
        }

        const isQuestion = toolName === 'AskUserQuestion';

        // #332: strictReadonly（MCP submit_instruction 経由）の場合、skipPermissions による
        // 無条件 allow を行わない。allowlist 判定は下の isQuestion 分岐の後に一本化する
        if (!isQuestion && !options.strictReadonly && getServerSkipPermissions()) {
          console.log(`⚡ [SDK] Auto-approved (skip-permissions, plan mode): ${toolName}`);
          options.onAutoApproved?.({ toolName, toolInput: input });
          return { behavior: 'allow', updatedInput: input };
        }

        if (isQuestion) {
          const requestId = crypto.randomUUID();
          console.log(`❓ [SDK] User question (plan mode): ${toolName} (${requestId.substring(0, 8)}...)`);

          onApprovalRequest({
            requestId,
            toolName,
            toolInput: input,
            title: opts.title,
            description: opts.description,
            decisionReason: opts.decisionReason,
            isQuestion: true,
          });

          return new Promise<PermissionResult>((resolve, reject) => {
            pendingToolApprovals.set(requestId, { resolve, reject, input });

            if (opts.signal.aborted) {
              pendingToolApprovals.delete(requestId);
              resolve({ behavior: 'deny', message: 'Aborted' });
              return;
            }
            opts.signal.addEventListener('abort', () => {
              if (pendingToolApprovals.has(requestId)) {
                pendingToolApprovals.delete(requestId);
                resolve({ behavior: 'deny', message: 'Aborted' });
              }
            }, { once: true });
          });
        }

        // #332: strictReadonly の場合、PLAN_READONLY_TOOLS または allowedTools（Bash パターン）に
        // マッチしないツールは聞かずに deny する（allowlist 外は allow ではなく deny 側に倒す設計）。
        // 判定ロジックは plan-permission.ts の decidePlanPermission に集約（node --test で検証済み）。
        // #333: defaultAllowedTools（対象 OS の DEFAULT_ALLOWED_TOOLS_LINUX）を渡し、ユーザーカスタム
        // allowedTools との和集合で判定する（カスタム保存があると default 追加が効かない問題への対策。
        // 人間承認時の追記で明示された方針。strictReadonly のこの判定にのみ適用し、options.allowedTools
        // 自体は書き換えないため interactive/exec の allowedTools 解決には影響しない）。
        const decision = decidePlanPermission({
          toolName,
          input,
          strictReadonly: !!options.strictReadonly,
          allowedTools: options.allowedTools,
          defaultAllowedTools: DEFAULT_ALLOWED_TOOLS_LINUX,
          readonlyTools: PLAN_READONLY_TOOLS,
          readonlyBashCommands: PLAN_READONLY_BASH_COMMANDS,
          writeBashCommands: PLAN_WRITE_BASH_COMMANDS,
          writeTools: PLAN_WRITE_TOOLS,
          skipPermissions: !!getServerSkipPermissions(),
        });
        if (decision.behavior === 'deny') {
          console.warn(`🛑 [SDK] Denied by strictReadonly policy (plan mode): ${toolName} [${decision.reason}]`);
          options.onPolicyDenied?.({ toolName, toolInput: input, reason: decision.reason });
          return {
            behavior: 'deny',
            message: `プランモードでは使用できません（理由: ${decision.detail ?? decision.reason}）。必要な操作は承認後のexecで行ってください。`,
          };
        }

        // AskUserQuestion 以外は plan モードのデフォルト動作（allowedTools で制御済み）
        return { behavior: 'allow', updatedInput: input };
      };
    }
  } else {
    // Exec モード: canUseTool でパーミッション制御
    sdkOptions.permissionMode = 'default';
    if (options.onToolApprovalRequest) {
      // WebSocket 経由のユーザー承認（Phase 2+）
      const onApprovalRequest = options.onToolApprovalRequest;
      sdkOptions.canUseTool = async (toolName, input, opts) => {
        const isQuestion = toolName === 'AskUserQuestion';

        // 全許可モード: AskUserQuestion 以外は即座に allow（動的に最新値を参照）
        if (!isQuestion && getServerSkipPermissions()) {
          console.log(`⚡ [SDK] Auto-approved (skip-permissions mode): ${toolName}`);
          options.onAutoApproved?.({ toolName, toolInput: input });
          return { behavior: 'allow', updatedInput: input };
        }

        // AskUserQuestion は常にユーザーに聞く（approveAllMode や自動承認をスキップ）
        if (!isQuestion) {
          // セッション内で「📌 常に許可」されたツールルールにマッチする場合は即座に allow
          if (isToolSessionApproved(toolName, input)) {
            console.log(`📌 [SDK] Auto-approved (session tool rule): ${toolName}`);
            options.onAutoApproved?.({ toolName, toolInput: input });
            return { behavior: 'allow', updatedInput: input };
          }

          // 「以降すべて許可」モードなら即座に allow + 通知送信
          if (approveAllMode) {
            console.log(`🔓 [SDK] Auto-approved (approve-all mode): ${toolName}`);
            options.onAutoApproved?.({ toolName, toolInput: input });
            return { behavior: 'allow', updatedInput: input };
          }
        }

        const requestId = crypto.randomUUID();
        console.log(`${isQuestion ? '❓' : '🔐'} [SDK] ${isQuestion ? 'User question' : 'Permission request'}: ${toolName} (${requestId.substring(0, 8)}...)`);

        // Server にツール承認リクエストを送信（AskUserQuestion は isQuestion フラグ付き）
        onApprovalRequest({
          requestId,
          toolName,
          toolInput: input,
          title: opts.title,
          description: opts.description,
          decisionReason: opts.decisionReason,
          isQuestion,
        });

        // ユーザーの応答を待つ Promise を作成
        return new Promise<PermissionResult>((resolve, reject) => {
          pendingToolApprovals.set(requestId, { resolve, reject, input });

          // AbortSignal を監視（SDK 側からのキャンセル）
          if (opts.signal.aborted) {
            pendingToolApprovals.delete(requestId);
            resolve({ behavior: 'deny', message: 'Aborted' });
            return;
          }
          opts.signal.addEventListener('abort', () => {
            if (pendingToolApprovals.has(requestId)) {
              pendingToolApprovals.delete(requestId);
              resolve({ behavior: 'deny', message: 'Aborted' });
            }
          }, { once: true });
        });
      };
      console.log(`🔐 [SDK] Using exec mode with user approval (canUseTool)`);
    } else {
      // 全ツール自動許可（onToolApprovalRequest 未設定時のフォールバック）
      sdkOptions.canUseTool = async (_toolName, input) => ({
        behavior: 'allow',
        updatedInput: input,
      });
      console.log(`🚀 [SDK] Using exec mode (auto-approve all tools)`);
    }
  }

  // セッション resume
  if (options.resumeSessionId) {
    sdkOptions.resume = options.resumeSessionId;
    console.log(`🔄 [SDK] Resuming session: ${options.resumeSessionId.substring(0, 8)}...`);
  }

  // #355: auto-compact 無限ループ検知（実測 138.3 分・79 回連続の事故対策）。
  // 「compact したのに何も進んでいない」（テキスト0文字・ツール1種類の連打）だけを確実に捕まえ、
  // 正常な長時間作業（compact を挟みつつテキスト/複数ツールで進捗がある）は素通しする。
  const loopGuardConfig = resolveLoopGuardConfig(process.env);
  const loopGuardState = createLoopGuardState(Date.now());
  let loopGuardAborted = false;

  /**
   * #355: sdk-loop-guard が異常を検知した際の共通後処理。
   * 1. 理由を明示してユーザーに返す（#325 静かなフォールバック禁止）
   * 2. resume 用セッションIDをファイル側から破棄する（resume すると肥大サマリごと復活し即再発するため）
   * 3. abortController.abort() でサブプロセスを実際に殺す（return だけでは cleanup が走らない）
   */
  const abortForLoopGuard = async (
    reason: 'compactLoop' | 'toolRepeat' | 'wallClock',
    detail?: { compacts?: number; preTokens?: number; minutes?: number; repeats?: number; tool?: string }
  ): Promise<AiRunResult> => {
    loopGuardAborted = true;
    const lang = options.language ?? DEFAULT_CHAT_LANGUAGE;
    const key = reason === 'compactLoop' ? 'loopGuard.compactLoop' : reason === 'toolRepeat' ? 'loopGuard.toolRepeat' : 'loopGuard.wallClock';
    console.log(`[claude/sdk] 🛑 loop-guard triggered: reason=${reason} detail=${JSON.stringify(detail ?? {})}`);
    onOutput(tChat(lang, key, {
      compacts: detail?.compacts ?? 0,
      preTokens: detail?.preTokens ?? 0,
      minutes: detail?.minutes ?? 0,
      repeats: detail?.repeats ?? 0,
      tool: detail?.tool ?? '',
    }), true);
    result.sessionDiscarded = true;
    if (options.persistProjectState !== false) {
      try {
        await clearClaudeSessionId(projectPath);
      } catch (e) {
        console.error(`[claude/sdk] Failed to clear claude session id after loop-guard abort:`, e);
      }
    }
    sdkAbortController.abort();
    return result;
  };

  // #355 Workstream C（根治）: 今回のターン中に compact_boundary の trigger==='auto' が
  // 何回発生したかを数える（loop-guard の noProgressCompactCount とは独立、進捗の有無を問わず
  // 単純カウント）。判定に contextUsage.percentage は使わない（壊れた指標のため）。
  let autoCompactCountThisTurn = 0;
  const autoCompactRotateThresholdRaw = Number(process.env.DEVRELAY_AUTO_COMPACT_ROTATE_THRESHOLD);
  const autoCompactRotateThreshold =
    Number.isFinite(autoCompactRotateThresholdRaw) && autoCompactRotateThresholdRaw > 0
      ? Math.floor(autoCompactRotateThresholdRaw)
      : 3;

  /**
   * #355 Workstream C: auto-compact が閾値回数以上発生していたら、ターン完走後（結果確定後、
   * まだ最終 onOutput を送る前）に resume 用セッションを破棄する。ターンの応答自体は変更せず、
   * 「途中では切らない」という設計を守る。切ったことは必ず onOutput で明示する（#325）。
   */
  const finalizeAutoCompactRotation = async (): Promise<void> => {
    if (autoCompactCountThisTurn < autoCompactRotateThreshold) return;
    console.log(`[claude/sdk] 🔄 auto-compact rotate threshold reached (${autoCompactCountThisTurn}/${autoCompactRotateThreshold}), discarding session before next turn`);
    onOutput(tChat(options.language ?? DEFAULT_CHAT_LANGUAGE, 'sessionRotate.autoCompact', {
      count: autoCompactCountThisTurn,
      threshold: autoCompactRotateThreshold,
    }), false);
    result.sessionDiscarded = true;
    if (options.persistProjectState !== false) {
      try {
        await clearClaudeSessionId(projectPath);
      } catch (e) {
        console.error(`[claude/sdk] Failed to clear claude session id after auto-compact rotation:`, e);
      }
    }
  };

  try {
    for await (const message of query({ prompt, options: sdkOptions })) {
      const m = message as any;

      // #355: 実行時間上限チェック（既定45分、サーバー側60分ハードタイムアウトより先に発火させる）
      const loopGuardWallClock = checkWallClock(loopGuardState, Date.now(), loopGuardConfig);
      if (loopGuardWallClock.abort) {
        return await abortForLoopGuard('wallClock', loopGuardWallClock.detail);
      }

      // セッション ID 抽出（system/init または result から）
      if (m.session_id && !result.extractedSessionId) {
        result.extractedSessionId = m.session_id;
        console.log(`[claude/sdk] 📋 Session ID: ${m.session_id.substring(0, 8)}...`);
        // #348: persistProjectState===false（一時セッション）なら projectPath 上には書かない
        if (options.persistProjectState !== false) {
          saveClaudeSessionId(projectPath, m.session_id).catch(err => {
            console.error(`Failed to save session ID:`, err);
          });
        }
      }

      // #355: compact_boundary イベント（auto-compact 発生）を loop-guard に通知する。
      // 型定義は compact_metadata/pre_tokens だが、ディスク上の jsonl は
      // compactMetadata/preTokens で観測されているため両方防御的に読む。
      if (m.type === 'system' && m.subtype === 'compact_boundary') {
        const compactMeta = m.compact_metadata ?? m.compactMetadata;
        const preTokens = compactMeta?.pre_tokens ?? compactMeta?.preTokens;
        // #355 Workstream C: auto-compact のみを数える（手動 /compact は対象外）
        if (compactMeta?.trigger === 'auto') {
          autoCompactCountThisTurn += 1;
        }
        const compactDecision = observeLoopGuardEvent(
          loopGuardState,
          { kind: 'compact', preTokens, nowMs: Date.now() },
          loopGuardConfig
        );
        if (compactDecision.abort) {
          return await abortForLoopGuard('compactLoop', compactDecision.detail);
        }
        continue;
      }

      // assistant メッセージ: テキストとツール使用を出力
      if (m.type === 'assistant' && m.message?.content) {
        for (const block of m.message.content) {
          if (block.type === 'text' && block.text) {
            // "Prompt is too long" 検出
            if (block.text.trim() === 'Prompt is too long') {
              console.log(`[claude/sdk] ⚠️ "Prompt is too long" detected, suppressing`);
              if (options.resumeSessionId) {
                result.resumeFailed = true;
                return result;
              }
              onOutput('⚠️ プロンプトが長すぎます。`x` コマンドで会話履歴をクリアしてください。', true);
              return result;
            }
            // Claude Code 未ログイン検出（resume リトライしても直らないので即座に案内して打ち切る）
            // Devin 専用マシン等で claude 未ログインのまま claude が呼ばれた場合にここに来る
            if (/^not logged in.*please run \/login/i.test(block.text.trim())) {
              console.log(`[claude/sdk] 🔑 Claude Code is not logged in`);
              onOutput(
                '⚠️ Claude Code が未ログインです。\n' +
                '対象マシンで `claude` を起動してログインするか、`a` コマンドで別の AI ツール（devin 等）に切り替えてください。',
                true
              );
              return result;
            }
            // #338: OAuth トークン期限切れ検出。SDK はこの失敗を JS 例外としてではなく通常の
            // assistant テキストブロックとして返すため、従来はここを素通りして生の JSON エラー
            // （`Failed to authenticate. API Error: 401 {...}`）がそのままチャットに出ていた。
            // 15分ポーリング（`claude auth status --json`）はローカル資格情報の有無しか見ておらず
            // このケースを検知できないため、ここで検知した瞬間に即座にサーバーへ報告する。
            if (isClaudeAuthExpiredMessage(block.text)) {
              console.log(`[claude/sdk] 🔒 OAuth token expired detected in assistant text`);
              reportClaudeAuthExpiredFromRuntime();
              onOutput(formatAiErrorMessage(block.text, options.language ?? DEFAULT_CHAT_LANGUAGE), true);
              return result;
            }
            fullOutput += block.text;
            console.log(`[claude/sdk] +${block.text.length} chars`);
            onOutput(block.text, false);
            // #355: 「進捗あり」の証拠として P1（テキスト出力）を loop-guard に通知する
            observeLoopGuardEvent(loopGuardState, { kind: 'text', text: block.text, nowMs: Date.now() }, loopGuardConfig);
          } else if (block.type === 'tool_use' && block.name) {
            console.log(`[claude/sdk] 🔧 Using tool: ${block.name}`);
            onOutput(`\n${tChat(options.language ?? DEFAULT_CHAT_LANGUAGE, 'progress.usingTool', { tool: block.name })}\n`, false);
            // #355: 「進捗あり」の証拠として P2（異なるツール種別）を loop-guard に通知、
            // 同一ツール連打（層2）も同時に検知する
            const toolDecision = observeLoopGuardEvent(
              loopGuardState,
              { kind: 'tool', name: block.name, input: block.input, nowMs: Date.now() },
              loopGuardConfig
            );
            if (toolDecision.abort) {
              return await abortForLoopGuard('toolRepeat', toolDecision.detail);
            }
          }
        }
      }

      // rate_limit_event: レートリミット情報をキャプチャ
      if (m.type === 'rate_limit_event' && m.rate_limit_info) {
        const info = m.rate_limit_info;
        const pct = info.utilization != null ? Math.round(info.utilization * 100) : null;
        console.log(`[claude/sdk] 📉 Rate limit: type=${info.rateLimitType}, utilization=${pct}%, status=${info.status}`);
        const entry: RateLimitEntry = {
          utilization: info.utilization ?? 0,
          resetsAt: info.resetsAt,
          status: info.status,
        };
        // utilization が null の場合も status は記録する（将来の対応用）
        if (info.rateLimitType === 'five_hour') {
          result.rateLimits = result.rateLimits || {};
          result.rateLimits.fiveHour = entry;
        } else if (info.rateLimitType?.startsWith('seven_day')) {
          result.rateLimits = result.rateLimits || {};
          result.rateLimits.sevenDay = entry;
        }
      }

      // result メッセージ: 使用量データ抽出
      if (m.type === 'result') {
        console.log(`[claude/sdk] ✅ Complete (${m.duration_ms}ms)`);

        // コンテキスト使用量を計算
        if (m.usage) {
          let contextWindow = 200000;
          if (m.modelUsage) {
            const modelInfo = Object.values(m.modelUsage)[0] as any;
            if (modelInfo?.contextWindow) {
              contextWindow = modelInfo.contextWindow;
            }
          }
          const cacheReadTokens = m.usage.cache_read_input_tokens || 0;
          result.contextUsage = {
            used: cacheReadTokens,
            total: contextWindow,
            percentage: Math.round((cacheReadTokens / contextWindow) * 100),
          };
          console.log(`[claude/sdk] ${formatContextUsage(result.contextUsage)}`);
          // #348: persistProjectState===false（一時セッション）なら projectPath 上には書かない
          if (options.persistProjectState !== false) {
            saveContextUsage(projectPath, result.contextUsage).catch(err => {
              console.error(`Failed to save context usage:`, err);
            });
          }
        }

        // 使用量データ（DB 保存用）
        result.usageData = {
          usage: m.usage,
          modelUsage: m.modelUsage,
          durationMs: m.duration_ms,
          model: m.modelUsage ? Object.keys(m.modelUsage)[0] : undefined,
          rateLimits: result.rateLimits,
        };
        console.log(`[claude/sdk] 💾 Usage data captured: duration=${m.duration_ms}ms`);

        // resume 失敗検出
        if (m.is_error && options.resumeSessionId) {
          console.log(`[claude/sdk] ⚠️ Result is error with --resume, flagging for retry`);
          result.resumeFailed = true;
        }

        // result は stream-json の終端メッセージ。ここで完了シグナルを送って return する。
        // これにより、result 送出後に SDK ジェネレータが終了せず for await が返ってこない
        // （高コンテキスト時などに発生）場合でも、応答がサーバーへ確実に届く。
        if (result.resumeFailed) {
          // resume 失敗時は完了を送らず retry 経路（connection.ts の composeFullPrompt(true) 再送）に委ねる
          console.log(`[claude/sdk] 🔁 Result flagged resumeFailed → deferring to retry (no completion sent)`);
          return result;
        }
        // #326 Phase2（BUG A 最小修正）: 実際にターンが成功した（出力があり、エラーでもない）瞬間を
        // 「ログイン済み」の直接証拠として即時報告する。resumeFailed を先に弾いているため
        // resume 失敗を健康の証拠にしてしまうことはない。
        if (fullOutput.length > 0 && !m.is_error) {
          reportClaudeAuthOkFromRuntime();
        }
        // #355 Workstream C: ターンが完走したのでここで初めてローテーション判定を行う
        // （最終 onOutput より前、応答内容自体には影響しない）
        await finalizeAutoCompactRotation();
        if (fullOutput.length === 0) {
          onOutput('(No response from AI)', true, result.usageData);
        } else {
          onOutput('', true, result.usageData);
        }
        completionSent = true;
        console.log(`[claude/sdk] 📨 Completion sent from result handler (fullOutput=${fullOutput.length} chars)`);
        return result;
      }
    }
  } catch (err: any) {
    // #355: loop-guard による意図的な abort()（AbortError）は、既存の resume 失敗検出
    // （err.message.includes('session') 等）に誤って一致し resumeFailed=true になると
    // connection.ts が同じプロンプトを再送してループが再開してしまう。
    // そのため catch の最初で必ずこのガードを通す（既存分岐より前）。
    if (loopGuardAborted) {
      console.log(`[claude/sdk] 🛑 loop-guard abort() caught (${err?.name ?? err?.message ?? 'unknown'}), returning discarded result without retry`);
      return result;
    }
    console.error(`[claude/sdk] Error:`, err.message);

    // resume 失敗のエラーを検出
    if (options.resumeSessionId && (
      err.message?.includes('resume') ||
      err.message?.includes('session') ||
      err.message?.includes('Prompt is too long')
    )) {
      console.log(`[claude/sdk] ⚠️ SDK error with --resume, flagging for retry`);
      result.resumeFailed = true;
      return result;
    }

    if (fullOutput.length === 0) {
      onOutput(formatAiErrorMessage(err.message, options.language ?? DEFAULT_CHAT_LANGUAGE), true);
    }
    return result;
  } finally {
    // #355: このセッションの abort ハンドルをレジストリから除去する。
    // 同一性ガード（===）で後続ターンの新しい controller を誤って消さないようにする。
    if (activeSdkAborts.get(sessionId) === sdkAbortController) {
      activeSdkAborts.delete(sessionId);
    }
  }

  // 完了シグナル送信（フォールバック）
  // 通常は result ハンドラ内で送信済み（completionSent=true）。
  // ここに来るのは稀に result メッセージが来ずループが自然終了したケースのみ。
  if (!completionSent) {
    // #355 Workstream C: result メッセージが来なかった稀なケースでもローテーション判定は行う
    await finalizeAutoCompactRotation();
    if (fullOutput.length === 0) {
      onOutput('(No response from AI)', true, result.usageData);
    } else {
      onOutput('', true, result.usageData);
    }
  }

  return result;
}

/**
 * 端末インタフェースモード経由で Claude を実行する
 * Agent SDK の代わりに PTY で `claude --continue` を都度起動する
 *
 * Phase 1 では tool 承認は CLI の --dangerously-skip-permissions に委ねる。
 * 自動承認 OFF の場合は CLI が承認プロンプトを出すが、端末モードでは
 * 即座に "いいえ" を送信する（Phase 3 で WS 承認カード連動に拡張予定）
 */
async function sendPromptToTerminalClaude(
  sessionId: string,
  prompt: string,
  projectPath: string,
  onOutput: OutputCallback,
  options: SendPromptOptions
): Promise<AiRunResult> {
  const result: AiRunResult = {};
  const startTs = Date.now();

  let claudeCommand: string;
  try {
    claudeCommand = resolveClaudePath();
  } catch (err) {
    const msg = (err as Error).message;
    console.error(`❌ [terminal-mode] claude path resolution failed: ${msg}`);
    onOutput(`Error: ${msg}`, true);
    return result;
  }

  // 端末モード本体（node-pty / @xterm/headless）を遅延ロード。
  // node-pty のネイティブビルド欠落時はここで明確なエラーを返す
  let runTerminalClaude: TerminalRunnerModule['runTerminalClaude'];
  try {
    const mod = await loadTerminalRunner();
    runTerminalClaude = mod.runTerminalClaude;
  } catch (err) {
    const msg = (err as Error).message;
    console.error(`❌ [terminal-mode] terminal-runner load failed: ${msg}`);
    onOutput(
      `Error: 端末インタフェースモードの起動に失敗しました。\n` +
      `node-pty のネイティブモジュールが見つからない可能性があります。\n` +
      `Agent ホストで以下を実行してください:\n` +
      `  cd ~/.devrelay/agent && pnpm rebuild node-pty\n` +
      `詳細: ${msg}`,
      true,
    );
    return result;
  }

  // approveAllMode: server-side skipPermissions または「以降すべて許可」が立っていれば真
  // セッション内で動的に変化するため、起動時の値をスナップショットとして使う
  const approveAllMode = !!(options.skipPermissions || isApproveAllMode());

  // SDK が保存した Claude セッション ID を読み込んで CLI の `--resume` で復元する
  // SDK と CLI は `~/.claude/projects/<hash>/sessions/<id>.jsonl` を共有しているので互換
  // resume 判定:
  //   forceNewSession (MCP) → 常に新規（前回文脈の汚染防止）
  //   exec モード → 常に resume（前回の plan/exec を継続）
  //   plan モード → 前回も plan なら resume（会話継続）、前回が exec なら新規（#238 暴走防止）
  let resumeSessionId: string | undefined;
  if (options.forceNewSession) {
    resumeSessionId = undefined;
    console.log(`🆕 [terminal-mode] forceNewSession: starting fresh (MCP submit)`);
  } else if (options.usePlanMode) {
    const meta = await loadSessionMeta(projectPath);
    if (meta && meta.mode === 'plan') {
      resumeSessionId = meta.sessionId;
      console.log(`🔄 [terminal-mode] plan→plan resume: ${resumeSessionId.slice(0, 8)}...`);
    } else {
      resumeSessionId = undefined;
      console.log(`🆕 [terminal-mode] ${meta ? 'exec→plan' : 'no previous session'}: starting fresh`);
    }
  } else {
    resumeSessionId = await loadClaudeSessionId(projectPath) || undefined;
  }

  // 診断ログ: WebUI トグルとの食い違いを調査するため、判定根拠を出力する
  console.log(`🖥️ [terminal-mode] permissions state: options.skipPermissions=${!!options.skipPermissions}, isApproveAllMode()=${isApproveAllMode()}, computed approveAllMode=${approveAllMode}, resumeSessionId=${resumeSessionId ? resumeSessionId.slice(0, 8) + '...' : '(none)'}`);

  // 起動メッセージ（仕様書 §2.2.2）
  // 実際に渡される args を表示することで、approveAllMode / resumeSessionId の有無が WebUI から確認できる
  // terminal-runner.ts の args 構築ロジックと一致させること
  const previewArgs: string[] = [];
  if (approveAllMode) previewArgs.push('--dangerously-skip-permissions');
  if (resumeSessionId) previewArgs.push('--resume', resumeSessionId.slice(0, 8) + '...');
  const argsDisplay = previewArgs.length > 0 ? ` ${previewArgs.join(' ')}` : '';
  onOutput(`🖥️ 端末インタフェースを起動中...\n  → ${claudeCommand}${argsDisplay}\n`, false);

  // onChoiceRequest ファクトリ: リトライ時にも同じコールバックを使い回す
  // 端末モードの choice prompt は全て QuestionCard で表示する（AskUserQuestion・trust folder・resume 等）
  const choiceRequestTimes = new Map<string, number>(); // requestId → timestamp（応答時間計測用）
  const makeChoiceHandler = options.onToolApprovalRequest ? (req: { requestId: string; question: string; options: string[]; respond: (optionIndex: number) => void }) => {
    // resolver と options を登録（resolveToolApproval で選択ラベル→index 逆引きに使う）
    terminalApprovalResolvers.set(req.requestId, { respond: req.respond, options: req.options });
    choiceRequestTimes.set(req.requestId, Date.now());
    console.log(`⏱️ [APPROVAL] choice detected at ${new Date().toISOString()}: "${req.question.substring(0, 60)}" (${req.options.length} options, requestId=${req.requestId.substring(0, 8)})`);
    // QuestionCard 互換フォーマットで WS 送信（isQuestion: true で QuestionCard を使う）
    options.onToolApprovalRequest!({
      requestId: req.requestId,
      toolName: 'Claude CLI Prompt',
      toolInput: {
        // QuestionCard は questions 配列を期待する（SDK の AskUserQuestion と同じ形式）
        questions: [{
          question: req.question,
          options: req.options.map(o => ({ label: o })),
        }],
      },
      title: req.question.slice(0, 100),
      description: req.options.map((o, i) => `${i + 1}. ${o}`).join('\n'),
      isQuestion: true,
    });
  } : undefined;

  // AI 画面解析コールバック: Server 経由で Claude Haiku を呼ぶ
  const makeScreenAnalyzer = options.onScreenAnalyzeRequest
    ? async (screenText: string, context: string): Promise<ScreenAnalysis | null> => {
        return options.onScreenAnalyzeRequest!(screenText, context, sessionId);
      }
    : undefined;

  // 応答要約コールバック: Server 経由で Haiku に要約させる
  const makeResponseSummarizer = options.onResponseSummarizeRequest
    ? async (assistantText: string): Promise<string> => {
        return options.onResponseSummarizeRequest!(assistantText, sessionId);
      }
    : undefined;

  try {
    let runResult = await runTerminalClaude({
      projectPath,
      prompt,
      approveAllMode,
      disableAsk: !!options.disableAsk,
      claudeCommand,
      sessionId,
      resumeSessionId: resumeSessionId || undefined,
      onOutput: (chunk) => onOutput(chunk, false),
      onChoiceRequest: makeChoiceHandler,
      onScreenAnalyze: makeScreenAnalyzer,
      onResponseSummarize: makeResponseSummarizer,
      sessionMode: options.usePlanMode ? 'plan' : 'exec',
    });

    // プロンプト未送信のまま早期 exit した場合のフォールバック（1 回のみリトライ）:
    // - trust prompt 回答後に Claude CLI が exit(1) するケース（#237: 新規プロジェクトで頻発）
    // - --resume のセッション ID が壊れていて起動失敗するケース（#236）
    // リトライ時は trust 保存済み / --resume なしで起動するため正常起動する
    const earlyExitMs = 30_000; // 30 秒以内に終了 = 早期 exit と判定
    if (!runResult.promptSent && !runResult.timedOut && !runResult.cancelledByAskDisable
        && runResult.durationMs < earlyExitMs) {
      const reason = resumeSessionId ? 'early exit with --resume' : 'early exit during startup';
      console.warn(`⚠️ [terminal-mode] ${reason} (${runResult.durationMs}ms, promptSent=false) → retrying without --resume`);
      // --resume のセッション ID があればクリア（壊れている可能性）
      if (resumeSessionId) {
        await clearClaudeSessionId(projectPath);
      }
      onOutput(`\n⚠️ Claude CLI が起動中に終了しました。リトライします...\n`, false);
      onOutput(`🖥️ 端末インタフェースを起動中...\n  → ${claudeCommand}${approveAllMode ? ' --dangerously-skip-permissions' : ''}\n`, false);

      runResult = await runTerminalClaude({
        projectPath,
        prompt,
        approveAllMode,
        disableAsk: !!options.disableAsk,
        claudeCommand,
        sessionId,
        resumeSessionId: undefined, // リトライは常に --resume なし
        onOutput: (chunk) => onOutput(chunk, false),
        onChoiceRequest: makeChoiceHandler,
        onScreenAnalyze: makeScreenAnalyzer,
        onResponseSummarize: makeResponseSummarizer,
        sessionMode: options.usePlanMode ? 'plan' : 'exec',
      });
    }

    if (runResult.cancelledByAskDisable) {
      onOutput(
        `\n⚠️ AskUserQuestion が出たため、Ask 無効設定により中断しました。\n（実行時間: ${(runResult.durationMs / 1000).toFixed(1)} 秒）`,
        true,
        runResult.usageData,  // JSONL から集計した usageData を伝搬
      );
      return result;
    }

    const durationStr = (runResult.durationMs / 1000).toFixed(1);
    const suffix = runResult.timedOut
      ? `\n⚠️ アイドルタイムアウト（10 分無音）により終了しました。（実行時間: ${durationStr} 秒）`
      : !runResult.promptSent
      ? `\n❌ Claude CLI が起動できませんでした。（実行時間: ${durationStr} 秒）\nこのフォルダで claude コマンドを直接実行して動作を確認してください。\nログ: logs/terminal-${sessionId}.log`
      : (runResult.exitCode != null && runResult.exitCode !== 0)
      ? `\n⚠️ Claude CLI がクラッシュしました (exit code ${runResult.exitCode})。（実行時間: ${durationStr} 秒）\nログ: logs/terminal-${sessionId}.log`
      : `\n✅ 完了。セッションを終了しました。（実行時間: ${durationStr} 秒）`;

    onOutput(suffix, true, runResult.usageData);  // JSONL から集計した usageData を伝搬
  } catch (err) {
    const msg = (err as Error).message;
    console.error(`❌ [terminal-mode] runTerminalClaude failed: ${msg}`);
    onOutput(`\nError: ${msg}`, true, { durationMs: Date.now() - startTs });
  }

  return result;
}

export async function sendPromptToAi(
  sessionId: string,
  prompt: string,
  projectPath: string,
  aiTool: AiTool,
  claudeSessionId: string,
  config: AgentConfig,
  onOutput: OutputCallback,
  options: SendPromptOptions = {}
): Promise<AiRunResult> {
  console.log(`📝 Sending prompt to ${aiTool}: ${prompt.substring(0, 50)}...`);

  // #316: チャット表示言語が 'en' の場合のみ、AI への指示文言語（日本語のまま）はそのままに
  // 「ユーザーへの返答は英語で」という指示を末尾に追加する。
  // 'ja'（既定）の場合は何も付与せず、既存挙動を完全に維持する（回帰リスクを避けるため）。
  if (options.language === 'en') {
    prompt = `${prompt}\n\n---\nIMPORTANT: Respond to the user in English from now on, regardless of the language used in any instructions above.`;
  }

  // 端末インタフェースモード（PTY 経由で claude --continue 起動）
  // aiTool が claude かつ terminalMode フラグが立っている場合のみ分岐
  if (aiTool === 'claude' && options.terminalMode) {
    return sendPromptToTerminalClaude(sessionId, prompt, projectPath, onOutput, options);
  }

  // Claude は Agent SDK を使用（spawn の代わり）
  if (aiTool === 'claude') {
    return sendPromptToAiSdk(sessionId, prompt, projectPath, claudeSessionId, config, onOutput, options);
  }

  const command = getAiCommand(aiTool, config);
  if (!command) {
    onOutput(`Error: AI tool not configured: ${aiTool}`, true);
    return {};
  }

  const result: AiRunResult = {};
  let proc;
  // Devin: -r で resume したセッション ID を関数スコープで記録（close ハンドラから参照して空振り検出に使う）
  let devinResumedSessionId: string | null = null;
  // このサイクル: 今回のターンで使った Devin モデルを関数スコープで記録（close ハンドラから
  // 参照してセッション保存時にモデルも一緒に保存するため。devinResumedSessionId と同じ理由）
  let devinCurrentModelForResume = '';
  // #347: plan モードで --config/--agent-config を実際に積んだか（close ハンドラの無音 deny 検出に使う）
  let devinPlanConfigApplied = false;
  // #276: Devin の途中経過表示用。--export の ATIF ファイルパス（対応版のみ設定）と進捗タイマー群を
  // 関数スコープに置き、close/error ハンドラから停止・後始末できるようにする。
  let devinExportPath: string | null = null;
  let devinHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let devinExportPollTimer: ReturnType<typeof setInterval> | null = null;
  let devinExportReadPos = 0; // ATIF ファイルの読み取り済みバイト位置
  // #277: Devin 課金暴走抑止（実行時間 / ステップ数の上限で SIGTERM 停止）
  let devinLimitTimer: ReturnType<typeof setTimeout> | null = null;
  let devinRuntimeLimitHit = false; // 実行時間上限で kill したか
  let devinStepLimitHit = false;    // ステップ数上限で kill したか
  let devinStepCount = 0;           // ATIF ステップ数カウンタ
  const devinMaxRuntimeMin = config.aiTools.devin?.maxRuntimeMinutes ?? 15; // 0=無制限
  const devinMaxSteps = config.aiTools.devin?.maxSteps ?? 0;                 // 0=無効
  // #281: Devin の作業中ファイル変更ウォッチ（「内部で何をしているか」のライブ表示）。
  // ATIF は turn 終了時にしか書かれずライブ tail 不可のため、ファイル操作を監視して補完する。
  let devinFsWatcher: fs.FSWatcher | null = null;
  const devinReportedFiles = new Map<string, number>(); // ファイル名 → 最終通知時刻（スロットル用）
  // 欠陥2対策: ターンあたりのファイル変更通知件数の上限（既定20、DEVRELAY_DEVIN_FILEWATCH_MAX で上書き可）。
  // SVN/Mercurial 等の作業コピーで大量ファイルが同時変更された際に無制限にチャットへ流れ込むのを防ぐ。
  const devinFileWatchMaxEnv = Number(process.env.DEVRELAY_DEVIN_FILEWATCH_MAX);
  const devinFileWatchMax = Number.isFinite(devinFileWatchMaxEnv) && devinFileWatchMaxEnv > 0
    ? devinFileWatchMaxEnv
    : DEFAULT_FILE_WATCH_NOTICE_LIMIT;
  let devinFileWatchCount = 0;
  let devinFileWatchLimitNotified = false; // 上限到達を1回だけ通知するためのガード（#325 静かなフォールバック禁止）
  // #281: 完了時に ATIF から作る「実行ステップまとめ」。最終回答の末尾に添付する。
  let devinStepSummary = '';
  // Devin モデル選択サイクル・サイクル B（変更5）: ATIF から読み取った実モデル名（close ハンドラで代入）。
  // devinCurrentModelForResume と同じ理由で関数スコープの let（block 内 const にすると
  // close ハンドラから参照できず TS2304 になる、サイクル A の S0 で踏んだ落とし穴）。
  let devinAtifModelName: string | null = null;
  let devinAtifModelId: string | null = null;
  // 欠陥1対策（プランモード無言終了検知）: ATIF の最後のステップがツール呼び出しで終わっている
  // （＝そのあと AI のテキスト応答が無い）かどうか。devinCurrentModelForResume と同じ理由で
  // 関数スコープの let（block 内 const にすると close ハンドラから参照できず TS2304 になる）。
  let devinAtifEndedWithoutAnswer = false;
  // #282: CHISEL_LOG_STDERR=1 で stderr に流れる devin 内部ログの分類用
  let devinToolRejectedInLog = false;   // ログ形式で検出したツール拒否（#274 検出の置き換え）
  let devinStderrLineBuffer = '';       // stderr の行バッファ（改行区切り処理の残り）
  let devinLastLogLevel = '';           // 継続行（"Caused by:" 等）の帰属判定用
  const devinLogReported = new Map<string, number>(); // 同一メッセージ10秒スロットル

  // #308: Codex CLI 用の状態（関数スコープに置き、stdout/close ハンドラから参照する）
  let codexResumedThreadId: string | null = null; // resume 起動時に渡した thread_id（空振り検出用）
  let codexThreadId: string | null = null;          // thread.started で取得した現在のスレッド ID
  let codexHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  const codexProgressReported = new Map<string, number>(); // 同一進捗メッセージ10秒スロットル
  let codexTurnFailed = false;      // turn.failed イベントを受信したか
  let codexTurnFailedMessage = '';  // turn.failed の error.message

  /** config.proxy がある場合、AI プロセスにもプロキシ環境変数を注入 */
  const proxyEnv: Record<string, string> = {};
  if (config.proxy?.url) {
    const proxyUrl = config.proxy.url;
    proxyEnv.HTTP_PROXY = proxyUrl;
    proxyEnv.HTTPS_PROXY = proxyUrl;
    proxyEnv.http_proxy = proxyUrl;
    proxyEnv.https_proxy = proxyUrl;
  }

  if (aiTool === 'gemini') {
    // Gemini CLI with auto_edit approval mode
    // Use stdin to pass prompt (same as Claude) to avoid shell interpretation issues
    const args = ['--approval-mode', 'auto_edit'];
    // #309: plan/exec モデル分離。旧 CLI で `--model` 非対応の場合は引数を付けずデフォルトへ劣化させる。
    const geminiCaps = probeGeminiCapabilities(command);
    const geminiModel = safeModelArg(options.model);
    if (geminiModel && geminiCaps.model) {
      args.push('-m', geminiModel);
    }
    console.log(`🔧 Running: ${command} ${args.join(' ')} (prompt via stdin)`);

    // Gemini コマンドのディレクトリを PATH に追加（systemd 実行時に node が見つからない問題を回避）
    // #344: command がベース名のみ（例: 'gemini'）の場合 path.dirname は '.' になり cwd が PATH の
    // 先頭に積まれてしまうため、フルパスが解決できている場合のみ PATH に追加する。
    const geminiDir = path.dirname(command);
    const pathSep = process.platform === 'win32' ? ';' : ':';
    const envPath = geminiDir === '.'
      ? (process.env.PATH ?? geminiDir)
      : (process.env.PATH ? `${geminiDir}${pathSep}${process.env.PATH}` : geminiDir);

    proc = spawn(command, args, {
      cwd: projectPath,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        ...proxyEnv,
        PATH: envPath,  // Add gemini's directory to PATH so node can be found
        DEVRELAY: '1',
        DEVRELAY_SESSION_ID: sessionId,
        DEVRELAY_PROJECT: projectPath,
      },
    });

    // Write prompt to stdin (secure - not visible in process list)
    proc.stdin?.write(prompt);
    proc.stdin?.end();
  } else if (aiTool === 'devin') {
    // Devin CLI: plan → agent-config で Read のみ許可（Write/Exec deny）、exec → dangerous（全承認）
    // #329: --agent-config/--permission-mode/--prompt-file はバージョンによって対応可否が異なり、
    // 非対応フラグを渡すと clap が exit 2 で即死し出力ゼロ→汎用「(No response from AI)」に落ちて
    // 実際のエラーが届かない問題があったため、--model/--export と同じ probe 方式で駆動する。
    const args: string[] = [];
    const devinCaps = probeDevinCapabilities(command);
    const devinDropped = new Set(options.devinDroppedFlags ?? []);
    // #347: --agent-config は廃止済み（#346）。後継の --config を優先し、
    // 古い CLI のために --agent-config へのフォールバックも残す。
    const devinHasConfig = devinCaps.config && !devinDropped.has('--config');
    const devinHasAgentConfig = devinCaps.agentConfig && !devinDropped.has('--agent-config');
    const devinHasPermissionMode = devinCaps.permissionMode && !devinDropped.has('--permission-mode');
    const devinHasPromptFile = devinCaps.promptFile && !devinDropped.has('--prompt-file');
    // #345: workspace trust 拒否対策。devinDropped に載れば #329 の自動リトライ安全網が既に外している。
    const devinHasRespectWorkspaceTrust = devinCaps.respectWorkspaceTrust && !devinDropped.has('--respect-workspace-trust');
    // #329: 読み取り専用強制がプロンプト指示のみに劣化した場合、静かなフォールバック禁止の方針に従い1行警告する
    // #344: 理由を enum 化。exec モードの --permission-mode 非対応は plan 用の readonlyUnsupported
    // ではなく専用の execPermissionUnsupported で通知する（従来は同じ boolean で plan 用文言が誤って
    // exec モードでも表示されていた）。
    let devinDegradedReason: 'planReadonly' | 'execPermission' | null = null;
    // #344: probe 自体が失敗した（ok:false）場合は「対応ありと仮定して続行する」旨を1回だけ知らせる
    if (!devinCaps.ok && !devinProbeFailedWarned) {
      devinProbeFailedWarned = true;
      onOutput(`${tChat(options.language ?? DEFAULT_CHAT_LANGUAGE, 'devin.probeFailed', { detail: buildDevinCapabilityDetail(devinCaps) })}\n`, false);
    }

    // 保存済み Devin セッション ID があれば -r で resume
    // ただし exec モードでは新規セッションを開始する（--permission-mode dangerous を
    // CLI で指定しても、resume したセッションは元の auto モードを保持して
    // 書き込みが拒否されるため）
    // フォールバック時（#274）は resume しない（壊れたセッション回避）
    const devinSessionId = options.usePlanMode && !options.devinAutoPermFallback
      ? await loadDevinSessionId(projectPath)
      : null;
    // このサイクル（G3 実測で確定）: devin -r はモデル指定を無視し、セッション作成時のモデルを
    // そのまま使い続ける（`--model` を付けても CLI が warning を出して黙って無視する）。
    // 「l devin:plan:X → 次のプロンプトから X で動く」を成立させるため、保存済みモデルと
    // 今回指定のモデルが食い違っていたら resume せず新規セッションで開始する。
    devinCurrentModelForResume = safeModelArg(options.model) ?? '';
    if (devinSessionId) {
      const devinSavedModel = (await loadDevinModel(projectPath)) ?? '';
      if (devinSavedModel === devinCurrentModelForResume) {
        args.push('-r', devinSessionId);
        devinResumedSessionId = devinSessionId;
        console.log(`🔄 Resuming Devin session: ${devinSessionId}`);
      } else {
        console.log(`[devin] Model changed (${devinSavedModel || '(default)'} → ${devinCurrentModelForResume || '(default)'}), starting a new session instead of resuming ${devinSessionId}`);
        onOutput(`${tChat(options.language ?? DEFAULT_CHAT_LANGUAGE, 'devin.modelChangedNewSession', { previousModel: devinSavedModel || '(default)', newModel: devinCurrentModelForResume || '(default)' })}\n`, false);
      }
    }

    if (options.usePlanMode && !options.devinAutoPermFallback && (devinHasConfig || devinHasAgentConfig)) {
      // plan モード: --config（後継、#347）または --agent-config（旧、後方互換）で Read(**) を許可し、
      // Write(**) は常に deny（多層防御の最終防波堤）。Exec は「読み取り専用コマンド・DevRelay
      // スキル実行の prefix allow」+「破壊的コマンドの prefix deny」+「--permission-mode」の
      // 三層で扱う（本サイクル、devin-plan-config.ts に集約）。
      //
      // 【本サイクルで直した根本原因】Devin 公式ドキュメント（docs.devin.ai/cli/reference/permissions）
      // によれば Exec() は glob ではなく「プレフィックス一致」であり Exec(**) は無効なルール
      // （"Exec(**) is not valid" と明記）。#260 以来使っていた deny:["Write(**)","Exec(**)"] の
      // Exec(**) は元々一度も機能していなかった。ルールに一致しないツール呼び出しは「承認待ち」に
      // 落ち、非対話 -p モードでは拒否・保留とも無言 exit 0 になる。加えて --permission-mode auto は
      // 「読み取り専用ツールだけ」を自動承認する仕様（devin --help 逐語）であり、シェル実行は
      // 読み取り専用ではないため auto だけでは自動承認されない。この2つが重なり、DevRelay 自身の
      // 調査系スキル（devrelay-list-inventory 等、実体はすべて bash スクリプト）が allow にも
      // deny にも一致せず承認待ちに落ち、非対話モードのため無言で終わっていた。
      //
      // 対策は二層: ①読み取り専用コマンド・スキル実行の prefix を明示的に Exec() allow へ追加、
      // ②`--permission-mode` を（対応していれば）smart に切り替え、allow に無いが安全なコマンドは
      // Devin 自身の安全判定に委ねる。deny（Write(**) + 破壊的コマンドの prefix）は常に allow/smart
      // より優先されるため、書き込みは構造的に止まったまま。
      // DEVRELAY_DEVIN_PLAN_EXEC_DENY=1 で Exec 許可リストなし + --permission-mode auto
      // （今日までの（壊れていた）挙動）に戻せる（キルスイッチ）。
      // DEVRELAY_DEVIN_PLAN_PERMISSION_MODE=auto|smart で --permission-mode を明示上書きできる。
      const devinPlanStrictExec = process.env.DEVRELAY_DEVIN_PLAN_EXEC_DENY === '1';
      const planConfig = buildDevinPlanConfig({
        strictExec: devinPlanStrictExec,
        skillsDir: path.join(os.homedir(), '.claude', 'skills'),
        readonlyBashCommands: PLAN_READONLY_BASH_COMMANDS,
        writeBashCommands: PLAN_WRITE_BASH_COMMANDS,
      });
      const planConfigPath = path.join(os.tmpdir(), `devrelay-devin-plan-config-${sessionId}.json`);
      fs.writeFileSync(planConfigPath, JSON.stringify(planConfig), 'utf-8');
      const configFlagName = devinHasConfig ? '--config' : '--agent-config';
      args.push('-p', configFlagName, planConfigPath);
      const devinPlanPermMode = resolveDevinPlanPermissionMode(devinCaps, {
        strictExec: devinPlanStrictExec,
        envOverride: process.env.DEVRELAY_DEVIN_PLAN_PERMISSION_MODE,
      });
      if (devinPlanPermMode) {
        // config の allow/deny だけに任せず、Devin 自身の安全判定（smart/auto）も併用する（多層防御）
        args.push('--permission-mode', devinPlanPermMode);
      }
      devinPlanConfigApplied = true;
      console.log(`📋 Devin plan mode: using ${configFlagName} (${devinPlanStrictExec ? 'Read only, Write/Exec denied' : 'Read + safe Exec allowed, Write denied'})${devinPlanPermMode ? ` + --permission-mode ${devinPlanPermMode}` : ''}`);
    } else if (options.usePlanMode && !options.devinAutoPermFallback && devinHasPermissionMode) {
      // #329/#347: --config/--agent-config 非対応の CLI → --permission-mode に劣化（config による
      // Exec allow/deny prefix は使えないため読み取り専用強制はプロンプト指示のみ）
      const devinPlanPermMode = resolveDevinPlanPermissionMode(devinCaps, {
        strictExec: process.env.DEVRELAY_DEVIN_PLAN_EXEC_DENY === '1',
        envOverride: process.env.DEVRELAY_DEVIN_PLAN_PERMISSION_MODE,
      }) ?? 'auto';
      args.push('-p', '--permission-mode', devinPlanPermMode);
      devinDegradedReason = 'planReadonly';
      console.log(`📋 Devin plan mode: --config/--agent-config unsupported, degraded to --permission-mode ${devinPlanPermMode} (readonly not enforced)`);
    } else if (options.usePlanMode && !options.devinAutoPermFallback) {
      // #329/#347: --config/--agent-config も --permission-mode も非対応 → -p のみ（最小フラグ、読み取り専用強制はプロンプト指示のみ）
      args.push('-p');
      devinDegradedReason = 'planReadonly';
      console.log(`📋 Devin plan mode: --config/--agent-config/--permission-mode all unsupported, running with -p only (readonly not enforced)`);
    } else if (options.usePlanMode && options.devinAutoPermFallback) {
      // plan フォールバック（#274）: config の deny で Devin がツール拒否→出力ゼロになる問題の回避。
      // config を渡さず --permission-mode auto（安全ツールのみ自動承認）で実行する。
      // 厳密読み取り専用は緩むが「プラン不能」よりまし。書き換え抑止はプロンプト側の指示に委ねる。
      if (devinHasPermissionMode) {
        args.push('-p', '--permission-mode', 'auto');
        console.log(`📋 Devin plan mode fallback: using --permission-mode auto (agent-config skipped)`);
      } else {
        args.push('-p');
        console.log(`📋 Devin plan mode fallback: --permission-mode unsupported, running with -p only`);
      }
    } else {
      // exec モード: 全ツール自動承認
      if (devinHasPermissionMode) {
        args.push('-p', '--permission-mode', 'dangerous');
      } else {
        // #329: --permission-mode 非対応の旧 CLI → -p のみ（劣化通知）
        args.push('-p');
        devinDegradedReason = 'execPermission';
        console.log(`⚠️ Devin exec mode: --permission-mode unsupported, running with -p only`);
      }
    }

    // #276: 途中経過表示。対応版なら --export で ATIF をファイル書き出しさせ、後段でポーリングして進捗を出す。
    // stdout ではなく別ファイルへ出るため、最終保存メッセージ（responseText）を汚染しない。
    if (probeDevinExportSupport(command)) {
      devinExportPath = path.join(os.tmpdir(), `devrelay-devin-export-${sessionId}.jsonl`);
      args.push('--export', devinExportPath);
      console.log(`📤 Devin --export enabled: ${devinExportPath}`);
    }

    // #309: plan/exec モデル分離。旧 CLI で `--model` 非対応の場合は引数を付けずデフォルトへ劣化させる。
    // Devin は fuzzy 名（例: 'opus', 'sonnet', 'gpt-5.5'）を受け付ける。
    const devinModel = safeModelArg(options.model);
    if (devinModel && devinCaps.model) {
      args.push('--model', devinModel);
    } else if (devinModel && !devinCaps.model && !devinModelUnsupportedWarned) {
      // #325: 静かなフォールバック禁止。モデル指定が黙って無視されるのを防ぐため、
      // プロセス寿命中 1 回だけチャットへ通知する（devinFlagListNotified と同じ流儀）。
      devinModelUnsupportedWarned = true;
      onOutput(`${tChat(options.language ?? DEFAULT_CHAT_LANGUAGE, 'devin.modelUnsupported', { model: devinModel, detail: buildDevinCapabilityDetail(devinCaps) })}\n`, false);
    }

    // #345: DevRelay は常に -p（非対話）で起動する。devin の --help は
    // 「Defaults to ... false for non-interactive (print) mode」と明記しているが、
    // 実機ではユーザー config の respect_workspace_trust が優先され
    // 「Refusing to run in an untrusted workspace」で全ターンが失敗する。
    // リモート実行では対話の trust プロンプトを人間が押せないため構造的に復旧不能。
    // よって CLI 引数で devin 自身の print モード既定を明示的に指定する（権限拡大ではない）。
    if (devinHasRespectWorkspaceTrust && process.env.DEVRELAY_DEVIN_RESPECT_WORKSPACE_TRUST !== '1') {
      args.push('--respect-workspace-trust', 'false');
    }

    // #344: 位置引数フォールバック（`--` の後にプロンプトを argv として直接渡す経路）を廃止した。
    // Node の `spawn(..., {shell:true})` は引数をクォートしないため、この経路は
    // プロンプトに含まれる `\n`/バッククォート/`&` 等がシェルに解釈される任意コマンド実行の脆弱性だった
    // （DevRelay は全プロンプトに ~170行の Agreement/プランモード指示を前置しており、
    // PLAN_MODE_INSTRUCTION は `\n\n` で始まりバッククォートを含むため、probe 失敗時は
    // 毎回この経路を踏んでいた＝#344 の実バグ原因）。probe が実際に成功した（ok:true）上で
    // なお --prompt-file が無いと判明した場合のみ、静かなフォールバック禁止の方針に従い明示的に中止する。
    let promptFilePath: string | null = null;
    if (devinHasPromptFile) {
      promptFilePath = path.join(os.tmpdir(), `devrelay-prompt-${sessionId}.txt`);
      fs.writeFileSync(promptFilePath, prompt, 'utf-8');
      args.push('--prompt-file', promptFilePath);
    } else {
      console.error(`[devin] --prompt-file unsupported, aborting (unsafe argv fallback removed in #344)`);
      onOutput(tChat(options.language ?? DEFAULT_CHAT_LANGUAGE, 'devin.promptFileUnsupported'), true);
      return {};
    }

    if (devinDegradedReason === 'planReadonly') {
      onOutput(`${tChat(options.language ?? DEFAULT_CHAT_LANGUAGE, 'devin.readonlyUnsupported', { detail: buildDevinCapabilityDetail(devinCaps) })}\n`, false);
      // #346: --agent-config 非対応時は「このマシンで何が使えるか」をプロセス寿命中 1 回だけ追送する
      // （agent.log にしか出ていなかった detected flags をチャットへ可視化）。
      if (!devinFlagListNotified) {
        devinFlagListNotified = true;
        onOutput(`${tChat(options.language ?? DEFAULT_CHAT_LANGUAGE, 'devin.flagList', { flags: formatDevinFlagList(devinCaps.flags) })}\n`, false);
      }
    } else if (devinDegradedReason === 'execPermission') {
      onOutput(`${tChat(options.language ?? DEFAULT_CHAT_LANGUAGE, 'devin.execPermissionUnsupported', { detail: buildDevinCapabilityDetail(devinCaps) })}\n`, false);
    }

    console.log(`🔧 Running: ${command} ${args.join(' ').replace(promptFilePath, '...')}`);

    // Devin コマンドのディレクトリを PATH に追加
    // #344: command がベース名のみ（例: 'devin'）の場合 path.dirname は '.' になり、cwd（プロジェクト
    // ディレクトリ）が PATH の先頭に積まれてしまう（悪意あるリポジトリに `git`/`node` という名前の
    // ファイルがあると誤って実行される恐れ）。フルパスが解決できている場合のみ PATH に追加する。
    const devinDir = path.dirname(command);
    const devinPathSep = process.platform === 'win32' ? ';' : ':';
    const devinEnvPath = devinDir === '.'
      ? (process.env.PATH ?? devinDir)
      : (process.env.PATH ? `${devinDir}${devinPathSep}${process.env.PATH}` : devinDir);

    proc = spawn(command, args, {
      cwd: projectPath,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        ...proxyEnv,
        PATH: devinEnvPath,
        DEVRELAY: '1',
        DEVRELAY_SESSION_ID: sessionId,
        DEVRELAY_PROJECT: projectPath,
        // #282: devin 内部ログを stderr にリアルタイム出力させ、ツール実行をライブ表示する
        CHISEL_LOG_STDERR: '1',
      },
    });

    // stdin は使わない（--prompt-file で渡す）
    proc.stdin?.end();
  } else if (aiTool === 'codex') {
    // #308: Codex CLI（`codex exec`）。非対話実行のみで、プロンプトは stdin 経由（`-` 明示）。
    // 数十KBになる会話履歴込みプロンプトをシェル引数に埋めると Windows の cmd.exe コマンドライン長上限
    // （約8191文字）で確実に壊れるため、gemini と同じ stdin 方式を使う。
    const caps = probeCodexCapabilities(command);
    const args: string[] = ['exec'];
    if (caps.json) args.push('--json');
    args.push('--skip-git-repo-check');

    // 権限: plan = read-only（CLI レベルで書き込み不可を強制）、exec = danger-full-access + 自動承認
    // `-s/--sandbox` ではなく `-c sandbox_mode=` を使う: `codex exec resume` には `-s` が存在しないため、
    // `-c` に統一することで新規／resume でフラグ列を完全に共通化できる（実測で確認済み）。
    // 値は TOML としてパースされるため文字列は内側にダブルクォートが必要（例: sandbox_mode="read-only"）。
    // 実行モードはすべて danger-full-access。プランモードだけは CLI レベルで
    // read-only を強制する。これにより通常の exec でも git 操作とネットワークアクセスを行える。
    if (options.usePlanMode) {
      args.push('-c', 'sandbox_mode="read-only"');
    } else {
      args.push('-c', 'sandbox_mode="danger-full-access"', '-c', 'approval_policy="never"');
    }

    // #309: plan/exec モデル分離。`-m/--model` は新規セッションのみ対応（`codex exec resume` に存在しない）
    // ため、`sandbox_mode` と同じく `-c model="..."` を使い新規/resume でフラグ列を共通化する。
    // 値は TOML 文字列としてパースされるためダブルクォート必須（server 側で危険文字は事前に拒否済みだが二重に防御）。
    const codexModel = safeModelArg(options.model);
    if (codexModel) {
      args.push('-c', `model="${codexModel}"`);
    }

    // 保存済み thread_id があれば resume で継続（フラグを全部書いた"後"に置く必要がある）
    const codexThreadIdToResume = caps.resume ? await loadCodexSessionId(projectPath) : null;
    if (codexThreadIdToResume) {
      args.push('resume', codexThreadIdToResume);
      codexResumedThreadId = codexThreadIdToResume;
      console.log(`🔄 Resuming Codex thread: ${codexThreadIdToResume}`);
    }
    args.push('-'); // プロンプトは stdin から読む（必ず最後の引数）

    console.log(`🔧 Running: ${command} ${args.join(' ')}`);

    // Codex コマンドのディレクトリを PATH に追加（gemini/devin と同様）
    const codexDir = path.dirname(command);
    const codexPathSep = process.platform === 'win32' ? ';' : ':';
    const codexEnvPath = process.env.PATH ? `${codexDir}${codexPathSep}${process.env.PATH}` : codexDir;

    // npm がグローバルインストールする codex は Windows では `codex.cmd` シムになるため、
    // Node の spawn は shell 経由でないとバッチファイルを直接実行できない（EINVAL）。
    // `-c` の値にダブルクォートを含むため、Linux/macOS では shell を経由しない（エスケープ事故防止）が、
    // Windows のみ shell: true にする（gemini/devin と同じ既存の使い分け方針）。
    const isWindowsCodex = process.platform === 'win32';
    proc = spawn(command, args, {
      cwd: projectPath,
      shell: isWindowsCodex,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        ...proxyEnv,
        PATH: codexEnvPath,
        DEVRELAY: '1',
        DEVRELAY_SESSION_ID: sessionId,
        DEVRELAY_PROJECT: projectPath,
      },
    });

    proc.stdin?.write(prompt);
    proc.stdin?.end();
  } else {
    // For other AI tools (aider), use shell (legacy behavior)
    const escapedPrompt = prompt.replace(/'/g, "'\\''");
    const fullCommand = `${command} '${escapedPrompt}'`;

    console.log(`🔧 Running: ${fullCommand.substring(0, 100)}...`);

    // OS デフォルトシェルを使用（Linux: /bin/sh, Windows: cmd.exe）
    proc = spawn(fullCommand, [], {
      cwd: projectPath,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, ...proxyEnv },
    });

    proc.stdin?.end();
  }

  // 実行中のプロセスを activeSessions に保存（cancelAiSession で参照するため）
  const session = activeSessions.get(sessionId);
  if (session) {
    session.process = proc;
  }

  // #276: Devin は `-p` 実行中に stdout を出さないため、進捗ハートビートを送る。
  // これによりサーバー側の進捗ボックス（🤖 処理中... ⏱️ N秒経過）に生存が表示され、
  // かつサーバーの 5 分無出力タイムアウト（PROGRESS_TIMEOUT）による誤った打ち切りを防ぐ。
  // 進捗チャンクは ⏳ 始まりにして、connection.ts で最終保存メッセージから除外する。
  if (aiTool === 'devin') {
    const devinStartTime = Date.now();
    const lang: Language = options.language ?? DEFAULT_CHAT_LANGUAGE;
    devinHeartbeatTimer = setInterval(() => {
      const elapsedSec = Math.floor((Date.now() - devinStartTime) / 1000);
      // #277: 上限有効時は「/ 上限M分」を併記して残り時間を可視化
      const limitSuffix = devinMaxRuntimeMin > 0 ? tChat(lang, 'progress.runtimeLimitSuffix', { min: devinMaxRuntimeMin }) : '';
      // #278: 30秒間隔で発火し、1分未満は秒表示（短時間タスクでも最低1回は進捗が出るように）
      const elapsedLabel = elapsedSec < 60
        ? tChat(lang, 'progress.elapsedSec', { n: elapsedSec })
        : tChat(lang, 'progress.elapsedMin', { n: Math.floor(elapsedSec / 60) });
      onOutput(`${tChat(lang, 'progress.devinRunning', { label: elapsedLabel, limit: limitSuffix })}\n`, false);
    }, 30_000);

    // #277: 実行時間上限（本命）。超過で SIGTERM 停止し、close ハンドラで課金抑止メッセージを送る。
    if (devinMaxRuntimeMin > 0) {
      devinLimitTimer = setTimeout(() => {
        console.log(`[devin] ⏸️ Runtime limit ${devinMaxRuntimeMin}min reached, killing process (cost guard)`);
        devinRuntimeLimitHit = true;
        proc.kill('SIGTERM');
      }, devinMaxRuntimeMin * 60_000);
    }

    // Devin モデル選択サイクル・サイクル B（変更4）: `maxSteps` は ATIF 経由では原理的に
    // 機能しない（ATIF はターン終了時に一括書き出しされるため、書き込み途中のファイルは
    // parse に成功せずポーラーは毎回 null を返す）。有効時は 1 回だけ console 警告し、
    // 実効的なコストガードとして `maxRuntimeMinutes` を使うよう案内する（#325 静かなフォールバック禁止）。
    if (devinMaxSteps > 0 && !devinMaxStepsWarned) {
      devinMaxStepsWarned = true;
      console.log(`[devin] ⚠️ maxSteps is not enforceable with ATIF export (written at turn end).`);
      console.log(`        Use maxRuntimeMinutes (current: ${devinMaxRuntimeMin}) as the effective cost guard.`);
    }

    // #281: プロジェクトディレクトリのファイル変更を監視して「内部で何をしているか」を進捗表示する。
    // devin は -p 実行中 stdout 無出力 + ATIF は turn 終了時一括書き出しのため、
    // ファイル操作の監視がライブで内部動作を見せる唯一の手段。⏳ prefix で最終回答からは除外される。
    try {
      devinFsWatcher = fs.watch(projectPath, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const f = filename.toString().replace(/\\/g, '/');
        // 除外: VCS・依存・生成物・一時ファイル（devin 自身の作業に無関係なノイズを弾く、欠陥2対策）
        if (isNoisyChangedPath(f)) return;
        const now = Date.now();
        // 同一ファイルは10秒に1回まで（保存の連打でスパムにならないように）
        if (now - (devinReportedFiles.get(f) ?? 0) < 10_000) return;
        devinReportedFiles.set(f, now);
        if (devinFileWatchCount >= devinFileWatchMax) {
          if (!devinFileWatchLimitNotified) {
            devinFileWatchLimitNotified = true;
            onOutput(`⏳ ${tChat(options.language ?? DEFAULT_CHAT_LANGUAGE, 'devin.fileWatchTruncated', { limit: String(devinFileWatchMax) })}\n`, false);
          }
          return;
        }
        devinFileWatchCount++;
        onOutput(`⏳ 📝 ${f} を更新中...\n`, false);
      });
    } catch (err) {
      // recursive fs.watch 非対応環境（古い Node 等）は黙ってスキップ（ライブ表示なしでも動作は継続）
      console.warn(`[devin] fs.watch unavailable, file activity display disabled:`, (err as Error).message);
    }

    // --export 対応版なら ATIF ファイルをポーリングしてステップ要約を進捗として出す（ベストエフォート）
    if (devinExportPath) {
      const exportPath = devinExportPath;
      devinExportPollTimer = setInterval(() => {
        try {
          if (!fs.existsSync(exportPath)) return;
          const stat = fs.statSync(exportPath);
          if (stat.size <= devinExportReadPos) return;
          const fd = fs.openSync(exportPath, 'r');
          try {
            const buf = Buffer.alloc(stat.size - devinExportReadPos);
            fs.readSync(fd, buf, 0, buf.length, devinExportReadPos);
            devinExportReadPos = stat.size;
            const chunk = buf.toString('utf-8');
            for (const line of chunk.split('\n')) {
              const trimmed = line.trim();
              if (!trimmed) continue;
              try {
                const entry = JSON.parse(trimmed);
                // 変更4（判明15）: pretty-print された単一 JSON の配列末尾スカラー行（`"pattern"`等）も
                // 単独では valid JSON となり parse に成功してしまうため、summarizeAtifEntry() が
                // 非 null を返した（＝実ステップと判定できた）ときだけ devinStepCount を進める。
                // これが 8 ステップが 38 と誤カウントされていたバグの是正点。
                const s = summarizeAtifEntry(entry);
                const summary = s ? formatAtifStepSummary(s, options.language ?? DEFAULT_CHAT_LANGUAGE) : null;
                if (summary) {
                  onOutput(`⏳ ${summary}\n`, false);
                  // #277: ステップ数上限（--export 対応版のみ）。超過で SIGTERM 停止。
                  devinStepCount++;
                  if (devinMaxSteps > 0 && devinStepCount > devinMaxSteps && !devinStepLimitHit) {
                    console.log(`[devin] ⏸️ Step limit ${devinMaxSteps} exceeded, killing process (cost guard)`);
                    devinStepLimitHit = true;
                    proc.kill('SIGTERM');
                  }
                }
              } catch {
                // ATIF が JSONL でない／不完全行 → 無視（ハートビートが生存を担保）
              }
            }
          } finally {
            fs.closeSync(fd);
          }
        } catch (err) {
          console.warn(`[devin] export poll error:`, (err as Error).message);
        }
      }, 3_000);
    }
  }

  // #308: Codex は長考中に JSONL イベントが途切れることがあるため、devin と同じ 30 秒ハートビートを送る
  // （サーバーの 5 分無出力タイムアウトによる誤打ち切り防止）。
  if (aiTool === 'codex') {
    const codexStartTime = Date.now();
    const lang: Language = options.language ?? DEFAULT_CHAT_LANGUAGE;
    codexHeartbeatTimer = setInterval(() => {
      const elapsedSec = Math.floor((Date.now() - codexStartTime) / 1000);
      const elapsedLabel = elapsedSec < 60
        ? tChat(lang, 'progress.elapsedSec', { n: elapsedSec })
        : tChat(lang, 'progress.elapsedMin', { n: Math.floor(elapsedSec / 60) });
      onOutput(`${tChat(lang, 'progress.codexRunning', { label: elapsedLabel })}\n`, false);
    }, 30_000);
  }

  let fullOutput = '';
  let lineBuffer = '';
  // stderr を収集してエラー検出に使用
  let stderrOutput = '';
  // onOutput(true) の二重呼び出し防止（error + close イベント競合対策）
  let completionSent = false;
  // "Prompt is too long" が stdout（通常の応答テキスト）で出力された場合の検出フラグ
  let promptTooLong = false;

  // --resume 使用時のスタートアップタイムアウト（ハング検出・自動リトライ用）
  const RESUME_STARTUP_TIMEOUT = 60000; // 60秒
  let startupTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  if (options.resumeSessionId) {
    startupTimeoutTimer = setTimeout(() => {
      if (fullOutput.length === 0 && !completionSent) {
        console.log(`[${aiTool}] ⚠️ --resume startup timeout (${RESUME_STARTUP_TIMEOUT / 1000}s), killing process for retry`);
        result.resumeFailed = true;
        proc.kill('SIGTERM');
      }
    }, RESUME_STARTUP_TIMEOUT);
  }

  return new Promise<AiRunResult>((resolve) => {
    proc.stdout?.on('data', (data) => {
      // 初回データ受信でスタートアップタイムアウトをクリア（正常起動確認）
      if (startupTimeoutTimer) {
        clearTimeout(startupTimeoutTimer);
        startupTimeoutTimer = null;
      }
      const text = data.toString();
      lineBuffer += text;

      // Process complete lines
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        if (!line.trim()) continue;

        // #308: Codex CLI（`codex exec --json`）は claude 形式と異なる JSONL スキーマのため、
        // claude 形式の判定に入る前に専用処理して次の行へ進む。
        if (aiTool === 'codex') {
          let codexJson: any;
          try {
            codexJson = JSON.parse(line);
          } catch {
            // --json 非対応の旧バージョン等 → プレーンテキストとして扱う
            const trimmed = line.trim();
            if (trimmed) {
              fullOutput += trimmed + '\n';
              onOutput(trimmed + '\n', false);
            }
            continue;
          }

          switch (codexJson.type) {
            case 'thread.started': {
              const threadId = codexJson.thread_id;
              if (threadId) {
                codexThreadId = threadId;
                result.extractedSessionId = threadId;
                console.log(`[codex] 📋 Thread ID: ${threadId}`);
                saveCodexSessionId(projectPath, threadId).catch(err => {
                  console.error(`Failed to save Codex session ID:`, err);
                });
              }
              break;
            }
            case 'item.completed': {
              const item = codexJson.item;
              if (!item) break;
              if (item.type === 'agent_message' && item.text) {
                fullOutput += item.text;
                console.log(`[codex] +${item.text.length} chars`);
                onOutput(item.text, false);
              } else if (item.type === 'reasoning') {
                // ノイズ・トークン浪費のため表示しない
              } else {
                // command_execution / file_change / web_search / mcp_tool_call 等 → 進捗表示（10秒スロットル）
                const summary = summarizeCodexItem(item, options.language ?? DEFAULT_CHAT_LANGUAGE);
                if (summary) {
                  const now = Date.now();
                  if (now - (codexProgressReported.get(summary) ?? 0) >= 10_000) {
                    codexProgressReported.set(summary, now);
                    onOutput(`⏳ ${summary}\n`, false);
                  }
                }
              }
              break;
            }
            case 'turn.completed': {
              const usage = codexJson.usage;
              if (usage) {
                // claude 互換キーへマップ（reasoning_output_tokens は output_tokens に内包されるため加算しない）
                const mappedUsage: Record<string, number> = {
                  input_tokens: usage.input_tokens ?? 0,
                  output_tokens: usage.output_tokens ?? 0,
                  cache_read_input_tokens: usage.cached_input_tokens ?? 0,
                  cache_creation_input_tokens: usage.cache_write_input_tokens ?? 0,
                };
                const modelName = safeModelArg(options.model) || 'codex'; // #309: 指定モデルがあれば実 ID、未指定時は 'codex'
                result.usageData = {
                  usage: mappedUsage,
                  modelUsage: { [modelName]: { contextWindow: 200000, ...mappedUsage } },
                  model: modelName,
                };
                console.log(`[codex] 💾 Usage captured: input=${mappedUsage.input_tokens}, output=${mappedUsage.output_tokens}, cached=${mappedUsage.cache_read_input_tokens}`);
              }
              break;
            }
            case 'turn.failed': {
              codexTurnFailed = true;
              codexTurnFailedMessage = codexJson.error?.message || 'unknown error';
              console.error(`[codex] ❌ turn.failed: ${codexTurnFailedMessage}`);
              break;
            }
            default:
              // thread.started 以外の管理イベント（turn.started 等）は無視
              break;
          }
          continue;
        }

        try {
          const json = JSON.parse(line);

          // Parse for session ID and context usage
          const parsed = parseStreamJsonLine(line);
          // Debug: log raw usage data from result message
          if (json.type === 'result' && json.usage) {
            console.log(`[${aiTool}] 📊 Raw usage: input_tokens=${json.usage.input_tokens}, cache_read=${json.usage.cache_read_input_tokens}, cache_creation=${json.usage.cache_creation_input_tokens}`);
          }
          if (parsed.sessionId) {
            result.extractedSessionId = parsed.sessionId;
            console.log(`[${aiTool}] 📋 Session ID: ${parsed.sessionId.substring(0, 8)}...`);
            // Save session ID for future resumption
            // #348: persistProjectState===false（一時セッション）なら projectPath 上には書かない
            if (options.persistProjectState !== false) {
              saveClaudeSessionId(projectPath, parsed.sessionId).catch(err => {
                console.error(`Failed to save session ID:`, err);
              });
            }
          }
          if (parsed.contextUsage) {
            result.contextUsage = parsed.contextUsage;
            console.log(`[${aiTool}] ${formatContextUsage(parsed.contextUsage)}`);
            // Save context usage for display at start of next prompt
            // #348: persistProjectState===false（一時セッション）なら projectPath 上には書かない
            if (options.persistProjectState !== false) {
              saveContextUsage(projectPath, parsed.contextUsage).catch(err => {
                console.error(`Failed to save context usage:`, err);
              });
            }
          }
          // usageData をそのまま保存（DB 格納用）
          if (parsed.usageData) {
            result.usageData = parsed.usageData;
            console.log(`[${aiTool}] 💾 Usage data captured: duration=${parsed.usageData.durationMs}ms, models=${Object.keys(parsed.usageData.modelUsage || {}).join(', ')}`);
          }

          // Extract text from assistant messages (new format)
          if (json.type === 'assistant' && json.message?.content) {
            for (const block of json.message.content) {
              if (block.type === 'text' && block.text) {
                // "Prompt is too long" が通常の応答テキストとして出力される場合を検出
                // ストリーミングせず、close ハンドラで日本語警告に変換する
                if (block.text.trim() === 'Prompt is too long') {
                  console.log(`[${aiTool}] ⚠️ "Prompt is too long" detected in stdout, suppressing`);
                  promptTooLong = true;
                  continue;
                }
                fullOutput += block.text;
                console.log(`[${aiTool}] +${block.text.length} chars`);
                onOutput(block.text, false);
              } else if (block.type === 'tool_use' && block.name) {
                console.log(`[${aiTool}] 🔧 Using tool: ${block.name}`);
                onOutput(`\n${tChat(options.language ?? DEFAULT_CHAT_LANGUAGE, 'progress.usingTool', { tool: block.name })}\n`, false);
              }
            }
          }
          // Extract text from streaming events (legacy format)
          else if (json.type === 'stream_event' &&
              json.event?.type === 'content_block_delta' &&
              json.event?.delta?.type === 'text_delta') {
            const deltaText = json.event.delta.text;
            fullOutput += deltaText;
            console.log(`[${aiTool}] +${deltaText.length} chars`);
            onOutput(deltaText, false);
          }
          // Also capture tool use for visibility (legacy format)
          else if (json.type === 'stream_event' &&
                   json.event?.type === 'content_block_start' &&
                   json.event?.content_block?.type === 'tool_use') {
            const toolName = json.event.content_block.name;
            console.log(`[${aiTool}] 🔧 Using tool: ${toolName}`);
            onOutput(`\n${tChat(options.language ?? DEFAULT_CHAT_LANGUAGE, 'progress.usingTool', { tool: toolName })}\n`, false);
          }
          // Capture result for final output
          else if (json.type === 'result') {
            console.log(`[${aiTool}] ✅ Complete (${json.duration_ms}ms)`);
          }
        } catch {
          // JSON パース失敗 → プレーンテキスト出力（Devin/Gemini/Aider/Codex）
          const trimmed = line.trim();
          // #347: Devin の初回起動バナー（Welcome to Devin CLI! 等）は AI の回答ではないため除外する。
          // 含めると fullOutput が汚染され「出力ゼロ」を条件にした安全網（#274/#329）が無効化される。
          if (trimmed && !(aiTool === 'devin' && isDevinBannerLine(trimmed))) {
            fullOutput += trimmed + '\n';
            onOutput(trimmed + '\n', false);
          }
        }
      }
    });

    // #282: devin 専用 stderr 分類（CHISEL_LOG_STDERR=1 の内部ログをライブ進捗 / エラー検出に振り分け）。
    // 例: "2026-07-24T07:34:22.891238Z  INFO toolbox::tools::write: Writing to file: X"
    const DEVIN_LOG_RE = /^\d{4}-\d{2}-\d{2}T\S+Z\s+(INFO|WARN|ERROR|DEBUG|TRACE)\s+([\w:]+):\s?(.*)$/;
    const classifyDevinStderrLine = (line: string) => {
      const m = line.match(DEVIN_LOG_RE);
      if (!m) {
        // タイムスタンプなし行: ログ外のプレーン stderr と ERROR の継続行のみ stderrOutput に残す
        // （WARN/INFO の継続行 = "Caused by:" 等のノイズは捨てる）
        if (devinLastLogLevel === '' && line.trim()) {
          stderrOutput += line + '\n';
          console.error(`[devin] stderr: ${line}`);
        } else if (devinLastLogLevel === 'ERROR' && line.trim()) {
          stderrOutput += line + '\n';
        }
        return;
      }
      const [, level, moduleName, message] = m;
      devinLastLogLevel = level;
      // ツール拒否の検出（#274 の平文 "A tool was rejected" はログモードでは出ないため置き換え、
      // 変更6: 実測(v3000.6.14)で確認済みの新パターンも isDevinToolRejectionText() でまとめて判定）
      if (isDevinToolRejectionText(message)) {
        devinToolRejectedInLog = true;
        console.log(`[devin] 🔒 tool rejection detected in log: ${message}`);
        return;
      }
      // ERROR はエラー情報として stderrOutput にも残す（stderrTail 表示・token+limit 検出用）
      if (level === 'ERROR') stderrOutput += `${moduleName}: ${message}\n`;
      // ツール実行ログ → ライブ進捗表示（⏳ prefix で最終メッセージから除外）
      if (moduleName.startsWith('toolbox::')) {
        const key = message.slice(0, 120);
        const now = Date.now();
        if (now - (devinLogReported.get(key) ?? 0) < 10_000) return;
        devinLogReported.set(key, now);
        const toolName = moduleName.split('::').pop() ?? 'tool';
        // #283: session_manager のノイズは空文字が返るので表示スキップ
        const formatted = formatDevinToolLog(toolName, message);
        if (formatted) onOutput(`⏳ ${formatted}\n`, false);
      }
      // それ以外（session_manager/telemetry 等のノイズ）は捨てる（量が多いため agent.log にも出さない）
    };

    proc.stderr?.on('data', (data) => {
      const text = data.toString();
      if (aiTool !== 'devin') {
        stderrOutput += text;
        console.error(`[${aiTool}] stderr: ${text}`);
        return;
      }
      // #282: devin は CHISEL_LOG_STDERR=1 で内部ログが stderr に流れる → 行単位で分類
      devinStderrLineBuffer += text;
      const lines = devinStderrLineBuffer.split('\n');
      devinStderrLineBuffer = lines.pop() ?? '';
      for (const line of lines) classifyDevinStderrLine(line);
    });

    proc.on('close', (code, signal) => {
      console.log(`[${aiTool}] Process exited with code ${code}, signal ${signal}`);

      // #276: 進捗タイマー停止 + ATIF エクスポートファイルの後始末
      if (devinHeartbeatTimer) { clearInterval(devinHeartbeatTimer); devinHeartbeatTimer = null; }
      if (devinExportPollTimer) { clearInterval(devinExportPollTimer); devinExportPollTimer = null; }
      // #308: Codex ハートビート停止
      if (codexHeartbeatTimer) { clearInterval(codexHeartbeatTimer); codexHeartbeatTimer = null; }
      // #281: ファイル変更ウォッチャ停止
      if (devinFsWatcher) { try { devinFsWatcher.close(); } catch {} devinFsWatcher = null; }
      // #281: ATIF は turn 終了時に一括書き出しされるため、削除する前に読んで実行ステップまとめを作る
      // Devin モデル選択サイクル・サイクル B（変更4/変更5）: パースは devin-atif.ts に委譲済み。
      // ここで result.usageData / devinAtifModelName / devinAtifModelId も一緒に確定させる。
      // 15箇所ある result.usageData 読み取り（コスト上限・SIGTERM・#329フラグ再試行・#274 plan tool-rejected
      // の早期 return 経路含む）より前にこの代入が実行されることが重要。
      if (devinExportPath && fs.existsSync(devinExportPath)) {
        try {
          const digest = readDevinTurnDigest(devinExportPath, options.language ?? DEFAULT_CHAT_LANGUAGE);
          if (digest) {
            devinStepSummary = digest.summaryText;
            devinAtifModelName = digest.modelName;
            devinAtifModelId = digest.modelId;
            devinAtifEndedWithoutAnswer = digest.endedWithoutAnswer;
            if (digest.usage) {
              const modelKey = digest.modelId ?? digest.modelName ?? 'devin';
              result.usageData = {
                usage: { ...digest.usage },
                modelUsage: { [modelKey]: { ...digest.usage } },
                model: modelKey,
              };
            }
            if (digest.permissionMode) {
              // permission_mode はチャットには出さず console ログのみ（診断用）
              console.log(`[devin] permission_mode=${digest.permissionMode}`);
            }
          }
        } catch {}
      }
      if (devinExportPath) { try { fs.unlinkSync(devinExportPath); } catch {} }
      // #277: 実行時間上限タイマー停止
      if (devinLimitTimer) { clearTimeout(devinLimitTimer); devinLimitTimer = null; }

      // #282: devin stderr 行バッファの残りをフラッシュ（末尾改行なしの拒否ログ等の取りこぼし防止）
      if (aiTool === 'devin' && devinStderrLineBuffer.trim()) {
        classifyDevinStderrLine(devinStderrLineBuffer);
        devinStderrLineBuffer = '';
      }

      // #275: 改行なしで終わった最終出力の取りこぼし防止（lineBuffer フラッシュ）。
      // stdout ハンドラは改行区切りで処理し「最後の不完全な行」を lineBuffer に残すが、
      // close 時にこれをフラッシュしていなかったため、末尾改行なしの短い応答が丸ごと破棄され
      // exit 0 でも fullOutput 空 →「(No response from AI)」になっていた（Devin の1行応答等）。
      // JSON パース可能な残骸（stream-json メタデータ）は従来どおり捨てる。
      // #308: Codex は独自の JSONL パーサ（for ループ内で完結）を持つため、
      // ここでの汎用フラッシュは対象外にする（末尾の不完全な JSON 断片がそのまま表示されるのを防ぐ）
      if (aiTool !== 'codex' && lineBuffer.trim()) {
        const leftover = lineBuffer.trim();
        lineBuffer = '';
        let isJsonMeta = false;
        try { JSON.parse(leftover); isJsonMeta = true; } catch {}
        if (!isJsonMeta) {
          console.log(`[${aiTool}] 📦 Flushing ${leftover.length} chars from line buffer at close`);
          fullOutput += leftover + '\n';
          onOutput(leftover + '\n', false);
        }
      }

      // Devin: 一時ファイル（プロンプト + agent-config）削除 + セッション ID 取得・保存
      // ただし resume（-r）が出力ゼロで終わった場合はセッション ID を再保存しない（壊れた ID の温存防止）
      const devinResumeEmpty = aiTool === 'devin' && !!devinResumedSessionId && fullOutput.trim().length === 0;
      // #274: 出力ゼロで終わった実行（resume に限らず新規も含む）はセッション ID を保存しない。
      // 失敗セッション（ツール拒否→panic 等）を保存すると次回 resume で毎回 panic するループを断つ。
      const devinOutputEmpty = aiTool === 'devin' && fullOutput.trim().length === 0;
      if (aiTool === 'devin') {
        try { fs.unlinkSync(path.join(os.tmpdir(), `devrelay-prompt-${sessionId}.txt`)); } catch {}
        try { fs.unlinkSync(path.join(os.tmpdir(), `devrelay-devin-plan-config-${sessionId}.json`)); } catch {}
        // #347: 旧名（--agent-config 時代）の残骸も掃除する。次サイクル以降に削除してよい。
        try { fs.unlinkSync(path.join(os.tmpdir(), `devrelay-devin-agent-config-${sessionId}.json`)); } catch {}
        // devin list --format json で最新セッション ID を取得して保存（出力ゼロ時はスキップ）
        try {
          if (!devinOutputEmpty) {
          const listOutput = execSync(`${command} list --format json`, {
            cwd: projectPath, encoding: 'utf-8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
          });
          const sessions = JSON.parse(listOutput);
          // cwd が一致するセッションの最新を取得（Windows: パス区切り正規化）
          const normalizedPath = projectPath.replace(/\\/g, '/').toLowerCase();
          const latest = sessions
            .filter((s: any) => s.working_directory?.replace(/\\/g, '/').toLowerCase() === normalizedPath)
            .sort((a: any, b: any) => (b.last_activity_at || 0) - (a.last_activity_at || 0))[0];
          if (latest?.id) {
            saveDevinSessionId(projectPath, latest.id).catch(() => {});
            // このサイクル: 次回のモデル一致判定のため、今回使ったモデルもセッション ID と並べて保存する
            saveDevinModel(projectPath, devinCurrentModelForResume).catch(() => {});
          }
          }
        } catch (err) {
          console.warn(`[devin] Could not retrieve session ID:`, (err as Error).message);
        }
      }

      // スタートアップタイムアウトをクリア（正常終了時）
      if (startupTimeoutTimer) {
        clearTimeout(startupTimeoutTimer);
        startupTimeoutTimer = null;
      }

      // プロセス参照をクリア（キャンセル済み判定のため exitCode は残る）
      if (session) {
        session.process = null as any;
      }

      // #277: 実行時間 / ステップ数の上限で停止したケース（課金暴走の抑止）。
      // SIGTERM キャンセル判定より前に置く（Windows は kill 後 signal が null になる場合があるためフラグで判定）。
      if (devinRuntimeLimitHit || devinStepLimitHit) {
        const reason = devinRuntimeLimitHit
          ? `実行時間上限 ${devinMaxRuntimeMin} 分`
          : `ステップ数上限 ${devinMaxSteps} 回`;
        console.log(`[devin] ⏸️ Stopped by ${reason}`);
        if (!completionSent) {
          completionSent = true;
          const partial = fullOutput.trim() ? `\n\n[途中までの出力]\n${fullOutput.trim()}` : '';
          onOutput(
            `⏸️ Devin を${reason}で停止しました（課金暴走の抑止）。\n` +
            `Devin は完了時にしか結果を出力しないため途中結果は表示できませんが、` +
            `ファイル変更等はすでに行われている可能性があります。続行する場合は続きを指示してください。\n` +
            `（上限変更: config.yaml の aiTools.devin.maxRuntimeMinutes / maxSteps、0 で無制限・無効）${partial}`,
            true,
            result.usageData
          );
        }
        resolve(result);
        return;
      }

      // SIGTERM によるキャンセル検出
      if (signal === 'SIGTERM') {
        if (result.resumeFailed) {
          // スタートアップタイムアウトによる kill → リトライに任せる
          console.log(`[${aiTool}] ⚠️ Resume startup timeout, will retry without --resume`);
        } else {
          console.log(`[${aiTool}] ⛔ Process was cancelled`);
        }
        if (!completionSent) {
          completionSent = true;
          onOutput('', true, result.usageData);
        }
        resolve(result);
        return;
      }

      // #329: devin CLI が非対応フラグを渡された場合（バージョン差異で --agent-config 等が存在しない）、
      // clap が exit code 2 で即死し stdout 空 → 既存のどの分岐にも該当せず汎用「(No response from AI)」に
      // 落ちて実際のエラーが握りつぶされていた。明示検出して自動リトライ（フラグを1つ外して最大2回）する。
      const devinUnknownFlagMatch = aiTool === 'devin' && fullOutput.trim().length === 0
        ? stderrOutput.match(/unexpected argument '(--[a-z-]+)'/i)
        : null;
      if (devinUnknownFlagMatch) {
        const droppedFlag = devinUnknownFlagMatch[1];
        const alreadyDropped = options.devinDroppedFlags ?? [];
        const lang = options.language ?? DEFAULT_CHAT_LANGUAGE;
        if (!alreadyDropped.includes(droppedFlag) && alreadyDropped.length < 2) {
          console.log(`[devin] ⚠️ Unknown flag '${droppedFlag}' rejected by CLI (code ${code}), retrying without it`);
          completionSent = true;
          onOutput(`${tChat(lang, 'devin.unknownFlagRetry', { flag: droppedFlag })}\n`, false);
          const fallbackOptions: SendPromptOptions = {
            ...options,
            devinDroppedFlags: [...alreadyDropped, droppedFlag],
          };
          sendPromptToAi(sessionId, prompt, projectPath, aiTool, claudeSessionId, config, onOutput, fallbackOptions)
            .then((fallbackResult) => resolve(fallbackResult))
            .catch((err) => {
              console.error(`[devin] unknown-flag retry failed: ${(err as Error).message}`);
              if (fullOutput.length === 0) {
                onOutput('(No response from AI)', true, result.usageData);
              }
              resolve(result);
            });
          return;
        }
        // リトライ済みでも解消しない → 「(No response from AI)」ではなく実際の stderr を明示して停止
        if (!completionSent) {
          completionSent = true;
          const stderrTail = stderrOutput.trim().split('\n').slice(-5).join('\n');
          onOutput(tChat(lang, 'devin.unknownFlagFailed', { flag: droppedFlag, stderr: stderrTail }), true, result.usageData);
        }
        resolve(result);
        return;
      }

      // #274: Devin プランモードで config の deny によりツールが拒否され出力ゼロになったケースを検出。
      // config（Read only, Write/Exec deny）を渡すと Devin が計画立案で Exec 等を使おうとして
      // 「A tool was rejected by the user」→ 実行全体が中断・出力ゼロで終わる（新規プロジェクトで頻発）。
      // config を外して --permission-mode auto で内部リトライする（resume なし・新規セッション）。
      // devinAutoPermFallback ガードで無限ループを防止。
      const devinPlanToolRejected =
        aiTool === 'devin' &&
        options.usePlanMode === true &&
        !options.devinAutoPermFallback &&
        fullOutput.trim().length === 0 &&
        (
          // #282: CHISEL_LOG_STDERR=1 では平文 "A tool was rejected" が出ずログ形式になるため両方で検出
          // 変更6: isDevinToolRejectionText() に集約（旧2パターン+実測で確認済みの新パターン）
          isDevinToolRejectionText(stderrOutput) ||
          devinToolRejectedInLog ||
          // #347 Phase 0 実測: 非対話 deny は説明テキストを一切出さない（バナーはフィルタ済みなので
          // fullOutput は既に空）。config を実際に適用したターンで exit 0・出力ゼロなら deny とみなす。
          // config を積んでいないターンでは発火しない（devinPlanConfigApplied ガード）。
          (devinPlanConfigApplied && code === 0)
        );
      if (devinPlanToolRejected) {
        console.log(`[devin] ⚠️ Devin plan config rejected a tool (code ${code}), falling back to --permission-mode auto`);
        completionSent = true; // この呼び出しの後続 onOutput を抑止（フォールバック側が完了通知を送る）
        // 壊れた可能性のあるセッション ID をクリアしてからフォールバック（新規セッション）
        // このサイクル(S1): セッションIDとモデルは常に対で扱う不変条件のため、モデルも一緒にクリアする
        Promise.all([clearDevinSessionId(projectPath), clearDevinModel(projectPath)]).finally(() => {
          const fallbackOptions: SendPromptOptions = {
            ...options,
            devinAutoPermFallback: true,
            resumeSessionId: undefined,
          };
          sendPromptToAi(sessionId, prompt, projectPath, aiTool, claudeSessionId, config, onOutput, fallbackOptions)
            .then((fallbackResult) => resolve(fallbackResult))
            .catch((err) => {
              console.error(`[devin] fallback retry failed:`, err);
              if (fullOutput.length === 0) {
                onOutput('(No response from AI)', true, result.usageData);
              }
              resolve(result);
            });
        });
        return;
      }

      // Devin: resume（-r）が出力ゼロで終了（exit code 不問）→ セッション ID を破棄して新規セッションでリトライ
      // -r + -p/--agent-config の組み合わせで CLI がエラーも出力も出さず正常終了扱いで空振りするケースの対処
      if (devinResumeEmpty) {
        console.log(`[devin] ⚠️ Resumed session produced no output (code ${code}), clearing session ID and retrying fresh`);
        result.resumeFailed = true;
        // クリア完了後に resolve（後続リトライの loadDevinSessionId と競合させない）。onOutput は呼ばずリトライに完了通知を任せる
        // このサイクル(S1): セッションIDとモデルは常に対で扱う不変条件のため、モデルも一緒にクリアする
        Promise.all([clearDevinSessionId(projectPath), clearDevinModel(projectPath)]).finally(() => resolve(result));
        return;
      }

      // #308: Codex: resume した thread が出力ゼロで終了 → セッションファイルが古くなっている（Session not found 等）
      // 可能性があるため、thread_id を破棄して新規スレッドでリトライする（devin と同じ設計、resumeFailed 汎用機構に乗せる）
      const codexResumeEmpty = aiTool === 'codex' && !!codexResumedThreadId && fullOutput.trim().length === 0;
      if (codexResumeEmpty) {
        console.log(`[codex] ⚠️ Resumed thread produced no output (code ${code}), clearing session ID and retrying fresh`);
        result.resumeFailed = true;
        clearCodexSessionId(projectPath).finally(() => resolve(result));
        return;
      }

      // #308: Codex: turn.failed イベントを受信した場合は理由を明示して完了通知
      if (aiTool === 'codex' && codexTurnFailed && !completionSent) {
        completionSent = true;
        onOutput(`⚠️ Codex の実行が失敗しました: ${codexTurnFailedMessage}`, true, result.usageData);
        resolve(result);
        return;
      }

      // "Prompt is too long" エラーを stdout（promptTooLong フラグ）+ stderr 両方から検出
      const isPromptTooLong = promptTooLong ||
        stderrOutput.includes('Prompt is too long') ||
        (stderrOutput.toLowerCase().includes('token') && stderrOutput.toLowerCase().includes('limit'));

      if (isPromptTooLong) {
        console.log(`[${aiTool}] ⚠️ Prompt too long error detected (stdout=${promptTooLong}, stderr=${stderrOutput.includes('Prompt is too long')})`);
        if (options.resumeSessionId) {
          // --resume でセッションが長すぎる → retry に任せる（新規セッションで再試行）
          console.log(`[${aiTool}] ⚠️ --resume session too long, flagging for retry without session ID`);
          result.resumeFailed = true;
          resolve(result);
          return;
        }
        // --resume なし → 日本語の警告メッセージを送信
        if (!completionSent) {
          completionSent = true;
          onOutput('⚠️ プロンプトが長すぎます。`x` コマンドで会話履歴をクリアしてください。', true, result.usageData);
        }
        resolve(result);
        return;
      }

      // Detect --resume failure: exit code 1 + no output → retry に任せるため onOutput を呼ばない
      if (code === 1 && fullOutput.length === 0 && options.resumeSessionId) {
        console.log(`[${aiTool}] ⚠️ --resume failed, flagging for retry without session ID`);
        result.resumeFailed = true;
        resolve(result);
        return;
      }

      // Detect API error with --resume: exit code 1 + error output (e.g., "API Error: 500 ...")
      // Flag as resumeFailed so the caller clears the session ID and retries fresh
      if (code === 1 && options.resumeSessionId && fullOutput.includes('API Error:')) {
        console.log(`[${aiTool}] ⚠️ API error with --resume, flagging for retry without session ID`);
        result.resumeFailed = true;
        // Still send the error output to the user so they know what happened
        if (!completionSent) {
          completionSent = true;
          onOutput('', true, result.usageData);
        }
        resolve(result);
        return;
      }

      // #274: Devin プランモードのフォールバック（--permission-mode auto）でもツール拒否で出力ゼロだった場合は
      // 「(No response from AI)」でなく具体的な案内を出す（devin CLI 単体確認を促す）
      const devinFallbackToolRejected =
        aiTool === 'devin' &&
        options.usePlanMode === true &&
        options.devinAutoPermFallback === true &&
        fullOutput.trim().length === 0 &&
        // 変更6: isDevinToolRejectionText() に集約（旧2パターン+実測で確認済みの新パターン）
        (isDevinToolRejectionText(stderrOutput) || devinToolRejectedInLog);
      if (devinFallbackToolRejected && !completionSent) {
        completionSent = true;
        const stderrTail = stderrOutput.trim().split('\n').slice(-5).join('\n');
        // 変更6: --permission-mode auto フォールバック後もなお拒否された「二重空振り」は
        // プランモードでの再試行を促さず、exec モードへの切り替えを明示する（#325 静かなフォールバック禁止）
        onOutput(
          tChat(options.language ?? DEFAULT_CHAT_LANGUAGE, 'devin.planToolRejectedNoRetry', { stderrTail }),
          true,
          result.usageData
        );
        resolve(result);
        return;
      }

      // #275: フラッシュ後もなお Devin が出力ゼロ + exit 0 で終わった場合は「(No response from AI)」でなく
      // 具体的な案内を出す（処理自体は実行された可能性を伝える。exec 自動リトライは二重実行の危険があるため行わない）
      if (aiTool === 'devin' && fullOutput.trim().length === 0 && code === 0 && !completionSent) {
        completionSent = true;
        const stderrTail = stderrOutput.trim() ? `\n\n[stderr]\n${stderrOutput.trim().split('\n').slice(-5).join('\n')}` : '';
        onOutput(
          `⚠️ Devin が出力なしで終了しました（exit 0）。処理自体は実行された可能性があります。\nプロジェクトの変更状況を確認してください。${stderrTail}`,
          true,
          result.usageData
        );
        resolve(result);
        return;
      }

      if (!completionSent) {
        completionSent = true;
        if (fullOutput.length === 0) {
          // #344: 汎用「(No response from AI)」で実エラーを握りつぶさないよう、既存の分岐（unknownFlag
          // の自動リトライ・devin の exit 0 空応答案内等、いずれもこの手前で既に return 済み）は
          // 一切変更せず、それらに該当しなかった残りのケースだけを分類して案内する。
          const cliFailure = classifyCliFailure({ exitCode: code, stdoutLength: fullOutput.length, stderr: stderrOutput });
          const lang = options.language ?? DEFAULT_CHAT_LANGUAGE;
          if (cliFailure.kind === 'commandNotFound') {
            onOutput(tChat(lang, 'ai.cliNotFound', { tool: aiTool, command }), true, result.usageData);
          } else if (cliFailure.kind === 'emptyNonZero' && aiTool === 'devin' && isWorkspaceTrustError(stderrOutput)) {
            // #345: devin が workspace trust 拒否で即死したケース。生 stderr のダンプではなく対処手順を出す。
            onOutput(tChat(lang, 'devin.workspaceUntrusted', { path: projectPath }), true, result.usageData);
          } else if (cliFailure.kind === 'emptyNonZero') {
            onOutput(tChat(lang, 'ai.cliFailed', { tool: aiTool, code: String(code ?? 'null'), stderr: cliFailure.stderrTail || '(empty)' }), true, result.usageData);
          } else {
            onOutput('(No response from AI)', true, result.usageData);
          }
        } else {
          // #281: Devin の実行ステップまとめを最終回答へ添付してから完了通知（⏳ でない=最終メッセージに残る）
          if (devinStepSummary) onOutput(devinStepSummary, false);
          // Devin モデル選択サイクル・サイクル B（変更5）: 実モデル名を1行通知（チャット表示）
          if (devinAtifModelName || devinAtifModelId) {
            onOutput(tChat(options.language ?? DEFAULT_CHAT_LANGUAGE, 'devin.modelUsed', {
              modelName: devinAtifModelName ?? devinAtifModelId ?? '',
              modelId: devinAtifModelId ?? devinAtifModelName ?? '',
            }) + '\n', false);
          }
          // 欠陥1対策: プランモードでツール呼び出し直後に無言終了した場合、黙ったまま終わらせず理由を明示する
          // （#325 静かなフォールバック禁止）。devinPlanToolRejected/devinFallbackToolRejected は
          // fullOutput.trim().length===0 を前提条件に持つためこの分岐（fullOutput 非空）では発火せず、
          // 既存のリトライ経路（2650-2687 相当）とは排他的に動作する。自動リトライはしない
          // （config を外すと読み取り専用保証が緩むため、#347 の設計意図に反する）。
          if (aiTool === 'devin' && options.usePlanMode === true && devinPlanConfigApplied && code === 0 && devinAtifEndedWithoutAnswer) {
            onOutput('\n' + tChat(options.language ?? DEFAULT_CHAT_LANGUAGE, 'devin.planTurnTruncated', { tool: aiTool }) + '\n', false);
          }
          onOutput('', true, result.usageData); // Signal completion with usage data
        }
      }
      resolve(result);
    });

    proc.on('error', (err) => {
      if (startupTimeoutTimer) {
        clearTimeout(startupTimeoutTimer);
        startupTimeoutTimer = null;
      }
      // #276: 進捗タイマー停止 + ATIF エクスポートファイルの後始末
      if (devinHeartbeatTimer) { clearInterval(devinHeartbeatTimer); devinHeartbeatTimer = null; }
      if (devinExportPollTimer) { clearInterval(devinExportPollTimer); devinExportPollTimer = null; }
      // #308: Codex ハートビート停止
      if (codexHeartbeatTimer) { clearInterval(codexHeartbeatTimer); codexHeartbeatTimer = null; }
      // #281: ファイル変更ウォッチャ停止
      if (devinFsWatcher) { try { devinFsWatcher.close(); } catch {} devinFsWatcher = null; }
      if (devinExportPath) { try { fs.unlinkSync(devinExportPath); } catch {} }
      // #277: 実行時間上限タイマー停止
      if (devinLimitTimer) { clearTimeout(devinLimitTimer); devinLimitTimer = null; }
      console.error(`[${aiTool}] Process error:`, err);
      if (!completionSent) {
        completionSent = true;
        onOutput(formatAiErrorMessage(err.message, options.language ?? DEFAULT_CHAT_LANGUAGE), true);
      }
      resolve(result);
    });
  });
}

export async function stopAiSession(sessionId: string): Promise<void> {
  const session = activeSessions.get(sessionId);

  if (!session) {
    return;
  }

  console.log(`⏹️ Stopping AI session: ${sessionId}`);
  // 実行中のプロセスがあれば停止
  if (session.process && session.process.exitCode === null) {
    session.process.kill('SIGTERM');
  }
  activeSessions.delete(sessionId);
}

/**
 * 実行中の AI プロセスをキャンセルする（セッションは維持）
 * @returns キャンセルできた場合 true、プロセスが存在しない場合 false
 */
export function cancelAiSession(sessionId: string): boolean {
  // 端末インタフェースモードの PTY プロセスがあれば停止
  // terminal-runner がロード済みでない場合 = PTY 実行中ではない（ロードされた時点で必ずキャッシュされる）
  if (terminalRunnerModule && terminalRunnerModule.cancelTerminalProcess(sessionId)) {
    return true;
  }

  // #355: Claude SDK 経路（session.process が null のため上の分岐は必ず false を返す）。
  // activeSdkAborts に登録済みの AbortController を実際に abort() することで
  // claude サブプロセスに SIGTERM を送る（`c` コマンドが「キャンセルした」と嘘をつく問題の解消）。
  const sdkAbortController = activeSdkAborts.get(sessionId);
  if (sdkAbortController) {
    console.log(`⛔ Cancelling AI session (Claude SDK): ${sessionId}`);
    sdkAbortController.abort();
    return true;
  }

  const session = activeSessions.get(sessionId);
  if (!session || !session.process || session.process.exitCode !== null) {
    return false;
  }

  console.log(`⛔ Cancelling AI session: ${sessionId}`);
  session.process.kill('SIGTERM');
  return true;
}

export function getActiveSession(sessionId: string): AiSession | undefined {
  return activeSessions.get(sessionId);
}

export function getActiveSessions(): AiSession[] {
  return Array.from(activeSessions.values());
}

function getAiCommand(aiTool: AiTool, config: AgentConfig): string | undefined {
  switch (aiTool) {
    case 'claude':
      return config.aiTools.claude?.command || 'claude';
    case 'gemini':
      return config.aiTools.gemini?.command || 'gemini';
    case 'codex':
      return config.aiTools.codex?.command || 'codex';
    case 'aider':
      return config.aiTools.aider?.command || 'aider';
    case 'devin':
      return config.aiTools.devin?.command || 'devin';
    default:
      return undefined;
  }
}

/**
 * Claude Code の実行パスを解決する（クロスプラットフォーム対応）
 *
 * 以下の優先順位で探索:
 * 1. devrelay-claude ラッパーが存在すれば使用
 *    - Linux: ~/.devrelay/bin/devrelay-claude（シンボリックリンク）
 *    - Windows: %APPDATA%\devrelay\bin\devrelay-claude.cmd（バッチファイル）
 * 2. 存在しなければ which/where claude でフォールバック
 *    - 見つかった場合、ラッパーも自動作成（次回以降は高速に）
 * 3. どちらも見つからなければエラー
 *
 * Windows ではシンボリックリンクに管理者権限が必要なため、
 * .cmd バッチファイル（@echo off + claude パス + %*）を使用する。
 *
 * @returns Claude Code の実行パス
 * @throws claude コマンドが見つからない場合
 */
export function resolveClaudePath(): string {
  const isWindows = process.platform === 'win32';
  const devrelayBinDir = getBinDir();
  // Windows: .cmd バッチファイル、Linux: シンボリックリンク
  const wrapperName = isWindows ? 'devrelay-claude.cmd' : 'devrelay-claude';
  const devrelayClaudePath = path.join(devrelayBinDir, wrapperName);

  // ラッパー/シンボリックリンクが存在すればそのまま使用
  if (fs.existsSync(devrelayClaudePath)) {
    return devrelayClaudePath;
  }

  // ラッパーが存在しない → which/where claude でフォールバック
  const findCmd = isWindows ? 'where' : 'which';
  console.log(`⚠️ ${wrapperName} not found, searching for claude...`);

  try {
    const claudePathRaw = execSync(`${findCmd} claude`, { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
    // where コマンドは複数行を返す場合があるため、最初の行を使用
    const claudePath = claudePathRaw.split(/\r?\n/)[0];
    console.log(`✅ Found claude at: ${claudePath}`);

    // ラッパーを自動作成（次回以降は高速に + ps でプロセス識別可能に）
    try {
      fs.mkdirSync(devrelayBinDir, { recursive: true });
      if (isWindows) {
        // Windows: .cmd バッチファイルを作成（管理者権限不要）
        fs.writeFileSync(devrelayClaudePath, `@echo off\r\n"${claudePath}" %*\r\n`);
      } else {
        // Linux: シンボリックリンクを作成
        fs.symlinkSync(claudePath, devrelayClaudePath);
      }
      console.log(`✅ Wrapper created: ${wrapperName} -> ${claudePath}`);
      return devrelayClaudePath;
    } catch (wrapperErr) {
      // ラッパー作成に失敗しても claude 自体は使える
      console.log(`⚠️ Could not create wrapper, using claude directly: ${(wrapperErr as Error).message}`);
      return claudePath;
    }
  } catch {
    throw new Error(
      'Claude Code が見つかりません。以下を確認してください:\n' +
      '  セットアップガイド: https://code.claude.com/docs/ja/setup\n' +
      '  Linux:   curl -fsSL https://claude.ai/install.sh | bash\n' +
      '  Windows: irm https://claude.ai/install.ps1 | iex\n' +
      '  インストール後、Agent を再起動してください'
    );
  }
}
