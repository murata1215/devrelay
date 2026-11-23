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
  SANDBOX_ALLOW_REQUEST_VERSION,
  type SandboxAllowState,
} from './sandbox-allow-state.js';

const execFileAsync = promisify(execFile);

export type SandboxAllowCommandRunner = (
  command: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

const defaultRunner: SandboxAllowCommandRunner = (command, args) => execFileAsync(command, args);

/** タスク起動後、結果ファイルの反映を待つ上限（決定3: 「最大 10 秒待って再読込」） */
export const SANDBOX_ALLOW_APPLY_WAIT_MS = 10_000;
const SANDBOX_ALLOW_APPLY_POLL_INTERVAL_MS = 500;

const SANDBOX_ALLOW_TASK_NAME = '\\DevRelay\\apply-sandbox-allowlist';

export interface SandboxAllowReconcileResult {
  /** `config.yaml` の `sandbox.allowDestinations` が構文として妥当だったか */
  valid: boolean;
  invalidReason: string | null;
  /** 最終的に設定と実ルールが一致したか（これが false なら呼び出し側は実行を拒否すること） */
  applied: boolean;
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
 * 不一致なら要求ファイルを書いて `schtasks /Run` でタスクを 1 回起動し、最大
 * `SANDBOX_ALLOW_APPLY_WAIT_MS` 待って結果ファイルを再読込する。それでも不一致なら
 * `applied: false` を返す（呼び出し側はこのターンの Sandbox 実行を拒否すること。fail-closed）。
 */
export async function reconcileSandboxAllowDestinations(
  allowDestinations: string[] | undefined,
  run: SandboxAllowCommandRunner = defaultRunner,
): Promise<SandboxAllowReconcileResult> {
  const resolution = resolveSandboxAllowDestinations(allowDestinations);
  if (!resolution.ok) {
    return {
      valid: false,
      invalidReason: resolution.reason,
      applied: false,
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
    return { valid: true, invalidReason: null, applied: true, expectedDigest, state, taskRunError: null };
  }

  // apply-needed: 要求ファイルを書いてタスクを起動し、結果ファイルの変化を待つ
  let taskRunError: string | null = null;
  try {
    await writeRequestFileAtomically(
      buildRequestFileContent(resolution.destinations, resolution.canonical, expectedDigest),
    );
    await run('schtasks', ['/Run', '/TN', SANDBOX_ALLOW_TASK_NAME]);
  } catch (err) {
    taskRunError = err instanceof Error ? err.message : String(err);
  }

  const deadline = Date.now() + SANDBOX_ALLOW_APPLY_WAIT_MS;
  let latestState = state;
  while (Date.now() < deadline) {
    await sleep(SANDBOX_ALLOW_APPLY_POLL_INTERVAL_MS);
    const raw = await readStateFile();
    const parsed = parseSandboxAllowState(raw);
    if (parsed && parsed.digest === expectedDigest && parsed.result === 'ok') {
      latestState = parsed;
      break;
    }
    latestState = parsed;
  }

  const secondDecision = decideSandboxAllowReconcile({
    configuredCount: resolution.destinations.length,
    expectedDigest,
    state: latestState,
    alreadyRetried: true,
  });

  return {
    valid: true,
    invalidReason: null,
    applied: secondDecision === 'match',
    expectedDigest,
    state: latestState,
    taskRunError,
  };
}
