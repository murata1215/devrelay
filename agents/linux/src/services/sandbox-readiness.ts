/**
 * Sandbox 実行前確認の表駆動 fail-closed 判定（外部 import ゼロ、純関数）。
 *
 * `apps/server/src/services/cross-ask-isolation-rules.ts` と同じ流儀: 判別可能ユニオンを返す
 * `decide...()`、理由ごとの文言を組み立てる `build...DenialMessage()`。既定は拒否で、許可は
 * 全項目を満たしたときのみ 1 段ずつ明示的に通す。
 *
 * サイクル SB-1a-1。1 つでも NG なら Sandbox Host へ spawn 要求を送らず拒否すること
 * （fail-closed。「制限なしで実行してしまう」経路を作らない）。
 */

import { buildSandboxCliCommand } from './sandbox-cli-hint.js';

export type SandboxDenyReason =
  | 'disabled_by_switch'
  | 'unsupported_platform'
  | 'unsupported_ai_tool'
  | 'terminal_mode_unsupported'
  | 'project_path_under_user_profile'
  | 'capability_not_declared'
  | 'claude_executable_fallback_active'
  | 'allowlist_invalid'
  | 'pipe_unreachable'
  | 'protocol_version_mismatch'
  | 'signature_invalid'
  | 'identity_mismatch'
  | 'block_probe_failed'
  | 'loopback_probe_failed'
  | 'claude_executable_unreadable'
  | 'project_folder_not_writable'
  // サイクル SB-2.1: 許可リスト（IP とポート）の検証・反映
  | 'allow_destinations_invalid'
  // サイクル SB-2.1.5: 反映中（まだ分からない。再送を促す）と、反映に失敗したと確信できる場合を区別
  | 'allow_destinations_apply_pending'
  | 'allow_destinations_not_applied'
  // サイクル SB-1a-2: チャット経路のターン単位の拒否理由（`decideSandboxTurnEligibility()`）
  | 'target_undecidable'
  | 'raw_mode_unsupported'
  | 'ephemeral_session_unsupported'
  | 'handover_turn_unsupported'
  | 'sandbox_token_missing';

export type SandboxPreflightDecision = { allowed: true } | { allowed: false; reason: SandboxDenyReason };

export interface SandboxPreflightInput {
  /** `DEVRELAY_SANDBOX_DISABLE` キルスイッチ（`1` なら sandbox 要求ターンを全部拒否） */
  disabledBySwitch: boolean;
  /** `process.platform`。Sandbox は Windows 専用 */
  platform: string;
  /** すり替え解決後（`resolveEffectiveAiTool()` 等を経た後）の実効 AI ツール名 */
  effectiveAiTool: string;
  /** 端末インタフェースモード（PTY 経由）が ON か。sandbox は SDK 経路のみ対応 */
  terminalMode: boolean;
  /** realpath 正規化後の projectPath が開発者ホーム配下かどうか（配下だと claude の
   *  sensitive file 誤判定・ACL 付与範囲の意図しない拡大につながるため拒否） */
  projectPathUnderUserProfile: boolean;
  /** Agent がビルド時点で `'sandbox-host'` capability を申告しているか */
  capabilityDeclared: boolean;
  /** `getClaudeExecutableFallback()` が非 null（同梱実行ファイル欠落でシステム claude を使っている） */
  claudeExecutableFallbackActive: boolean;
  /** 許可リストが妥当か（`resolveSandboxAllowlist()` の結果） */
  allowlistValid: boolean;
  /** サイクル SB-2.1: 直接通信の許可リスト（IP とポート）が妥当か
   *  （`resolveSandboxAllowDestinations()` の結果） */
  allowDestinationsValid: boolean;
  /** サイクル SB-2.1: 直接通信の許可リストが実際のファイアウォールのルールに反映済みか
   *  （`reconcileSandboxAllowDestinations()` の結果。未設定/空かつ結果ファイル無しも true） */
  allowDestinationsApplied: boolean;
  /** サイクル SB-2.1.5: 反映がまだ完了していないが、失敗したとは確信できない状態か
   *  （`outcome === 'pending'`。`allowDestinationsApplied` が false の場合のみ意味を持つ） */
  allowDestinationsPending: boolean;
  /** 名前付きパイプへの接続が成功したか */
  pipeConnected: boolean;
  /** ハンドシェイクのプロトコル版が一致したか */
  protocolVersionMatch: boolean;
  /** ECDSA（P-256 / SHA-256）署名が公開鍵で検証できたか（これが false の間は、以下の身元・
   *  プローブ結果は自己申告に過ぎず証拠にならない。Plan は ed25519 を前提にしていたが、
   *  Sandbox Host を in-box csc.exe でビルドする制約上 ECDSA P-256 に変更した。
   *  詳細は `sandbox-attest.ts` のコメント参照） */
  signatureValid: boolean;
  /** 署名検証後の申告内容: サービス名が期待値と一致 */
  identityServiceNameMatches: boolean;
  /** 署名検証後の申告内容: SID が `S-1-5-80-` で始まる（サービス SID） */
  identitySidHasServicePrefix: boolean;
  /** 署名検証後の申告内容: SID が Agent 自身の SID と異なる */
  identitySidDiffersFromAgent: boolean;
  /** 署名検証後の申告内容: SID が既知の特権 SID（LocalSystem 等）でない */
  identitySidNotKnownPrivileged: boolean;
  /** 陽性対照（許可リストの実ホストへの直結）が遮断された */
  blockProbePositiveControlBlocked: boolean;
  /** Agent の loopback 中継プロキシへの到達確認が成功した（プローブが実際に走った証拠） */
  blockProbeLoopbackReachable: boolean;
  /** ホストが claude 実行ファイル（`command` パス）を実際に open できる */
  hostCanReadClaudeExecutable: boolean;
  /** ホストがプロジェクトフォルダに書き込める */
  hostCanWriteProjectFolder: boolean;
}

/**
 * Sandbox 実行を許可してよいか判定する。既定は拒否。全項目を満たしたときのみ許可する。
 * 判定順序: 構造判定（コスト0） → capability → 実行ファイル健全性 → 許可リスト妥当性
 *   → 直接通信許可リスト（IP とポート）の妥当性・反映済みか（反映中 pending と失敗を区別、SB-2.1.5）
 *   → パイプ接続 → プロトコル版 → 署名 → 身元 → プローブ → ホスト側読み書き確認。
 */
export function decideSandboxPreflight(input: SandboxPreflightInput): SandboxPreflightDecision {
  if (input.disabledBySwitch) return { allowed: false, reason: 'disabled_by_switch' };
  if (input.platform !== 'win32') return { allowed: false, reason: 'unsupported_platform' };
  if (input.effectiveAiTool !== 'claude') return { allowed: false, reason: 'unsupported_ai_tool' };
  if (input.terminalMode) return { allowed: false, reason: 'terminal_mode_unsupported' };
  if (input.projectPathUnderUserProfile) return { allowed: false, reason: 'project_path_under_user_profile' };
  if (!input.capabilityDeclared) return { allowed: false, reason: 'capability_not_declared' };
  if (input.claudeExecutableFallbackActive) return { allowed: false, reason: 'claude_executable_fallback_active' };
  if (!input.allowlistValid) return { allowed: false, reason: 'allowlist_invalid' };
  if (!input.allowDestinationsValid) return { allowed: false, reason: 'allow_destinations_invalid' };
  if (!input.allowDestinationsApplied) {
    return input.allowDestinationsPending
      ? { allowed: false, reason: 'allow_destinations_apply_pending' }
      : { allowed: false, reason: 'allow_destinations_not_applied' };
  }
  if (!input.pipeConnected) return { allowed: false, reason: 'pipe_unreachable' };
  if (!input.protocolVersionMatch) return { allowed: false, reason: 'protocol_version_mismatch' };
  if (!input.signatureValid) return { allowed: false, reason: 'signature_invalid' };
  // 署名が検証できた後にのみ、申告内容（身元・プローブ結果）を証拠として扱ってよい。
  if (
    !input.identityServiceNameMatches ||
    !input.identitySidHasServicePrefix ||
    !input.identitySidDiffersFromAgent ||
    !input.identitySidNotKnownPrivileged
  ) {
    return { allowed: false, reason: 'identity_mismatch' };
  }
  if (!input.blockProbePositiveControlBlocked) return { allowed: false, reason: 'block_probe_failed' };
  if (!input.blockProbeLoopbackReachable) return { allowed: false, reason: 'loopback_probe_failed' };
  if (!input.hostCanReadClaudeExecutable) return { allowed: false, reason: 'claude_executable_unreadable' };
  if (!input.hostCanWriteProjectFolder) return { allowed: false, reason: 'project_folder_not_writable' };
  return { allowed: true };
}

/**
 * チャットの拒否文に埋め込む実行環境のパス。呼び出し側で収集して渡すことで、文言生成自体は
 * I/O を持たない純関数に保つ。
 */
export interface SandboxDenialMessageContext {
  platform: string;
  nodeExe: string;
  cliEntry: string;
  projectPath: string;
  /** 管理者が実行する Host インストーラーの絶対パス。配布 Agent で不明なら省略する。 */
  installScriptPath?: string;
  /** 開発者の設定ファイルの絶対パス。 */
  configPath?: string;
}

function cliCommand(context: SandboxDenialMessageContext, subcommand: string, includeProject = false): string {
  return buildSandboxCliCommand({
    platform: context.platform,
    nodeExe: context.nodeExe,
    cliEntry: context.cliEntry,
    subcommand,
    projectPath: includeProject ? context.projectPath : undefined,
  });
}

function setupGuideLine(): string {
  return '全体の手順は doc/sandbox/SETUP.md';
}

function installHostLines(context: SandboxDenialMessageContext): string[] {
  if (context.installScriptPath) {
    return [
      '管理者: 管理者 PowerShell で次を実行してください。',
      `& "${context.installScriptPath}"`,
    ];
  }
  return ['管理者: DevRelay のクローンで scripts\\install-sandbox-host.ps1 を実行してください。'];
}

/**
 * 拒否理由ごとの日本語メッセージ。準備が不足する理由では、判定順で最初に見つかった 1 件だけの
 * 次の手順を 3〜6 行で返す。`context` を省略する旧来の CLI 呼び出しにも短い説明を返す。
 *
 * 文言には `session` / `resume` / `Prompt is too long` を含めない（ai-runner.ts の
 * resume 失敗 retry 誤判定 (`:1987-1995`) に紛れ込ませないため）。
 * また `⏳` で始めてはならない（`connection.ts` の `output.startsWith('⏳')` 判定で進捗専用
 * チャンクとして扱われ、最終回答から除外されてしまうため）。
 */
export function buildSandboxDenialMessage(reason: SandboxDenyReason, context?: SandboxDenialMessageContext): string {
  if (!context) return '❌ Sandbox で実行できません。doc/sandbox/SETUP.md を確認してください。';

  let lines: string[];
  switch (reason) {
    case 'pipe_unreachable':
      lines = ['❌ Sandbox で実行できません: Sandbox Host が準備・起動されていません。', ...installHostLines(context)];
      break;
    case 'protocol_version_mismatch':
    case 'signature_invalid':
    case 'identity_mismatch':
    case 'block_probe_failed':
    case 'loopback_probe_failed':
      lines = ['❌ Sandbox で実行できません: Sandbox Host の確認に失敗しました。', ...installHostLines(context)];
      break;
    case 'sandbox_token_missing':
      lines = [
        '❌ Sandbox で実行できません: Sandbox 用トークンが未登録です。',
        '開発者: 通常の PowerShell で次を実行し、claude setup-token の値を貼り付けてください。',
        cliCommand(context, 'sandbox set-token'),
      ];
      break;
    case 'claude_executable_unreadable':
    case 'project_folder_not_writable':
      lines = [
        '❌ Sandbox で実行できません: プロジェクトへの Sandbox 権限が未準備です。',
        '開発者: 通常の PowerShell で次を実行してください。',
        cliCommand(context, 'sandbox prep', true),
      ];
      break;
    case 'project_path_under_user_profile':
      lines = [
        '❌ Sandbox で実行できません: プロジェクトが開発者のホーム配下にあります。',
        '開発者: プロジェクトを C:\\dev などホーム外へ移してから、次を実行してください。',
        cliCommand(context, 'sandbox prep', true),
      ];
      break;
    case 'allowlist_invalid':
    case 'allow_destinations_invalid':
    case 'target_undecidable':
      lines = [
        '❌ Sandbox で実行できません: Sandbox の設定が正しくありません。',
        `開発者: ${context.configPath ?? '%APPDATA%\\devrelay\\config.yaml'} の sandbox 設定を修正してください。`,
        cliCommand(context, 'sandbox status', true),
      ];
      break;
    case 'allow_destinations_apply_pending':
      lines = [
        '❌ Sandbox で実行できません: 許可リストをファイアウォールへ反映中です。',
        '開発者: 少し待ってから同じメッセージをもう一度送ってください。',
      ];
      break;
    case 'allow_destinations_not_applied':
      lines = ['❌ Sandbox で実行できません: 許可リストの反映に失敗しました。', ...installHostLines(context)];
      break;
    case 'disabled_by_switch':
      lines = ['❌ Sandbox で実行できません: この PC で Sandbox が無効化されています。', '開発者: DEVRELAY_SANDBOX_DISABLE=1 を解除して Agent を再起動してください。'];
      break;
    case 'unsupported_platform':
      lines = ['❌ Sandbox で実行できません: Sandbox は Windows 専用です。', '開発者: Windows の Agent で実行してください。'];
      break;
    case 'unsupported_ai_tool':
      lines = ['❌ Sandbox で実行できません: Sandbox は Claude Code 専用です。', '開発者: AI ツールを Claude Code に変更して再実行してください。'];
      break;
    case 'terminal_mode_unsupported':
      lines = ['❌ Sandbox で実行できません: 端末インタフェースモードには対応していません。', '開発者: 端末インタフェースモードを OFF にして再実行してください。'];
      break;
    case 'capability_not_declared':
      lines = ['❌ Sandbox で実行できません: この Agent は Sandbox に対応していません。', '開発者: Windows 用の最新 Agent に更新して再接続してください。'];
      break;
    case 'claude_executable_fallback_active':
      lines = ['❌ Sandbox で実行できません: 同梱の Claude Code 実行ファイルがありません。', '開発者: Agent を更新してから再実行してください。'];
      break;
    case 'raw_mode_unsupported':
    case 'ephemeral_session_unsupported':
    case 'handover_turn_unsupported':
      lines = ['❌ Sandbox で実行できません: この種類のチャット実行には対応していません。', '開発者: 通常のチャットで再実行してください。'];
      break;
  }
  return [...lines, setupGuideLine()].join('\n');
}

// -----------------------------------------------------------------------------
// チャット経路のターン単位の拒否判定（サイクル SB-1a-2、I/O ゼロの安いふるい）
// -----------------------------------------------------------------------------

export interface SandboxTurnEligibilityInput {
  /** `decideSandboxTarget()` が `undecidable` を返した（設定ミス等で判定不能） */
  targetUndecidable: boolean;
  /** `DEVRELAY_SANDBOX_DISABLE` キルスイッチ */
  disabledBySwitch: boolean;
  /** `process.platform` */
  platform: string;
  /** すり替え解決後の実効 AI ツール名 */
  effectiveAiTool: string;
  /** 端末インタフェースモード（PTY 経由）が ON か */
  terminalMode: boolean;
  /** raw-completion（rawMode）ターンか */
  rawMode: boolean;
  /** 一時セッション（クロス ask・teamexec・askdesc・raw、`isEphemeralSession()`）か */
  isEphemeralSession: boolean;
  /** クロス ask スコープが設定されているか（`isEphemeralSession` と重複する場合があるが、
   *  どちらか一方だけでも拒否するため独立したフィールドとして持つ） */
  crossAskScope: boolean;
  /** スレッド引継ぎ（`n`）の引継ぎ書生成ターンか */
  handoverTurn: boolean;
}

/**
 * チャット経路のターンが Sandbox 実行の対象として成立するか判定する（`decideSandboxTarget()` で
 * `target` と判定された後に呼ぶ、I/O ゼロの安いふるい）。これを通過した後にのみ
 * `decideSandboxPreflight()`（実際にホストへ接続する高コストな確認）を呼ぶこと。
 *
 * 判定順序: 設定不正（最優先・fail-closed） → キルスイッチ → 構造判定（OS/AI ツール/端末モード/
 *   raw/一時セッション/引継ぎ）。
 */
export function decideSandboxTurnEligibility(input: SandboxTurnEligibilityInput): SandboxPreflightDecision {
  if (input.targetUndecidable) return { allowed: false, reason: 'target_undecidable' };
  if (input.disabledBySwitch) return { allowed: false, reason: 'disabled_by_switch' };
  if (input.platform !== 'win32') return { allowed: false, reason: 'unsupported_platform' };
  if (input.effectiveAiTool !== 'claude') return { allowed: false, reason: 'unsupported_ai_tool' };
  if (input.terminalMode) return { allowed: false, reason: 'terminal_mode_unsupported' };
  if (input.rawMode) return { allowed: false, reason: 'raw_mode_unsupported' };
  if (input.isEphemeralSession || input.crossAskScope) return { allowed: false, reason: 'ephemeral_session_unsupported' };
  if (input.handoverTurn) return { allowed: false, reason: 'handover_turn_unsupported' };
  return { allowed: true };
}

// -----------------------------------------------------------------------------
// 遮断プローブの解釈（陽性対照方式。改訂版 Plan のレビュー指摘2対応）
// -----------------------------------------------------------------------------

export type SandboxBlockProbeOutcome = 'blocked' | 'reachable' | 'inconclusive';

export interface SandboxBlockProbeResult {
  connected: boolean;
  errorCode?: string;
  timedOut: boolean;
}

/**
 * Windows のファイアウォールで Outbound Block された TCP connect が返すエラーコード。
 * **実機確認要**（SB-0 §5 リスク2 / 改訂版 Plan の未確認項目）。実機で異なるコードが観測された
 * 場合はここを更新し、`doc/sandbox/` に実測値を記録すること。
 */
export const SANDBOX_BLOCK_ERROR_CODES: ReadonlySet<string> = new Set(['EACCES', 'WSAEACCES']);

/**
 * 遮断プローブの結果を解釈する。**fail-closed**: 「判断できない」（タイムアウト・未知のエラー）は
 * `'inconclusive'` とし、`'blocked'` ではないため preflight は許可しない側に倒れる。
 */
export function interpretSandboxBlockProbe(result: SandboxBlockProbeResult): SandboxBlockProbeOutcome {
  if (result.connected) return 'reachable';
  if (result.timedOut) return 'inconclusive';
  if (result.errorCode && SANDBOX_BLOCK_ERROR_CODES.has(result.errorCode)) return 'blocked';
  return 'inconclusive';
}

// -----------------------------------------------------------------------------
// 確認結果のキャッシュ（E 節: 構造判定・身元・プロトコル版は毎ターン、プローブ類は TTL）
// -----------------------------------------------------------------------------

export interface SandboxCacheKeyInput {
  /** Sandbox Host の公開鍵指紋（`fingerprintSandboxPublicKey()`） */
  hostPublicKeyFingerprint: string;
  protocolVersion: number;
  /** realpath 正規化後の projectPath */
  projectPathReal: string;
  /** 許可リストのハッシュ（`hashSandboxAllowlist()`） */
  allowlistHash: string;
  proxyPort: number;
}

/** プローブ結果キャッシュのキーを組み立てる。ホスト・projectPath・許可リスト・プロキシポートの
 *  いずれかが変わればキャッシュは不一致になり、再確認が行われる。 */
export function buildSandboxCacheKey(input: SandboxCacheKeyInput): string {
  return [
    input.hostPublicKeyFingerprint,
    input.protocolVersion,
    input.projectPathReal,
    input.allowlistHash,
    input.proxyPort,
  ].join('|');
}

/** キャッシュエントリが TTL 内かどうか判定する */
export function isSandboxProbeCacheFresh(cachedAtMs: number, nowMs: number, ttlMs: number): boolean {
  return nowMs - cachedAtMs < ttlMs && ttlMs > 0;
}
