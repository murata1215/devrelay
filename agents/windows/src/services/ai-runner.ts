import { spawn, ChildProcess, execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { isUnsafeModelId, tChat, DEFAULT_CHAT_LANGUAGE } from '@devrelay/shared';
import type { AiTool, AiUsageData, Language } from '@devrelay/shared';
import type { AgentConfig } from './config.js';
import { parseStreamJsonLine, formatContextUsage, isContextWarning, getContextWarningMessage, type ContextUsage } from './output-parser.js';
import { saveClaudeSessionId, saveContextUsage, loadDevinSessionId, saveDevinSessionId, clearDevinSessionId, loadDevinModel, saveDevinModel, clearDevinModel, loadCodexSessionId, saveCodexSessionId, clearCodexSessionId } from './session-store.js';
import { classifyCliFailure, isWorkspaceTrustError } from './cli-failure.js';
import { buildDevinCapabilityDetail, formatDevinFlagList, isDevinBannerLine, isDevinToolRejectionText } from './devin-diagnostics.js';
import { buildAtifDigest, summarizeAtifEntry, type AtifStepSummary } from './devin-atif.js';
import log from './logger.js';

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
  log.info(`[devin] --export support: ${devinSupportsExport}`);
  return devinSupportsExport;
}

// #308: Codex CLI の `--json`/`resume` 対応可否キャッシュ（`codex exec --help` プローブ結果）。
// null=未判定
let codexCapabilitiesCache: { json: boolean; resume: boolean } | null = null;

/**
 * Codex CLI が `codex exec` の `--json` / `resume` サブコマンドに対応しているか
 * `--help` の出力で判定する（結果はキャッシュ）。
 * @param command codex コマンドのフルパス
 * @returns 対応フラグ（プローブ失敗時は両方 false の安全側に倒す）
 */
function probeCodexCapabilities(command: string): { json: boolean; resume: boolean } {
  if (codexCapabilitiesCache !== null) return codexCapabilitiesCache;
  try {
    const help = execSync(`${command} exec --help`, { encoding: 'utf-8', timeout: 10000 });
    const json = /--json\b/.test(help);
    const resume = /\bresume\b/.test(help);
    codexCapabilitiesCache = { json, resume };
    log.info(`[codex] capabilities: --json=${json}, resume=${resume}`);
  } catch (err) {
    codexCapabilitiesCache = { json: false, resume: false };
    log.warn(`[codex] exec --help probe failed, using minimal flags: ${(err as Error).message}`);
  }
  return codexCapabilitiesCache;
}

// #309: Gemini CLI / Devin CLI の `--model` フラグ対応可否キャッシュ（plan/exec モデル分離用）。
let geminiCapabilitiesCache: { model: boolean } | null = null;

// #344: `ok:false`（probe 失敗）の場合は全フラグ true と楽観的に仮定して cache する（理由は関数 JSDoc 参照）。
// 楽観キャッシュは TTL 付き（devinCapabilitiesFailedAt と併用）で、devin が後から PATH に現れても
// Agent プロセスを再起動しなくても再検出できるようにする。`ok:true`（実際に probe 成功）は無期限キャッシュ。
let devinCapabilitiesCache: {
  model: boolean;
  agentConfig: boolean;
  config: boolean;
  permissionMode: boolean;
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
// #344: probe 失敗（ok:false）の警告はプロセス寿命中 1 回だけ出す（毎ターン繰り返さない）
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
// devin 起動時（`devinMaxSteps > 0`）に1回だけ警告を出す（プロセス寿命中1回、毎ターン繰り返さない）。
let devinMaxStepsWarned = false;

/**
 * Gemini CLI が `-m/--model` フラグに対応しているか `gemini --help` の出力で判定する（結果はキャッシュ）。
 * 失敗時は false に倒し、モデル引数を付けずに CLI デフォルトへ劣化させる。
 * @param command gemini コマンドのフルパス
 * @returns `{ model }` 対応可否
 */
function probeGeminiCapabilities(command: string): { model: boolean } {
  if (geminiCapabilitiesCache !== null) return geminiCapabilitiesCache;
  try {
    const help = execSync(`${command} --help`, { encoding: 'utf-8', timeout: 10000 });
    const model = /-m,?\s*--model\b|--model\b/.test(help);
    geminiCapabilitiesCache = { model };
    log.info(`[gemini] capabilities: --model=${model}`);
  } catch (err) {
    geminiCapabilitiesCache = { model: false };
    log.warn(`[gemini] --help probe failed, disabling --model: ${(err as Error).message}`);
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
    const help = execSync(`${command} --help`, { encoding: 'utf-8', timeout: 10000 });
    const model = /--model\b/.test(help);
    const agentConfig = /--agent-config\b/.test(help);
    // #347: --agent-config は廃止済み（#346）で、後継が --config（グローバル引数、Phase 0 実測で確認済み）。
    const configFlag = /--config\b/.test(help);
    const permissionMode = /--permission-mode\b/.test(help);
    const promptFile = /--prompt-file\b/.test(help);
    const exportFlag = /--export\b/.test(help);
    const respectWorkspaceTrust = /--respect-workspace-trust\b/.test(help);
    let version = 'unknown';
    try {
      // #345: 診断専用の 1 行取得。失敗しても probe 自体（フラグ判定）は失敗させない。
      version = execSync(`${command} --version`, { encoding: 'utf-8', timeout: 10000 }).trim().split('\n')[0] || 'unknown';
    } catch {
      // バージョン取得は診断用のため失敗は無視（version は 'unknown' のまま）
    }
    const helpBytes = help.length;
    // #346: フラグ一覧を先に計算してキャッシュに含める（チャットへの「使えるフラグ」通知に使う）
    const detectedFlags = Array.from(new Set(help.match(/--[a-z][a-z-]*/gi) ?? [])).sort();
    devinCapabilitiesCache = { model, agentConfig, config: configFlag, permissionMode, promptFile, export: exportFlag, respectWorkspaceTrust, version, helpBytes, flags: detectedFlags, ok: true };
    devinCapabilitiesFailedAt = null;
    log.info(`[devin] capabilities: --model=${model} --agent-config=${agentConfig} --config=${configFlag} --permission-mode=${permissionMode} --prompt-file=${promptFile} --export=${exportFlag} --respect-workspace-trust=${respectWorkspaceTrust} version=${version} helpBytes=${helpBytes}`);
    log.info(`[devin] detected flags: ${detectedFlags.join(' ')}`);
    if (!agentConfig && !configFlag && !devinAgentConfigHelpDumped) {
      // #345: --agent-config/--config どちらも「非対応」と判定された場合のみ、H-A/H-B 切り分けのため help 全文を 1 回だけ dump
      devinAgentConfigHelpDumped = true;
      log.info(`[devin] --agent-config/--config not detected, full --help dump:\n${help}`);
    }
  } catch (err) {
    devinCapabilitiesCache = { model: true, agentConfig: true, config: true, permissionMode: true, promptFile: true, export: true, respectWorkspaceTrust: true, version: 'unknown', helpBytes: 0, flags: [], ok: false, reason: (err as Error).message };
    devinCapabilitiesFailedAt = Date.now();
    log.warn(`[devin] --help probe failed, assuming all flags supported (optimistic, TTL applies): ${(err as Error).message}`);
  }
  return devinCapabilitiesCache;
}

/**
 * #309: モデル ID の二重サニタイズ（server 側で既に検証済みだが、MCP 等 server を経由しない
 * 将来の呼び出し経路への保険として Agent 側でも検証する）。
 * 引用符・空白・セミコロン・ドルサイン・バッククォート・改行を含む値は危険とみなし無視する。
 * @param model 未検証のモデル ID（未指定なら undefined）
 * @returns 安全なモデル ID、または undefined（未指定 or 危険な値）
 */
function safeModelArg(model: string | undefined): string | undefined {
  if (!model) return undefined;
  if (isUnsafeModelId(model)) {
    log.warn(`危険な文字を含むモデル ID を無視: ${JSON.stringify(model)}`);
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
 * Devin モデル選択サイクル・サイクル B（変更4/変更5）: `devin-atif.ts` の `summarizeAtifEntry()`
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
    log.info(`[devin] ATIF parsed 0 steps; head sample: ${content.slice(0, 500)}`);
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

export interface AiRunResult {
  extractedSessionId?: string;
  contextUsage?: ContextUsage;
  resumeFailed?: boolean;  // True if --resume failed (exit code 1 + no output)
  /** Claude Code result メッセージから抽出した使用量データ */
  usageData?: AiUsageData;
}

// Active AI sessions: sessionId -> AiSession
const activeSessions = new Map<string, AiSession>();

/** AI出力コールバック。isComplete=true の場合、usageData に使用量データが含まれる */
type OutputCallback = (output: string, isComplete: boolean, usageData?: AiUsageData) => void;

/**
 * Find the full path to claude command on Windows
 */
function findClaudePath(): string | null {
  try {
    // Use 'where' command on Windows to find claude
    const result = execSync('where claude', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    const paths = result.trim().split('\r\n');
    // Return the first found path (usually claude.cmd or claude.exe)
    return paths[0] || null;
  } catch {
    return null;
  }
}

export async function startAiSession(
  sessionId: string,
  projectPath: string,
  aiTool: AiTool,
  config: AgentConfig,
  onOutput: OutputCallback
): Promise<void> {
  // Check if session already exists
  if (activeSessions.has(sessionId)) {
    throw new Error(`Session already exists: ${sessionId}`);
  }

  // Get AI tool command
  const command = getAiCommand(aiTool, config);
  if (!command) {
    throw new Error(`AI tool not configured: ${aiTool}`);
  }

  log.info(`Starting session for ${aiTool} in ${projectPath}`);

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

export interface SendPromptOptions {
  /** Claude session ID to resume (from previous execution) */
  resumeSessionId?: string;
  /** Use plan mode (--permission-mode plan) instead of skip-permissions */
  usePlanMode?: boolean;
  /** プランモード中に許可する読み取り専用ツール（--allowedTools） */
  allowedTools?: string[];
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
   * AI モデル指定（#309: claude/codex/gemini/devin 共通）。`l` コマンド／Settings で設定される。
   * claude: `--model` で渡す（例: 'sonnet', 'opus'）
   * codex: `-c model="..."` で渡す（例: 'gpt-5.5'）
   * gemini: `-m` で渡す（例: 'gemini-3.1-pro'）
   * devin: `--model` で渡す（fuzzy 名可、例: 'opus'）
   * 未指定なら各 CLI のデフォルト
   */
  model?: string;
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
  log.info(`Sending prompt to ${aiTool}: ${prompt.substring(0, 50)}...`);

  // #316: チャット表示言語が 'en' の場合のみ、AI への指示文言語（日本語のまま）はそのままに
  // 「ユーザーへの返答は英語で」という指示を末尾に追加する。
  // 'ja'（既定）の場合は何も付与せず、既存挙動を完全に維持する（回帰リスクを避けるため）。
  if (options.language === 'en') {
    prompt = `${prompt}\n\n---\nIMPORTANT: Respond to the user in English from now on, regardless of the language used in any instructions above.`;
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
  // #281: 完了時に ATIF から作る「実行ステップまとめ」。最終回答の末尾に添付する。
  let devinStepSummary = '';
  // Devin モデル選択サイクル・サイクル B（変更5）: ATIF から読み取った実モデル名（close ハンドラで代入）。
  // devinCurrentModelForResume と同じ理由で関数スコープの let（block 内 const にすると
  // close ハンドラから参照できず TS2304 になる、サイクル A の S0 で踏んだ落とし穴）。
  let devinAtifModelName: string | null = null;
  let devinAtifModelId: string | null = null;
  // #282: CHISEL_LOG_STDERR=1 で stderr に流れる devin 内部ログの分類用
  let devinToolRejectedInLog = false;   // ログ形式で検出したツール拒否（#274 検出の置き換え）
  let devinStderrLineBuffer = '';       // stderr の行バッファ（改行区切り処理の残り）
  let devinLastLogLevel = '';           // 継続行（"Caused by:" 等）の帰属判定用
  const devinLogReported = new Map<string, number>(); // 同一メッセージ10秒スロットル
  // #308: Codex 用の関数スコープ状態（resume 空振り検出・進捗表示・turn.failed 検出用）
  let codexResumedThreadId: string | null = null; // resume 起動時に渡した thread_id（空振り検出用）
  let codexThreadId: string | null = null;          // thread.started で取得した現在のスレッド ID
  let codexHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  const codexProgressReported = new Map<string, number>(); // 同一進捗メッセージ10秒スロットル
  let codexTurnFailed = false;
  let codexTurnFailedMessage = '';

  if (aiTool === 'claude') {
    // On Windows, use claude directly (claude.cmd will be found in PATH)
    const claudePath = findClaudePath() || 'claude';
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose'
    ];

    // Add permission mode based on options
    if (options.usePlanMode) {
      args.push('--permission-mode', 'plan');
      // #303: ExitPlanMode はプランモードの正規の脱出ハッチ。対話版 CLI なら人間が確認するが、
      // -p（非対話）でモデルが自発的に呼ぶと確認なしで通ってしまうケースがあるため、
      // ツール自体を CLI レベルで除去する（mimamori-server 2026-08-15 の事故対策、SDK 版と同一方針）。
      args.push('--disallowedTools', 'ExitPlanMode');
      // プランモードで読み取り専用コマンドを許可（カンマ区切りで1つの --allowedTools に渡す）
      if (options.allowedTools && options.allowedTools.length > 0) {
        args.push('--allowedTools', options.allowedTools.join(','));
        log.info(`Using plan mode with ${options.allowedTools.length} allowed tools`);
      } else {
        log.info(`Using plan mode (--permission-mode plan)`);
      }
    } else {
      args.push('--dangerously-skip-permissions');
      log.info(`Using exec mode (--dangerously-skip-permissions)`);
    }

    // Add resume option if we have a previous session ID
    if (options.resumeSessionId) {
      args.push('--resume', options.resumeSessionId);
      log.info(`Resuming session: ${options.resumeSessionId.substring(0, 8)}...`);
    }

    // #309: plan/exec モデル分離（Windows は従来 CLI 直起動のみで model 未配線だった欠落分を追加）
    const claudeModel = safeModelArg(options.model);
    if (claudeModel) {
      args.push('--model', claudeModel);
    }

    log.info(`Running: ${claudePath} ${args.join(' ')}`);

    // プロキシ環境変数を追加（自動起動時には process.env に含まれていないことがある）
    const proxyEnv: Record<string, string> = {};
    if (config.proxy?.url) {
      proxyEnv.HTTP_PROXY = config.proxy.url;
      proxyEnv.HTTPS_PROXY = config.proxy.url;
      proxyEnv.http_proxy = config.proxy.url;
      proxyEnv.https_proxy = config.proxy.url;
      log.info(`Setting proxy env for Claude: ${config.proxy.url}`);
    }

    proc = spawn(claudePath, args, {
      cwd: projectPath,
      shell: true,  // Windows needs shell: true to execute .cmd files (claude.cmd)
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...proxyEnv,
        DEVRELAY: '1',
        DEVRELAY_SESSION_ID: sessionId,
        DEVRELAY_PROJECT: projectPath,
      },
    });

    // Write prompt to stdin (secure - not visible in process list)
    proc.stdin?.write(prompt);
    proc.stdin?.end();
  } else if (aiTool === 'gemini') {
    // Gemini CLI with auto_edit approval mode
    // Use stdin to pass prompt (same as Claude) to avoid shell interpretation issues
    const args = ['--approval-mode', 'auto_edit'];
    // #309: plan/exec モデル分離。旧 CLI で `--model` 非対応の場合は引数を付けずデフォルトへ劣化させる。
    const geminiCaps = probeGeminiCapabilities(command);
    const geminiModel = safeModelArg(options.model);
    if (geminiModel && geminiCaps.model) {
      args.push('-m', geminiModel);
    }
    log.info(`Running: ${command} ${args.join(' ')} (prompt via stdin)`);

    // Extract directory from gemini command path and add to PATH
    // This ensures node can be found when running as a Windows service
    // #344: command がベース名のみ（例: 'gemini'）だと dirname が '.' になり、
    // プロジェクトの cwd が PATH の先頭に積まれる（PATH 汚染）ため、'.' の場合は追加しない。
    const geminiDir = path.dirname(command);
    const envPath = geminiDir === '.'
      ? (process.env.PATH ?? geminiDir)
      : (process.env.PATH ? `${geminiDir};${process.env.PATH}` : geminiDir);

    // プロキシ環境変数を追加（Gemini 用）
    const geminiProxyEnv: Record<string, string> = {};
    if (config.proxy?.url) {
      geminiProxyEnv.HTTP_PROXY = config.proxy.url;
      geminiProxyEnv.HTTPS_PROXY = config.proxy.url;
      geminiProxyEnv.http_proxy = config.proxy.url;
      geminiProxyEnv.https_proxy = config.proxy.url;
    }

    proc = spawn(command, args, {
      cwd: projectPath,
      shell: true,  // Windows needs shell: true for .cmd files
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...geminiProxyEnv,
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
    const devinHasRespectWorkspaceTrust = devinCaps.respectWorkspaceTrust && !devinDropped.has('--respect-workspace-trust');
    // #329/#344: 読み取り専用強制がプロンプト指示のみに劣化した場合、静かなフォールバック禁止の方針に従い1行警告する
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
        log.info(`Resuming Devin session: ${devinSessionId}`);
      } else {
        log.info(`[devin] Model changed (${devinSavedModel || '(default)'} → ${devinCurrentModelForResume || '(default)'}), starting a new session instead of resuming ${devinSessionId}`);
        onOutput(`${tChat(options.language ?? DEFAULT_CHAT_LANGUAGE, 'devin.modelChangedNewSession', { previousModel: devinSavedModel || '(default)', newModel: devinCurrentModelForResume || '(default)' })}\n`, false);
      }
    }

    if (options.usePlanMode && !options.devinAutoPermFallback && (devinHasConfig || devinHasAgentConfig)) {
      // #347: プランモードの読み取り専用は Devin の config ファイルで強制する。
      // --agent-config は新しい Devin CLI で廃止されたため（#346 で確定）、
      // 現行の --config <PATH> に置き換える。deny は allow より常に優先されるため
      // （docs.devin.ai/cli/reference/permissions）、Write/Exec は確実にブロックされる。
      // 一時ファイルは os.tmpdir() に置く（プロジェクトディレクトリを汚さない）。
      // #347 Phase 0 実測: devin は --config のファイルを「セットアップ状態の保存先」とみなし、
      // shell.setup_complete が無いと毎回 Welcome バナーを stdout に出す（fullOutput を汚染し
      // #274/#329 の「出力ゼロ」安全網を無効化する）。既定値を先に書いておいてバナー自体を抑止する
      // （推論なので isDevinBannerLine() によるフィルタとセットで運用する。下記プレーンテキスト出力箇所）。
      // #347 Phase 0 実測: devin はこのファイルを書き換える（実測では merge/replace 双方を観測）。
      // DevRelay は毎ターンここで作り直し、close ハンドラで削除するため、書き換えられても持ち越さない。
      const planConfig = {
        version: 1,
        shell: { setup_complete: true },
        permissions: {
          allow: ['Read(**)'],
          deny: ['Write(**)', 'Exec(**)'],
        },
      };
      const planConfigPath = path.join(os.tmpdir(), `devrelay-devin-plan-config-${sessionId}.json`);
      fs.writeFileSync(planConfigPath, JSON.stringify(planConfig), 'utf-8');
      const configFlagName = devinHasConfig ? '--config' : '--agent-config';
      args.push('-p', configFlagName, planConfigPath);
      devinPlanConfigApplied = true;
      log.info(`Devin plan mode: using ${configFlagName} (Read only, Write/Exec denied)`);
    } else if (options.usePlanMode && !options.devinAutoPermFallback && devinHasPermissionMode) {
      // #329: --config/--agent-config 非対応の CLI → --permission-mode auto に劣化（読み取り専用強制はプロンプト指示のみ）
      args.push('-p', '--permission-mode', 'auto');
      devinDegradedReason = 'planReadonly';
      log.info(`Devin plan mode: --config/--agent-config unsupported, degraded to --permission-mode auto (readonly not enforced)`);
    } else if (options.usePlanMode && !options.devinAutoPermFallback) {
      // #329: --config/--agent-config も --permission-mode も非対応 → -p のみ（最小フラグ、読み取り専用強制はプロンプト指示のみ）
      args.push('-p');
      devinDegradedReason = 'planReadonly';
      log.info(`Devin plan mode: --config/--agent-config/--permission-mode all unsupported, running with -p only (readonly not enforced)`);
    } else if (options.usePlanMode && options.devinAutoPermFallback) {
      // plan フォールバック（#274）: agent-config の deny で Devin がツール拒否→出力ゼロになる問題の回避。
      // agent-config を渡さず --permission-mode auto（安全ツールのみ自動承認）で実行する。
      // 厳密読み取り専用は緩むが「プラン不能」よりまし。書き換え抑止はプロンプト側の指示に委ねる。
      if (devinHasPermissionMode) {
        args.push('-p', '--permission-mode', 'auto');
        log.info(`Devin plan mode fallback: using --permission-mode auto (agent-config skipped)`);
      } else {
        args.push('-p');
        log.info(`Devin plan mode fallback: --permission-mode unsupported, running with -p only`);
      }
    } else {
      // exec モード: 全ツール自動承認
      if (devinHasPermissionMode) {
        args.push('-p', '--permission-mode', 'dangerous');
      } else {
        // #329: --permission-mode 非対応の旧 CLI → -p のみ（劣化通知）
        args.push('-p');
        devinDegradedReason = 'execPermission';
        log.info(`Devin exec mode: --permission-mode unsupported, running with -p only`);
      }
    }

    // #276: 途中経過表示。対応版なら --export で ATIF をファイル書き出しさせ、後段でポーリングして進捗を出す。
    // stdout ではなく別ファイルへ出るため、最終保存メッセージ（responseText）を汚染しない。
    if (probeDevinExportSupport(command)) {
      devinExportPath = path.join(os.tmpdir(), `devrelay-devin-export-${sessionId}.jsonl`);
      args.push('--export', devinExportPath);
      log.info(`Devin --export enabled: ${devinExportPath}`);
    }

    // #309: plan/exec モデル分離。旧 CLI で `--model` 非対応の場合は引数を付けずデフォルトへ劣化させる。
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

    // #344: 位置引数（`-- <prompt>`）フォールバックは Node の shell:true が引数をクォートしないため
    // シェルコマンド注入経路になっていた（DevRelay は毎回 ~170 行の Agreement/plan 指示をプロンプトに
    // 前置しており `\n\n` やバッククォートを含む）。安全性のため削除し、常に --prompt-file を使う。
    // Devin は stdin パイプ非対応（panic at repl_mode.rs）のため --prompt-file が唯一の安全な経路。
    let promptFilePath: string | null = null;
    if (devinHasPromptFile) {
      promptFilePath = path.join(os.tmpdir(), `devrelay-prompt-${sessionId}.txt`);
      fs.writeFileSync(promptFilePath, prompt, 'utf-8');
      args.push('--prompt-file', promptFilePath);
    } else {
      log.error(`[devin] --prompt-file unsupported, aborting (unsafe argv fallback removed in #344)`);
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

    log.info(`Running: ${command} ${args.join(' ').replace(promptFilePath, '...')}`);

    // Devin コマンドのディレクトリを PATH に追加
    // #344: command がベース名のみ（例: 'devin'）だと dirname が '.' になり、
    // プロジェクトの cwd が PATH の先頭に積まれる（PATH 汚染）ため、'.' の場合は追加しない。
    const devinDir = path.dirname(command);
    const devinEnvPath = devinDir === '.'
      ? (process.env.PATH ?? devinDir)
      : (process.env.PATH ? `${devinDir};${process.env.PATH}` : devinDir);

    // プロキシ環境変数を追加（Devin 用）
    const devinProxyEnv: Record<string, string> = {};
    if (config.proxy?.url) {
      devinProxyEnv.HTTP_PROXY = config.proxy.url;
      devinProxyEnv.HTTPS_PROXY = config.proxy.url;
      devinProxyEnv.http_proxy = config.proxy.url;
      devinProxyEnv.https_proxy = config.proxy.url;
    }

    proc = spawn(command, args, {
      cwd: projectPath,
      shell: true,  // Windows needs shell: true for .cmd files
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...devinProxyEnv,
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
    // （約8191文字）で確実に壊れるため、gemini/devin と同じ stdin 方式を使う。
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

    // #309: plan/exec モデル分離。`resume` に `-m` が無いため `-c model="..."` を使い新規/resume で共通化する。
    const codexModel = safeModelArg(options.model);
    if (codexModel) {
      args.push('-c', `model="${codexModel}"`);
    }

    // 保存済み thread_id があれば resume で継続（フラグを全部書いた"後"に置く必要がある）
    const codexThreadIdToResume = caps.resume ? await loadCodexSessionId(projectPath) : null;
    if (codexThreadIdToResume) {
      args.push('resume', codexThreadIdToResume);
      codexResumedThreadId = codexThreadIdToResume;
      log.info(`Resuming Codex thread: ${codexThreadIdToResume}`);
    }
    args.push('-'); // プロンプトは stdin から読む（必ず最後の引数）

    log.info(`Running: ${command} ${args.join(' ')}`);

    // Codex コマンドのディレクトリを PATH に追加（gemini/devin と同様）
    const codexDir = path.dirname(command);
    const codexEnvPath = process.env.PATH ? `${codexDir};${process.env.PATH}` : codexDir;

    // プロキシ環境変数を追加（Codex 用）
    const codexProxyEnv: Record<string, string> = {};
    if (config.proxy?.url) {
      codexProxyEnv.HTTP_PROXY = config.proxy.url;
      codexProxyEnv.HTTPS_PROXY = config.proxy.url;
      codexProxyEnv.http_proxy = config.proxy.url;
      codexProxyEnv.https_proxy = config.proxy.url;
    }

    // npm がグローバルインストールする codex は Windows では `codex.cmd` シムになるため、
    // Node の spawn は shell 経由でないとバッチファイルを直接実行できない（gemini/devin と同じ既存方針）。
    proc = spawn(command, args, {
      cwd: projectPath,
      shell: true,  // Windows needs shell: true for .cmd files
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...codexProxyEnv,
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
    const escapedPrompt = prompt.replace(/"/g, '\\"');
    const fullCommand = `${command} "${escapedPrompt}"`;

    log.info(`Running: ${fullCommand.substring(0, 100)}...`);

    proc = spawn(fullCommand, [], {
      cwd: projectPath,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
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
        log.info(`[devin] Runtime limit ${devinMaxRuntimeMin}min reached, killing process (cost guard)`);
        devinRuntimeLimitHit = true;
        proc.kill('SIGTERM');
      }, devinMaxRuntimeMin * 60_000);
    }

    // Devin モデル選択サイクル・サイクル B（変更4）: `maxSteps` は ATIF 経由では原理的に
    // 機能しない（ATIF はターン終了時に一括書き出しされるため、書き込み途中のファイルは
    // parse に成功せずポーラーは毎回 null を返す）。有効時は 1 回だけ警告し、
    // 実効的なコストガードとして `maxRuntimeMinutes` を使うよう案内する（#325 静かなフォールバック禁止）。
    if (devinMaxSteps > 0 && !devinMaxStepsWarned) {
      devinMaxStepsWarned = true;
      log.info(`[devin] maxSteps is not enforceable with ATIF export (written at turn end).`);
      log.info(`        Use maxRuntimeMinutes (current: ${devinMaxRuntimeMin}) as the effective cost guard.`);
    }

    // #281: プロジェクトディレクトリのファイル変更を監視して「内部で何をしているか」を進捗表示する。
    // devin は -p 実行中 stdout 無出力 + ATIF は turn 終了時一括書き出しのため、
    // ファイル操作の監視がライブで内部動作を見せる唯一の手段。⏳ prefix で最終回答からは除外される。
    try {
      devinFsWatcher = fs.watch(projectPath, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const f = filename.toString().replace(/\\/g, '/');
        // 除外: VCS・依存・生成物・一時ファイル（devin 自身の作業に無関係なノイズを弾く）
        if (/(^|\/)(\.git|node_modules|\.devrelay|\.devrelay-output|dist|build|__pycache__|\.next|target|vendor)(\/|$)/.test(f)) return;
        if (/~$|\.swp$|\.tmp$|\.log$|\.lock$/.test(f)) return;
        const now = Date.now();
        // 同一ファイルは10秒に1回まで（保存の連打でスパムにならないように）
        if (now - (devinReportedFiles.get(f) ?? 0) < 10_000) return;
        devinReportedFiles.set(f, now);
        onOutput(`⏳ 📝 ${f} を更新中...\n`, false);
      });
    } catch (err) {
      // recursive fs.watch 非対応環境は黙ってスキップ（Windows はネイティブ対応だが保険）
      log.warn(`[devin] fs.watch unavailable, file activity display disabled: ${(err as Error).message}`);
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
                    log.info(`[devin] Step limit ${devinMaxSteps} exceeded, killing process (cost guard)`);
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
          log.warn(`[devin] export poll error: ${(err as Error).message}`);
        }
      }, 3_000);
    }
  }

  // #308: Codex は長考中に JSONL イベントが途切れることがあるため、devin と同じ 30 秒ハートビートを送る
  // （サーバー側 5 分無出力タイムアウトの誤爆防止 + 進捗ボックスの生存表示）。
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

  return new Promise<AiRunResult>((resolve) => {
    proc.stdout?.on('data', (data) => {
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
                log.info(`[codex] Thread ID: ${threadId}`);
                saveCodexSessionId(projectPath, threadId).catch(err => {
                  log.error(`Failed to save Codex session ID: ${err}`);
                });
              }
              break;
            }
            case 'item.completed': {
              const item = codexJson.item;
              if (!item) break;
              if (item.type === 'agent_message' && item.text) {
                fullOutput += item.text;
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
                log.info(`[codex] Usage captured: input=${mappedUsage.input_tokens}, output=${mappedUsage.output_tokens}, cached=${mappedUsage.cache_read_input_tokens}`);
              }
              break;
            }
            case 'turn.failed': {
              codexTurnFailed = true;
              codexTurnFailedMessage = codexJson.error?.message || 'unknown error';
              log.error(`[codex] turn.failed: ${codexTurnFailedMessage}`);
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
            log.info(`[${aiTool}] Raw usage: input_tokens=${json.usage.input_tokens}, cache_read=${json.usage.cache_read_input_tokens}, cache_creation=${json.usage.cache_creation_input_tokens}`);
          }
          if (parsed.sessionId) {
            result.extractedSessionId = parsed.sessionId;
            log.info(`[${aiTool}] Session ID: ${parsed.sessionId.substring(0, 8)}...`);
            // Save session ID for future resumption
            saveClaudeSessionId(projectPath, parsed.sessionId).catch(err => {
              log.error(`Failed to save session ID:`, err);
            });
          }
          if (parsed.contextUsage) {
            result.contextUsage = parsed.contextUsage;
            log.info(`[${aiTool}] ${formatContextUsage(parsed.contextUsage)}`);
            // Save context usage for display at start of next prompt
            saveContextUsage(projectPath, parsed.contextUsage).catch(err => {
              log.error(`Failed to save context usage:`, err);
            });
          }
          // usageData をそのまま保存（DB 格納用）
          if (parsed.usageData) {
            result.usageData = parsed.usageData;
            log.info(`[${aiTool}] Usage data captured: duration=${parsed.usageData.durationMs}ms, models=${Object.keys(parsed.usageData.modelUsage || {}).join(', ')}`);
          }

          // Extract text from assistant messages (new format)
          if (json.type === 'assistant' && json.message?.content) {
            for (const block of json.message.content) {
              if (block.type === 'text' && block.text) {
                // "Prompt is too long" が通常の応答テキストとして出力される場合を検出
                // ストリーミングせず、close ハンドラで日本語警告に変換する
                if (block.text.trim() === 'Prompt is too long') {
                  log.info(`[${aiTool}] ⚠️ "Prompt is too long" detected in stdout, suppressing`);
                  promptTooLong = true;
                  continue;
                }
                // Claude Code 未ログイン検出（Devin 専用マシン等で claude 未ログインのまま呼ばれた場合）
                if (/^not logged in.*please run \/login/i.test(block.text.trim())) {
                  log.info(`[${aiTool}] 🔑 Claude Code is not logged in`);
                  onOutput(
                    '⚠️ Claude Code が未ログインです。\n' +
                    '対象マシンで `claude` を起動してログインするか、`a` コマンドで別の AI ツール（devin 等）に切り替えてください。',
                    false
                  );
                  continue;
                }
                fullOutput += block.text;
                log.info(`[${aiTool}] +${block.text.length} chars`);
                onOutput(block.text, false);
              } else if (block.type === 'tool_use' && block.name) {
                log.info(`[${aiTool}] 🔧 Using tool: ${block.name}`);
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
            log.info(`[${aiTool}] +${deltaText.length} chars`);
            onOutput(deltaText, false);
          }
          // Also capture tool use for visibility (legacy format)
          else if (json.type === 'stream_event' &&
                   json.event?.type === 'content_block_start' &&
                   json.event?.content_block?.type === 'tool_use') {
            const toolName = json.event.content_block.name;
            log.info(`[${aiTool}] 🔧 Using tool: ${toolName}`);
            onOutput(`\n${tChat(options.language ?? DEFAULT_CHAT_LANGUAGE, 'progress.usingTool', { tool: toolName })}\n`, false);
          }
          // Capture result for final output
          else if (json.type === 'result') {
            log.info(`[${aiTool}] ✅ Complete (${json.duration_ms}ms)`);
          }
        } catch {
          // JSON パース失敗 → プレーンテキスト出力（Devin/Gemini/Aider/Codex）
          const trimmed = line.trim();
          // #347: devin の初回起動バナー（--config に shell.setup_complete が無いと出る）は
          // AI の回答ではないため fullOutput に積まない（#274/#329の「出力ゼロ」安全網を守るため）
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
          log.error(`[devin] stderr: ${line}`);
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
        log.info(`[devin] 🔒 tool rejection detected in log: ${message}`);
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
        log.error(`[${aiTool}] stderr: ${text}`);
        return;
      }
      // #282: devin は CHISEL_LOG_STDERR=1 で内部ログが stderr に流れる → 行単位で分類
      devinStderrLineBuffer += text;
      const lines = devinStderrLineBuffer.split('\n');
      devinStderrLineBuffer = lines.pop() ?? '';
      for (const line of lines) classifyDevinStderrLine(line);
    });

    proc.on('close', (code, signal) => {
      log.info(`[${aiTool}] Process exited with code ${code}, signal ${signal}`);

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
            if (digest.usage) {
              const modelKey = digest.modelId ?? digest.modelName ?? 'devin';
              result.usageData = {
                usage: { ...digest.usage },
                modelUsage: { [modelKey]: { ...digest.usage } },
                model: modelKey,
              };
            }
            if (digest.permissionMode) {
              // permission_mode はチャットには出さずログのみ（診断用）
              log.info(`[devin] permission_mode=${digest.permissionMode}`);
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
      if (aiTool !== 'codex' && lineBuffer.trim()) {
        const leftover = lineBuffer.trim();
        lineBuffer = '';
        let isJsonMeta = false;
        try { JSON.parse(leftover); isJsonMeta = true; } catch {}
        if (!isJsonMeta) {
          log.info(`[${aiTool}] 📦 Flushing ${leftover.length} chars from line buffer at close`);
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
        try {
          if (!devinOutputEmpty) {
          const listOutput = execSync(`${command} list --format json`, {
            cwd: projectPath, encoding: 'utf-8', timeout: 10000,
          });
          const sessions = JSON.parse(listOutput);
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
          log.warn(`[devin] Could not retrieve session ID: ${(err as Error).message}`);
        }
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
        log.info(`[devin] Stopped by ${reason}`);
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
        log.info(`[${aiTool}] Process was cancelled`);
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
          log.info(`[devin] Unknown flag '${droppedFlag}' rejected by CLI (code ${code}), retrying without it`);
          completionSent = true;
          onOutput(`${tChat(lang, 'devin.unknownFlagRetry', { flag: droppedFlag })}\n`, false);
          const fallbackOptions: SendPromptOptions = {
            ...options,
            devinDroppedFlags: [...alreadyDropped, droppedFlag],
          };
          sendPromptToAi(sessionId, prompt, projectPath, aiTool, claudeSessionId, config, onOutput, fallbackOptions)
            .then((fallbackResult) => resolve(fallbackResult))
            .catch((err) => {
              log.error(`[devin] unknown-flag retry failed: ${(err as Error).message}`);
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
        log.info(`[devin] ⚠️ Devin plan config rejected a tool (code ${code}), falling back to --permission-mode auto`);
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
              log.error(`[devin] fallback retry failed: ${(err as Error).message}`);
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
        log.info(`[devin] ⚠️ Resumed session produced no output (code ${code}), clearing session ID and retrying fresh`);
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
        log.info(`[codex] Resumed thread produced no output (code ${code}), clearing session ID and retrying fresh`);
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
        log.info(`[${aiTool}] ⚠️ Prompt too long error detected (stdout=${promptTooLong}, stderr=${stderrOutput.includes('Prompt is too long')})`);
        if (options.resumeSessionId) {
          // --resume でセッションが長すぎる → retry に任せる（新規セッションで再試行）
          log.info(`[${aiTool}] ⚠️ --resume session too long, flagging for retry without session ID`);
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
        log.info(`[${aiTool}] ⚠️ --resume failed, flagging for retry without session ID`);
        result.resumeFailed = true;
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
          onOutput('', true, result.usageData); // Signal completion with usage data
        }
      }
      resolve(result);
    });

    proc.on('error', (err) => {
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
      log.error(`[${aiTool}] Process error:`, err);
      if (!completionSent) {
        completionSent = true;
        onOutput(`Error: ${err.message}`, true);
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

  log.info(`Stopping AI session: ${sessionId}`);
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
  const session = activeSessions.get(sessionId);
  if (!session || !session.process || session.process.exitCode !== null) {
    return false;
  }

  log.info(`Cancelling AI session: ${sessionId}`);
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
