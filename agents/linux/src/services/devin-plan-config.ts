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
   * DevRelay スキル実行時に実際に呼び出されうるコマンド文字列一覧（#364 1-B）。
   * 呼び出し側（ai-runner.ts）が `skill-manager.ts` の `buildSkillInvocationCommands()`
   * で組み立てた文字列をそのまま渡す（本モジュールは `os`/`path` は元より
   * `skill-manager.ts` も import しない——SKILL.md 本文と Exec() allow ルールの
   * 両方が単一情報源 `SKILL_INVOCATIONS`〔`skill-manager.ts`〕から導出されることで
   * 「2箇所が独立にコマンド文字列を書いていてズレる」構造的欠陥〔#364 真因A、
   * 旧 `buildSkillExecPrefixes()` がパス途中で閉じ括弧・スクリプト名を欠いたまま
   * 切れた壊れたルールを生成していた〕を解消する）。
   */
  skillExecCommands: readonly string[];
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
    for (const cmd of opts.skillExecCommands) {
      allow.push(`Exec(${cmd})`);
    }

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
  /**
   * `--permission-mode` の選択肢に `smart` が含まれるか（`--help` 文中に `"smart"` という文字列があるか）。
   * **注意（#364 Phase0.6 実測で確定）**: これは「`smart` が選択肢として存在するか」しか見ていない。
   * `--help` には `smart` が常に選択肢として載っているため、このフラグは実質的に常に true になる。
   * 実際にサーバー側で `smart` が使えるかどうかはこのフラグでは判定できない
   * （Phase0.6 実測では5回中5回とも `Warning: Smart permission mode is not available. Falling back to normal.`
   * が出て使えなかった）。実行時の可用性は `isDevinSmartUnavailableLine()`（`devin-diagnostics.ts`）でしか
   * 検知できない。このフィールドを「smart が使える」の根拠にしてはならない。
   */
  permissionModeSmart: boolean;
}

/**
 * プランモードで渡す `--permission-mode` の値を解決する。
 * #364 Phase1（1-A-5）: 既定を `smart` から `auto` に戻した。Phase0.6 実測で `smart` は
 * サーバー側事情により5回中5回とも使えず `normal` にフォールバックしており（`permissionModeSmart`
 * probe はこの可用性を判定できない）、かつ `auto` + 正しい allow ルールで Exec が問題なく通ることが
 * 確定した（E5'実測）ため、`smart` に頼る理由がない。
 * @param caps probe 済みの Devin ケーパビリティ
 * @param opts.strictExec true の場合は常に `'auto'`（今日の挙動と等価、キルスイッチ用）
 * @param opts.envOverride `DEVRELAY_DEVIN_PLAN_PERMISSION_MODE` の値（`'auto'`|`'smart'` のみ有効、明示上書き用）
 * @returns `--permission-mode` に渡す値。`--permission-mode` 自体が非対応なら `null`（引数を付けない）
 */
export function resolveDevinPlanPermissionMode(
  caps: DevinPlanPermissionModeCaps,
  opts: { strictExec: boolean; envOverride?: string | null },
): 'smart' | 'auto' | null {
  if (!caps.permissionMode) return null;
  if (opts.envOverride === 'auto' || opts.envOverride === 'smart') return opts.envOverride;
  return 'auto';
}
