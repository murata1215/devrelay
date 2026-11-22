/**
 * `devrelay sandbox` CLI コマンド群（サイクル SB-1a-1）。
 *
 * `status` / `prep` / `set-token` / `selftest` の 4 サブコマンドを提供する。
 * **ai-runner.ts / connection.ts には配線しない**（SB-1a-1 の範囲外）。これらのコマンドは
 * Sandbox Host（別途 `agents/sandbox-host/` + 管理者用インストールスクリプトで用意する
 * Windows サービス）に対して独立に動作確認するための入口。
 *
 * Windows 専用機能だが、このファイル自体は他 OS で `import` してもエラーにならないよう
 * `process.platform` で分岐する（Linux の CI/手元環境で `pnpm build` が通ることを優先する）。
 */

import * as fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import * as os from 'node:os';
import chalk from 'chalk';
import { loadConfig, getConfigDir, getSandboxTokenPath, getSandboxProgramDataDir, getSandboxPublicKeyPath, getSandboxHomeDir } from '../../services/config.js';
import {
  SANDBOX_PROTOCOL_VERSION,
  SANDBOX_PROXY_PORT,
  SANDBOX_HANDSHAKE_TIMEOUT_MS,
  EXPECTED_SANDBOX_SERVICE_NAME,
  SANDBOX_SERVICE_SID_PREFIX,
  SANDBOX_KNOWN_PRIVILEGED_SIDS,
  buildSandboxPipePath,
} from '../../services/sandbox-protocol.js';
import { connectToSandboxHost, performSandboxHandshake, SandboxSpawnedProcess, type SandboxHandshakeResult } from '../../services/sandbox-launcher.js';
import { generateSandboxNonce } from '../../services/sandbox-attest.js';
import { resolveSandboxAllowlist, hashSandboxAllowlist } from '../../services/sandbox-allowlist.js';
import {
  decideSandboxPreflight,
  buildSandboxDenialMessage,
  type SandboxPreflightInput,
  type SandboxDenyReason,
} from '../../services/sandbox-readiness.js';
import {
  buildSandboxPrepPlan,
  buildSandboxTokenLockdownStep,
  buildSandboxPrepManualFallbackText,
  type SandboxPrepStep,
} from '../../services/sandbox-prep-commands.js';
import { resolveCurrentUserSid } from '../../services/sandbox-identity.js';
import { probeSdkExecutable } from '../../services/sdk-executable.js';

const execFileAsync = promisify(execFile);

/** `DEVRELAY_SANDBOX_DISABLE` キルスイッチ（既定 `0`）。`1` なら sandbox 要求ターンを全部拒否する。 */
function isSandboxDisabledBySwitch(): boolean {
  return process.env.DEVRELAY_SANDBOX_DISABLE === '1';
}

interface SandboxPreflightCheckResult {
  decision: { allowed: true } | { allowed: false; reason: SandboxDenyReason };
  handshake: SandboxHandshakeResult | null;
  claudeExecutablePath: string | null;
  projectPath: string;
  currentUserSid: string | null;
  pipeConnected: boolean;
  connectError: string | null;
}

/**
 * `status` / `selftest` で共有する実行前確認ロジック。
 * ホストへ接続・ハンドシェイク・署名検証を行い、`decideSandboxPreflight()` に渡す完全な入力を
 * 組み立てて判定する。
 */
async function runSandboxPreflightCheck(projectPath: string): Promise<SandboxPreflightCheckResult> {
  const config = await loadConfig();
  const probe = probeSdkExecutable();
  const claudeExecutablePath = probe.path; // clijs/native のみ非 null（それ以外は fallback 扱い）
  const claudeExecutableFallbackActive = probe.form === 'none' || probe.form === 'unresolved';

  const allowlistResolution = resolveSandboxAllowlist(config.sandbox?.allowlist);

  let projectPathUnderUserProfile = true; // 判定できない場合は fail-closed（配下とみなす）
  try {
    const realProject = await fs.realpath(projectPath);
    const realHome = await fs.realpath(os.homedir());
    projectPathUnderUserProfile = realProject === realHome || realProject.startsWith(realHome + path.sep);
  } catch {
    // projectPath が存在しない等。判定できないため true のまま（fail-closed）
  }

  const currentUserSid = await resolveCurrentUserSid();

  let socket;
  let pipeConnected = false;
  let connectError: string | null = null;
  let handshake: SandboxHandshakeResult | null = null;
  try {
    socket = await connectToSandboxHost(buildSandboxPipePath(), SANDBOX_HANDSHAKE_TIMEOUT_MS);
    pipeConnected = true;
  } catch (err) {
    connectError = err instanceof Error ? err.message : String(err);
  }

  if (socket) {
    try {
      const nonce = generateSandboxNonce();
      handshake = await performSandboxHandshake(
        socket,
        {
          nonce,
          claudeExecutablePath: claudeExecutablePath ?? '',
          projectPath,
        },
        await readSandboxPublicKey(),
      );
    } catch (err) {
      connectError = err instanceof Error ? err.message : String(err);
    } finally {
      socket.destroy();
    }
  }

  const input: SandboxPreflightInput = {
    disabledBySwitch: isSandboxDisabledBySwitch(),
    platform: process.platform,
    effectiveAiTool: 'claude', // SB-1a-1 は未配線のため CLI は claude 固定で確認する
    terminalMode: false,
    projectPathUnderUserProfile,
    capabilityDeclared: true, // SB-1a-1 は capability 申告自体が未配線（SB-1a-2 で配線）。CLI 単独確認用に true とする
    claudeExecutableFallbackActive,
    allowlistValid: allowlistResolution.ok,
    pipeConnected,
    protocolVersionMatch: handshake ? handshake.protocolVersion === SANDBOX_PROTOCOL_VERSION : false,
    signatureValid: handshake ? handshake.signatureValid : false,
    identityServiceNameMatches: handshake ? handshake.serviceName === EXPECTED_SANDBOX_SERVICE_NAME : false,
    identitySidHasServicePrefix: handshake ? handshake.sid.startsWith(SANDBOX_SERVICE_SID_PREFIX) : false,
    identitySidDiffersFromAgent:
      handshake !== null && currentUserSid !== null ? handshake.sid !== currentUserSid : false,
    identitySidNotKnownPrivileged: handshake ? !SANDBOX_KNOWN_PRIVILEGED_SIDS.includes(handshake.sid) : false,
    blockProbePositiveControlBlocked: handshake ? handshake.positiveControlBlocked : false,
    blockProbeLoopbackReachable: handshake ? handshake.loopbackReachable : false,
    hostCanReadClaudeExecutable: handshake ? handshake.claudeExecutableReadable : false,
    hostCanWriteProjectFolder: handshake ? handshake.projectFolderWritable : false,
  };

  return {
    decision: decideSandboxPreflight(input),
    handshake,
    claudeExecutablePath,
    projectPath,
    currentUserSid,
    pipeConnected,
    connectError,
  };
}

async function readSandboxPublicKey(): Promise<string> {
  return fs.readFile(getSandboxPublicKeyPath(), 'utf-8');
}

function printCheck(label: string, ok: boolean | null): void {
  const icon = ok === null ? '➖' : ok ? '✅' : '❌';
  console.log(`  ${icon} ${label}`);
}

export async function sandboxStatusCommand(options: { project?: string }): Promise<void> {
  console.log(chalk.blue('🛡️  Sandbox 実行前確認'));
  const projectPath = options.project ?? process.cwd();
  console.log(chalk.gray(`  対象プロジェクト: ${projectPath}`));

  if (process.platform !== 'win32') {
    console.log(chalk.yellow(`  ⚠️ 現在の OS: ${process.platform}（Sandbox は Windows 専用です）`));
  }

  const result = await runSandboxPreflightCheck(projectPath);

  printCheck(`DEVRELAY_SANDBOX_DISABLE が設定されていない`, !isSandboxDisabledBySwitch());
  printCheck(`OS が Windows`, process.platform === 'win32');
  printCheck(`claude 実行ファイルが同梱版（system fallback ではない）`, result.handshake ? true : null);
  printCheck(`名前付きパイプへ接続できる`, result.pipeConnected);
  if (result.connectError) {
    console.log(chalk.gray(`     ${result.connectError}`));
  }
  if (result.handshake) {
    printCheck(`プロトコル版が一致（v${SANDBOX_PROTOCOL_VERSION}）`, result.handshake.protocolVersion === SANDBOX_PROTOCOL_VERSION);
    printCheck(`署名検証（ed25519）`, result.handshake.signatureValid);
    printCheck(`サービス名が一致: ${EXPECTED_SANDBOX_SERVICE_NAME}`, result.handshake.serviceName === EXPECTED_SANDBOX_SERVICE_NAME);
    printCheck(`SID がサービス SID（${SANDBOX_SERVICE_SID_PREFIX}...）`, result.handshake.sid.startsWith(SANDBOX_SERVICE_SID_PREFIX));
    printCheck(`SID が Agent 自身と異なる`, result.currentUserSid !== null && result.handshake.sid !== result.currentUserSid);
    printCheck(`SID が既知の特権 SID でない`, !SANDBOX_KNOWN_PRIVILEGED_SIDS.includes(result.handshake.sid));
    printCheck(`陽性対照（実ホストへの直結）が遮断された`, result.handshake.positiveControlBlocked);
    printCheck(`loopback 中継プロキシへ到達できた`, result.handshake.loopbackReachable);
    printCheck(`claude 実行ファイルをホストが読める`, result.handshake.claudeExecutableReadable);
    printCheck(`プロジェクトフォルダにホストが書ける`, result.handshake.projectFolderWritable);
  }

  console.log();
  if (result.decision.allowed) {
    console.log(chalk.green('✅ Sandbox 実行の前提は満たされています。'));
  } else {
    console.log(chalk.red(buildSandboxDenialMessage(result.decision.reason)));
    console.log(chalk.gray(`   reason=${result.decision.reason}`));
  }
}

export async function sandboxPrepCommand(options: { project?: string }): Promise<void> {
  if (!options.project) {
    console.log(chalk.red('❌ --project <path> を指定してください'));
    return;
  }
  const projectPath = path.resolve(options.project);

  if (process.platform !== 'win32') {
    console.log(chalk.yellow('⚠️ Sandbox 実行は Windows 専用です。このコマンドは何も行いません。'));
    return;
  }

  console.log(chalk.blue(`🛡️  Sandbox prep: ${projectPath}`));

  const servicePrincipal = await resolveServicePrincipal();
  const agentDir = path.join(getConfigDir(), 'agent');
  const nodeModulesPath = path.join(agentDir, 'node_modules');
  const gitHooksPath = path.join(projectPath, '.git', 'hooks');
  const ancestorPaths = [...new Set([path.dirname(getConfigDir()), getConfigDir(), agentDir])];

  const steps = buildSandboxPrepPlan({
    projectPath,
    nodeModulesPath,
    gitHooksPath,
    ancestorPaths,
    servicePrincipal,
  });

  const failed: SandboxPrepStep[] = [];
  for (const step of steps) {
    try {
      await execFileAsync(step.command, step.args);
      console.log(chalk.green(`  ✓ ${step.description}`));
    } catch (err) {
      console.log(chalk.yellow(`  ⚠ ${step.description} に失敗しました: ${err instanceof Error ? err.message : String(err)}`));
      failed.push(step);
    }
  }

  if (failed.length > 0) {
    console.log();
    console.log(chalk.yellow('以下は手動で実行してください:'));
    console.log(chalk.gray(buildSandboxPrepManualFallbackText(failed)));
  } else {
    console.log();
    console.log(chalk.green('✅ Sandbox prep が完了しました。`devrelay sandbox status --project <path>` で確認してください。'));
  }
}

/** `C:\ProgramData\devrelay\sandbox\host.json` の SID を優先的に使う。読めない場合はサービス名で代替する。 */
async function resolveServicePrincipal(): Promise<string> {
  try {
    const raw = await fs.readFile(path.join(getSandboxProgramDataDir(), 'host.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { sid?: string };
    if (parsed.sid) return `*${parsed.sid}`;
  } catch {
    // host.json が無い/読めない → サービス名で代替（仮想サービス SID は決定論的に解決可能）
  }
  return EXPECTED_SANDBOX_SERVICE_NAME;
}

export async function sandboxSetTokenCommand(): Promise<void> {
  if (process.platform !== 'win32') {
    console.log(chalk.yellow('⚠️ Sandbox 実行は Windows 専用です。このコマンドは何も行いません。'));
    return;
  }
  console.log(chalk.blue('🛡️  Sandbox トークン登録'));
  console.log(chalk.gray('  claude setup-token で発行したトークンを貼り付けてください（入力は表示されません）。'));

  let token: string;
  try {
    token = await readSecretFromStdin();
  } catch {
    console.log(chalk.red('❌ 入力がキャンセルされました'));
    return;
  }
  if (!token) {
    console.log(chalk.red('❌ トークンが空です'));
    return;
  }

  const tokenPath = getSandboxTokenPath();
  await fs.writeFile(tokenPath, token, { encoding: 'utf-8', mode: 0o600 });

  const lockdownStep = buildSandboxTokenLockdownStep(tokenPath, os.userInfo().username);
  try {
    await execFileAsync(lockdownStep.command, lockdownStep.args);
    console.log(chalk.green(`✅ トークンを保存し、本人のみに制限しました: ${tokenPath}`));
  } catch (err) {
    console.log(chalk.yellow(`⚠ トークンは保存しましたが ACL 制限に失敗しました: ${err instanceof Error ? err.message : String(err)}`));
    console.log(chalk.gray(`  手動で実行してください: ${lockdownStep.command} ${lockdownStep.args.join(' ')}`));
  }
}

/** stdin から非表示で 1 行読む（TTY なら raw mode でマスク、パイプ入力ならそのまま読む） */
function readSecretFromStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const isTty = !!stdin.isTTY;
    let buffer = '';

    if (isTty) stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding('utf-8');

    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\u0003') {
          cleanup();
          reject(new Error('cancelled'));
          return;
        }
        if (ch === '\r' || ch === '\n') {
          cleanup();
          process.stdout.write('\n');
          resolve(buffer.trim());
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          buffer = buffer.slice(0, -1);
          continue;
        }
        buffer += ch;
      }
    };
    function cleanup() {
      stdin.removeListener('data', onData);
      if (isTty) stdin.setRawMode?.(false);
      stdin.pause();
    }
    stdin.on('data', onData);
  });
}

export async function sandboxSelftestCommand(options: { project?: string; networkProbe?: boolean; spawn?: boolean }): Promise<void> {
  const projectPath = options.project ? path.resolve(options.project) : process.cwd();
  console.log(chalk.blue(`🛡️  Sandbox selftest: ${projectPath}`));

  const result = await runSandboxPreflightCheck(projectPath);
  if (!result.decision.allowed) {
    console.log(chalk.red(buildSandboxDenialMessage(result.decision.reason)));
    console.log(chalk.gray(`  reason=${result.decision.reason}`));
    return;
  }
  console.log(chalk.green('✅ 実行前確認を通過しました。'));

  if (!options.spawn && !options.networkProbe) {
    console.log(chalk.gray('  --spawn / --network-probe を指定すると実際にホスト経由でプロセスを起動します。'));
    return;
  }

  const config = await loadConfig();
  const allowlistResolution = resolveSandboxAllowlist(config.sandbox?.allowlist);
  if (!allowlistResolution.ok) {
    console.log(chalk.red(`❌ 許可リストが不正です: ${allowlistResolution.reason}`));
    return;
  }
  console.log(chalk.gray(`  許可リストハッシュ: ${hashSandboxAllowlist(allowlistResolution.allowlist)}`));
  console.log(chalk.gray(`  中継プロキシ固定ポート: ${SANDBOX_PROXY_PORT}`));

  if (options.spawn) {
    await runSandboxEchoSpawn(projectPath);
  }
  if (options.networkProbe) {
    await runSandboxNetworkProbes(projectPath);
  }
}

/** ホスト経由で簡単なコマンドを起動し、stdio 中継・exit コードが正しく返ることを確認する */
async function runSandboxEchoSpawn(projectPath: string): Promise<void> {
  console.log(chalk.blue('  ▶ ホスト経由で簡単なコマンドを実行します（claude 本体は起動しません）...'));
  const socket = await connectToSandboxHost(buildSandboxPipePath(), SANDBOX_HANDSHAKE_TIMEOUT_MS);
  try {
    const proc = new SandboxSpawnedProcess(socket, {
      command: 'cmd.exe',
      args: ['/c', 'echo', 'devrelay-sandbox-selftest'],
      cwd: projectPath,
      env: {},
    });
    const output = await collectStdout(proc, 5_000);
    await waitForExit(proc, 5_000);
    console.log(chalk.gray(`     出力: ${output.trim()}`));
    console.log(chalk.gray(`     exitCode: ${proc.exitCode}`));
  } finally {
    socket.destroy();
  }
}

function collectStdout(proc: SandboxSpawnedProcess, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    let out = '';
    const timer = setTimeout(() => resolve(out), timeoutMs);
    proc.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf-8');
    });
    proc.stdout.on('end', () => {
      clearTimeout(timer);
      resolve(out);
    });
  });
}

function waitForExit(proc: SandboxSpawnedProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    proc.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * ネットワーク遮断の実機確認（許可外 curl）と、既知の回避経路（bitsadmin 等）の記録。
 * **回避経路を「遮断できた」と表示しない**（人間の承認条件4）。
 */
async function runSandboxNetworkProbes(projectPath: string): Promise<void> {
  console.log(chalk.blue('  ▶ ネットワーク遮断の確認プローブを実行します...'));

  const curlResult = await runProbeCommand(projectPath, ['/c', 'curl', '-s', '-o', 'NUL', '-w', '%{http_code}', '--max-time', '5', 'https://example.com']);
  console.log(`     curl（許可外ホストへの直結）: ${describeProbeOutcome(curlResult, false)}`);

  const bitsadminResult = await runProbeCommand(projectPath, [
    '/c',
    'bitsadmin',
    '/transfer',
    'devrelay-sbtest',
    '/priority',
    'high',
    'https://example.com/',
    'C:\\Windows\\Temp\\devrelay-sbtest.tmp',
  ]);
  console.log(`     bitsadmin（既知の代行サービス経由の回避経路）: ${describeProbeOutcome(bitsadminResult, true)}`);
  console.log(chalk.yellow('       ⚠️ BITS 等のブローカーサービス経由の通信は SID ベースのファイアウォールルールで' +
    '構造的に遮断できません（別 SID のサービスが実際の通信を行うため）。'));
}

interface ProbeRunResult {
  exitCode: number | null;
  timedOut: boolean;
  errored: boolean;
}

async function runProbeCommand(cwd: string, args: string[]): Promise<ProbeRunResult> {
  try {
    const { stdout: _stdout } = await execFileAsync('cmd.exe', args, { cwd, timeout: 8_000 });
    return { exitCode: 0, timedOut: false, errored: false };
  } catch (err: unknown) {
    const e = err as { killed?: boolean; code?: number };
    if (e.killed) return { exitCode: null, timedOut: true, errored: false };
    return { exitCode: typeof e.code === 'number' ? e.code : null, timedOut: false, errored: true };
  }
}

/**
 * @param isKnownBypass true の場合、どんな結果でも「遮断できた」とは表示しない
 *   （構造的に遮断不能な経路であることが既知のため）
 */
function describeProbeOutcome(result: ProbeRunResult, isKnownBypass: boolean): string {
  if (isKnownBypass) {
    if (result.exitCode === 0) return '遮断できなかった（到達した可能性があります）';
    return '未確認（既知の回避経路のため、失敗してもファイアウォールの効果とは断定できません）';
  }
  if (result.timedOut) return '未確認（タイムアウト）';
  if (result.exitCode === 0) return '遮断できなかった（到達しました）';
  if (result.exitCode === 7) return '遮断できた（接続失敗、exit=7）';
  return `未確認（exit=${result.exitCode ?? 'null'}）`;
}
