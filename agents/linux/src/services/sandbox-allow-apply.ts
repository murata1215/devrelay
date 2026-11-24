/**
 * Sandbox 許可リスト（IP とポート）を特権タスクへ反映依頼し、結果を読む I/O 層。
 *
 * サイクル SB-2.1。純関数（検証・digest・一致判定）は `sandbox-allow-destinations.ts` /
 * `sandbox-allow-state.ts` に分離してあり、ここでは「要求ファイルを書く → タスクを起動する →
 * 結果ファイルを読む」という I/O だけを行う。実行コマンドは注入可能（`sandbox-identity.ts` と
 * 同じ流儀。テスト容易性のため）。
 *
 * 設計・決定事項は `doc/sandbox/SB-2.0_investigation.md`（決定3・決定5・追加1）。
 */

import * as fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  getSandboxAllowRequestPath,
  getSandboxAllowStatePath,
} from './config.js';
import {
  resolveSandboxAllowDestinations,
  type SandboxAllowDestination,
} from './sandbox-allow-destinations.js';
import {
  digestSandboxAllowDestinations,
  decideSandboxAllowReconcile,
  parseSandboxAllowState,
  isSandboxAllowStateFresherThan,
  interpretSandboxAllowTaskState,
  decideSandboxAllowWait,
  classifySandboxAllowApplyOutcome,
  SANDBOX_ALLOW_REQUEST_VERSION,
  SANDBOX_ALLOW_APPLY_WAIT_MS,
  SANDBOX_ALLOW_APPLY_MAX_WAIT_MS,
  type SandboxAllowState,
  type SandboxAllowTaskState,
  type SandboxAllowApplyOutcome,
} from './sandbox-allow-state.js';

const execFileAsync = promisify(execFile);

export type SandboxAllowCommandRunner = (
  command: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

const defaultRunner: SandboxAllowCommandRunner = (command, args) => execFileAsync(command, args);

export { SANDBOX_ALLOW_APPLY_WAIT_MS, SANDBOX_ALLOW_APPLY_MAX_WAIT_MS };

const SANDBOX_ALLOW_APPLY_POLL_INTERVAL_MS = 1_000;
/** タスク状態（`Get-ScheduledTask`）の probe はポーリングより重いので間引く（SB-2.1.5） */
const SANDBOX_ALLOW_TASK_STATE_PROBE_INTERVAL_MS = 3_000;
/** 反映中の通知をチャットへ流す間隔（SB-2.1.5。進捗ボックスのタイムアウトリセットも兼ねるが
 *  連投はしない） */
const SANDBOX_ALLOW_PROGRESS_NOTICE_INTERVAL_MS = 30_000;

const SANDBOX_ALLOW_TASK_FOLDER = '\\DevRelay\\';
const SANDBOX_ALLOW_TASK_SHORT_NAME = 'apply-sandbox-allowlist';
const SANDBOX_ALLOW_TASK_NAME = `${SANDBOX_ALLOW_TASK_FOLDER}${SANDBOX_ALLOW_TASK_SHORT_NAME}`;

export interface SandboxAllowReconcileResult {
  /** `config.yaml` の `sandbox.allowDestinations` が構文として妥当だったか */
  valid: boolean;
  invalidReason: string | null;
  /** 最終的に設定と実ルールが一致したか（これが false なら呼び出し側は実行を拒否すること） */
  applied: boolean;
  /** SB-2.1.5: 'applied'（一致）/ 'pending'（反映中かもしれない。再送を促す）/
   *  'failed'（反映に失敗したと確信できる）。`applied` フィールドは `outcome === 'applied'` と同値 */
  outcome: SandboxAllowApplyOutcome;
  /** 設定から計算した期待 digest（valid が false のときは null） */
  expectedDigest: string | null;
  /** 読み取れた最新の `state.json`（無ければ null） */
  state: SandboxAllowState | null;
  /** タスク起動コマンド自体が失敗した場合のエラー文字列（起動はできたが未反映、は含まない） */
  taskRunError: string | null;
}

async function readStateFile(): Promise<string | null> {
  try {
    return await fs.readFile(getSandboxAllowStatePath(), 'utf-8');
  } catch {
    return null;
  }
}

/**
 * 特権タスク（`\DevRelay\apply-sandbox-allowlist`）が現在実行中かどうかを probe する
 * （SB-2.1.5）。`Get-ScheduledTask` の `State` 列挙名（英語固定）を使う。`schtasks /Query` の
 * 「状態: 実行中」は日本語 Windows で localize されるため使わない。
 * 失敗・空出力は `'unknown'`（fail-open: 判定できないだけで、待ち続けるか諦めるかは
 * `decideSandboxAllowWait()` が経過時間で別途判断する）。
 */
async function probeSandboxAllowTaskState(run: SandboxAllowCommandRunner): Promise<SandboxAllowTaskState> {
  try {
    const { stdout } = await run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(Get-ScheduledTask -TaskPath '${SANDBOX_ALLOW_TASK_FOLDER}' -TaskName '${SANDBOX_ALLOW_TASK_SHORT_NAME}').State.ToString()`,
    ]);
    return interpretSandboxAllowTaskState(stdout);
  } catch {
    return 'unknown';
  }
}

/** `request.json` を一時ファイルに書いてから rename する（Agent が書きかけを読まないよう、特権タスク
 *  からは常に「無い」か「完全な内容」のどちらかに見えるようにする）。 */
async function writeRequestFileAtomically(content: string): Promise<void> {
  const finalPath = getSandboxAllowRequestPath();
  const tmpPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmpPath, content, 'utf-8');
  await fs.rename(tmpPath, finalPath);
}

function buildRequestFileContent(destinations: readonly SandboxAllowDestination[], canonical: string, digest: string): string {
  return JSON.stringify(
    {
      version: SANDBOX_ALLOW_REQUEST_VERSION,
      canonical,
      digest,
      destinations: destinations.map((d) => ({ ip: d.ip, port: d.port })),
    },
    null,
    2,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `config.yaml` の `sandbox.allowDestinations` を検証し、現在の `state.json` と digest を比較する。
 * 不一致なら要求ファイルを書いて `schtasks /Run` でタスクを 1 回起動し、結果ファイルの反映を待つ。
 *
 * SB-2.1.5: 待ち時間は基本 `SANDBOX_ALLOW_APPLY_WAIT_MS`（60 秒）、タスクが実行中と観測できて
 * いる間は `SANDBOX_ALLOW_APPLY_MAX_WAIT_MS`（180 秒）まで延長する（`decideSandboxAllowWait()`）。
 * 待っても一致しなかった場合、`outcome: 'failed'`（反映に失敗したと確信できる。例: `state.json` に
 * `error`/`rejected` が記録された）と `outcome: 'pending'`（まだ分からない。再送を促す）を区別する
 * （`classifySandboxAllowApplyOutcome()`）。いずれの場合も `applied: false` で、呼び出し側は
 * このターンの Sandbox 実行を拒否すること（fail-closed）。
 */
export async function reconcileSandboxAllowDestinations(
  allowDestinations: string[] | undefined,
  run: SandboxAllowCommandRunner = defaultRunner,
  onProgress?: (message: string) => void,
): Promise<SandboxAllowReconcileResult> {
  const resolution = resolveSandboxAllowDestinations(allowDestinations);
  if (!resolution.ok) {
    return {
      valid: false,
      invalidReason: resolution.reason,
      applied: false,
      outcome: 'failed',
      expectedDigest: null,
      state: null,
      taskRunError: null,
    };
  }

  const expectedDigest = digestSandboxAllowDestinations(resolution.canonical);
  const rawState = await readStateFile();
  const state = parseSandboxAllowState(rawState);

  const firstDecision = decideSandboxAllowReconcile({
    configuredCount: resolution.destinations.length,
    expectedDigest,
    state,
    alreadyRetried: false,
  });

  if (firstDecision === 'match') {
    return {
      valid: true,
      invalidReason: null,
      applied: true,
      outcome: 'applied',
      expectedDigest,
      state,
      taskRunError: null,
    };
  }

  // apply-needed: 要求ファイルを書いてタスクを起動し、結果ファイルの変化を待つ
  const requestWrittenAtMs = Date.now();
  let taskRunError: string | null = null;
  try {
    await writeRequestFileAtomically(
      buildRequestFileContent(resolution.destinations, resolution.canonical, expectedDigest),
    );
    await run('schtasks', ['/Run', '/TN', SANDBOX_ALLOW_TASK_NAME]);
  } catch (err) {
    taskRunError = err instanceof Error ? err.message : String(err);
  }

  const startMs = Date.now();
  let latestState = state;
  let taskState: SandboxAllowTaskState = 'unknown';
  let observedRunning = false;
  let lastTaskStateProbeMs = 0;
  let lastProgressNoticeMs = 0;

  while (true) {
    await sleep(SANDBOX_ALLOW_APPLY_POLL_INTERVAL_MS);
    const elapsedMs = Date.now() - startMs;

    // タスク状態の probe は読み取りより先に行う（「終了済み」を観測した後に書かれた結果を
    // 取りこぼさないようにするため）。間引いて実行コストを抑える。
    if (elapsedMs - lastTaskStateProbeMs >= SANDBOX_ALLOW_TASK_STATE_PROBE_INTERVAL_MS) {
      lastTaskStateProbeMs = elapsedMs;
      taskState = await probeSandboxAllowTaskState(run);
      if (taskState === 'running') observedRunning = true;
    }

    const raw = await readStateFile();
    latestState = parseSandboxAllowState(raw);

    const stateMatched =
      decideSandboxAllowReconcile({
        configuredCount: resolution.destinations.length,
        expectedDigest,
        state: latestState,
        alreadyRetried: true,
      }) === 'match';
    const stateFresh = isSandboxAllowStateFresherThan(latestState, requestWrittenAtMs);

    const waitDecision = decideSandboxAllowWait({
      stateMatched,
      stateFresh,
      elapsedMs,
      taskState,
      observedRunning,
    });

    if (waitDecision !== 'wait') break;

    if (onProgress && elapsedMs - lastProgressNoticeMs >= SANDBOX_ALLOW_PROGRESS_NOTICE_INTERVAL_MS) {
      lastProgressNoticeMs = elapsedMs;
      onProgress(`Sandbox の許可する接続先をファイアウォールへ反映中...（${Math.round(elapsedMs / 1000)}秒経過）`);
    }
  }

  const secondDecision = decideSandboxAllowReconcile({
    configuredCount: resolution.destinations.length,
    expectedDigest,
    state: latestState,
    alreadyRetried: true,
  });
  const matched = secondDecision === 'match';
  const stateFreshFinal = isSandboxAllowStateFresherThan(latestState, requestWrittenAtMs);
  const outcome = classifySandboxAllowApplyOutcome({
    matched,
    state: latestState,
    stateFresh: stateFreshFinal,
    taskRunError,
    observedRunning,
  });

  return {
    valid: true,
    invalidReason: null,
    applied: matched,
    outcome,
    expectedDigest,
    state: latestState,
    taskRunError,
  };
}
