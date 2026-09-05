/**
 * Devin プランモードで「ツールが許可されず返事が返ってこない」問題の根治（本サイクル）:
 * Devin CLI に `--config`/`--agent-config` 経由で渡す許可/拒否ルールと `--permission-mode` を
 * 組み立てる純関数群。
 *
 * ## 背景（なぜこのモジュールが必要か）
 * Devin 公式ドキュメント（`docs.devin.ai/cli/reference/permissions`）によれば:
 * - `Exec()` は glob ではなく「プレフィックス一致」であり、`Exec(**)` は無効なルール
 *   （"Exec(\*\*) is not valid" と明記）。#260 以来 `deny: ["Write(**)","Exec(**)"]` を
 *   使っていたが、この `Exec(**)` は**元々一度も機能していなかった**（#362 で deny から
 *   外した際も、無効ルールを削除しただけで挙動は変化していない＝真因ではなかった）。
 * - ルールに一致しないツール呼び出しは「承認待ち」に落ちる。非対話 `-p` モードでは
 *   拒否・保留とも**テキストを一切出さず exit 0 で終わる**（#347 Phase0 実測）。
 * - `--permission-mode auto` は「読み取り専用ツールだけ」を自動承認する（`devin --help`
 *   3000.6.7 実測: `"auto" auto-approves read-only tools, ... "smart" additionally
 *   auto-runs actions a fast model judges safe`）。シェル実行は読み取り専用ではないため
 *   `auto` では自動承認されない。
 *
 * 現行の `allow: ['Read(**)']` だけでは DevRelay 自身の調査系スキル（`devrelay-list-inventory`
 * 等、実体はすべて bash スクリプト）が allow にも deny にも一致せず承認待ちに落ち、
 * 非対話モードのため無言で終わる——これが「無言で途中終了」の本体。
 *
 * 対策は二層: ①読み取り専用コマンド・スキル実行の prefix を明示的に `Exec()` allow へ追加、
 * ②`--permission-mode` を（対応していれば）`smart` に切り替え、allow に無いが安全なコマンドは
 * Devin 自身の安全判定に委ねる。`deny`（`Write(**)` + 破壊的コマンドの prefix）は常に allow/smart
 * より優先されるため、書き込みは構造的に止まったまま。
 *
 * `devin-atif.ts`/`devin-diagnostics.ts`/`cli-failure.ts`/`session-scope.ts`/`plan-permission.ts`
 * と同じ流儀（外部 import ゼロ、3 OS byte-for-byte 同一、`node:test` から直接 `dist/` を
 * import してテストする）。
 */

/** `buildDevinPlanConfig()` に渡すオプション。 */
export interface DevinPlanConfigOptions {
  /**
   * true の場合、Exec の allow/deny prefix を一切追加せず、
   * `{ allow: ['Read(**)'], deny: ['Write(**)'] }` のみを返す（今日の（壊れている）挙動と等価）。
   * `DEVRELAY_DEVIN_PLAN_EXEC_DENY=1` のキルスイッチ用。
   */
  strictExec: boolean;
  /**
   * DevRelay スキルのディレクトリ（例: `<home>/.claude/skills`）。
   * この配下の bash スクリプト実行を許可する prefix を生成するために使う。
   * 呼び出し側（ai-runner.ts）が `path.join(os.homedir(), '.claude', 'skills')` 等で
   * 解決した文字列を渡す（本モジュールは `os`/`path` を import しない）。
   */
  skillsDir: string;
  /**
   * 読み取り専用とみなす単語コマンド一覧（呼び出し側が `PLAN_READONLY_BASH_COMMANDS`
   * 〔`packages/shared/src/constants.ts`〕を渡す）。
   */
  readonlyBashCommands: readonly string[];
  /**
   * 書き込み・破壊的とみなすコマンド一覧（呼び出し側が `PLAN_WRITE_BASH_COMMANDS`
   * 〔`packages/shared/src/constants.ts`〕を渡す）。
   */
  writeBashCommands: readonly string[];
}

/** `buildDevinPlanConfig()` の戻り値。`JSON.stringify()` してそのまま `--config` に書き出す。 */
export interface DevinPlanConfig {
  version: number;
  shell: { setup_complete: boolean };
  permissions: {
    allow: string[];
    deny: string[];
  };
}

/**
 * `PLAN_READONLY_BASH_COMMANDS` は `git` 単体を含まない（`git push` 等の書き込みサブコマンドを
 * 誤って許可しないため）。Devin は Exec がプレフィックス一致のため `git log`/`git status` の
 * ように**サブコマンドまで含めた粒度**で allow する必要がある。
 */
const DEVIN_GIT_READONLY_PREFIXES: readonly string[] = ['git log', 'git status', 'git diff', 'git show', 'git branch'];

/** `PLAN_WRITE_BASH_COMMANDS` に無い、Devin 専用の追加 deny prefix。 */
const DEVIN_EXTRA_DENY_PREFIXES: readonly string[] = ['sudo'];

/**
 * DevRelay スキルのディレクトリ配下で bash スクリプトを実行する呼び出しを許可するための
 * `Exec()` allow prefix を組み立てる。観測された実際の呼び出し形（例:
 * `bash "C:\Users\lfuser\.claude\skills\devrelay-list-inventory\scripts\list.sh"`）は
 * クォート有無・パス区切り（`/`/`\`）が環境によって揺れるため、4パターンすべてを候補に含める。
 * `skillsDir` が空文字列の場合は候補を返さない（呼び出し側の解決失敗を握りつぶさないための安全策）。
 */
function buildSkillExecPrefixes(skillsDir: string): string[] {
  if (!skillsDir) return [];
  const posixPath = skillsDir.replace(/\\/g, '/');
  const winPath = skillsDir.replace(/\//g, '\\');
  const variants = new Set<string>([
    `bash "${posixPath}`,
    `bash ${posixPath}`,
    `bash "${winPath}`,
    `bash ${winPath}`,
  ]);
  return Array.from(variants).map((prefix) => `Exec(${prefix})`);
}

/**
 * Devin CLI の `--config`/`--agent-config` に渡す JSON を組み立てる。
 * @returns `JSON.stringify()` してそのままファイルに書き出せるオブジェクト
 */
export function buildDevinPlanConfig(opts: DevinPlanConfigOptions): DevinPlanConfig {
  const allow: string[] = ['Read(**)'];
  const deny: string[] = ['Write(**)'];

  if (!opts.strictExec) {
    for (const cmd of opts.readonlyBashCommands) {
      allow.push(`Exec(${cmd})`);
    }
    for (const prefix of DEVIN_GIT_READONLY_PREFIXES) {
      allow.push(`Exec(${prefix})`);
    }
    allow.push(...buildSkillExecPrefixes(opts.skillsDir));

    for (const cmd of opts.writeBashCommands) {
      deny.push(`Exec(${cmd})`);
    }
    for (const prefix of DEVIN_EXTRA_DENY_PREFIXES) {
      deny.push(`Exec(${prefix})`);
    }
  }

  return {
    version: 1,
    shell: { setup_complete: true },
    permissions: { allow, deny },
  };
}

/** `resolveDevinPlanPermissionMode()` に渡す、probe 済みの Devin ケーパビリティ。 */
export interface DevinPlanPermissionModeCaps {
  /** `--permission-mode` フラグ自体への対応可否。 */
  permissionMode: boolean;
  /** `--permission-mode` の選択肢に `smart` が含まれるか（`--help` 文中に `"smart"` があるか）。 */
  permissionModeSmart: boolean;
}

/**
 * プランモードで渡す `--permission-mode` の値を解決する。
 * @param caps probe 済みの Devin ケーパビリティ
 * @param opts.strictExec true の場合は常に `'auto'`（今日の挙動と等価、キルスイッチ用）
 * @param opts.envOverride `DEVRELAY_DEVIN_PLAN_PERMISSION_MODE` の値（`'auto'`|`'smart'` のみ有効）
 * @returns `--permission-mode` に渡す値。`--permission-mode` 自体が非対応なら `null`（引数を付けない）
 */
export function resolveDevinPlanPermissionMode(
  caps: DevinPlanPermissionModeCaps,
  opts: { strictExec: boolean; envOverride?: string | null },
): 'smart' | 'auto' | null {
  if (!caps.permissionMode) return null;
  if (opts.envOverride === 'auto' || opts.envOverride === 'smart') return opts.envOverride;
  if (opts.strictExec) return 'auto';
  return caps.permissionModeSmart ? 'smart' : 'auto';
}
