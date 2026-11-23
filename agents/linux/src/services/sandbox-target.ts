/**
 * チャット経路のターンが Sandbox 実行の対象かどうかを判定する（外部 import ゼロ、純関数）。
 *
 * サイクル SB-1a-2。対象の指定は `config.yaml` の `sandbox.projects`（マシン単位・絶対パスの配列）。
 * SB-1a-1 時点ではこのキーはどこからも読まれていなかった（読まれていたのは `sandbox.allowlist`
 * だけ）。既定は「対象外」（リスト空/未設定）で、既存の全ターンに影響しない。
 *
 * 判定できない場合は fail-closed（`undecidable`）とし、呼び出し側はそのマシンの Sandbox 対象
 * ターン全体を拒否する。「設定ミスで対象外に紛れ込み、制限なしで動く」事故を避けるため。
 */

export type SandboxTargetDecision =
  | { kind: 'not-target' }
  | { kind: 'target' }
  | { kind: 'undecidable'; detail: string };

export interface SandboxTargetInput {
  /** `config.yaml` の `sandbox.projects`（未設定/空なら対象外） */
  configuredProjects?: readonly string[];
  /** このターンのプロジェクトパス */
  projectPath: string;
  /** `process.platform` */
  platform: string;
}

/**
 * パスを比較用に正規化する。区切り文字を `\` に統一し、末尾の区切りを除去する。
 * `win32` では大文字小文字を無視するため小文字化する（NTFS は既定で大文字小文字を区別しない）。
 */
export function normalizeSandboxProjectPath(value: string, platform: string): string {
  let normalized = value.replace(/\//g, '\\');
  while (normalized.length > 1 && (normalized.endsWith('\\') || normalized.endsWith('/'))) {
    normalized = normalized.slice(0, -1);
  }
  if (platform === 'win32') {
    normalized = normalized.toLowerCase();
  }
  return normalized;
}

/** 絶対パスかどうかの簡易判定（`C:\...` または `\\server\share\...` 形式のみ許容） */
function isAbsoluteWindowsPath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value);
}

/**
 * このターンが Sandbox 実行の対象かどうかを判定する。
 *
 * 判定順序（コストの低い判定から先に、既定は対象外）:
 * 1. `configuredProjects` が空/未設定 → `not-target`（他 OS・未設定機はここで即終了。I/O ゼロ）
 * 2. `projectPath` が空、または絶対パスでない → `undecidable`
 * 3. `configuredProjects` に絶対パスでない項目が 1 つでもある → `undecidable`
 *    （設定ミスを黙って「対象外」に倒さない。そのマシンの Sandbox 対象ターン全体を拒否させるため）
 * 4. 正規化して一致するものがあれば `target`
 * 5. それ以外は `not-target`
 */
export function decideSandboxTarget(input: SandboxTargetInput): SandboxTargetDecision {
  const configured = input.configuredProjects;
  if (!configured || configured.length === 0) {
    return { kind: 'not-target' };
  }

  if (!input.projectPath || typeof input.projectPath !== 'string') {
    return { kind: 'undecidable', detail: 'projectPath が空です' };
  }
  if (input.platform === 'win32' && !isAbsoluteWindowsPath(input.projectPath)) {
    return { kind: 'undecidable', detail: `projectPath が絶対パスではありません: ${input.projectPath}` };
  }

  const invalidEntries = configured.filter(
    (entry) => typeof entry !== 'string' || entry.trim().length === 0 || (input.platform === 'win32' && !isAbsoluteWindowsPath(entry)),
  );
  if (invalidEntries.length > 0) {
    return {
      kind: 'undecidable',
      detail: `sandbox.projects に絶対パスでない項目があります: ${JSON.stringify(invalidEntries)}`,
    };
  }

  const normalizedTarget = normalizeSandboxProjectPath(input.projectPath, input.platform);
  const match = configured.some((entry) => normalizeSandboxProjectPath(entry, input.platform) === normalizedTarget);
  return match ? { kind: 'target' } : { kind: 'not-target' };
}
