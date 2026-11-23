/**
 * `devrelay sandbox prep` が実行する Windows ACL コマンドの組み立て（外部 import ゼロ、純関数）。
 * 実際の実行（`child_process`）は CLI 側（`cli/commands/sandbox.ts`）が行う。失敗したステップは
 * `buildSandboxPrepManualFallbackText()` で「手で叩くコマンド」に変換して案内する
 * （`uninstall.ts:135-139` と同じ流儀）。
 *
 * サイクル SB-1a-1。`principal` は `icacls` に渡す書式そのもの
 * （SID を直接指定する場合は `*S-1-5-80-...`、サービス名を使う場合は `NT SERVICE\devrelay-sandbox`）
 * を呼び出し側（CLI）が決める。仮想サービス SID は決定論的に計算されるため、サービス名を直接
 * 指定するだけで非管理者でも名前解決できる（管理者用インストールスクリプトが `host.json` に
 * 実際の SID を記録していれば、それを優先して `*SID` 形式で使う）。
 */

export interface SandboxPrepStep {
  description: string;
  command: string;
  args: string[];
}

export type SandboxPrepPrecheckReason = 'not_found' | 'not_a_directory' | 'no_git';

export type SandboxPrepPrecheckResult = { ok: true } | { ok: false; reason: SandboxPrepPrecheckReason };

export interface SandboxPrepPrecheckInput {
  /** 対象パスが存在するか */
  exists: boolean;
  /** 存在する場合、ディレクトリか（ファイルなら false） */
  isDirectory: boolean;
  /** `<projectPath>/.git` が存在するか */
  hasGit: boolean;
}

/**
 * `devrelay sandbox prep --project <path>` の事前確認（B2 対応）。
 * 存在しない・ディレクトリでない・`.git` が無いパスに対しては ACL を一切変更せずに拒否する
 * （SB-1a-1 時点では存在確認をせず、存在しないパスでも祖先ディレクトリへの traverse 付与まで
 * 進んでから失敗していた。実機確認済みの既存バグ）。
 */
export function decideSandboxPrepPrecheck(input: SandboxPrepPrecheckInput): SandboxPrepPrecheckResult {
  if (!input.exists) return { ok: false, reason: 'not_found' };
  if (!input.isDirectory) return { ok: false, reason: 'not_a_directory' };
  if (!input.hasGit) return { ok: false, reason: 'no_git' };
  return { ok: true };
}

const SANDBOX_PREP_PRECHECK_MESSAGES: Record<SandboxPrepPrecheckReason, string> = {
  not_found: '❌ 指定されたプロジェクトパスが存在しません。ACL は変更していません。',
  not_a_directory: '❌ 指定されたプロジェクトパスはディレクトリではありません。ACL は変更していません。',
  no_git: '❌ 指定されたプロジェクトパスに .git がありません（git リポジトリではありません）。ACL は変更していません。',
};

/** 事前確認の拒否理由に対応する日本語メッセージを返す。 */
export function buildSandboxPrepPrecheckMessage(reason: SandboxPrepPrecheckReason): string {
  return SANDBOX_PREP_PRECHECK_MESSAGES[reason];
}

/** `icacls <path> /grant <principal>:(OI)(CI)(RX)`（継承あり・読み取り+実行） */
export function buildIcaclsGrantReadExecuteArgs(targetPath: string, principal: string): string[] {
  return [targetPath, '/grant', `${principal}:(OI)(CI)(RX)`];
}

/** 祖先ディレクトリへの traverse のみ（継承なし。配下ファイルの読み取り・列挙は増やさない） */
export function buildIcaclsGrantTraverseArgs(targetPath: string, principal: string): string[] {
  return [targetPath, '/grant', `${principal}:(X)`];
}

/** プロジェクトフォルダへの変更権限（継承あり・Modify） */
export function buildIcaclsGrantModifyArgs(targetPath: string, principal: string): string[] {
  return [targetPath, '/grant', `${principal}:(OI)(CI)(M)`];
}

/**
 * `.git\hooks` への書き込みを明示的に拒否する ACE。プロジェクトに書ける Sandbox 身元が
 * pre-commit 等のフックを経由して開発者身元のコード実行に昇格するのを防ぐ
 * （改訂版 Plan のレビュー指摘 B-12 対応）。
 */
export function buildIcaclsDenyWriteArgs(hooksPath: string, principal: string): string[] {
  return [hooksPath, '/deny', `${principal}:(OI)(CI)(W)`];
}

/** トークンファイルを本人のみに制限する（継承を切り、現在のユーザーにのみ R,W を付与） */
export function buildIcaclsLockdownArgs(filePath: string, currentUserPrincipal: string): string[] {
  return [filePath, '/inheritance:r', '/grant', `${currentUserPrincipal}:(R,W)`];
}

/**
 * `devrelay sandbox prep --project <path>` の実行手順を順序付きで組み立てる。
 * 呼び出し側は各ステップを順に実行し、失敗したステップがあれば
 * `buildSandboxPrepManualFallbackText()` で手動コマンドを案内する。
 */
export function buildSandboxPrepPlan(input: {
  projectPath: string;
  nodeModulesPath: string;
  gitHooksPath: string;
  ancestorPaths: string[];
  servicePrincipal: string;
}): SandboxPrepStep[] {
  const steps: SandboxPrepStep[] = [];
  for (const ancestor of input.ancestorPaths) {
    steps.push({
      description: `祖先ディレクトリへの traverse 権限を付与: ${ancestor}`,
      command: 'icacls',
      args: buildIcaclsGrantTraverseArgs(ancestor, input.servicePrincipal),
    });
  }
  steps.push({
    description: 'プロジェクトフォルダへの変更権限を付与',
    command: 'icacls',
    args: buildIcaclsGrantModifyArgs(input.projectPath, input.servicePrincipal),
  });
  steps.push({
    description: 'node_modules への読み取り・実行権限を付与（claude 本体を読めるようにする）',
    command: 'icacls',
    args: buildIcaclsGrantReadExecuteArgs(input.nodeModulesPath, input.servicePrincipal),
  });
  steps.push({
    description: '.git/hooks への書き込みを拒否（開発者身元への権限昇格を防ぐ）',
    command: 'icacls',
    args: buildIcaclsDenyWriteArgs(input.gitHooksPath, input.servicePrincipal),
  });
  return steps;
}

/** トークンファイルの ACL ロックダウン手順を 1 ステップとして組み立てる */
export function buildSandboxTokenLockdownStep(tokenFilePath: string, currentUserPrincipal: string): SandboxPrepStep {
  return {
    description: 'トークンファイルを本人のみに制限',
    command: 'icacls',
    args: buildIcaclsLockdownArgs(tokenFilePath, currentUserPrincipal),
  };
}

/** 失敗したステップを人間が手で叩けるコマンド文字列に変換する（`uninstall.ts:135-139` と同じ流儀） */
export function buildSandboxPrepManualFallbackText(steps: SandboxPrepStep[]): string {
  return steps.map((s) => `${s.command} ${s.args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`).join('\n');
}
