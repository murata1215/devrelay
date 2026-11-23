/**
 * `devrelay sandbox` CLI コマンド群（サイクル SB-1a-1、hp630g9 実機確認での不具合修正 SB-1a-1.1）。
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
import * as net from 'node:net';
import chalk from 'chalk';
import { loadConfig, getConfigDir, getSandboxTokenPath, getSandboxProgramDataDir, getSandboxPublicKeyPath, getSandboxHomeDir } from '../../services/config.js';
import {
  SANDBOX_PROTOCOL_VERSION,
  SANDBOX_PROXY_PORT,
  SANDBOX_HANDSHAKE_TIMEOUT_MS,
  SANDBOX_POSITIVE_CONTROL_HOST,
  EXPECTED_SANDBOX_SERVICE_NAME,
  SANDBOX_SERVICE_SID_PREFIX,
  SANDBOX_KNOWN_PRIVILEGED_SIDS,
  buildSandboxPipePath,
} from '../../services/sandbox-protocol.js';
import {
  connectToSandboxHost,
  performSandboxHandshake,
  awaitSandboxProcessResult,
  SandboxSpawnedProcess,
  type SandboxHandshakeResult,
} from '../../services/sandbox-launcher.js';
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
  decideSandboxPrepPrecheck,
  buildSandboxPrepPrecheckMessage,
  type SandboxPrepStep,
} from '../../services/sandbox-prep-commands.js';
import { resolveCurrentUserSid } from '../../services/sandbox-identity.js';
import { probeSdkExecutable } from '../../services/sdk-executable.js';
import { createSandboxConnectProxy, type SandboxProxyDenial, type SandboxProxyHandle } from '../../services/sandbox-proxy.js';
import { decideSandboxProxyMode } from '../../services/sandbox-proxy-mode.js';
import { buildSandboxChildEnv, redactSandboxSecrets } from '../../services/sandbox-env.js';
import { buildSandboxCliCommand } from '../../services/sandbox-cli-hint.js';
import { decodeWindowsConsoleText } from '../../services/sandbox-console-text.js';
import {
  interpretSandboxDirectBlockProbe,
  interpretSandboxProxyDenyProbe,
  interpretSandboxKnownBypassProbe,
  interpretSandboxReadProbe,
  type SandboxProbeInterpretation,
} from '../../services/sandbox-probe-interpret.js';

const execFileAsync = promisify(execFile);

/** `DEVRELAY_SANDBOX_DISABLE` キルスイッチ（既定 `0`）。`1` なら sandbox 要求ターンを全部拒否する。 */
function isSandboxDisabledBySwitch(): boolean {
  return process.env.DEVRELAY_SANDBOX_DISABLE === '1';
}

/** `devrelay sandbox <subcommand>` の実際に打てるコマンドを表示する（B1 対応: Windows に `devrelay` コマンドは無い）。 */
function printSandboxCliHint(subcommand: string, projectPath?: string): void {
  const command = buildSandboxCliCommand({
    platform: process.platform,
    nodeExe: process.execPath,
    cliEntry: process.argv[1] ?? '',
    subcommand,
    projectPath,
  });
  console.log(chalk.gray(`  ${command}`));
}

interface SandboxPreflightCheckResult {
  decision: { allowed: true } | { allowed: false; reason: SandboxDenyReason };
  handshake: SandboxHandshakeResult | null;
  claudeExecutablePath: string | null;
  /** 同梱実行ファイル欠落でシステム claude を使っている（B4 対応: 以前は handshake の成否と
   *  混同して表示していたため、別途保持して正しく表示する） */
  claudeExecutableFallbackActive: boolean;
  projectPath: string;
  currentUserSid: string | null;
  pipeConnected: boolean;
  connectError: string | null;
}

/**
 * `status` / `selftest` で共有する実行前確認ロジック。
 * ホストへ接続・ハンドシェイク・署名検証を行い、`decideSandboxPreflight()` に渡す完全な入力を
 * 組み立てて判定する。呼び出し側は事前に `withSandboxProxy()` で中継プロキシを用意しておくこと
 * （B3 対応。本関数自体はプロキシの起動は行わない）。
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
    claudeExecutableFallbackActive,
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

/** 拒否理由に応じて「sandbox prep を実行してください」の実コマンドを追加表示する対象。 */
const PREP_HINT_REASONS: readonly SandboxDenyReason[] = ['claude_executable_unreadable', 'project_folder_not_writable'];

function printDenialWithHint(reason: SandboxDenyReason, projectPath: string): void {
  console.log(chalk.red(buildSandboxDenialMessage(reason)));
  console.log(chalk.gray(`   reason=${reason}`));
  if (PREP_HINT_REASONS.includes(reason)) {
    printSandboxCliHint('sandbox prep', projectPath);
  }
}

// -----------------------------------------------------------------------------
// 中継プロキシ（127.0.0.1:48711）の用意（B3 対応）
// -----------------------------------------------------------------------------

/** 48711 への接続試行（500ms タイムアウト）で既存の中継プロキシの待ち受けを検出する */
function detectExistingSandboxProxyListener(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: SANDBOX_PROXY_PORT });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 500);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.end();
      resolve(true);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

interface SandboxProxySession {
  /** 自分で起動したプロキシが拒否した宛先の記録（既存の待ち受けを再利用した場合は常に空） */
  deniedTargets: SandboxProxyDenial[];
}

/**
 * `status` / `selftest` の前提として中継プロキシ（127.0.0.1:48711）を用意する。
 *
 * SB-1a-1 時点では status/selftest が中継プロキシを一切起動せず、Sandbox Host の
 * `ProbeLoopbackReachable()` が必ず失敗していた（実機確認済み、`loopback_probe_failed`）。
 * 既存の待ち受けがあれば再利用し、無ければ自分で一時起動して `fn()` の実行中だけ維持し、
 * 終了時に必ず閉じる。上位プロキシが socks の場合は起動せず、fail-closed のまま
 * （`loopback_probe_failed` で拒否される）表示だけ行う。
 */
async function withSandboxProxy<T>(fn: (session: SandboxProxySession) => Promise<T>): Promise<T> {
  const listenerDetected = await detectExistingSandboxProxyListener();
  const config = await loadConfig();
  let upstreamProxyScheme: string | undefined;
  if (config.proxy?.url) {
    try {
      upstreamProxyScheme = new URL(config.proxy.url).protocol.replace(/:$/, '');
    } catch {
      upstreamProxyScheme = undefined;
    }
  }
  const decision = decideSandboxProxyMode({ listenerDetected, upstreamProxyScheme });
  console.log(chalk.gray(`  ${decision.message}`));

  const session: SandboxProxySession = { deniedTargets: [] };
  if (decision.mode !== 'start-own') {
    return fn(session);
  }

  const allowlistResolution = resolveSandboxAllowlist(config.sandbox?.allowlist);
  const allowlist = allowlistResolution.ok ? allowlistResolution.allowlist : [];
  let handle: SandboxProxyHandle | null = null;
  try {
    handle = await createSandboxConnectProxy({
      port: SANDBOX_PROXY_PORT,
      allowlist,
      upstreamProxyUrl: config.proxy?.url,
      onDenied: (denial) => {
        session.deniedTargets.push(denial);
      },
    });
  } catch (err) {
    console.log(chalk.red(`  ❌ 中継プロキシの起動に失敗しました: ${err instanceof Error ? err.message : String(err)}`));
  }
  try {
    return await fn(session);
  } finally {
    if (handle) await handle.close();
  }
}

// -----------------------------------------------------------------------------
// status
// -----------------------------------------------------------------------------

export async function sandboxStatusCommand(options: { project?: string }): Promise<void> {
  console.log(chalk.blue('🛡️  Sandbox 実行前確認'));
  const projectPath = options.project ?? process.cwd();
  console.log(chalk.gray(`  対象プロジェクト: ${projectPath}`));

  if (process.platform !== 'win32') {
    console.log(chalk.yellow(`  ⚠️ 現在の OS: ${process.platform}（Sandbox は Windows 専用です）`));
  }

  const result = await withSandboxProxy(() => runSandboxPreflightCheck(projectPath));

  printCheck(`DEVRELAY_SANDBOX_DISABLE が設定されていない`, !isSandboxDisabledBySwitch());
  printCheck(`OS が Windows`, process.platform === 'win32');
  printCheck(`claude 実行ファイルが同梱版（system fallback ではない）`, !result.claudeExecutableFallbackActive);
  printCheck(`名前付きパイプへ接続できる`, result.pipeConnected);
  if (result.connectError) {
    console.log(chalk.gray(`     ${result.connectError}`));
  }
  if (result.handshake) {
    printCheck(`プロトコル版が一致（v${SANDBOX_PROTOCOL_VERSION}）`, result.handshake.protocolVersion === SANDBOX_PROTOCOL_VERSION);
    printCheck(`署名検証（ECDSA P-256 / SHA-256）`, result.handshake.signatureValid);
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
    printDenialWithHint(result.decision.reason, projectPath);
  }
}

// -----------------------------------------------------------------------------
// prep
// -----------------------------------------------------------------------------

/** 事前確認（存在・ディレクトリ・`.git`）に必要な情報をファイルシステムから取得する（B2 対応）。 */
async function probeSandboxPrepPrecheckInput(projectPath: string): Promise<{ exists: boolean; isDirectory: boolean; hasGit: boolean }> {
  let exists = false;
  let isDirectory = false;
  try {
    const stat = await fs.stat(projectPath);
    exists = true;
    isDirectory = stat.isDirectory();
  } catch {
    // 存在しない
  }
  let hasGit = false;
  if (exists && isDirectory) {
    try {
      await fs.stat(path.join(projectPath, '.git'));
      hasGit = true;
    } catch {
      // .git が無い
    }
  }
  return { exists, isDirectory, hasGit };
}

/** `execFileAsync(..., {encoding:'buffer'})` の失敗時エラーから、文字化けさせずに表示用テキストを作る（B2 対応）。 */
function describeSandboxExecError(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { stderr?: Buffer; stdout?: Buffer; message?: string };
    const stderrText = e.stderr && e.stderr.length > 0 ? decodeWindowsConsoleText(e.stderr).trim() : '';
    const stdoutText = e.stdout && e.stdout.length > 0 ? decodeWindowsConsoleText(e.stdout).trim() : '';
    const combined = [stderrText, stdoutText].filter(Boolean).join(' / ');
    if (combined) return combined;
    if (e.message) return e.message;
  }
  return String(err);
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

  // B2 対応: 存在確認・ディレクトリ確認・.git 確認を最初に行い、NG なら ACL を一切変更せず終了する
  // （SB-1a-1 時点では存在しないパスでも祖先ディレクトリへの traverse 付与まで進んでから
  // 失敗していた。実機確認済みの既存バグ）。
  const precheck = decideSandboxPrepPrecheck(await probeSandboxPrepPrecheckInput(projectPath));
  if (!precheck.ok) {
    console.log(chalk.red(buildSandboxPrepPrecheckMessage(precheck.reason)));
    return;
  }

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
      await execFileAsync(step.command, step.args, { encoding: 'buffer' });
      console.log(chalk.green(`  ✓ ${step.description}`));
    } catch (err) {
      console.log(chalk.yellow(`  ⚠ ${step.description} に失敗しました: ${describeSandboxExecError(err)}`));
      failed.push(step);
    }
  }

  if (failed.length > 0) {
    console.log();
    console.log(chalk.yellow('以下は手動で実行してください:'));
    console.log(chalk.gray(buildSandboxPrepManualFallbackText(failed)));
  } else {
    console.log();
    console.log(chalk.green('✅ Sandbox prep が完了しました。以下で確認してください:'));
    printSandboxCliHint('sandbox status', projectPath);
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

// -----------------------------------------------------------------------------
// set-token
// -----------------------------------------------------------------------------

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

// -----------------------------------------------------------------------------
// selftest
// -----------------------------------------------------------------------------

export async function sandboxSelftestCommand(options: {
  project?: string;
  networkProbe?: boolean;
  spawn?: boolean;
  bitsProbe?: boolean;
  claudeRoundtrip?: boolean;
  aclAudit?: boolean;
}): Promise<void> {
  const projectPath = options.project ? path.resolve(options.project) : process.cwd();
  console.log(chalk.blue(`🛡️  Sandbox selftest: ${projectPath}`));

  const result = await withSandboxProxy(() => runSandboxPreflightCheck(projectPath));
  if (!result.decision.allowed) {
    printDenialWithHint(result.decision.reason, projectPath);
    return;
  }
  console.log(chalk.green('✅ 実行前確認を通過しました。'));

  const anyFlag = options.spawn || options.networkProbe || options.aclAudit || options.claudeRoundtrip || options.bitsProbe;
  if (!anyFlag) {
    console.log(
      chalk.gray(
        '  --spawn / --network-probe / --acl-audit / --claude-roundtrip / --bits-probe を指定すると実際に確認します。',
      ),
    );
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
  if (options.aclAudit) {
    await runSandboxAclAudit(projectPath);
  }
  if (options.claudeRoundtrip) {
    await runSandboxClaudeRoundtrip(projectPath);
  }
  if (options.bitsProbe) {
    await runSandboxBitsProbe(projectPath);
  }
}

/** ホスト経由でコマンドを実行する共通ヘルパ。接続・spawn いずれかの失敗は `spawnFailed:true` にまとめる。 */
interface HostRoutedCommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  spawnFailed: boolean;
  stdout: string;
  stderr: string;
}

async function runHostRoutedCommand(
  projectPath: string,
  command: string,
  args: string[],
  envOverrides: Record<string, string | null> = {},
  timeoutMs = 8_000,
): Promise<HostRoutedCommandResult> {
  let socket;
  try {
    socket = await connectToSandboxHost(buildSandboxPipePath(), SANDBOX_HANDSHAKE_TIMEOUT_MS);
  } catch {
    return { exitCode: null, signal: null, timedOut: false, spawnFailed: true, stdout: '', stderr: '' };
  }
  try {
    const proc = new SandboxSpawnedProcess(socket, { command, args, cwd: projectPath, env: envOverrides });
    const r = await awaitSandboxProcessResult(proc, timeoutMs);
    return { exitCode: r.exitCode, signal: r.signal, timedOut: r.timedOut, spawnFailed: false, stdout: r.stdout, stderr: r.stderr };
  } catch {
    return { exitCode: null, signal: null, timedOut: false, spawnFailed: true, stdout: '', stderr: '' };
  } finally {
    socket.destroy();
  }
}

function describeProbeOutcomeLine(interpretation: SandboxProbeInterpretation): string {
  const label =
    interpretation.outcome === 'blocked' ? '遮断できた' : interpretation.outcome === 'reachable' ? '遮断できなかった' : '未確認';
  return `${label}（${interpretation.evidence}）`;
}

/** ホスト経由で簡単なコマンドを起動し、stdio 中継・exit コードが正しく返ることを確認する（B5 対応） */
async function runSandboxEchoSpawn(projectPath: string): Promise<void> {
  console.log(chalk.blue('  ▶ ホスト経由で簡単なコマンドを実行します（claude 本体は起動しません）...'));
  const raw = await runHostRoutedCommand(projectPath, 'cmd.exe', ['/c', 'echo', 'devrelay-sandbox-selftest'], {}, 5_000);
  if (raw.spawnFailed) {
    console.log(chalk.red('     ホスト経由での起動に失敗しました。'));
    return;
  }
  console.log(chalk.gray(`     出力: ${raw.stdout.trim()}`));
  if (raw.timedOut) {
    console.log(chalk.yellow('     タイムアウトしました（exitCode は取得できませんでした）。'));
  } else {
    console.log(chalk.gray(`     exitCode: ${raw.exitCode ?? 'null'}${raw.signal ? ` (signal=${raw.signal})` : ''}`));
  }
}

function buildCurlDirectArgs(): string[] {
  return ['-sS', '-o', 'NUL', '-w', '%{http_code}', '--max-time', '5', '--noproxy', '*', `https://${SANDBOX_POSITIVE_CONTROL_HOST}/`];
}

function buildCurlProxyDenyArgs(): string[] {
  return ['-sS', '-o', 'NUL', '-w', '%{http_code}', '--max-time', '5', 'https://example.com/'];
}

/**
 * ネットワーク遮断の実機確認を**ホスト経由（Sandbox 身元）**で行う（B6 対応）。
 * SB-1a-1 時点では開発者身元で直接 `cmd.exe` を実行していたため、ファイアウォールの制限の
 * 外で測っていた（実機確認済みの既存バグ）。確認は 2 本:
 *   1. プロキシを通さない直結が遮断されること（陽性対照: 許可リストの実ホストへ）
 *   2. 中継プロキシ経由で、許可リスト外のホストが拒否されること
 */
async function runSandboxNetworkProbes(projectPath: string): Promise<void> {
  console.log(chalk.blue('  ▶ ネットワーク遮断の確認プローブを実行します（ホスト経由）...'));

  await withSandboxProxy(async (session) => {
    const directRaw = await runHostRoutedCommand(projectPath, 'curl.exe', buildCurlDirectArgs(), {
      HTTPS_PROXY: null,
      HTTP_PROXY: null,
      https_proxy: null,
      http_proxy: null,
      ALL_PROXY: null,
      all_proxy: null,
    });
    const directInterpretation = interpretSandboxDirectBlockProbe(directRaw);
    console.log(`     直結（プロキシ無し、許可リストの実ホストへ）: ${describeProbeOutcomeLine(directInterpretation)}`);

    const proxyUrl = `http://127.0.0.1:${SANDBOX_PROXY_PORT}`;
    const viaProxyRaw = await runHostRoutedCommand(projectPath, 'curl.exe', buildCurlProxyDenyArgs(), {
      HTTPS_PROXY: proxyUrl,
      HTTP_PROXY: proxyUrl,
      https_proxy: proxyUrl,
      http_proxy: proxyUrl,
    });
    const proxyInterpretation = interpretSandboxProxyDenyProbe({
      ...viaProxyRaw,
      proxyDeniedObserved: session.deniedTargets.length > 0,
    });
    console.log(`     プロキシ経由（許可リスト外のホストへ）: ${describeProbeOutcomeLine(proxyInterpretation)}`);
  });
}

/**
 * Sandbox 身元から Agent の設定・トークン・リポジトリ資格情報が読めないことを確認する（C1 対応）。
 * `cmd.exe /c type <path> >nul` の**終了コードだけ**で判定する（stdout は `>nul` で捨てるため、
 * トークン等の値はホストからもパイプ上にも一切現れない）。
 */
async function runSandboxAclAudit(projectPath: string): Promise<void> {
  console.log(chalk.blue('  ▶ Sandbox 身元からの読み取り可否を確認します（exit コードのみで判定。内容は表示しません）...'));
  const agentDir = path.join(getConfigDir(), 'agent');
  const targets: Array<{ label: string; path: string }> = [
    { label: 'config.yaml', path: path.join(getConfigDir(), 'config.yaml') },
    { label: 'sandbox-token', path: getSandboxTokenPath() },
    { label: 'agent\\.git\\config', path: path.join(agentDir, '.git', 'config') },
  ];

  for (const target of targets) {
    const raw = await runHostRoutedCommand(projectPath, 'cmd.exe', ['/c', 'type', target.path, '>', 'nul']);
    const interpretation = interpretSandboxReadProbe(raw.spawnFailed ? null : raw.exitCode);
    const label =
      interpretation.outcome === 'readable'
        ? '読めてしまった（危険）'
        : interpretation.outcome === 'not-readable'
          ? '読めなかった（期待どおり）'
          : '未確認';
    console.log(`     ${target.label}: ${label}（${interpretation.evidence}）`);
  }

  const dirRaw = await runHostRoutedCommand(projectPath, 'cmd.exe', ['/c', 'dir', getConfigDir(), '>', 'nul']);
  const dirInterpretation = interpretSandboxReadProbe(dirRaw.spawnFailed ? null : dirRaw.exitCode);
  const dirLabel =
    dirInterpretation.outcome === 'readable'
      ? '列挙できてしまった（危険）'
      : dirInterpretation.outcome === 'not-readable'
        ? '列挙できなかった（期待どおり）'
        : '未確認';
  console.log(`     %APPDATA%\\devrelay の列挙: ${dirLabel}（${dirInterpretation.evidence}）`);
}

/**
 * claude 本体をホスト経由で 1 往復させる（B8 対応）。既存部品（`buildSandboxChildEnv()` /
 * `sandbox-token` / 中継プロキシ / `SandboxSpawnedProcess`）の組み合わせのみで実現し、
 * `ai-runner.ts` には配線しない（SB-1a-1 の範囲のまま）。
 */
async function runSandboxClaudeRoundtrip(projectPath: string): Promise<void> {
  console.log(chalk.blue('  ▶ claude 本体をホスト経由で 1 往復させます...'));

  let oauthToken: string;
  try {
    oauthToken = (await fs.readFile(getSandboxTokenPath(), 'utf-8')).trim();
  } catch {
    console.log(chalk.red('  ❌ sandbox-token が見つかりません。'));
    printSandboxCliHint('sandbox set-token');
    return;
  }
  if (!oauthToken) {
    console.log(chalk.red('  ❌ sandbox-token が空です。'));
    return;
  }

  const probe = probeSdkExecutable();
  let command: string;
  let args: string[];
  if (probe.form === 'native' && probe.path) {
    command = probe.path;
    args = ['-p', 'Reply with OK only.', '--output-format', 'text'];
  } else if (probe.form === 'clijs' && probe.path) {
    console.log(chalk.yellow('  ⚠️ cli.js 形式（0.2 系 SDK）のため node.exe を Sandbox 身元が読める必要があります。'));
    command = process.execPath;
    args = [probe.path, '-p', 'Reply with OK only.', '--output-format', 'text'];
  } else {
    console.log(chalk.red('  ❌ claude 実行ファイルを解決できませんでした（同梱実行ファイルが見つかりません）。'));
    return;
  }

  const proxyUrl = `http://127.0.0.1:${SANDBOX_PROXY_PORT}`;
  const env = buildSandboxChildEnv({
    oauthToken,
    proxyUrl,
    homeDir: getSandboxHomeDir(),
    sessionId: `selftest-${Date.now()}`,
    projectPath,
  });

  await withSandboxProxy(async () => {
    const raw = await runHostRoutedCommand(projectPath, command, args, env, 120_000);
    if (raw.spawnFailed) {
      console.log(chalk.red('  ❌ ホスト経由での起動に失敗しました。'));
      return;
    }
    if (raw.timedOut) {
      console.log(chalk.yellow('  ⚠ タイムアウトしました（120 秒）。'));
      return;
    }
    const safeOutput = redactSandboxSecrets(raw.stdout.slice(0, 200), [oauthToken]);
    console.log(chalk.gray(`     exitCode: ${raw.exitCode ?? 'null'}`));
    console.log(chalk.gray(`     出力（先頭200文字）: ${safeOutput.trim()}`));
    if (raw.exitCode === 0) {
      console.log(chalk.green('  ✅ claude 本体が 1 往復しました。'));
    } else {
      console.log(chalk.yellow('  ⚠ claude の実行が正常終了しませんでした。'));
    }
  });
}

/**
 * 既知の回避経路（bitsadmin 等のブローカーサービス経由の通信）を確認する（B7 対応）。
 * **既定では実行しない**（`--bits-probe` を明示指定したときだけ）。Microsoft Defender に
 * 検知される可能性があるため実行前に警告する。ウイルス対策の除外設定を案内する文言は入れない。
 */
async function runSandboxBitsProbe(projectPath: string): Promise<void> {
  console.log(chalk.yellow('  ⚠️ 警告: この確認はウイルス対策ソフトに検知される可能性があります（bitsadmin 経由の通信確認）。'));
  console.log(chalk.blue('  ▶ 既知の回避経路（bitsadmin）の確認プローブを実行します（ホスト経由）...'));

  const outFile = `${getSandboxHomeDir()}\\devrelay-sbtest-${Date.now()}.tmp`;
  const raw = await runHostRoutedCommand(projectPath, 'bitsadmin.exe', [
    '/transfer',
    'devrelay-sbtest',
    '/priority',
    'high',
    `https://${SANDBOX_POSITIVE_CONTROL_HOST}/`,
    outFile,
  ]);
  const interpretation = interpretSandboxKnownBypassProbe({ exitCode: raw.exitCode, timedOut: raw.timedOut, spawnFailed: raw.spawnFailed });
  console.log(`     bitsadmin（既知の代行サービス経由の回避経路）: ${describeProbeOutcomeLine(interpretation)}`);
  console.log(
    chalk.yellow(
      '       ⚠️ BITS 等のブローカーサービス経由の通信は SID ベースのファイアウォールルールで' +
        '構造的に遮断できません（別 SID のサービスが実際の通信を行うため）。',
    ),
  );
}
