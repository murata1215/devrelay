/**
 * 端末インタフェースモード（Terminal Mode）の PTY ランナー
 *
 * Agent SDK の `query()`（非対話呼び出し）ではなく、PTY 経由で
 * `claude --continue` をインタラクティブに起動し、1 要求 1 セッションで
 * 都度起動・都度終了するモード。WebUI / モバイルからの手動メッセージ起点。
 *
 * 完了検出は「最終出力から 10 分無音」をメイン基準とし、
 * プロンプト復帰検出は補助的に使う（仕様書 §4.1）。
 */
// @homebridge/node-pty-prebuilt-multiarch: Linux/macOS/Windows のプリビルドを同梱したフォーク。
// upstream の microsoft/node-pty は Linux x64 プリビルドを同梱しないためビルドツールが必須だが、
// このフォークなら build-essential / python3 不要でインストールできる（API は完全互換）
import * as pty from '@homebridge/node-pty-prebuilt-multiarch';
// @xterm/headless は webpack バンドル済みの CommonJS のため named import が ESM で失敗する
// Node の ESM ローダーは CJS から named export を取り出せないため、default import で取得する
import xtermHeadless from '@xterm/headless';
import type { IPty } from '@homebridge/node-pty-prebuilt-multiarch';
const { Terminal } = xtermHeadless;
import path from 'path';
import fs from 'fs';
import { getConfigDir } from './config.js';
import {
  detectPromptReady,
  detectToolApprovalPrompt,
  detectAskQuestionPrompt,
  detectStartupChoicePrompt,
  extractFinalOutput,
  extractClaudeResponse,
  extractChoicePrompt,
  extractThinkingIndicator,
  getBulletLines,
  bulletCountMap,
  countNewBullets,
} from './terminal-parser.js';
import crypto from 'crypto';

/** PTY サイズ */
const TERM_COLS = 120;
const TERM_ROWS = 40;

/** 起動完了（プロンプト復帰）の最大待機時間 */
const STARTUP_TIMEOUT_MS = 15_000;

/** アイドルタイムアウト（最終出力からこの時間無音で完了とみなす） */
const IDLE_TIMEOUT_MS = 10 * 60_000;

/** /exit 送信後にプロセスが終了するまでの猶予 */
const EXIT_GRACE_MS = 5_000;

/** 画面変化監視・完了判定チェック間隔 */
const CHECK_INTERVAL_MS = 500;

/** 完了判定: プロンプト復帰 + 画面アイドル時間（onData の頻度に依存しない判定基準） */
const IDLE_FOR_COMPLETION_MS = 1500;

/** プロンプト送信開始からこの時間が経つまでは「画面アイドル」を完了と判定しない（プロンプト書き込み中の偽 idle 防止） */
const EXEC_COOLDOWN_MS = 3500;

/** First-bullet safety timeout: submit 後この時間が経っても `●` バレットが 1 つも出なければ強制完了（無限ハング防止） */
const FIRST_BULLET_TIMEOUT_MS = 5 * 60_000;

/** completion check スキップ理由ログの throttle 間隔（毎 500ms 出すと spam になるため） */
const SKIP_LOG_THROTTLE_MS = 5_000;

/** Heartbeat 表示の最小間隔（思考フェーズで「死んでない」が伝わるように WebUI に流す）*/
const HEARTBEAT_INTERVAL_MS = 30_000;

/** バレット送信直後はハートビートを抑制する期間（連射時に混じらないように） */
const HEARTBEAT_QUIET_AFTER_BULLET_MS = 20_000;

/** ストリーミング送信するバレットテキストの最大文字数（長い応答は切詰めて 1 行化） */
const STREAM_BULLET_MAX_CHARS = 200;

/** プロンプトをチャンクに分割するサイズ（PTY/CLI バッファのオーバーフローや誤解釈を防ぐ） */
const PROMPT_CHUNK_SIZE = 200;

/** チャンク間の待機時間 */
const PROMPT_CHUNK_DELAY_MS = 30;

/** プロンプト末尾投入から submit (\r) 送信までの待機時間 */
const PROMPT_SUBMIT_DELAY_MS = 400;

/** 承認/質問プロンプトをユーザーに転送するためのリクエスト */
export interface ChoiceRequest {
  /** ユニークなリクエスト ID（WS approval 経路で使う） */
  requestId: string;
  /** 質問本文（Claude CLI 画面から抽出） */
  question: string;
  /** 選択肢リスト（"1. xxx" の xxx 部分） */
  options: string[];
  /** ユーザーが選択肢を選んだら呼び出すレスポンダ（0-indexed） */
  respond: (optionIndex: number) => void;
}

export interface TerminalRunOptions {
  /** プロジェクトのワーキングディレクトリ */
  projectPath: string;
  /** 送信するプロンプト本文 */
  prompt: string;
  /** 全ツール自動承認モード（--dangerously-skip-permissions 相当） */
  approveAllMode: boolean;
  /** AskUserQuestion 抑止（質問プロンプト検出時に中断） */
  disableAsk: boolean;
  /** Claude CLI の実行パス（resolveClaudePath で取得済みの値） */
  claudeCommand: string;
  /** PTY 出力ストリーミングコールバック（ANSI 除去済み） */
  onOutput: (chunk: string) => void;
  /** セッション識別子（ログファイル名・トラブルシュート用） */
  sessionId: string;
  /**
   * Claude CLI セッションを resume する場合の session ID（UUID 形式）。
   * SDK と CLI は `~/.claude/projects/<hash>/sessions/<id>.jsonl` を共有しているため、
   * SDK が `.devrelay/claude-session-id` に保存した ID を `claude --resume <id>` で復元できる。
   * 未指定の場合は新規セッションとして起動（CLI が新しい ID を採番）
   */
  resumeSessionId?: string;
  /**
   * 承認/質問プロンプト発生時のコールバック。
   * 設定されている場合、Claude CLI の番号付き選択肢プロンプトを検出すると呼ばれる。
   * 未設定の場合は自動的に "2"（拒否）を送信する後方互換挙動になる
   */
  onChoiceRequest?: (req: ChoiceRequest) => void;
}

export interface TerminalRunResult {
  /** 最終バッファから抽出した整形済み出力 */
  finalOutput: string;
  /** 実行時間（ミリ秒） */
  durationMs: number;
  /** タイムアウトによる強制終了か */
  timedOut: boolean;
  /** Ask 無効により中断したか */
  cancelledByAskDisable: boolean;
}

/** ランニング中の PTY プロセス（キャンセル用） */
const runningProcesses = new Map<string, IPty>();

/**
 * 指定セッションの実行中 PTY プロセスを取得する
 * cancelAiSession から参照される
 */
export function getRunningTerminalProcess(sessionId: string): IPty | undefined {
  return runningProcesses.get(sessionId);
}

/**
 * 端末インタフェースモードで claude を起動し、プロンプトを送って結果を返す
 *
 * @param opts 実行オプション
 * @returns 整形済み最終出力と実行統計
 */
export async function runTerminalClaude(opts: TerminalRunOptions): Promise<TerminalRunResult> {
  const start = Date.now();
  // scrollback: default 1000 だと長い `claude --resume` 履歴（40+ メッセージ）で
  // 古いバレット行が押し出されて baseline 比較が破綻する。10000 行に拡張して安全マージン確保
  const term = new Terminal({ cols: TERM_COLS, rows: TERM_ROWS, allowProposedApi: true, scrollback: 10000 });

  // `--continue` は cwd ごとに保存された Claude CLI セッションを resume するが、
  // 端末モードを初めて使うフォルダではセッションが存在せず "No conversation found to continue" で
  // 即 exit code=1 で死ぬ。代わりに `--resume <id>` を使う。
  // SDK と CLI は `~/.claude/projects/<hash>/sessions/<id>.jsonl` を共有しているため、
  // SDK が `.devrelay/claude-session-id` に保存した ID を渡せば過去の会話を継続できる
  const args: string[] = [];
  if (opts.approveAllMode) {
    args.push('--dangerously-skip-permissions');
  }
  if (opts.resumeSessionId) {
    args.push('--resume', opts.resumeSessionId);
  }

  console.log(`🖥️ [terminal-mode] spawning: ${opts.claudeCommand} ${args.join(' ')} (cwd=${opts.projectPath})`);

  const ptyProcess = pty.spawn(opts.claudeCommand, args, {
    name: 'xterm-256color',
    cwd: opts.projectPath,
    cols: TERM_COLS,
    rows: TERM_ROWS,
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      DEVRELAY: '1',
      DEVRELAY_SESSION_ID: opts.sessionId,
      DEVRELAY_PROJECT: opts.projectPath,
    } as { [key: string]: string },
  });

  runningProcesses.set(opts.sessionId, ptyProcess);

  // PTY 全出力を記録するログファイル（仕様書 §9）
  const logDir = path.join(getConfigDir(), 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `terminal-${opts.sessionId}.log`);
  let logStream: fs.WriteStream | null = null;
  try {
    logStream = fs.createWriteStream(logFile, { flags: 'a' });
  } catch (err) {
    console.warn(`⚠️ [terminal-mode] log stream open failed: ${(err as Error).message}`);
  }

  let promptReady = false;
  let execStarted = false;
  let promptSent = false;
  let finished = false;
  let timedOut = false;
  let cancelledByAskDisable = false;
  /** 起動時の選択肢プロンプト（trust folder / resume summary / 等）のユーザー応答待ち中フラグ */
  let pendingStartupChoice = false;
  /** 起動時の選択肢プロンプトの重複転送防止用ハッシュ集合 */
  const handledStartupChoiceHashes = new Set<string>();
  let execStartedAt = 0;
  /** 画面が最後に変化した時刻（完了判定の「画面アイドル」基準） */
  let lastScreenChangeAt = Date.now();
  /** 画面変化追跡用の前回レンダリング結果 */
  let lastRenderedForChangeTracking = '';
  /**
   * baseline 時点の Claude メッセージ（`●` 行）テキスト → 出現回数 Map。
   * Map ベースの count 差分で新規バレットを判定する。
   *
   * Set 比較ではなく Map<text, count> を使う理由:
   *  - 同じ質問の re-ask で前回応答が JSONL 履歴に残っている場合、Set 比較では
   *    新規応答テキストが baseline Set に既にあるため新規判定が漏れる（hang する）
   *  - count 差分なら「同じテキストが baseline より多く現れた = 新規描画」を確実に検知
   *  - 単純 int count ベース（旧版）は buffer trim で current < baseline の負数になり破綻
   *  - Map なら text 単位で `Math.max(0, current - base)` 合計で trim 耐性も確保
   */
  let baselineBulletMap = new Map<string, number>();
  /** 既に応答済みのプロンプト hash（同じ承認プロンプトの重複転送防止） */
  const handledPromptHashes = new Set<string>();
  /** 承認応答待ち中のリクエスト数。>0 の間は「画面アイドル + プロンプト復帰」を完了と判定しない */
  let pendingApprovalCount = 0;
  let idleTimer: NodeJS.Timeout | null = null;
  let startupTimer: NodeJS.Timeout | null = null;
  let completionCheckInterval: NodeJS.Timeout | null = null;
  /**
   * 起動中の検出ポーリング。Claude CLI がプロンプトを表示して入力待ちになると
   * PTY からの onData 発火が止まるため、onData ベースの検出だけでは検知できない
   * （特に Windows ConPTY ではこの挙動が顕著）。
   * 別タイマーで定期的に検出を回すことで「無音中に立っているプロンプト」を捕捉する
   */
  let startupPollInterval: NodeJS.Timeout | null = null;

  return new Promise<TerminalRunResult>((resolve, reject) => {
    const finish = (reason: string) => {
      if (finished) return;
      finished = true;
      if (idleTimer) clearTimeout(idleTimer);
      if (startupTimer) clearTimeout(startupTimer);
      if (completionCheckInterval) {
        clearInterval(completionCheckInterval);
        completionCheckInterval = null;
      }
      if (startupPollInterval) {
        clearInterval(startupPollInterval);
        startupPollInterval = null;
      }
      console.log(`🖥️ [terminal-mode] finishing (${reason})`);

      // Claude の応答を抽出して送信（promptSent 後のみ意味のある応答が得られる）
      if (promptSent) {
        const finalRendered = extractFinalOutput(term);
        const currentBulletLines = getBulletLines(finalRendered);
        const newBullets = countNewBullets(baselineBulletMap, currentBulletLines);
        console.log(`📊 [terminal-mode] completion bullets: baseline=${baselineBulletMap.size}unique, current=${currentBulletLines.length}, new=${newBullets}`);
        const response = extractClaudeResponse(finalRendered, baselineBulletMap);
        if (response) {
          opts.onOutput(response);
        } else {
          // 応答抽出失敗時のフォールバック: 原因と画面末尾を表示
          if (newBullets === 0) {
            console.warn(`⚠️ [terminal-mode] no new Claude bullet (●) detected at finish time (likely idle timeout or early CLI exit).`);
            opts.onOutput(`\n⚠️ Claude が応答テキストを出さずにセッションが終わりました。\n（タイムアウト・Claude CLI の早期終了・無応答エラーの可能性。logs/terminal-${opts.sessionId}.log を確認してください）`);
          } else {
            console.warn(`⚠️ [terminal-mode] could not extract response despite ${newBullets} new bullet(s)`);
            const tail = finalRendered.length > 500 ? finalRendered.slice(-500) : finalRendered;
            opts.onOutput(`\n（Claude の応答抽出に失敗しました。画面末尾:\n${tail}\n）`);
          }
        }
      }

      // /exit 送信して正規終了を試みる
      try {
        ptyProcess.write('/exit\r');
      } catch {
        // ignore
      }

      // 猶予内にプロセスが終わらなければ kill
      const killTimer = setTimeout(() => {
        try {
          ptyProcess.kill();
        } catch {
          // already exited
        }
      }, EXIT_GRACE_MS);

      ptyProcess.onExit(() => {
        clearTimeout(killTimer);
        runningProcesses.delete(opts.sessionId);
        logStream?.end();
        const finalOutput = extractFinalOutput(term);
        resolve({
          finalOutput,
          durationMs: Date.now() - start,
          timedOut,
          cancelledByAskDisable,
        });
      });
    };

    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        timedOut = true;
        console.log(`⏰ [terminal-mode] idle timeout (${IDLE_TIMEOUT_MS}ms)`);
        finish('idle-timeout');
      }, IDLE_TIMEOUT_MS);
    };

    /**
     * 起動タイマーをセット/再セットする。
     * 起動時の選択肢プロンプトでユーザー応答を待つ間に一時停止 → 応答後に再起動するためにヘルパー化
     */
    const installStartupTimer = () => {
      if (startupTimer) clearTimeout(startupTimer);
      startupTimer = setTimeout(() => {
        if (!promptReady) {
          // 起動失敗時に画面の最後 500 文字をログに残す（検出ロジック改善のための調査材料）
          const rendered = extractFinalOutput(term);
          const tail = rendered.length > 500 ? rendered.slice(-500) : rendered;
          console.error(`❌ [terminal-mode] startup timeout (${STARTUP_TIMEOUT_MS}ms). Last 500 chars of rendered screen:\n--- BEGIN SCREEN ---\n${tail}\n--- END SCREEN ---`);
          if (startupPollInterval) {
            clearInterval(startupPollInterval);
            startupPollInterval = null;
          }
          try {
            ptyProcess.kill();
          } catch {
            // ignore
          }
          runningProcesses.delete(opts.sessionId);
          logStream?.end();
          reject(new Error(
            '端末モードの起動がタイムアウトしました（15 秒）\n' +
            'ヒント: Claude CLI 側に未処理のプロンプト（フォルダ信頼確認・モデル選択等）が残っている可能性があります。\n' +
            '一度 Agent ホストで `claude --continue` を手動実行して初期セットアップを完了させてください。'
          ));
        }
      }, STARTUP_TIMEOUT_MS);
    };
    installStartupTimer();

    /**
     * 起動フェーズの検出を 1 回だけ実行する。
     * onData ハンドラ内とポーリング interval の両方から呼ばれる。
     *
     * - 起動時の選択肢プロンプト（trust folder / resume summary / その他将来追加されるシステムプロンプト）
     *   → 既存 WS 承認カード経路で WebUI/Discord/Telegram に転送、ユーザー応答を PTY に書き戻す
     * - 入力プロンプト復帰 → 検出したらユーザープロンプト送信フェーズに遷移
     *
     * Claude が入力待ちで PTY 無音になると onData が発火しなくなる。
     * ポーリングによってその「無音中の状態」を捕捉できる
     */
    const runStartupDetection = () => {
      if (finished || promptReady) return;
      const rendered = extractFinalOutput(term);

      // 画面変化を記録（完了判定の「画面アイドル」基準）
      if (rendered !== lastRenderedForChangeTracking) {
        lastScreenChangeAt = Date.now();
        lastRenderedForChangeTracking = rendered;
      }

      // 起動時の選択肢プロンプト（trust folder / resume summary / 等）
      // 「ターミナルモードは Claude CLI の薄い UI ラッパ」という設計思想に基づき、agent が
      // 自動判断せずユーザーに選ばせる（既存 tool 承認と同じ承認カード経路に bridge）。
      // onChoiceRequest 未配線の自動実行環境では option 1 自動選択で後方互換を保つ
      if (!pendingStartupChoice && detectStartupChoicePrompt(rendered)) {
        const meta = extractChoicePrompt(rendered);
        if (meta && meta.options.length >= 2) {
          const hash = crypto.createHash('sha1')
            .update(meta.question + '|' + meta.options.join('|'))
            .digest('hex').slice(0, 16);

          if (!handledStartupChoiceHashes.has(hash)) {
            handledStartupChoiceHashes.add(hash);
            pendingStartupChoice = true;
            const elapsed = Date.now() - start;

            // ユーザー応答待ち中は startup timer を停止（応答に何分かかるかわからない）
            if (startupTimer) {
              clearTimeout(startupTimer);
              startupTimer = null;
            }

            if (opts.onChoiceRequest) {
              const requestId = crypto.randomUUID();
              console.log(`📜 [terminal-mode] startup choice prompt → forwarding to user (${meta.options.length} options, requestId=${requestId.slice(0, 8)}, ${elapsed}ms after spawn): "${meta.question.slice(0, 80)}"`);
              opts.onChoiceRequest({
                requestId,
                question: meta.question,
                options: meta.options,
                respond: (optionIndex: number) => {
                  if (finished) return;
                  const choice = Math.max(0, Math.min(meta.options.length - 1, optionIndex)) + 1;  // 1-indexed, clamp
                  console.log(`✅ [terminal-mode] user chose option ${choice} for startup choice (requestId=${requestId.slice(0, 8)})`);
                  try {
                    ptyProcess.write(`${choice}\r`);
                  } catch {
                    // ignore
                  }
                  pendingStartupChoice = false;
                  // 応答後のレンダリング待ちで startup timer を再起動（summary 生成は 30-60s かかる）
                  installStartupTimer();
                },
              });
            } else {
              // フォールバック: onChoiceRequest 未配線 → option 1 自動選択（後方互換）
              console.log(`🔐 [terminal-mode] no choice callback configured → auto-selecting option 1 (${elapsed}ms after spawn): "${meta.question.slice(0, 80)}"`);
              try {
                ptyProcess.write('1\r');
              } catch {
                // ignore
              }
              pendingStartupChoice = false;
              installStartupTimer();
            }
          }
          return;
        }
      }

      // 起動完了検出
      if (detectPromptReady(rendered)) {
        promptReady = true;
        if (startupTimer) {
          clearTimeout(startupTimer);
          startupTimer = null;
        }
        if (startupPollInterval) {
          clearInterval(startupPollInterval);
          startupPollInterval = null;
        }
        const elapsed = Date.now() - start;
        console.log(`✅ [terminal-mode] prompt ready (${elapsed}ms after spawn), sending user prompt (${opts.prompt.length} chars)`);
        // baseline 時点のバレット行 text→count Map を記録。count を超える出現が新規応答
        const baselineLines = getBulletLines(rendered);
        baselineBulletMap = bulletCountMap(baselineLines);
        console.log(`📊 [terminal-mode] baseline bullets: ${baselineBulletMap.size} unique, ${baselineLines.length} total instances`);
        // ユーザー向けヒント（実行中はストリーミング停止するため目印を出す）
        opts.onOutput('\n📨 メッセージを送信しました。Claude の応答を待っています...\n');
        promptSent = true;
        execStarted = true;
        execStartedAt = Date.now();
        // プロンプトを Claude CLI に投入（fire-and-forget で onData を継続）
        sendPromptToClaudeCLI(opts.prompt).catch(err => {
          console.error(`❌ [terminal-mode] prompt send failed: ${err.message}`);
        });
        // 完了監視を開始（500ms ごとに「画面アイドル + プロンプト復帰」を確認）
        startCompletionCheck();
      }
    };

    // ポーリング: Claude が入力待ちで PTY 無音中も検出が回るようにする
    startupPollInterval = setInterval(runStartupDetection, 250);

    ptyProcess.onData((data) => {
      term.write(data);
      logStream?.write(data);

      resetIdleTimer();

      // 起動フェーズの検出（onData 駆動の fast path、ポーリングと冪等に共存）
      if (!promptReady) {
        runStartupDetection();
        return;
      }

      // 検出は仮想画面でレンダリング済みのテキストに対して行う。
      // raw PTY バッファに strip-ansi するだけだとカーソル位置指定で配置された
      // 単語が密着してしまう（"trust this folder" → "trustthisfolder"）ため、
      // 仮想画面でのレンダリング結果を使うことで視認できる空白で正しく判定できる
      const rendered = extractFinalOutput(term);

      // 画面変化を記録（完了判定の「画面アイドル」基準）
      if (rendered !== lastRenderedForChangeTracking) {
        lastScreenChangeAt = Date.now();
        lastRenderedForChangeTracking = rendered;
      }

      // 実行開始後: 番号付き選択肢プロンプト（tool 承認 / AskUserQuestion 等）の処理
      // 完了判定は startCompletionCheck の setInterval で独立して行う
      if (execStarted && !finished && !opts.approveAllMode && detectToolApprovalPrompt(rendered)) {
        const meta = extractChoicePrompt(rendered);
        if (meta) {
          // 同一プロンプトの重複転送を防ぐため、内容で hash を作って既処理を記録
          const hash = crypto.createHash('sha1')
            .update(meta.question + '|' + meta.options.join('|'))
            .digest('hex').slice(0, 16);

          if (!handledPromptHashes.has(hash)) {
            handledPromptHashes.add(hash);

            // Ask 無効化 + AskUserQuestion パターン → 中断（既存挙動）
            if (opts.disableAsk && detectAskQuestionPrompt(rendered)) {
              cancelledByAskDisable = true;
              console.log(`🚫 [terminal-mode] AskUserQuestion detected with disableAsk → cancelling`);
              try {
                ptyProcess.write('\x03'); // Ctrl+C
              } catch {
                // ignore
              }
              finish('ask-disabled');
              return;
            }

            // onChoiceRequest 未設定 → 旧挙動（自動拒否=2）
            if (!opts.onChoiceRequest) {
              console.log(`🔐 [terminal-mode] approval prompt → declining (no callback configured)`);
              try {
                ptyProcess.write('2\r');
              } catch {
                // ignore
              }
              return;
            }

            // WS 承認カード経路にフォワード
            pendingApprovalCount++;
            const requestId = crypto.randomUUID();
            console.log(`🔐 [terminal-mode] approval prompt → requesting user choice (${meta.options.length} options, requestId=${requestId.slice(0, 8)}): "${meta.question.slice(0, 80)}"`);
            opts.onChoiceRequest({
              requestId,
              question: meta.question,
              options: meta.options,
              respond: (optionIndex: number) => {
                if (finished) return;
                pendingApprovalCount = Math.max(0, pendingApprovalCount - 1);
                const choice = Math.max(0, Math.min(meta.options.length - 1, optionIndex)) + 1;  // 1-indexed, clamp
                console.log(`✅ [terminal-mode] user chose option ${choice}: "${meta.options[choice - 1]?.slice(0, 60)}" (requestId=${requestId.slice(0, 8)})`);
                try {
                  ptyProcess.write(`${choice}\r`);
                } catch {
                  // ignore
                }
                // 承認後の画面更新を期待してアイドルタイマーをリセット
                resetIdleTimer();
              },
            });
          }
        }
        return;
      }
    });

    /**
     * Claude CLI にユーザープロンプトを投入する。
     *
     * 単純な `write(prompt + '\r')` だと以下の問題が発生した:
     *   1. プロンプトが内部 `\n` を持つマルチライン構造のとき、末尾の `\n\r` が CRLF と
     *      誤認されて submit に至らない
     *   2. 一度に大量バイト書き込むと PTY/CLI バッファ取りこぼしで一部脱落
     *
     * 対策:
     *   - 末尾の改行を除去してから投入
     *   - チャンクに分割して 30ms ずつ delay
     *   - 全投入後に 400ms 待ってから単独の `\r` を送って明示的に submit
     */
    const sendPromptToClaudeCLI = async (prompt: string) => {
      const clean = prompt.replace(/[\r\n]+$/, '');
      console.log(`📝 [terminal-mode] sending prompt to PTY (${clean.length} chars, in ${Math.ceil(clean.length / PROMPT_CHUNK_SIZE)} chunks)`);
      for (let i = 0; i < clean.length; i += PROMPT_CHUNK_SIZE) {
        if (finished) return;
        ptyProcess.write(clean.slice(i, i + PROMPT_CHUNK_SIZE));
        if (i + PROMPT_CHUNK_SIZE < clean.length) {
          await new Promise(r => setTimeout(r, PROMPT_CHUNK_DELAY_MS));
        }
      }
      // 投入完了 → 画面が落ち着くまで待つ → 単独 \r で submit
      await new Promise(r => setTimeout(r, PROMPT_SUBMIT_DELAY_MS));
      if (finished) return;
      console.log(`📨 [terminal-mode] sending submit \\r (Enter)`);
      ptyProcess.write('\r');
    };

    /**
     * 完了監視ループ。500ms ごとに「画面アイドル時間 + プロンプト復帰」を確認する。
     *
     * onData ハンドラ内で完了判定すると、Claude が応答テキストを書き出している間も
     * 入力ボックスの `❯` プロンプトは画面下部に常駐しているため検出器が常に true を返し、
     * onData ごとにタイマーがリセットされて完了が永遠に確定しない問題があった。
     * 独立した setInterval にすることで、onData の頻度に依存せず確実に完了を検出できる
     */
    const startCompletionCheck = () => {
      if (completionCheckInterval) return;
      // スキップ理由ごとに最後にログを出した時刻を記録（同じ理由を 5 秒に 1 回だけ出す）
      const lastSkipLogAt = new Map<string, number>();
      const logSkip = (reason: string, extra: string) => {
        const now = Date.now();
        const last = lastSkipLogAt.get(reason) ?? 0;
        if (now - last < SKIP_LOG_THROTTLE_MS) return;
        lastSkipLogAt.set(reason, now);
        console.log(`⏸️ [terminal-mode] completion skip: ${reason} (${extra})`);
      };

      // ストリーミング配信状態:
      //   sentBulletCounts: そのテキストを WebUI に何回送ったか（同じテキストの再描画を重複送信しないため）
      //   lastBulletStreamAt: 最後にバレットを流した時刻（ハートビート抑制判断用）
      //   lastHeartbeatAt: 最後にハートビートを流した時刻
      const sentBulletCounts = new Map<string, number>();
      let lastBulletStreamAt = Date.now();
      let lastHeartbeatAt = 0;

      /**
       * 新規バレットを WebUI にストリーミング配信する。
       * baseline + これまでに送った回数を超える出現分だけを送る
       */
      const streamNewBullets = () => {
        const currentLines = getBulletLines(lastRenderedForChangeTracking);
        const currentMap = bulletCountMap(currentLines);
        for (const [text, count] of currentMap) {
          const baseCount = baselineBulletMap.get(text) ?? 0;
          const newInstances = Math.max(0, count - baseCount);
          const alreadySent = sentBulletCounts.get(text) ?? 0;
          const toSend = newInstances - alreadySent;
          if (toSend > 0) {
            const display = text.length > STREAM_BULLET_MAX_CHARS
              ? text.slice(0, STREAM_BULLET_MAX_CHARS) + '…'
              : text;
            for (let k = 0; k < toSend; k++) {
              opts.onOutput(display + '\n');
            }
            sentBulletCounts.set(text, alreadySent + toSend);
            lastBulletStreamAt = Date.now();
          }
        }
      };

      /**
       * 思考フェーズの「死んでない」ハートビートを送る。
       * バレットが最近送られていない時のみ・30 秒に 1 回 max。
       * Claude CLI の思考インジケータ（Cogitating for Xs · Y tokens 等）を抽出して表示
       */
      const sendHeartbeat = () => {
        const now = Date.now();
        if (now - lastBulletStreamAt < HEARTBEAT_QUIET_AFTER_BULLET_MS) return;
        if (now - lastHeartbeatAt < HEARTBEAT_INTERVAL_MS) return;
        lastHeartbeatAt = now;
        const indicator = extractThinkingIndicator(lastRenderedForChangeTracking);
        const elapsedSec = Math.round((now - execStartedAt) / 1000);
        if (indicator) {
          opts.onOutput(`\n⏳ [${elapsedSec}s 経過] ${indicator}\n`);
        } else {
          opts.onOutput(`\n⏳ [${elapsedSec}s 経過] 応答待機中...\n`);
        }
      };

      completionCheckInterval = setInterval(() => {
        if (finished || !execStarted) return;

        // ストリーミング: 完了条件と無関係に、新規バレットがあれば毎チェックで流す
        streamNewBullets();

        // 承認応答待ち中は完了しない（ユーザーの応答前に終わらせると Claude の続きの応答を取り逃がす）
        if (pendingApprovalCount > 0) {
          logSkip('approval-pending', `count=${pendingApprovalCount}`);
          return;
        }
        const elapsedSinceExec = Date.now() - execStartedAt;
        const elapsedSinceChange = Date.now() - lastScreenChangeAt;
        // プロンプト送信完了までは echo を真の応答と誤認しないようスキップ
        if (elapsedSinceExec < EXEC_COOLDOWN_MS) {
          logSkip('cooldown', `${elapsedSinceExec}/${EXEC_COOLDOWN_MS}ms`);
          return;
        }
        // Claude の「思考フェーズ」初期は PTY が無音になる（API リクエスト送信 → first token までの latency）。
        // この間に「画面アイドル + プロンプト復帰」だけで完了判定すると、プロンプト submit 直後の round-trip 待ちを
        // 「処理完了」と誤認してしまう（実機 PTY ログで確定）。
        // 応答 1 個目の `●` バレット（baseline の count を超える新規描画）が出るまでは完了とみなさない
        const currentBulletLines = getBulletLines(lastRenderedForChangeTracking);
        const newBullets = countNewBullets(baselineBulletMap, currentBulletLines);
        if (newBullets === 0) {
          // First-bullet safety timeout: 5 分以上待っても `●` が出ない = 詰まっている可能性大。
          // 10 分 IDLE_TIMEOUT を待つより早く諦めて /exit で正規終了させる
          if (elapsedSinceExec > FIRST_BULLET_TIMEOUT_MS) {
            console.warn(`⏰ [terminal-mode] first-bullet timeout (${elapsedSinceExec}ms > ${FIRST_BULLET_TIMEOUT_MS}ms) — Claude did not produce a ● bullet, forcing completion`);
            finish('first-bullet-timeout');
            return;
          }
          // バレット未到来時はハートビート送信（思考中であることをユーザーに伝える）
          sendHeartbeat();
          logSkip('no-new-bullet', `current=${currentBulletLines.length} baseline=${baselineBulletMap.size}unique renderedLen=${lastRenderedForChangeTracking.length} elapsedSinceExec=${elapsedSinceExec}ms`);
          return;
        }
        if (elapsedSinceChange < IDLE_FOR_COMPLETION_MS) {
          logSkip('not-idle', `${elapsedSinceChange}/${IDLE_FOR_COMPLETION_MS}ms new=${newBullets}`);
          return;
        }
        if (!detectPromptReady(lastRenderedForChangeTracking)) {
          logSkip('prompt-not-ready', `idle=${elapsedSinceChange}ms new=${newBullets}`);
          return;
        }
        if (detectToolApprovalPrompt(lastRenderedForChangeTracking)) {
          logSkip('tool-approval-visible', `idle=${elapsedSinceChange}ms new=${newBullets}`);
          return;
        }
        // 画面が 1.5 秒間変化なし + プロンプト復帰中 + 新規バレットあり → 完了
        console.log(`✅ [terminal-mode] screen idle ${elapsedSinceChange}ms + prompt ready + ${newBullets} new bullet(s), completing`);
        finish('idle-and-prompt-ready');
      }, CHECK_INTERVAL_MS);
    };

    ptyProcess.onExit(({ exitCode, signal }) => {
      if (finished) return;
      finished = true;
      if (idleTimer) clearTimeout(idleTimer);
      if (startupTimer) clearTimeout(startupTimer);
      runningProcesses.delete(opts.sessionId);
      logStream?.end();
      console.log(`🖥️ [terminal-mode] pty exited (code=${exitCode}, signal=${signal})`);
      const finalOutput = extractFinalOutput(term);
      resolve({
        finalOutput,
        durationMs: Date.now() - start,
        timedOut,
        cancelledByAskDisable,
      });
    });

    // 初回アイドルタイマー起動
    resetIdleTimer();
  });
}

/**
 * キャンセル: 実行中の PTY プロセスを停止する
 * cancelAiSession から呼び出される
 */
export function cancelTerminalProcess(sessionId: string): boolean {
  const proc = runningProcesses.get(sessionId);
  if (!proc) return false;
  try {
    proc.kill();
    console.log(`🛑 [terminal-mode] cancelled session ${sessionId}`);
  } catch {
    // already exited
  }
  runningProcesses.delete(sessionId);
  return true;
}
