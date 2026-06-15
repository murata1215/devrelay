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
import { saveClaudeSessionId } from './session-store.js';
import {
  detectPromptReady,
  detectToolApprovalPrompt,
  detectAskQuestionPrompt,
  detectStartupChoicePrompt,
  extractFinalOutput,
  extractClaudeResponse,
  extractChoicePrompt,
  extractThinkingIndicator,
  extractClaudeSessionIdFromBuffer,
  getBulletLines,
  bulletCountMap,
  countNewBullets,
  isToolCallBullet,
  isLikelyPartialBullet,
  parseSessionJsonlUsage,
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

/** 完了判定: プロンプト復帰 + 画面アイドル時間（onData の頻度に依存しない判定基準）。
 *  Claude CLI はツール（Bash 等）完了後、次の API トークンが届くまで `❯` プロンプトを
 *  一瞬表示する。この隙間が閾値を超えると「応答完了」と誤認して /exit を送る事故が
 *  発生した（#233 pixblog exec が 14 秒で kill された件）。
 *  API レスポンス遅延を考慮して 5 秒に設定。真の完了時の追加待機は +3.5 秒のみ。 */
const IDLE_FOR_COMPLETION_MS = 5000;

/** プロンプト送信開始からこの時間が経つまでは「画面アイドル」を完了と判定しない（プロンプト書き込み中の偽 idle 防止） */
const EXEC_COOLDOWN_MS = 3500;

/** First-bullet safety timeout: submit 後この時間が経っても `●` バレットが 1 つも出なければ強制完了（無限ハング防止）。
 *  画像複数枚 + 長セッションだと 5 分超は普通に発生するので 10 分に緩和 */
const FIRST_BULLET_TIMEOUT_MS = 10 * 60_000;

/** 診断ログ: fresh rendered の末尾を 60s ごとに 1 回 dump（将来同様の症状調査用） */
const SCREEN_DUMP_INTERVAL_MS = 60_000;

/** completion check スキップ理由ログの throttle 間隔（毎 500ms 出すと spam になるため） */
const SKIP_LOG_THROTTLE_MS = 5_000;

/** Heartbeat 表示の最小間隔（思考フェーズで「死んでない」が伝わるように WebUI に流す）*/
const HEARTBEAT_INTERVAL_MS = 30_000;

/** バレット送信直後はハートビートを抑制する期間（連射時に混じらないように） */
const HEARTBEAT_QUIET_AFTER_BULLET_MS = 20_000;

/** ストリーミング送信するバレットテキストの最大文字数（長い応答は切詰めて 1 行化） */
const STREAM_BULLET_MAX_CHARS = 200;

/** バレットが安定したと判定するまでの連続観測 tick 数（CHECK_INTERVAL_MS × N = 待機時間）。
 *  Claude CLI のストリーミング rendering 中の部分文字列を流さないためのデバウンス */
const STREAM_DEBOUNCE_TICKS = 3;

/** 延長アイドル完了の閾値: detectPromptReady が false でも、これだけ画面変化が無ければ完了発火。
 *  Claude が npm build 等のバックグラウンドタスク実行中は `❯` カーソルが隠れて
 *  detectPromptReady が永遠に false を返すため、long idle で完了させる safety net */
const EXTENDED_IDLE_FOR_COMPLETION_MS = 30_000;

/** startup choice 応答から promptReady 検出までのクールダウン。
 *  Claude CLI が bypass/trust 画面→メイン UI 遷移 + プロジェクトスキャン + 入力ハンドラ初期化
 *  を完了するまでの猶予。3 秒に設定（大規模プロジェクトの初回スキャンを考慮）
 *  #237: bypass 承認直後に promptReady を検出してプロンプト送信→テキスト消失した事故の対策 */
const STARTUP_CHOICE_COOLDOWN_MS = 3000;

/** プロンプトをチャンクに分割するサイズ（PTY/CLI バッファのオーバーフローや誤解釈を防ぐ） */
const PROMPT_CHUNK_SIZE = 200;

/** チャンク間の待機時間 */
const PROMPT_CHUNK_DELAY_MS = 30;

/** プロンプト末尾投入から submit (\r) 送信までの待機時間。
 *  Windows ConPTY では Ink TextInput の入力バッファ処理に時間がかかるため
 *  1000ms に設定（#237: 400ms では \r が受理されない事象） */
const PROMPT_SUBMIT_DELAY_MS = 1000;

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
  /** PTY プロセスの終了コード（正常完了=0, crash=1 等。finish() 経由の場合は undefined） */
  exitCode?: number;
  /** Ask 無効により中断したか */
  cancelledByAskDisable: boolean;
  /** ユーザープロンプトが実際に Claude CLI に送信されたか（false = 起動段階で exit した） */
  promptSent: boolean;
  /** JSONL セッションファイルから集計した使用量データ（Conversations 表示用） */
  usageData?: import('@devrelay/shared').AiUsageData;
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
  /** startup choice に応答した時刻（クールダウン判定用） */
  let lastChoiceAnsweredAt = 0;
  let execStartedAt = 0;
  /** セッション中に一度でも新規バレット（`●`）が観測されたかフラグ。
   *  ツール実行中に `●` が画面から消えても first-bullet-timeout を適用しないために使う（#237） */
  let bulletEverObserved = false;
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
        // Claude CLI exit 時に出る「Resume this session with: claude --resume <UUID>」から
        // session id を抽出して `.devrelay/claude-session-id` に保存。次回 terminal mode
        // 起動時に --resume で会話継続できるようにする（SDK Claude と同じファイルを共有）
        // promptSent=false の場合は保存しない（壊れたセッション ID の残留防止, #237）
        const claudeSessionId = extractClaudeSessionIdFromBuffer(finalOutput);
        if (claudeSessionId && promptSent) {
          saveClaudeSessionId(opts.projectPath, claudeSessionId).catch(err => {
            console.warn(`⚠️ [terminal-mode] failed to save Claude session id: ${(err as Error).message}`);
          });
          console.log(`💾 [terminal-mode] captured Claude session id: ${claudeSessionId.slice(0, 8)}...`);
        }
        resolve({
          finalOutput,
          durationMs: Date.now() - start,
          timedOut,
          cancelledByAskDisable,
          promptSent,
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
      //
      // 検出は画面末尾 30 行のみ対象: scrollback 上部に確認済み prompt が残っていると
      // 二重検出されて同じ trust prompt が再 forwarding される事故が発生（#235 pixdraft）
      const tailForChoice = rendered.split('\n').slice(-30).join('\n');
      if (!pendingStartupChoice && detectStartupChoicePrompt(tailForChoice)) {
        const meta = extractChoicePrompt(tailForChoice);
        if (meta && meta.options.length >= 2) {
          // hash は options のみ: question は画面上部の内容に依存して不安定なため
          const hash = crypto.createHash('sha1')
            .update(meta.options.join('|'))
            .digest('hex').slice(0, 16);

          if (!handledStartupChoiceHashes.has(hash)) {
            handledStartupChoiceHashes.add(hash);
            pendingStartupChoice = true;
            const elapsed = Date.now() - start;

            // --dangerously-skip-permissions の bypass permissions 確認プロンプトを自動承認:
            // 「1. No, exit / 2. Yes, I accept」形式。trust prompt（1. Yes / 2. No）とは逆順。
            // approveAllMode=true なら --dangerously-skip-permissions を明示指定済みなので
            // ユーザーに聞く意味がなく、"Yes, I accept" を自動選択する（#237）
            const acceptOptionIdx = meta.options.findIndex(o => /yes.*accept/i.test(o));
            if (opts.approveAllMode && acceptOptionIdx >= 0) {
              const choice = acceptOptionIdx + 1; // 1-indexed
              console.log(`🔐 [terminal-mode] bypass permissions prompt auto-accepted (option ${choice}, ${elapsed}ms after spawn)`);
              try {
                if (choice > 1) {
                  ptyProcess.write('\x1B[B'.repeat(choice - 1));
                  setTimeout(() => { try { ptyProcess.write('\r'); } catch { /* ignore */ } }, 200);
                } else {
                  setTimeout(() => { try { ptyProcess.write('\r'); } catch { /* ignore */ } }, 200);
                }
              } catch {
                // ignore
              }
              pendingStartupChoice = false;
              lastChoiceAnsweredAt = Date.now();
              installStartupTimer();
              return;
            }

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
                  // startup prompt はカーソル選択型 UI（❯ ↑↓ + Enter）なので
                  // 番号タイプではなく矢印キー移動 + Enter で選択する。
                  // 番号入力（`1\r`）は Claude CLI の SelectInput を混乱させて
                  // Enter が効かなくなる事象が確認された（#234 clipped trust prompt）
                  try {
                    if (choice > 1) {
                      // option 1 がデフォルト選択。N > 1 は ↓ を (N-1) 回押してから Enter
                      ptyProcess.write('\x1B[B'.repeat(choice - 1));
                      setTimeout(() => { try { ptyProcess.write('\r'); } catch { /* ignore */ } }, 100);
                    } else {
                      // option 1 はデフォルト → Enter のみ
                      ptyProcess.write('\r');
                    }
                  } catch {
                    // ignore
                  }
                  pendingStartupChoice = false;
                  lastChoiceAnsweredAt = Date.now();
                  // 応答後のレンダリング待ちで startup timer を再起動（summary 生成は 30-60s かかる）
                  installStartupTimer();
                },
              });
            } else {
              // フォールバック: onChoiceRequest 未配線 → option 1 自動選択（後方互換）
              console.log(`🔐 [terminal-mode] no choice callback configured → auto-selecting option 1 (${elapsed}ms after spawn): "${meta.question.slice(0, 80)}"`);
              try {
                ptyProcess.write('\r');  // option 1 はデフォルト → Enter のみ
              } catch {
                // ignore
              }
              pendingStartupChoice = false;
              lastChoiceAnsweredAt = Date.now();
              installStartupTimer();
            }
          }
          return;
        }
      }

      // startup choice 応答後のクールダウン: Claude CLI が画面遷移・入力ハンドラ初期化を
      // 完了するまで promptReady を検出しない（#237: bypass 承認後にプロンプトが消失した事故）
      if (lastChoiceAnsweredAt > 0 && (Date.now() - lastChoiceAnsweredAt < STARTUP_CHOICE_COOLDOWN_MS)) {
        return;
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

      // raw PTY ストリーム中の `●` マーカーを検出して bulletEverObserved をセット。
      // Ink UI が `[2J]` (clear screen) で画面を頻繁にクリア・再描画するため、
      // xterm 仮想画面上では `●` が一瞬で消える。500ms 間隔の完了チェックでは
      // 捉えられないバレットを、raw ストリームで先に検出しておく（#237）
      if (execStarted && !bulletEverObserved && data.includes('●')) {
        bulletEverObserved = true;
        console.log(`📊 [terminal-mode] bullet observed in raw PTY data (bulletEverObserved=true)`);
      }

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

      // 実行開始後: select 型選択肢プロンプト（AskUserQuestion / その他「Enter to select」型）の処理。
      // `detectToolApprovalPrompt` は末尾独立 `❯` 入力行型専用なので、
      // 「❯ 1. ...」の navigation 型はここで別経路として検出する。
      // approveAllMode でも AskUserQuestion はユーザーに聞くべきなのでガードしない
      //
      // 検出は画面末尾 30 行のみ: scrollback 残骸の二重検出を防止（#235）
      const midTailForChoice = rendered.split('\n').slice(-30).join('\n');
      if (execStarted && !finished && !pendingStartupChoice && detectStartupChoicePrompt(midTailForChoice)) {
        const meta = extractChoicePrompt(midTailForChoice);
        if (meta && meta.options.length >= 2) {
          // hash は options のみ（question は画面上部に依存して不安定）
          const hash = crypto.createHash('sha1')
            .update(meta.options.join('|'))
            .digest('hex').slice(0, 16);

          if (!handledStartupChoiceHashes.has(hash)) {
            handledStartupChoiceHashes.add(hash);
            pendingStartupChoice = true;
            pendingApprovalCount++;  // completion check の暴発を防ぐ

            if (opts.onChoiceRequest) {
              const requestId = crypto.randomUUID();
              console.log(`📜 [terminal-mode] mid-session choice prompt → forwarding to user (${meta.options.length} options, requestId=${requestId.slice(0, 8)}): "${meta.question.slice(0, 80)}"`);
              opts.onChoiceRequest({
                requestId,
                question: meta.question,
                options: meta.options,
                respond: (optionIndex: number) => {
                  if (finished) return;
                  const choice = Math.max(0, Math.min(meta.options.length - 1, optionIndex)) + 1;
                  console.log(`✅ [terminal-mode] user chose option ${choice} for mid-session choice (requestId=${requestId.slice(0, 8)})`);
                  // mid-session choice もカーソル選択型 UI（Enter to confirm パターン）なので
                  // 矢印キー + Enter で選択する（startup choice と同じ理由）
                  try {
                    if (choice > 1) {
                      ptyProcess.write('\x1B[B'.repeat(choice - 1));
                      setTimeout(() => { try { ptyProcess.write('\r'); } catch { /* ignore */ } }, 100);
                    } else {
                      ptyProcess.write('\r');
                    }
                  } catch {
                    // ignore
                  }
                  pendingStartupChoice = false;
                  pendingApprovalCount = Math.max(0, pendingApprovalCount - 1);
                  resetIdleTimer();
                },
              });
            } else {
              // フォールバック: onChoiceRequest 未配線 → option 1 自動選択（後方互換）
              console.log(`🔐 [terminal-mode] no choice callback configured → auto-selecting option 1: "${meta.question.slice(0, 80)}"`);
              try {
                ptyProcess.write('\r');  // option 1 はデフォルト → Enter のみ
              } catch {
                // ignore
              }
              pendingStartupChoice = false;
              pendingApprovalCount = Math.max(0, pendingApprovalCount - 1);
            }
          }
          return;  // tool approval block にフォールスルーしない
        }
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

      // submit 後の画面変化を確認。Windows ConPTY + Ink TextInput で \r が受理されない
      // ケースがあるため、画面が変化するまで \r をリトライする（#237）
      const screenLenBefore = extractFinalOutput(term).length;
      for (let retry = 0; retry < 3; retry++) {
        await new Promise(r => setTimeout(r, 1000));
        if (finished) return;
        const screenLenAfter = extractFinalOutput(term).length;
        if (screenLenAfter !== screenLenBefore) {
          console.log(`📨 [terminal-mode] screen changed after submit (${screenLenBefore} → ${screenLenAfter})`);
          break;
        }
        console.warn(`⚠️ [terminal-mode] screen unchanged ${retry + 1}s after submit, retrying \\r (attempt ${retry + 2})`);
        ptyProcess.write('\r');
      }
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
      //   sentBulletTexts: WebUI に既に送ったバレットテキスト集合（一度送ったら二度と送らない）
      //   pendingBullets: 候補となったバレットの「最初に観測した tick」を記録（debounce 用）
      //   tickCount: completion check の累積 tick 数（debounce 比較基準）
      //   lastBulletStreamAt: 最後にバレットを流した時刻（ハートビート抑制判断用）
      //   lastHeartbeatAt: 最後にハートビートを流した時刻
      //   lastScreenDumpAt: 最後に画面末尾を診断ログに dump した時刻
      //
      // **Set ベース + prefix フィルタ + debounce を使う理由**:
      // - 完了判定 (`countNewBullets`) は Map<text,count> 差分で「Claude の進捗」を測る
      // - ストリーミングは「ユーザーに見せる新規発言」が単位
      //   1. Set<text> で同じテキストの scrollback 重複コピーをブロック
      //   2. **Prefix フィルタ**: 別の候補がこのテキストを prefix として持つ → 部分文字列スキップ
      //      （Claude のストリーミング rendering 途中で「ビルド設定を確認し」が出て、後で
      //       「ビルド設定を確認しました。…」が出る現象を吸収）
      //   3. **Debounce (3 tick = 1.5s)**: バレットが連続 3 tick 同じテキストで安定したら送信。
      //      その間に長文に置き換われば pending から削除されるので部分文字列は流れない
      const sentBulletTexts = new Set<string>();
      const pendingBullets = new Map<string, number>();
      let tickCount = 0;
      let lastBulletStreamAt = Date.now();
      let lastHeartbeatAt = 0;
      let lastScreenDumpAt = 0;

      /**
       * 新規バレットを WebUI にストリーミング配信する。
       * - baseline に含まれるテキスト（履歴の bullet）→ スキップ
       * - 既に送ったテキスト → スキップ
       * - 別の候補テキストがこのテキストを prefix として含む → 部分文字列スキップ
       * - 連続 STREAM_DEBOUNCE_TICKS (1.5s) 同じテキストで安定したら送信
       *
       * これで Claude CLI のストリーミング rendering 中の部分文字列を吸収できる
       */
      const streamNewBullets = (rendered: string) => {
        tickCount++;
        const currentLines = getBulletLines(rendered);

        // 候補集合: baseline / 既送信 / ツール呼び出しバレット / 途中切れ partial を除外
        const candidates = new Set<string>();
        for (const text of currentLines) {
          if (sentBulletTexts.has(text)) continue;
          if (baselineBulletMap.has(text)) continue;
          if (isToolCallBullet(text)) continue;
          if (isLikelyPartialBullet(text)) continue;
          candidates.add(text);
        }

        // cleanup: pending にあったが候補から消えたテキスト（長文に置き換わった/scroll-out）
        for (const text of Array.from(pendingBullets.keys())) {
          if (!candidates.has(text)) pendingBullets.delete(text);
        }

        for (const text of candidates) {
          // Prefix フィルタ: 別の候補がこのテキストを prefix として持つ → 部分文字列
          let isPartialOfAnother = false;
          for (const other of candidates) {
            if (other !== text && other.startsWith(text)) {
              isPartialOfAnother = true;
              break;
            }
          }
          if (isPartialOfAnother) {
            pendingBullets.delete(text);
            continue;
          }

          // Debounce: 連続 N tick 安定したら送信
          const firstSeenTick = pendingBullets.get(text);
          if (firstSeenTick === undefined) {
            pendingBullets.set(text, tickCount);
          } else if (tickCount - firstSeenTick >= STREAM_DEBOUNCE_TICKS) {
            const display = text.length > STREAM_BULLET_MAX_CHARS
              ? text.slice(0, STREAM_BULLET_MAX_CHARS) + '…'
              : text;
            opts.onOutput(display + '\n');
            sentBulletTexts.add(text);
            pendingBullets.delete(text);
            lastBulletStreamAt = Date.now();
          }
        }
      };

      /**
       * 思考フェーズの「死んでない」ハートビートを送る。
       * バレットが最近送られていない時のみ・30 秒に 1 回 max。
       * Claude CLI の思考インジケータ（Cogitating for Xs · Y tokens 等）を抽出して表示
       */
      const sendHeartbeat = (rendered: string) => {
        const now = Date.now();
        if (now - lastBulletStreamAt < HEARTBEAT_QUIET_AFTER_BULLET_MS) return;
        if (now - lastHeartbeatAt < HEARTBEAT_INTERVAL_MS) return;
        lastHeartbeatAt = now;
        const indicator = extractThinkingIndicator(rendered);
        const elapsedSec = Math.round((now - execStartedAt) / 1000);
        if (indicator) {
          opts.onOutput(`\n⏳ [${elapsedSec}s 経過] ${indicator}\n`);
        } else {
          opts.onOutput(`\n⏳ [${elapsedSec}s 経過] 応答待機中...\n`);
        }
      };

      completionCheckInterval = setInterval(() => {
        if (finished || !execStarted) return;

        // 毎チェックで fresh render を取得する（lastRenderedForChangeTracking は onData が
        // 止まっている時にフリーズしてしまうことが実機で確認された 2026-05-24 mviewer ハング）。
        // この tick でトラッカーも更新するので、idle 判定も最新の画面状態に基づく
        const freshRendered = extractFinalOutput(term);
        if (freshRendered !== lastRenderedForChangeTracking) {
          lastScreenChangeAt = Date.now();
          lastRenderedForChangeTracking = freshRendered;
        }

        // ストリーミング: 完了条件と無関係に、新規バレットがあれば毎チェックで流す
        streamNewBullets(freshRendered);

        // 60s に 1 回、画面末尾を診断ログに dump（将来同様の症状の調査用）
        const nowForDump = Date.now();
        if (nowForDump - lastScreenDumpAt > SCREEN_DUMP_INTERVAL_MS) {
          lastScreenDumpAt = nowForDump;
          const tail = freshRendered.length > 200 ? freshRendered.slice(-200) : freshRendered;
          console.log(`📷 [terminal-mode] screen tail (${freshRendered.length} chars total, elapsedSinceExec=${Date.now() - execStartedAt}ms):\n${tail.replace(/\n/g, '⏎')}`);
        }

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
        const currentBulletLines = getBulletLines(freshRendered);
        const newBullets = countNewBullets(baselineBulletMap, currentBulletLines);
        if (newBullets > 0) {
          bulletEverObserved = true;
        }
        if (newBullets === 0) {
          if (!bulletEverObserved) {
            // 初期フェーズ: バレットが一度も出ていない → first-bullet-timeout 適用
            if (elapsedSinceExec > FIRST_BULLET_TIMEOUT_MS) {
              console.warn(`⏰ [terminal-mode] first-bullet timeout (${elapsedSinceExec}ms > ${FIRST_BULLET_TIMEOUT_MS}ms) — Claude did not produce a ● bullet, forcing completion`);
              finish('first-bullet-timeout');
              return;
            }
            sendHeartbeat(freshRendered);
            logSkip('no-new-bullet', `current=${currentBulletLines.length} baseline=${baselineBulletMap.size}unique renderedLen=${freshRendered.length} elapsedSinceExec=${elapsedSinceExec}ms`);
            return;
          }
          // バレットは過去に出たが現在画面から消えている（ツール実行中等）
          // first-bullet-timeout は適用せず、extended-idle / prompt-ready にフォールスルーする（#237）
          sendHeartbeat(freshRendered);
          logSkip('bullets-hidden', `current=${currentBulletLines.length} baseline=${baselineBulletMap.size}unique renderedLen=${freshRendered.length} elapsedSinceExec=${elapsedSinceExec}ms bulletEverObserved=true`);
          // ↓ フォールスルー: idle check / prompt-ready / extended-idle をチェック
        }
        if (elapsedSinceChange < IDLE_FOR_COMPLETION_MS) {
          logSkip('not-idle', `${elapsedSinceChange}/${IDLE_FOR_COMPLETION_MS}ms new=${newBullets}`);
          return;
        }
        if (detectToolApprovalPrompt(freshRendered)) {
          logSkip('tool-approval-visible', `idle=${elapsedSinceChange}ms new=${newBullets}`);
          return;
        }
        // Claude CLI が「N shell(s) still running」と表示中はバックグラウンドプロセスが動いている。
        // この状態で完了すると /exit でプロセスが kill されるため、完了を抑制する（#237）
        const hasRunningShells = /still running/i.test(freshRendered);
        if (hasRunningShells) {
          logSkip('shells-running', `idle=${elapsedSinceChange}ms new=${newBullets}`);
          return;
        }
        if (detectPromptReady(freshRendered)) {
          // 画面が 5 秒間変化なし + プロンプト復帰中 + 新規バレットあり → 完了
          console.log(`✅ [terminal-mode] screen idle ${elapsedSinceChange}ms + prompt ready + ${newBullets} new bullet(s), completing`);
          finish('idle-and-prompt-ready');
          return;
        }
        // 延長アイドル完了パス: ❯ カーソルが隠れていても（npm build 等のバックグラウンドタスク
        // 実行中に発生）、30 秒以上画面変化が無ければ Claude は実質応答完了とみなして finish
        if (elapsedSinceChange >= EXTENDED_IDLE_FOR_COMPLETION_MS) {
          console.log(`✅ [terminal-mode] extended idle ${elapsedSinceChange}ms + ${newBullets} new bullet(s), completing (❯ cursor hidden)`);
          finish('extended-idle-complete');
          return;
        }
        logSkip('prompt-not-ready', `idle=${elapsedSinceChange}ms new=${newBullets}`);
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
      // 異常 exit の場合、画面内容をログに残す（エラー原因の診断用）
      if (exitCode !== 0) {
        const tail = finalOutput.length > 500 ? finalOutput.slice(-500) : finalOutput;
        const phase = promptSent ? 'after prompt sent' : 'before prompt sent';
        console.error(`❌ [terminal-mode] PTY exited with code=${exitCode} ${phase}. Last 500 chars:\n--- BEGIN SCREEN ---\n${tail}\n--- END SCREEN ---`);
      }
      // 画面に Claude session id があれば保存して次回 --resume で継続可能にする。
      // ただし promptSent=false（起動失敗等）の場合は保存しない — 壊れた/空のセッション ID で
      // 次回 --resume すると不安定な挙動になる（#237: bypass "No, exit" の session ID が残留した事故）
      const claudeSessionId = extractClaudeSessionIdFromBuffer(finalOutput);
      if (claudeSessionId && promptSent) {
        saveClaudeSessionId(opts.projectPath, claudeSessionId).catch(err => {
          console.warn(`⚠️ [terminal-mode] failed to save Claude session id: ${(err as Error).message}`);
        });
        console.log(`💾 [terminal-mode] captured Claude session id: ${claudeSessionId.slice(0, 8)}...`);
      } else if (claudeSessionId && !promptSent) {
        console.log(`⏭️ [terminal-mode] skipping session id save (promptSent=false): ${claudeSessionId.slice(0, 8)}...`);
      }

      // JSONL セッションファイルから usageData を集計（Conversations の Model/Tokens 表示用）
      // セッション ID は「今回抽出したもの」または「--resume で渡されたもの」を使う
      const effectiveSessionId = claudeSessionId || opts.resumeSessionId;
      let usageData: import('@devrelay/shared').AiUsageData | undefined;
      if (effectiveSessionId) {
        const parsed = parseSessionJsonlUsage(opts.projectPath, effectiveSessionId);
        if (parsed) {
          // durationMs は JSONL に含まれないため、PTY 実行時間を使う
          parsed.durationMs = Date.now() - start;
          usageData = parsed;
        }
      }
      // JSONL からの取得に失敗した場合でも durationMs だけは記録（#238）
      // Claude CLI インタラクティブモードは JSONL を書き出さないため、
      // Duration 列だけでも Conversations 画面に表示する
      if (!usageData) {
        usageData = {
          durationMs: Date.now() - start,
        };
      }

      resolve({
        finalOutput,
        durationMs: Date.now() - start,
        timedOut,
        cancelledByAskDisable,
        promptSent,
        exitCode: exitCode ?? undefined,
        usageData,
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
