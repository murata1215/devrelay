import { spawn, ChildProcess, execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { DEFAULT_ALLOWED_TOOLS_LINUX } from '@devrelay/shared';
import type { AiTool, AiUsageData, ScreenAnalysis } from '@devrelay/shared';
import type { AgentConfig } from './config.js';
import { getBinDir } from './config.js';
import { parseStreamJsonLine, formatContextUsage, isContextWarning, getContextWarningMessage, type ContextUsage } from './output-parser.js';
import { saveClaudeSessionId, saveContextUsage, loadClaudeSessionId, clearClaudeSessionId, loadDevinSessionId, saveDevinSessionId, loadSessionMeta } from './session-store.js';
import { getServerSkipPermissions } from './connection.js';
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
}

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
 * @returns マッチした場合 true
 */
function isToolSessionApproved(toolName: string, input: Record<string, unknown>): boolean {
  if (sessionApprovedTools.size === 0) return false;

  for (const rule of sessionApprovedTools) {
    // "ToolName" 形式: ツール名完全一致（Edit, Read, Write, Glob, Grep 等）
    if (!rule.includes('(')) {
      if (toolName === rule) return true;
      continue;
    }

    // "Bash(cmd *)" / "Bash(cmd)" 形式: Bash コマンドのパターンマッチ
    const match = rule.match(/^(\w+)\((.+)\)$/);
    if (!match) continue;
    const [, ruleToolName, rulePattern] = match;
    if (toolName !== ruleToolName) continue;

    // Bash コマンドのマッチング
    if (toolName === 'Bash' && typeof input.command === 'string') {
      const command = input.command.trim();
      if (rulePattern.endsWith(' *')) {
        const prefix = rulePattern.slice(0, -2);
        if (command === prefix || command.startsWith(prefix + ' ')) return true;
      } else {
        if (command === rulePattern) return true;
      }
    }
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
  /** Claude SDK モデル指定（例: 'sonnet', 'opus', 'haiku'）。省略時は SDK デフォルト */
  model?: string;
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
  };
  if (options.model) {
    console.log(`🧠 [SDK] Using model: ${options.model}`);
  }

  // AskUserQuestion 無効化（SDK レベルでツール除去）
  if (options.disableAsk) {
    sdkOptions.disallowedTools = ['AskUserQuestion'];
    console.log('🚫 [SDK] AskUserQuestion disabled (disallowedTools)');
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
        const isQuestion = toolName === 'AskUserQuestion';

        // 全許可モード: AskUserQuestion 以外は即座に allow（動的に最新値を参照）
        // Plan モードでも allowedTools 外のツール（find 等）が SDK からパーミッション要求される場合があるため必須
        if (!isQuestion && getServerSkipPermissions()) {
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

  try {
    for await (const message of query({ prompt, options: sdkOptions })) {
      const m = message as any;

      // セッション ID 抽出（system/init または result から）
      if (m.session_id && !result.extractedSessionId) {
        result.extractedSessionId = m.session_id;
        console.log(`[claude/sdk] 📋 Session ID: ${m.session_id.substring(0, 8)}...`);
        saveClaudeSessionId(projectPath, m.session_id).catch(err => {
          console.error(`Failed to save session ID:`, err);
        });
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
            fullOutput += block.text;
            console.log(`[claude/sdk] +${block.text.length} chars`);
            onOutput(block.text, false);
          } else if (block.type === 'tool_use' && block.name) {
            console.log(`[claude/sdk] 🔧 Using tool: ${block.name}`);
            onOutput(`\n🔧 ${block.name}を使用中...\n`, false);
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
          saveContextUsage(projectPath, result.contextUsage).catch(err => {
            console.error(`Failed to save context usage:`, err);
          });
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
      }
    }
  } catch (err: any) {
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
      onOutput(`Error: ${err.message}`, true);
    }
    return result;
  }

  // 完了シグナル送信
  if (fullOutput.length === 0) {
    onOutput('(No response from AI)', true, result.usageData);
  } else {
    onOutput('', true, result.usageData);
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
    console.log(`🔧 Running: ${command} --approval-mode auto_edit (prompt via stdin)`);

    // Gemini コマンドのディレクトリを PATH に追加（systemd 実行時に node が見つからない問題を回避）
    const geminiDir = path.dirname(command);
    const pathSep = process.platform === 'win32' ? ';' : ':';
    const envPath = process.env.PATH ? `${geminiDir}${pathSep}${process.env.PATH}` : geminiDir;

    proc = spawn(command, args, {
      cwd: projectPath,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
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
    // Devin CLI: plan → auto（読み取り専用のみ）、exec → dangerous（全承認）
    const permMode = options.usePlanMode ? 'auto' : 'dangerous';
    const args: string[] = [];

    // 保存済み Devin セッション ID があれば -r で resume
    // ただし exec モードでは新規セッションを開始する（--permission-mode dangerous を
    // CLI で指定しても、resume したセッションは元の auto モードを保持して
    // 書き込みが拒否されるため）
    const devinSessionId = options.usePlanMode
      ? await loadDevinSessionId(projectPath)
      : null;
    if (devinSessionId) {
      args.push('-r', devinSessionId);
      console.log(`🔄 Resuming Devin session: ${devinSessionId}`);
    }

    args.push('-p', '--permission-mode', permMode);

    // Devin は stdin パイプ非対応（panic at repl_mode.rs）→ --prompt-file で一時ファイル経由
    const promptFilePath = path.join(os.tmpdir(), `devrelay-prompt-${sessionId}.txt`);
    fs.writeFileSync(promptFilePath, prompt, 'utf-8');
    args.push('--prompt-file', promptFilePath);

    console.log(`🔧 Running: ${command} ${args.join(' ').replace(promptFilePath, '...')}`);

    // Devin コマンドのディレクトリを PATH に追加
    const devinDir = path.dirname(command);
    const devinPathSep = process.platform === 'win32' ? ';' : ':';
    const devinEnvPath = process.env.PATH ? `${devinDir}${devinPathSep}${process.env.PATH}` : devinDir;

    proc = spawn(command, args, {
      cwd: projectPath,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...proxyEnv,
        PATH: devinEnvPath,
        DEVRELAY: '1',
        DEVRELAY_SESSION_ID: sessionId,
        DEVRELAY_PROJECT: projectPath,
      },
    });

    // stdin は使わない（--prompt-file で渡す）
    proc.stdin?.end();
  } else {
    // For other AI tools (aider, codex), use shell (legacy behavior)
    const escapedPrompt = prompt.replace(/'/g, "'\\''");
    const fullCommand = `${command} '${escapedPrompt}'`;

    console.log(`🔧 Running: ${fullCommand.substring(0, 100)}...`);

    // OS デフォルトシェルを使用（Linux: /bin/sh, Windows: cmd.exe）
    proc = spawn(fullCommand, [], {
      cwd: projectPath,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...proxyEnv },
    });

    proc.stdin?.end();
  }

  // 実行中のプロセスを activeSessions に保存（cancelAiSession で参照するため）
  const session = activeSessions.get(sessionId);
  if (session) {
    session.process = proc;
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
            saveClaudeSessionId(projectPath, parsed.sessionId).catch(err => {
              console.error(`Failed to save session ID:`, err);
            });
          }
          if (parsed.contextUsage) {
            result.contextUsage = parsed.contextUsage;
            console.log(`[${aiTool}] ${formatContextUsage(parsed.contextUsage)}`);
            // Save context usage for display at start of next prompt
            saveContextUsage(projectPath, parsed.contextUsage).catch(err => {
              console.error(`Failed to save context usage:`, err);
            });
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
            console.log(`[${aiTool}] +${deltaText.length} chars`);
            onOutput(deltaText, false);
          }
          // Also capture tool use for visibility (legacy format)
          else if (json.type === 'stream_event' &&
                   json.event?.type === 'content_block_start' &&
                   json.event?.content_block?.type === 'tool_use') {
            const toolName = json.event.content_block.name;
            console.log(`[${aiTool}] 🔧 Using tool: ${toolName}`);
            onOutput(`\n🔧 ${toolName}を使用中...\n`, false);
          }
          // Capture result for final output
          else if (json.type === 'result') {
            console.log(`[${aiTool}] ✅ Complete (${json.duration_ms}ms)`);
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

    proc.stderr?.on('data', (data) => {
      const text = data.toString();
      stderrOutput += text;
      console.error(`[${aiTool}] stderr: ${text}`);
    });

    proc.on('close', (code, signal) => {
      console.log(`[${aiTool}] Process exited with code ${code}, signal ${signal}`);

      // Devin: 一時ファイル削除 + セッション ID 取得・保存
      if (aiTool === 'devin') {
        try { fs.unlinkSync(path.join(os.tmpdir(), `devrelay-prompt-${sessionId}.txt`)); } catch {}
        // devin list --format json で最新セッション ID を取得して保存
        try {
          const listOutput = execSync(`${command} list --format json`, {
            cwd: projectPath, encoding: 'utf-8', timeout: 10000,
          });
          const sessions = JSON.parse(listOutput);
          // cwd が一致するセッションの最新を取得（Windows: パス区切り正規化）
          const normalizedPath = projectPath.replace(/\\/g, '/').toLowerCase();
          const latest = sessions
            .filter((s: any) => s.working_directory?.replace(/\\/g, '/').toLowerCase() === normalizedPath)
            .sort((a: any, b: any) => (b.last_activity_at || 0) - (a.last_activity_at || 0))[0];
          if (latest?.id) {
            saveDevinSessionId(projectPath, latest.id).catch(() => {});
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

      if (!completionSent) {
        completionSent = true;
        if (fullOutput.length === 0) {
          onOutput('(No response from AI)', true, result.usageData);
        } else {
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
      console.error(`[${aiTool}] Process error:`, err);
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
    const claudePathRaw = execSync(`${findCmd} claude`, { encoding: 'utf-8', timeout: 5000 }).trim();
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
