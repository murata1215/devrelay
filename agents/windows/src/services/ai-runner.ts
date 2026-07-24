import { spawn, ChildProcess, execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import type { AiTool, AiUsageData } from '@devrelay/shared';
import type { AgentConfig } from './config.js';
import { parseStreamJsonLine, formatContextUsage, isContextWarning, getContextWarningMessage, type ContextUsage } from './output-parser.js';
import { saveClaudeSessionId, saveContextUsage, loadDevinSessionId, saveDevinSessionId, clearDevinSessionId } from './session-store.js';
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
  if (devinSupportsExport !== null) return devinSupportsExport;
  try {
    const help = execSync(`${command} --help`, { encoding: 'utf-8', timeout: 10000 });
    devinSupportsExport = /--export\b/.test(help);
    log.info(`[devin] --export support: ${devinSupportsExport}`);
  } catch (err) {
    devinSupportsExport = false;
    log.warn(`[devin] --help probe failed, disabling --export: ${(err as Error).message}`);
  }
  return devinSupportsExport;
}

/**
 * ATIF（Devin の --export）1行を人間可読な短い進捗要約に変換する。
 * ATIF スキーマは非公開のためベストエフォート。認識できるフィールドがなければ null を返す（進捗を出さない）。
 * @param entry JSON.parse 済みの ATIF 1エントリ
 * @returns 「⏳ ...」形式で表示する要約（先頭の ⏳ は呼び出し側で付与）／認識不能なら null
 */
function summarizeAtifEntry(entry: any): string | null {
  if (!entry || typeof entry !== 'object') return null;
  const toolName = entry.tool_name || entry.tool || entry.name;
  if (toolName) {
    const title = entry.title || entry.command || entry.action;
    return title ? `${toolName}: ${String(title).slice(0, 80)}` : `${toolName} を実行中`;
  }
  if (entry.title) return String(entry.title).slice(0, 100);
  if (entry.type && typeof entry.type === 'string') return `[${entry.type}]`;
  return null;
}

/**
 * #281: ATIF エクスポートファイル全体を読み、実行ステップの要約文字列を作る。
 * devin は turn 終了時に ATIF を一括書き出しする（「Exports after each turn」）ため、
 * 実行中の live tail はゼロ件になる。そこで完了時にまとめて読み、最終回答の末尾へ
 * 「🧭 実行ステップ (N件): ...」として添付し、「何をやったか」を可視化する。
 * JSONL（1行1エントリ）を基本とし、単一 JSON（配列/オブジェクト）もフォールバックでパースする。
 * @param exportPath ATIF ファイルパス
 * @returns 「\n\n🧭 実行ステップ ...」形式。ステップ0件なら空文字列
 */
function buildDevinStepSummary(exportPath: string): string {
  let content: string;
  try {
    content = fs.readFileSync(exportPath, 'utf-8');
  } catch {
    return '';
  }
  const steps: string[] = [];
  // まず JSONL（1行1エントリ）として行ごとにパース
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const s = summarizeAtifEntry(JSON.parse(trimmed));
      if (s) steps.push(s);
    } catch {
      // 行パース失敗は無視（後段の単一 JSON フォールバックに委ねる）
    }
  }
  // JSONL で1件も取れなければ、全体を単一 JSON（配列 / {messages:[]} / 単一オブジェクト）としてパース
  if (steps.length === 0) {
    try {
      const parsed = JSON.parse(content);
      const entries = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.messages)
          ? parsed.messages
          : [parsed];
      for (const e of entries) {
        const s = summarizeAtifEntry(e);
        if (s) steps.push(s);
      }
    } catch {
      // 単一 JSON でもない
    }
  }
  if (steps.length === 0) {
    // スキーマ不一致の可能性 → 先頭を記録（原因 (c) の切り分け・v2 パーサ修正用）
    log.info(`[devin] ATIF parsed 0 steps; head sample: ${content.slice(0, 500)}`);
    return '';
  }
  const shown = steps.slice(0, 10);
  const more = steps.length > shown.length ? `（他${steps.length - shown.length}件）` : '';
  return `\n\n🧭 実行ステップ (${steps.length}件): ${shown.join(' → ')}${more}\n`;
}

/**
 * #282: devin の toolbox ログ（CHISEL_LOG_STDERR=1 で stderr に流れる内部ログ）を
 * 日本語の進捗表示に変換する。既知パターンは日本語、未知パターンは原文（英語）のまま返す。
 * devin バイナリのログ文字列は英語ハードコードのためプロンプトでは変えられず、Agent 側で変換する。
 */
function formatDevinToolLog(toolName: string, message: string): string {
  // write: "Writing to file: <path>"（実機サンプルで書式確認済み）
  let m = message.match(/^Writing to file:\s*(.+)$/i);
  if (m) return `📝 ${m[1]} に書き込み中...`;
  // read 系: "Reading file: <path>" 等（実ログ未確認のため広めにマッチ）
  m = message.match(/^Reading(?: file)?:?\s*(.+)$/i);
  if (m) return `📖 ${m[1]} を読み込み中...`;
  // exec 系: "Executing command: <cmd>" / "Running: <cmd>" 等
  m = message.match(/^(?:Executing(?: command)?|Running):?\s*(.+)$/i);
  if (m) return `💻 コマンド実行中: ${m[1]}`;
  // 未知パターン: 原文のまま（英語）。実ログを見て変換表を拡充する（v3）
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

  const command = getAiCommand(aiTool, config);
  if (!command) {
    onOutput(`Error: AI tool not configured: ${aiTool}`, true);
    return {};
  }

  const result: AiRunResult = {};
  let proc;
  // Devin: -r で resume したセッション ID を関数スコープで記録（close ハンドラから参照して空振り検出に使う）
  let devinResumedSessionId: string | null = null;
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
  // #282: CHISEL_LOG_STDERR=1 で stderr に流れる devin 内部ログの分類用
  let devinToolRejectedInLog = false;   // ログ形式で検出したツール拒否（#274 検出の置き換え）
  let devinStderrLineBuffer = '';       // stderr の行バッファ（改行区切り処理の残り）
  let devinLastLogLevel = '';           // 継続行（"Caused by:" 等）の帰属判定用
  const devinLogReported = new Map<string, number>(); // 同一メッセージ10秒スロットル

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
    log.info(`Running: ${command} --approval-mode auto_edit (prompt via stdin)`);

    // Extract directory from gemini command path and add to PATH
    // This ensures node can be found when running as a Windows service
    const geminiDir = path.dirname(command);
    const envPath = process.env.PATH ? `${geminiDir};${process.env.PATH}` : geminiDir;

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
    const args: string[] = [];

    // 保存済み Devin セッション ID があれば -r で resume
    // ただし exec モードでは新規セッションを開始する（--permission-mode dangerous を
    // CLI で指定しても、resume したセッションは元の auto モードを保持して
    // 書き込みが拒否されるため）
    // フォールバック時（#274）は resume しない（壊れたセッション回避）
    const devinSessionId = options.usePlanMode && !options.devinAutoPermFallback
      ? await loadDevinSessionId(projectPath)
      : null;
    if (devinSessionId) {
      args.push('-r', devinSessionId);
      devinResumedSessionId = devinSessionId;
      log.info(`Resuming Devin session: ${devinSessionId}`);
    }

    if (options.usePlanMode && !options.devinAutoPermFallback) {
      // plan モード: --agent-config で Read のみ許可、Write/Exec を明示的に deny
      // --permission-mode auto は「安全と判断したツールを自動承認」するだけで
      // 厳密な読み取り専用ではないため、agent-config で強制する
      const agentConfig = {
        permissions: {
          allow: ['Read(**)'],
          deny: ['Write(**)', 'Exec(**)'],
        },
      };
      const agentConfigPath = path.join(os.tmpdir(), `devrelay-devin-agent-config-${sessionId}.json`);
      fs.writeFileSync(agentConfigPath, JSON.stringify(agentConfig), 'utf-8');
      args.push('-p', '--agent-config', agentConfigPath);
      log.info(`Devin plan mode: using agent-config (Read only, Write/Exec denied)`);
    } else if (options.usePlanMode && options.devinAutoPermFallback) {
      // plan フォールバック（#274）: agent-config の deny で Devin がツール拒否→出力ゼロになる問題の回避。
      // agent-config を渡さず --permission-mode auto（安全ツールのみ自動承認）で実行する。
      // 厳密読み取り専用は緩むが「プラン不能」よりまし。書き換え抑止はプロンプト側の指示に委ねる。
      args.push('-p', '--permission-mode', 'auto');
      log.info(`Devin plan mode fallback: using --permission-mode auto (agent-config skipped)`);
    } else {
      // exec モード: 全ツール自動承認
      args.push('-p', '--permission-mode', 'dangerous');
    }

    // #276: 途中経過表示。対応版なら --export で ATIF をファイル書き出しさせ、後段でポーリングして進捗を出す。
    // stdout ではなく別ファイルへ出るため、最終保存メッセージ（responseText）を汚染しない。
    if (probeDevinExportSupport(command)) {
      devinExportPath = path.join(os.tmpdir(), `devrelay-devin-export-${sessionId}.jsonl`);
      args.push('--export', devinExportPath);
      log.info(`Devin --export enabled: ${devinExportPath}`);
    }

    // Devin は stdin パイプ非対応（panic at repl_mode.rs）→ --prompt-file で一時ファイル経由
    const promptFilePath = path.join(os.tmpdir(), `devrelay-prompt-${sessionId}.txt`);
    fs.writeFileSync(promptFilePath, prompt, 'utf-8');
    args.push('--prompt-file', promptFilePath);

    log.info(`Running: ${command} ${args.join(' ').replace(promptFilePath, '...')}`);

    // Devin コマンドのディレクトリを PATH に追加
    const devinDir = path.dirname(command);
    const devinEnvPath = process.env.PATH ? `${devinDir};${process.env.PATH}` : devinDir;

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
  } else {
    // For other AI tools (aider, codex), use shell
    // On Windows, need to handle shell differently
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
    devinHeartbeatTimer = setInterval(() => {
      const elapsedSec = Math.floor((Date.now() - devinStartTime) / 1000);
      // #277: 上限有効時は「/ 上限M分」を併記して残り時間を可視化
      const limitSuffix = devinMaxRuntimeMin > 0 ? ` / 上限${devinMaxRuntimeMin}分` : '';
      // #278: 30秒間隔で発火し、1分未満は秒表示（短時間タスクでも最低1回は進捗が出るように）
      const elapsedLabel = elapsedSec < 60 ? `${elapsedSec}秒経過` : `${Math.floor(elapsedSec / 60)}分経過`;
      onOutput(`⏳ Devin 実行中... (${elapsedLabel}${limitSuffix})\n`, false);
    }, 30_000);

    // #277: 実行時間上限（本命）。超過で SIGTERM 停止し、close ハンドラで課金抑止メッセージを送る。
    if (devinMaxRuntimeMin > 0) {
      devinLimitTimer = setTimeout(() => {
        log.info(`[devin] Runtime limit ${devinMaxRuntimeMin}min reached, killing process (cost guard)`);
        devinRuntimeLimitHit = true;
        proc.kill('SIGTERM');
      }, devinMaxRuntimeMin * 60_000);
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
                const summary = summarizeAtifEntry(entry);
                if (summary) onOutput(`⏳ ${summary}\n`, false);
                // #277: ステップ数上限（--export 対応版のみ）。超過で SIGTERM 停止。
                devinStepCount++;
                if (devinMaxSteps > 0 && devinStepCount > devinMaxSteps && !devinStepLimitHit) {
                  log.info(`[devin] Step limit ${devinMaxSteps} exceeded, killing process (cost guard)`);
                  devinStepLimitHit = true;
                  proc.kill('SIGTERM');
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
                onOutput(`\n🔧 ${block.name}を使用中...\n`, false);
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
            onOutput(`\n🔧 ${toolName}を使用中...\n`, false);
          }
          // Capture result for final output
          else if (json.type === 'result') {
            log.info(`[${aiTool}] ✅ Complete (${json.duration_ms}ms)`);
          }
        } catch {
          // JSON パース失敗 → プレーンテキスト出力（Devin/Gemini/Aider/Codex）
          const trimmed = line.trim();
          if (trimmed) {
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
      // ツール拒否の検出（#274 の平文 "A tool was rejected" はログモードでは出ないため置き換え）
      if (/rejecting tool \w+ that requires confirmation/.test(message)) {
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
        onOutput(`⏳ ${formatDevinToolLog(toolName, message)}\n`, false);
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
      // #281: ファイル変更ウォッチャ停止
      if (devinFsWatcher) { try { devinFsWatcher.close(); } catch {} devinFsWatcher = null; }
      // #281: ATIF は turn 終了時に一括書き出しされるため、削除する前に読んで実行ステップまとめを作る
      if (devinExportPath && fs.existsSync(devinExportPath)) {
        try { devinStepSummary = buildDevinStepSummary(devinExportPath); } catch {}
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
      if (lineBuffer.trim()) {
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

      // #274: Devin プランモードで agent-config の deny によりツールが拒否され出力ゼロになったケースを検出。
      // agent-config（Read only, Write/Exec deny）を渡すと Devin が計画立案で Exec 等を使おうとして
      // 「A tool was rejected by the user」→ 実行全体が中断・出力ゼロで終わる（新規プロジェクトで頻発）。
      // agent-config を外して --permission-mode auto で内部リトライする（resume なし・新規セッション）。
      // devinAutoPermFallback ガードで無限ループを防止。
      const devinPlanToolRejected =
        aiTool === 'devin' &&
        options.usePlanMode === true &&
        !options.devinAutoPermFallback &&
        fullOutput.trim().length === 0 &&
        // #282: CHISEL_LOG_STDERR=1 では平文 "A tool was rejected" が出ずログ形式になるため両方で検出
        (/tool was rejected/i.test(stderrOutput) || devinToolRejectedInLog);
      if (devinPlanToolRejected) {
        log.info(`[devin] ⚠️ Devin plan agent-config rejected a tool (code ${code}), falling back to --permission-mode auto`);
        completionSent = true; // この呼び出しの後続 onOutput を抑止（フォールバック側が完了通知を送る）
        // 壊れた可能性のあるセッション ID をクリアしてからフォールバック（新規セッション）
        clearDevinSessionId(projectPath).finally(() => {
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
        clearDevinSessionId(projectPath).finally(() => resolve(result));
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
        // #282: ログ形式のツール拒否検出も含める（後方互換で平文検出も残す）
        (/tool was rejected/i.test(stderrOutput) || devinToolRejectedInLog);
      if (devinFallbackToolRejected && !completionSent) {
        completionSent = true;
        const stderrTail = stderrOutput.trim().split('\n').slice(-5).join('\n');
        onOutput(
          `⚠️ Devin がツール承認拒否で終了しました。\n端末で \`devin\` を単体実行して動作を確認してください。\n\n[stderr]\n${stderrTail}`,
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
          onOutput('(No response from AI)', true, result.usageData);
        } else {
          // #281: Devin の実行ステップまとめを最終回答へ添付してから完了通知（⏳ でない=最終メッセージに残る）
          if (devinStepSummary) onOutput(devinStepSummary, false);
          onOutput('', true, result.usageData); // Signal completion with usage data
        }
      }
      resolve(result);
    });

    proc.on('error', (err) => {
      // #276: 進捗タイマー停止 + ATIF エクスポートファイルの後始末
      if (devinHeartbeatTimer) { clearInterval(devinHeartbeatTimer); devinHeartbeatTimer = null; }
      if (devinExportPollTimer) { clearInterval(devinExportPollTimer); devinExportPollTimer = null; }
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
