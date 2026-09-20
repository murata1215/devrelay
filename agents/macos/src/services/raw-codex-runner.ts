/**
 * raw-completion Phase 2（Codex 経路）の I/O 実体。`raw-codex-mode.ts`（外部 import ゼロの純関数）を
 * 使って `codex exec` を spawn し、stdin にプロンプトを書き込み、stdout の JSONL を
 * `consumeRawCodexLine()` で集約し、`resolveRawCodexResult()` で最終結果へ変換する。
 *
 * 既存 `ai-runner.ts` の codex 分岐（対話セッション向け）とは独立した専用コードパス
 * （raw-completion-mode.ts が Claude 側で確立したパターンと同じ、D2 の精神を Codex にも適用）。
 * `ai-runner.ts` は 0 行変更。
 */
import { spawn, execSync, type ChildProcessWithoutNullStreams } from 'child_process';
import * as path from 'path';
import {
  buildRawCodexArgs,
  buildRawCodexEnv,
  composeRawCodexPrompt,
  createRawCodexAccumulator,
  consumeRawCodexLine,
  resolveRawCodexResult,
  type RawCodexResult,
} from './raw-codex-mode.js';

/** `codex exec --help` のプローブ結果キャッシュ（プロセス内 1 回だけ実行、既存 codex プローブと同じ流儀） */
let rawCodexSupportCache: { json: boolean; ephemeral: boolean } | null = null;

/**
 * `codex exec --help` の出力から `--json`/`--ephemeral` フラグへの対応可否を判定する（結果はキャッシュ）。
 * `--ephemeral` 非対応は false に倒す（rollout 永続化は起きるが機能自体は失敗しない安全側フォールバック）。
 * `--json` 非対応は **fail-closed**（`runRawCodex()` が spawn せずエラーを返す。raw-completion は
 * 構造化 JSONL 出力を前提にした事後検出方式のツール deny（`raw-codex-mode.ts` 参照）に依存しており、
 * プレーンテキストへの劣化は許容しない — Claude 経路の「旧 Agent を検知して無言劣化させない」思想
 * （`raw-completion-response.ts` 分岐2）と同じ）。
 *
 * @param command codex コマンドのフルパス
 */
export function probeRawCodexSupport(command: string): { json: boolean; ephemeral: boolean } {
  if (rawCodexSupportCache !== null) return rawCodexSupportCache;
  try {
    const help = execSync(`${command} exec --help`, { encoding: 'utf-8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    rawCodexSupportCache = { json: /--json\b/.test(help), ephemeral: /--ephemeral\b/.test(help) };
  } catch (err) {
    rawCodexSupportCache = { json: false, ephemeral: false };
    console.warn(`[raw-codex] exec --help probe failed, defaulting json=false ephemeral=false:`, (err as Error).message);
  }
  return rawCodexSupportCache;
}

/** `runRawCodex()` の入力 */
export interface RunRawCodexInput {
  /** `codex` コマンドのフルパス（`config.aiTools.codex.command` 解決済みの値） */
  command: string;
  /** 実行時の cwd（`raw-cwd.ts` の `ensureRawCwd()` を渡すこと。対象プロジェクトのパスを渡さない） */
  cwd: string;
  /** 席の system 指示（`buildRawCodexArgs` の `developer_instructions` へ） */
  system: string;
  /** user prompt（stdin へ書き込む） */
  prompt: string;
  /** モデル指定（未指定なら CLI 既定モデル） */
  model?: string;
  /** Agent 側タイムアウト予算（ミリ秒） */
  timeoutMs: number;
  /** プロキシ環境変数（`config.proxy.url` から呼び出し元が組み立てたもの） */
  proxyEnv?: Record<string, string>;
}

/** SIGTERM を送ってから SIGKILL へエスカレーションするまでの猶予（ミリ秒） */
const KILL_ESCALATION_MS = 5000;

/**
 * `codex exec` を非対話・ステートレスで 1 回実行する。
 *
 * @param input 実行に必要な入力
 * @returns `RawCodexResult`（`resolveRawCodexResult()` の戻り値そのもの）
 */
export function runRawCodex(input: RunRawCodexInput): Promise<RawCodexResult> {
  const { command, cwd, system, prompt, model, timeoutMs, proxyEnv } = input;
  const support = probeRawCodexSupport(command);
  if (!support.json) {
    return Promise.resolve({
      ok: false,
      text: '',
      stopReason: 'error',
      errorMessage: 'codex exec --json is not supported by this Codex CLI version (raw-completion requires structured output)',
      deniedTools: [],
    });
  }
  const args = buildRawCodexArgs({ system, model, supportsEphemeral: support.ephemeral });

  const codexDir = path.dirname(command);
  const pathSep = process.platform === 'win32' ? ';' : ':';
  const env = buildRawCodexEnv({ ...process.env, ...proxyEnv }, codexDir, pathSep);

  // npm がグローバルインストールする codex は Windows では `codex.cmd` シムになるため、
  // Node の spawn は shell 経由でないとバッチファイルを直接実行できない（既存 codex 分岐と同じ理由）。
  const isWindows = process.platform === 'win32';

  return new Promise((resolve) => {
    let proc: ChildProcessWithoutNullStreams;
    try {
      proc = spawn(command, args, {
        cwd,
        shell: isWindows,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env,
      }) as ChildProcessWithoutNullStreams;
    } catch (err) {
      resolve({ ok: false, text: '', stopReason: 'error', errorMessage: `failed to spawn codex: ${(err as Error).message}`, deniedTools: [] });
      return;
    }

    const acc = createRawCodexAccumulator();
    let lineBuffer = '';
    let stderrTail = '';
    let timedOut = false;
    let settled = false;
    let killEscalationTimer: ReturnType<typeof setTimeout> | null = null;

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      try { proc.kill('SIGTERM'); } catch { /* already exited */ }
      killEscalationTimer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* already exited */ }
      }, KILL_ESCALATION_MS);
    }, timeoutMs);

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killEscalationTimer) clearTimeout(killEscalationTimer);
      if (lineBuffer.trim()) consumeRawCodexLine(acc, lineBuffer);
      resolve(resolveRawCodexResult({ acc, exitCode, signal, timedOut, stderrTail, requestedModel: model }));
    };

    proc.stdout.on('data', (chunk: Buffer) => {
      lineBuffer += chunk.toString('utf-8');
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) consumeRawCodexLine(acc, line);
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf-8')).slice(-2000);
    });

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killEscalationTimer) clearTimeout(killEscalationTimer);
      resolve({ ok: false, text: '', stopReason: 'error', errorMessage: `codex process error: ${err.message}`, deniedTools: [] });
    });

    proc.on('close', (code, signal) => {
      finish(code, signal);
    });

    proc.stdin.write(composeRawCodexPrompt(prompt));
    proc.stdin.end();
  });
}
