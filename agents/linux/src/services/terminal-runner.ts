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
  extractClaudeResponse,
  countClaudeBullets,
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

/** 画面変化監視・完了判定チェック間隔 */
const CHECK_INTERVAL_MS = 500;

/** 完了判定: プロンプト復帰 + 画面アイドル時間（onData の頻度に依存しない判定基準） */
const IDLE_FOR_COMPLETION_MS = 1500;

/** プロンプト送信開始からこの時間が経つまでは「画面アイドル」を完了と判定しない（プロンプト書き込み中の偽 idle 防止） */
const EXEC_COOLDOWN_MS = 3500;

/** プロンプトをチャンクに分割するサイズ（PTY/CLI バッファのオーバーフローや誤解釈を防ぐ） */
const PROMPT_CHUNK_SIZE = 200;

/** チャンク間の待機時間 */
const PROMPT_CHUNK_DELAY_MS = 30;

/** プロンプト末尾投入から submit (\r) 送信までの待機時間 */
const PROMPT_SUBMIT_DELAY_MS = 400;

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
  /** 画面が最後に変化した時刻（完了判定の「画面アイドル」基準） */
  let lastScreenChangeAt = Date.now();
  /** 画面変化追跡用の前回レンダリング結果 */
  let lastRenderedForChangeTracking = '';
  /** baseline 時点の Claude メッセージ（`●` 行）数。これより多ければ新規応答あり */
  let baselineBulletCount = 0;
  let idleTimer: NodeJS.Timeout | null = null;
  let startupTimer: NodeJS.Timeout | null = null;
  let completionCheckInterval: NodeJS.Timeout | null = null;

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
      console.log(`🖥️ [terminal-mode] finishing (${reason})`);

      // Claude の応答を抽出して送信（promptSent 後のみ意味のある応答が得られる）
      if (promptSent) {
        const finalRendered = extractFinalOutput(term);
        const currentBullets = countClaudeBullets(finalRendered);
        const newBullets = currentBullets - baselineBulletCount;
        console.log(`📊 [terminal-mode] completion bullets: baseline=${baselineBulletCount}, current=${currentBullets}, new=${newBullets}`);
        const response = extractClaudeResponse(finalRendered, baselineBulletCount);
        if (response) {
          opts.onOutput(response);
        } else {
          // 応答抽出失敗時のフォールバック: 原因と画面末尾を表示
          if (newBullets <= 0) {
            console.warn(`⚠️ [terminal-mode] no new Claude bullet (●) detected. Prompt may not have been submitted to Claude CLI.`);
            opts.onOutput(`\n⚠️ Claude が応答しませんでした。プロンプトの送信に失敗した可能性があります。\n（ヒント: 「自動承認」「Ask 無効」設定や、Claude CLI の状態をご確認ください）`);
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

    // 起動タイムアウト
    startupTimer = setTimeout(() => {
      if (!promptReady) {
        // 起動失敗時に画面の最後 500 文字をログに残す（検出ロジック改善のための調査材料）
        const rendered = extractFinalOutput(term);
        const tail = rendered.length > 500 ? rendered.slice(-500) : rendered;
        console.error(`❌ [terminal-mode] startup timeout (${STARTUP_TIMEOUT_MS}ms). Last 500 chars of rendered screen:\n--- BEGIN SCREEN ---\n${tail}\n--- END SCREEN ---`);
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
          // baseline 時点の `●` メッセージ数を記録。これより後のメッセージが Claude の応答
          baselineBulletCount = countClaudeBullets(rendered);
          console.log(`📊 [terminal-mode] baseline bullet count: ${baselineBulletCount}`);
          // ユーザー向けヒント（実行中はストリーミング停止するため目印を出す）
          opts.onOutput('\n📨 メッセージを送信しました。Claude の応答を待っています...\n');
          promptSent = true;
          execStarted = true;
          execStartedAt = Date.now();
          // プロンプトを Claude CLI に投入（fire-and-forget で onData を継続）
          // - 末尾の \r/\n を除去（残っていると \r が「もう一つの改行」と誤認される）
          // - チャンク分割 + 遅延で PTY/CLI 取りこぼし防止
          // - 投入完了後に明示的に \r を送って submit
          sendPromptToClaudeCLI(opts.prompt).catch(err => {
            console.error(`❌ [terminal-mode] prompt send failed: ${err.message}`);
          });
          // 完了監視を開始（500ms ごとに「画面アイドル + プロンプト復帰」を確認）
          startCompletionCheck();
          return;
        }
        return;
      }

      // 実行開始後: tool 承認・質問プロンプトの自動応答
      // 完了判定は startCompletionCheck の setInterval で独立して行う
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
      completionCheckInterval = setInterval(() => {
        if (finished || !execStarted) return;
        const elapsedSinceExec = Date.now() - execStartedAt;
        const elapsedSinceChange = Date.now() - lastScreenChangeAt;
        // プロンプト送信完了までは echo を真の応答と誤認しないようスキップ
        if (elapsedSinceExec < EXEC_COOLDOWN_MS) return;
        // 画面が 1.5 秒間変化なし + プロンプト復帰中 → 完了
        if (elapsedSinceChange >= IDLE_FOR_COMPLETION_MS && detectPromptReady(lastRenderedForChangeTracking)) {
          console.log(`✅ [terminal-mode] screen idle ${elapsedSinceChange}ms + prompt ready, completing`);
          finish('idle-and-prompt-ready');
        }
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
