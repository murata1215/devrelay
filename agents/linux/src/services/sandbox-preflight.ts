/**
 * Sandbox 実行前確認（`status`/`selftest` と同じ処理）と、通過したターンの起動材料の組み立て。
 *
 * サイクル SB-1a-2。`runSandboxPreflightCheck()` は SB-1a-1/1.1 時点では
 * `cli/commands/sandbox.ts` の中にあった（`status`/`selftest` 専用、`effectiveAiTool`/
 * `terminalMode` は CLI 単独確認用に固定値だった）。チャット経路（`ai-runner.ts`）でも
 * 同じ確認を行うためにここへ移設し、両者を引数化した。CLI は `'claude'`/`false` を渡すため、
 * 表示・項目数は変わらない。
 *
 * `prepareSandboxLaunch()` は本サイクルの新規追加: 実行前確認を通過したターンに対して、
 * `createSandboxSpawnFunction()`（SDK の `spawnClaudeCodeProcess` に渡す同期関数）と
 * 後始末（`dispose()`）を組み立てる。
 */

import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import {
  getSandboxTokenPath,
  getSandboxPublicKeyPath,
  getSandboxHomeDir,
  getConfigDir,
  type AgentConfig,
} from './config.js';
import {
  SANDBOX_PROTOCOL_VERSION,
  SANDBOX_PROXY_PORT,
  SANDBOX_HANDSHAKE_TIMEOUT_MS,
  EXPECTED_SANDBOX_SERVICE_NAME,
  SANDBOX_SERVICE_SID_PREFIX,
  SANDBOX_KNOWN_PRIVILEGED_SIDS,
  buildSandboxPipePath,
} from './sandbox-protocol.js';
import {
  connectToSandboxHost,
  performSandboxHandshake,
  createSandboxSpawnFunction,
  type SandboxHandshakeResult,
  type SandboxSpawnedProcess,
  type SandboxSdkSpawnOptions,
} from './sandbox-launcher.js';
import { generateSandboxNonce } from './sandbox-attest.js';
import { resolveSandboxAllowlist } from './sandbox-allowlist.js';
import {
  decideSandboxPreflight,
  buildSandboxDenialMessage,
  type SandboxDenialMessageContext,
  type SandboxPreflightInput,
  type SandboxDenyReason,
} from './sandbox-readiness.js';
import { resolveCurrentUserSid } from './sandbox-identity.js';
import { probeSdkExecutable } from './sdk-executable.js';
import { buildSandboxChildEnv } from './sandbox-env.js';
import { acquireSandboxProxy } from './sandbox-proxy-session.js';
import { shouldDeclareSandboxHostCapability } from './sandbox-target.js';
import {
  reconcileSandboxAllowDestinations,
  type SandboxAllowReconcileResult,
} from './sandbox-allow-apply.js';
import * as os from 'node:os';
import * as path from 'node:path';

/** チャットの拒否文へ渡す、この Agent で実行可能な実パスを組み立てる。 */
export function buildRuntimeSandboxDenialContext(projectPath: string): SandboxDenialMessageContext {
  const cliEntry = process.argv[1] ?? '';
  const repoInstallScript = path.resolve(path.dirname(cliEntry), '../../../..', 'scripts', 'install-sandbox-host.ps1');
  return {
    platform: process.platform,
    nodeExe: process.execPath,
    cliEntry,
    projectPath,
    // Agent がリポジトリ外へ配布されている場合は、存在しない推測パスを表示しない。
    installScriptPath: existsSync(repoInstallScript) ? repoInstallScript : undefined,
    configPath: path.join(getConfigDir(), 'config.yaml'),
  };
}

/** `DEVRELAY_SANDBOX_DISABLE` キルスイッチ（既定 `0`）。`1` なら sandbox 要求ターンを全部拒否する。 */
export function isSandboxDisabledBySwitch(): boolean {
  return process.env.DEVRELAY_SANDBOX_DISABLE === '1';
}

export interface SandboxPreflightCheckResult {
  decision: { allowed: true } | { allowed: false; reason: SandboxDenyReason };
  handshake: SandboxHandshakeResult | null;
  claudeExecutablePath: string | null;
  claudeExecutableFallbackActive: boolean;
  projectPath: string;
  currentUserSid: string | null;
  pipeConnected: boolean;
  connectError: string | null;
  /** サイクル SB-2.1: 直接通信の許可リスト（IP とポート）の検証・反映結果（`status` の表示用） */
  allowDestinations: SandboxAllowReconcileResult;
}

export interface SandboxPreflightCheckOptions {
  /** すり替え解決後の実効 AI ツール名（既定 `'claude'`。CLI 単独確認は常にこの既定値を使う） */
  effectiveAiTool?: string;
  /** 端末インタフェースモード（PTY 経由）が ON か（既定 `false`） */
  terminalMode?: boolean;
  /** `config.yaml` の `sandbox.allowlist`（未指定なら既定値） */
  allowlist?: string[];
  /** サイクル SB-2.1: `config.yaml` の `sandbox.allowDestinations`（未指定なら空集合扱い） */
  allowDestinations?: string[];
  /** サイクル SB-2.1.5: 許可リストの反映待ち中に呼ばれる進捗通知（呼び出し側が表示手段を選ぶ） */
  onProgress?: (message: string) => void;
}

async function readSandboxPublicKey(): Promise<string> {
  return fs.readFile(getSandboxPublicKeyPath(), 'utf-8');
}

/**
 * Sandbox 実行前確認（ホストへ接続・ハンドシェイク・署名検証を行い、`decideSandboxPreflight()`
 * に渡す完全な入力を組み立てて判定する）。呼び出し側は事前に中継プロキシを用意しておくこと
 * （本関数自体はプロキシの起動は行わない）。
 */
export async function runSandboxPreflightCheck(
  projectPath: string,
  options: SandboxPreflightCheckOptions = {},
): Promise<SandboxPreflightCheckResult> {
  const effectiveAiTool = options.effectiveAiTool ?? 'claude';
  const terminalMode = options.terminalMode ?? false;

  const probe = probeSdkExecutable();
  const claudeExecutablePath = probe.path; // clijs/native のみ非 null（それ以外は fallback 扱い）
  const claudeExecutableFallbackActive = probe.form === 'none' || probe.form === 'unresolved';

  const allowlistResolution = resolveSandboxAllowlist(options.allowlist);
  // サイクル SB-2.1: 直接通信の許可リスト（IP とポート）の検証・反映確認。パイプ接続より前に
  // 行う（高コストなハンドシェイクを、どうせ拒否になる設定不一致の後に払わないため）。
  const allowDestinations = await reconcileSandboxAllowDestinations(
    options.allowDestinations,
    undefined,
    options.onProgress,
  );

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
    effectiveAiTool,
    terminalMode,
    projectPathUnderUserProfile,
    // サイクルSB-1b: capability 申告の配線完了（agents/linux は Windows 実行時のみ申告する）
    capabilityDeclared: shouldDeclareSandboxHostCapability(process.platform),
    claudeExecutableFallbackActive,
    allowlistValid: allowlistResolution.ok,
    allowDestinationsValid: allowDestinations.valid,
    allowDestinationsApplied: allowDestinations.applied,
    allowDestinationsPending: allowDestinations.outcome === 'pending',
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
    allowDestinations,
  };
}

export interface SandboxLaunch {
  /** SDK の `Options.spawnClaudeCodeProcess` にそのまま設定する同期関数 */
  spawn: (opts: SandboxSdkSpawnOptions) => SandboxSpawnedProcess;
  /** ターン終了時に必ず呼ぶ（中継プロキシのリース解放） */
  dispose: () => Promise<void>;
}

export interface PrepareSandboxLaunchInput {
  sessionId: string;
  projectPath: string;
  /** 判定のたびに読み直した最新の `config.yaml` の `sandbox` 設定（SB-1a-2 の人間の追加指示:
   *  キャッシュされた AgentConfig を使うと `u` が再起動しない場合に変更が反映されないため、
   *  呼び出し側が毎ターン `loadConfig()` 等で読み直した値をここへ渡すこと） */
  sandboxSettings: AgentConfig['sandbox'];
  /** 上位プロキシ（`config.proxy.url`）。http/https のみ chain する */
  upstreamProxyUrl?: string;
  /** 拒否理由等をチャットへ出すための出力コールバック */
  onOutput: (output: string, isComplete: boolean) => void;
}

/**
 * 実行前確認を通過したターンに対して Sandbox 起動の材料を組み立てる。
 * 1 つでも NG なら拒否理由を `onOutput()` でチャットへ返し、`null` を返す
 * （呼び出し側はこのターンを打ち切ること。制限なしでの実行にフォールバックしない）。
 */
export async function prepareSandboxLaunch(input: PrepareSandboxLaunchInput): Promise<SandboxLaunch | null> {
  const { session: _session, release } = await acquireSandboxProxy({
    allowlist: input.sandboxSettings?.allowlist,
    upstreamProxyUrl: input.upstreamProxyUrl,
  });

  let launchPrepared = false;
  try {
    const check = await runSandboxPreflightCheck(input.projectPath, {
      effectiveAiTool: 'claude',
      terminalMode: false,
      allowlist: input.sandboxSettings?.allowlist,
      allowDestinations: input.sandboxSettings?.allowDestinations,
      // サイクル SB-2.1.5: 反映待ちの間、チャットへ 1 行出す（`⏳` prefix で進捗専用チャンクとして
      // 扱われ、最終回答には混ざらない。connection.ts の `output.startsWith('⏳')` 規約）。
      onProgress: (message) => input.onOutput(`⏳ ${message}\n`, false),
    });
    if (!check.decision.allowed) {
      input.onOutput(buildSandboxDenialMessage(check.decision.reason, buildRuntimeSandboxDenialContext(input.projectPath)), true);
      return null;
    }

    let oauthToken: string;
    try {
      oauthToken = (await fs.readFile(getSandboxTokenPath(), 'utf-8')).trim();
    } catch {
      input.onOutput(buildSandboxDenialMessage('sandbox_token_missing', buildRuntimeSandboxDenialContext(input.projectPath)), true);
      return null;
    }
    if (!oauthToken) {
      input.onOutput(buildSandboxDenialMessage('sandbox_token_missing', buildRuntimeSandboxDenialContext(input.projectPath)), true);
      return null;
    }

    const baseEnv = buildSandboxChildEnv({
      oauthToken,
      proxyUrl: `http://127.0.0.1:${SANDBOX_PROXY_PORT}`,
      homeDir: getSandboxHomeDir(),
      sessionId: input.sessionId,
      projectPath: input.projectPath,
    });

    const spawn = createSandboxSpawnFunction({
      pipePath: buildSandboxPipePath(),
      baseEnv,
      agentEnv: process.env,
    });

    launchPrepared = true;
    return {
      spawn,
      dispose: async () => {
        await release();
      },
    };
  } finally {
    if (!launchPrepared) {
      await release();
    }
  }
}
