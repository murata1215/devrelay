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
  | 'project_folder_not_writable';

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
 * 拒否理由ごとの日本語メッセージ（固定の `Record` なので、`SandboxDenyReason` に新しい値を
 * 追加するとコンパイルエラーで検知できる＝書き忘れを防ぐ）。
 * 文言には `session` / `resume` / `Prompt is too long` を含めない（ai-runner.ts の
 * resume 失敗 retry 誤判定 (`:1987-1995`) に紛れ込ませないため。SB-1a-1 では配線しないが、
 * SB-1a-2 以降の配線を見据えて今のうちに固定する）。
 */
const SANDBOX_DENIAL_MESSAGES: Record<SandboxDenyReason, string> = {
  disabled_by_switch: '❌ Sandbox 実行はこのマシンで無効化されています（DEVRELAY_SANDBOX_DISABLE）。',
  unsupported_platform: '❌ Sandbox 実行は Windows 専用です。',
  unsupported_ai_tool: '❌ Sandbox 実行は Claude Code 専用です（実際に使う AI ツールが異なります）。',
  terminal_mode_unsupported: '❌ Sandbox 実行は端末インタフェースモードに対応していません。',
  project_path_under_user_profile: '❌ プロジェクトの場所が開発者のホーム配下のため、Sandbox 実行を拒否しました。別の場所へ移してください。',
  capability_not_declared: '❌ この Agent は Sandbox 実行に対応していません。更新してください。',
  claude_executable_fallback_active: '❌ 同梱の claude 実行ファイルが見つからず代替パスを使っているため、Sandbox 実行を拒否しました。',
  allowlist_invalid: '❌ Sandbox の許可リスト設定が不正なため、実行を拒否しました。',
  pipe_unreachable: '❌ Sandbox Host に接続できません。サービスが起動しているか確認してください。',
  protocol_version_mismatch: '❌ Sandbox Host のプロトコル版が一致しません。インストールスクリプトを再実行してください。',
  signature_invalid: '❌ Sandbox Host の署名検証に失敗しました。実行を拒否しました。',
  identity_mismatch: '❌ Sandbox Host の身元が期待と異なります。実行を拒否しました。',
  block_probe_failed: '❌ 外向き通信の遮断を確認できなかったため、実行を拒否しました。',
  loopback_probe_failed: '❌ 中継プロキシへの到達を確認できなかったため、実行を拒否しました。',
  claude_executable_unreadable: '❌ Sandbox Host が claude 実行ファイルを読み取れません。`devrelay sandbox prep` を実行してください。',
  project_folder_not_writable: '❌ Sandbox Host がプロジェクトフォルダに書き込めません。`devrelay sandbox prep` を実行してください。',
};

/** 拒否理由に対応する日本語メッセージを返す。 */
export function buildSandboxDenialMessage(reason: SandboxDenyReason): string {
  return SANDBOX_DENIAL_MESSAGES[reason];
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
