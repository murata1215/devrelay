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
import * as pty from 'node-pty';
import { Terminal } from '@xterm/headless';
import type { IPty } from 'node-pty';
import path from 'path';
import fs from 'fs';
import stripAnsi from 'strip-ansi';
import { getConfigDir } from './config.js';
import {
  detectPromptReady,
  detectToolApprovalPrompt,
  detectAskQuestionPrompt,
  extractFinalOutput,
} from './terminal-parser.js';

/** PTY サイズ */
const TERM_COLS = 120;
const TERM_ROWS = 40;

/** 起動完了（プロンプト復帰）の最大待機時間 */
const STARTUP_TIMEOUT_MS = 15_000;

/** アイドルタイムアウト（最終出力からこの時間無音で完了とみなす） */
const IDLE_TIMEOUT_MS = 10 * 60_000;

/** /exit 送信後にプロセスが終了するまでの猶予 */
const EXIT_GRACE_MS = 5_000;

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
  const term = new Terminal({ cols: TERM_COLS, rows: TERM_ROWS, allowProposedApi: true });

  const args: string[] = ['--continue'];
  if (opts.approveAllMode) {
    args.push('--dangerously-skip-permissions');
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

  let buffer = '';
  let promptReady = false;
  let execStarted = false;
  let finished = false;
  let timedOut = false;
  let cancelledByAskDisable = false;
  let idleTimer: NodeJS.Timeout | null = null;
  let startupTimer: NodeJS.Timeout | null = null;

  return new Promise<TerminalRunResult>((resolve, reject) => {
    const finish = (reason: string) => {
      if (finished) return;
      finished = true;
      if (idleTimer) clearTimeout(idleTimer);
      if (startupTimer) clearTimeout(startupTimer);
      console.log(`🖥️ [terminal-mode] finishing (${reason})`);

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

    // 起動タイムアウト
    startupTimer = setTimeout(() => {
      if (!promptReady) {
        console.error(`❌ [terminal-mode] startup timeout (${STARTUP_TIMEOUT_MS}ms)`);
        try {
          ptyProcess.kill();
        } catch {
          // ignore
        }
        runningProcesses.delete(opts.sessionId);
        logStream?.end();
        reject(new Error('端末モードの起動がタイムアウトしました（15 秒）'));
      }
    }, STARTUP_TIMEOUT_MS);

    ptyProcess.onData((data) => {
      term.write(data);
      buffer += data;
      logStream?.write(data);

      // ANSI 除去した断片を上位にストリーミング
      const cleaned = stripAnsi(data);
      if (cleaned.length > 0) {
        opts.onOutput(cleaned);
      }

      resetIdleTimer();

      // 起動完了検出
      if (!promptReady) {
        if (detectPromptReady(buffer)) {
          promptReady = true;
          if (startupTimer) {
            clearTimeout(startupTimer);
            startupTimer = null;
          }
          console.log(`✅ [terminal-mode] prompt ready, sending user prompt (${opts.prompt.length} chars)`);
          // プロンプト本文を送信（CRLF 終端で送信完了させる）
          ptyProcess.write(opts.prompt + '\r');
          execStarted = true;
          // 送信直後のプロンプト復帰はスキップしたいので buffer をクリア
          buffer = '';
          return;
        }
        return;
      }

      // 実行開始後: tool 承認・質問・完了プロンプトを判定
      if (execStarted && !finished) {
        // Ask 無効化: 質問プロンプトを検出したら中断
        if (opts.disableAsk && detectAskQuestionPrompt(buffer)) {
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

        // tool 承認プロンプト検出（approveAllMode なら CLI 側で出ない想定だが念のため）
        if (!opts.approveAllMode && detectToolApprovalPrompt(buffer)) {
          // Phase 1 では承認カード連動を見送り、ユーザーに「自動承認 ON にしてください」と促す
          // Phase 3 で WebUI 承認カードへの転送に置き換える
          console.log(`🔐 [terminal-mode] tool approval prompt detected → declining (Phase 1 limitation)`);
          try {
            ptyProcess.write('2\r'); // いいえを選択
          } catch {
            // ignore
          }
          return;
        }

        // 完了プロンプト（次のユーザー入力待ち）に戻ったら正規完了
        // ただし送信直後の echo を完了と誤検知しないよう、最低 2 秒のクールダウンを置く
        if (detectPromptReady(buffer)) {
          const elapsedSinceStart = Date.now() - start;
          if (elapsedSinceStart > 2000) {
            console.log(`✅ [terminal-mode] prompt returned, completing`);
            finish('prompt-ready');
          }
        }
      }
    });

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
