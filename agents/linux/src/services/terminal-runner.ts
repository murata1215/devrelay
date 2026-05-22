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
  detectTrustPrompt,
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

/** 仮想ターミナルからのスナップショット送信間隔（ストリーミング表示用） */
const SNAPSHOT_INTERVAL_MS = 250;

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

  let promptReady = false;
  let execStarted = false;
  let promptSent = false;
  let finished = false;
  let timedOut = false;
  let cancelledByAskDisable = false;
  let trustConfirmed = false;
  let execStartedAt = 0;
  let idleTimer: NodeJS.Timeout | null = null;
  let startupTimer: NodeJS.Timeout | null = null;
  let snapshotTimer: NodeJS.Timeout | null = null;
  /** プロンプト復帰後、安定期間（追加データなし）を待つタイマー。発火で完了確定 */
  let stableReturnTimer: NodeJS.Timeout | null = null;
  /** 直前にユーザーへ送信したスナップショット（差分計算用） */
  let lastSnapshot = '';

  /**
   * 仮想ターミナル（@xterm/headless）の現在の画面状態を抽出し、
   * 前回送信分との差分を上位にストリーミングする。
   *
   * 生 PTY チャンクに `strip-ansi` するだけだとカーソル移動 ANSI で位置調整された
   * テキストが密着してしまう（"Accessing workspace" → "Accessingworkspace"）。
   * 仮想画面でレンダリングしてから抽出することで人間が読める形に整形される。
   *
   * `promptSent` が false の間（= ユーザープロンプト送信前）は履歴の再描画なので
   * 上位に送らず、`lastSnapshot` を更新するだけにする（履歴を ベースライン化）。
   * 送信後はベースラインからの差分のみが流れるため、ユーザーには Claude の応答だけが見える
   */
  const sendSnapshot = (terminal: typeof term, push: (s: string) => void) => {
    const current = extractFinalOutput(terminal);
    if (current === lastSnapshot) return;

    if (!promptSent) {
      // 起動・履歴再描画中はベースラインを更新するだけ（出力抑制）
      lastSnapshot = current;
      return;
    }

    let delta: string;
    if (current.startsWith(lastSnapshot)) {
      delta = current.slice(lastSnapshot.length);
    } else {
      // 画面が再描画でリセットされた場合は新しい全体を送信
      delta = '\n' + current;
    }
    if (delta.length > 0) {
      push(delta);
    }
    lastSnapshot = current;
  };

  return new Promise<TerminalRunResult>((resolve, reject) => {
    const finish = (reason: string) => {
      if (finished) return;
      finished = true;
      if (idleTimer) clearTimeout(idleTimer);
      if (startupTimer) clearTimeout(startupTimer);
      if (snapshotTimer) {
        clearTimeout(snapshotTimer);
        snapshotTimer = null;
      }
      if (stableReturnTimer) {
        clearTimeout(stableReturnTimer);
        stableReturnTimer = null;
      }
      console.log(`🖥️ [terminal-mode] finishing (${reason})`);

      // 最後のスナップショットを確実に送信
      sendSnapshot(term, opts.onOutput);

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

    /** スナップショット送信をスロットルで予約 */
    const scheduleSnapshot = () => {
      if (snapshotTimer) return;
      snapshotTimer = setTimeout(() => {
        snapshotTimer = null;
        if (!finished) sendSnapshot(term, opts.onOutput);
      }, SNAPSHOT_INTERVAL_MS);
    };

    // 起動タイムアウト
    startupTimer = setTimeout(() => {
      if (!promptReady) {
        // 起動失敗時に画面の最後 500 文字をログに残す（検出ロジック改善のための調査材料）
        const rendered = extractFinalOutput(term);
        const tail = rendered.length > 500 ? rendered.slice(-500) : rendered;
        console.error(`❌ [terminal-mode] startup timeout (${STARTUP_TIMEOUT_MS}ms). Last 500 chars of rendered screen:\n--- BEGIN SCREEN ---\n${tail}\n--- END SCREEN ---`);
        // 最後のスナップショットを送信して状況を可視化
        sendSnapshot(term, opts.onOutput);
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

    ptyProcess.onData((data) => {
      term.write(data);
      logStream?.write(data);

      resetIdleTimer();
      scheduleSnapshot();

      // 検出は仮想画面でレンダリング済みのテキストに対して行う。
      // raw PTY バッファに strip-ansi するだけだとカーソル位置指定で配置された
      // 単語が密着してしまう（"trust this folder" → "trustthisfolder"）ため、
      // 仮想画面でのレンダリング結果を使うことで視認できる空白で正しく判定できる
      const rendered = extractFinalOutput(term);

      // フォルダ信頼確認プロンプト: --dangerously-skip-permissions を付けても
      // 初回ワークスペースでは出るため、自動で Enter を送って承認する。
      // ユーザーが端末モードを ON にしたという明示的選択がトリガなので、無人自動承認ではない。
      if (!trustConfirmed && detectTrustPrompt(rendered)) {
        trustConfirmed = true;
        console.log(`🔐 [terminal-mode] trust folder prompt → auto-confirming`);
        try {
          ptyProcess.write('\r');  // デフォルト選択 "1. Yes, I trust this folder" を Enter で確定
        } catch {
          // ignore
        }
        return;
      }

      // 起動完了検出
      if (!promptReady) {
        if (detectPromptReady(rendered)) {
          promptReady = true;
          if (startupTimer) {
            clearTimeout(startupTimer);
            startupTimer = null;
          }
          console.log(`✅ [terminal-mode] prompt ready, sending user prompt (${opts.prompt.length} chars)`);
          // 履歴再描画分はベースラインとして固定。以降はこれからの差分のみが流れる
          lastSnapshot = rendered;
          // ユーザー向けヒント（履歴大量再描画後に何も流れない時間があるため目印を出す）
          opts.onOutput('\n📨 メッセージを送信しました。Claude の応答を待っています...\n\n');
          // プロンプト本文を送信（CRLF 終端で送信完了させる）
          ptyProcess.write(opts.prompt + '\r');
          promptSent = true;
          execStarted = true;
          execStartedAt = Date.now();
          return;
        }
        return;
      }

      // 実行開始後: tool 承認・質問・完了プロンプトを判定
      if (execStarted && !finished) {
        // Ask 無効化: 質問プロンプトを検出したら中断
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

        // tool 承認プロンプト検出（approveAllMode なら CLI 側で出ない想定だが念のため）
        if (!opts.approveAllMode && detectToolApprovalPrompt(rendered)) {
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
        // ただし以下を満たす必要がある:
        //  1. exec 送信から 2 秒以上経過（送信直後の echo 由来の偽復帰防止）
        //  2. プロンプト復帰検出後、1.5 秒間追加データが来ない（応答ストリーミング中の一時的復帰防止）
        if (detectPromptReady(rendered) && Date.now() - execStartedAt > 2000) {
          // 既に予約があれば cancel して再予約（onData ごとにアイドル時間を 0 に戻す）
          if (stableReturnTimer) clearTimeout(stableReturnTimer);
          stableReturnTimer = setTimeout(() => {
            stableReturnTimer = null;
            if (finished) return;
            // 1.5 秒間追加データなしで再評価。まだプロンプト復帰中なら真の完了
            const stillReady = detectPromptReady(extractFinalOutput(term));
            if (stillReady) {
              console.log(`✅ [terminal-mode] prompt returned (stable for 1.5s), completing`);
              finish('prompt-ready');
            }
          }, 1500);
        } else if (stableReturnTimer) {
          // プロンプト復帰でないデータが来た → 安定タイマーをキャンセル
          clearTimeout(stableReturnTimer);
          stableReturnTimer = null;
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
