/**
 * Devin CLI ガードレール調査サイクル（2026-11-05）: `--agent-config`（将来配線）および
 * Devin 組織ダッシュボード（Terminal Permissions）に渡す「deny-only」の宣言的ルールを
 * 安全に組み立てるための純関数群。
 *
 * ## 背景（#362〜#368 の教訓を再発させないための構造的制約）
 * `doc/devin_gate_investigation.md`（サイクル D0）と削除済み `devin-plan-config.ts`
 * （`git show 5609323^:agents/linux/src/services/devin-plan-config.ts` で全文参照可）に、
 * allow-list 方式が構造的にモグラ叩きになる真因が実測つきで記録されている:
 * - `Exec()` は glob ではなく**プレフィックス一致**。`Exec(**)` は無効なルールで、
 *   #260 以来 deny に入っていたが一度も機能していなかった。
 * - allow にも deny にも一致しないツール呼び出しは「承認待ち」に落ち、非対話 `-p` モードでは
 *   拒否・保留ともテキストを一切出さず **exit 0 で完全に無音のまま終わる**（#347 Phase0 実測）。
 *
 * → 6 サイクルの失敗は allow-list 方式に構造的に起因していた。本モジュールは **allow/ask を
 * 一切生成しない deny-only の構成**に限定することで、この罠を構造的に回避する。
 * `--permission-mode dangerous`（deny 以外を全自動承認）との組み合わせを前提とする。
 *
 * ## 現在のステータス（重要）
 * **本モジュールは未配線。** `ai-runner.ts` の devin spawn 分岐には接続されていない
 * （2026-11-05 時点では、`dangerous` が user/project レベルの deny を上書きしないか等の
 * 実機 Phase 0 検証が未完了のため）。現時点で提供するのは:
 * 1. `buildDevinGuardOrgPolicy()` — Devin 組織ダッシュボード（Terminal Permissions）に
 *    貼り付ける deny-only JSON の生成（DevRelay のコード変更ゼロで即日効く L1 層）
 * 2. `buildDevinAgentConfig()` — 将来 `--agent-config` に渡す deny-only JSON の生成
 *    （実機で deny が `dangerous` を上書きしないと確認できた場合に配線する L2 層）
 *
 * `rm` はこのプリセットに**意図的に含めていない**。`Exec(rm)` は「プロジェクト外のみ禁止」の
 * ような条件付き表現ができず、全面禁止にすると `rm -rf node_modules` 等の正常作業まで止まる
 * （#362〜#368 のモグラ叩きの再演）。`rm` の扱いはユーザー判断事項として別途解決する。
 *
 * `devin-diagnostics.ts`/`devin-atif.ts`/`git-guard-core.ts`/`plan-permission.ts` と同じ流儀
 * （外部 import ゼロ、3 OS byte-for-byte 同一、`node:test` から `dist/` を直接 import してテストする）。
 */

/**
 * Devin の `permissions` ルール文字列（`Exec(...)` / `Read(...)` / `Write(...)` / `Fetch(...)`）が
 * 構造的に妥当かを判定する。
 *
 * 公式ドキュメント実測（`doc/devin_gate_investigation.md` Q3(c)）により、`Exec()` は glob ではなく
 * プレフィックス一致であり `Exec(**)` は「無効なルールとして黙って効かない」ことが判明済みのため、
 * `Exec()` の内容に glob 文字（`*` `?` `[` `]`）を含むものは構造的に拒否する。
 * `Read()` / `Write()` / `Fetch()` は公式ドキュメント上 glob パターンを受け付けるため対象外。
 * 括弧の対応が取れていない・括弧内が空・ツール名が4種以外・改行や NUL を含む、のいずれも拒否する。
 * 例外を投げない。
 *
 * @param rule 検証対象のルール文字列（例: `'Exec(rm)'`, `'Read(~/.ssh/**)'`）
 * @returns 構造的に妥当なら true
 */
export function isValidDevinPermissionRule(rule: string): boolean {
  if (!rule) return false;
  const match = rule.match(/^(Exec|Read|Write|Fetch)\((.+)\)$/);
  if (!match) return false;
  const [, kind, body] = match;
  if (body.length === 0) return false;
  if (/[\n\r\0]/.test(body)) return false;
  if (kind === 'Exec' && /[*?[\]]/.test(body)) return false;
  return true;
}

/**
 * 今すぐ安全に禁止できる不可逆操作の `Exec()` プレフィックス一覧。
 * `rm` は上記 JSDoc の理由により意図的に含めない。
 */
export const DEVIN_GUARD_IRREVERSIBLE_EXEC_PREFIXES: readonly string[] = [
  'dd',
  'mkfs',
  'shred',
  'sudo',
  'doas',
  'git push',
  'git reset --hard',
  'git clean',
  'pm2 delete',
  'pm2 restart',
  'systemctl stop',
  'systemctl restart',
  'systemctl disable',
  'docker rm',
  'docker rmi',
  'docker stop',
  'shutdown',
  'reboot',
];

/** シークレット・秘匿情報の読み取りを禁止する `Read()` グロブ一覧。 */
export const DEVIN_GUARD_SECRET_READ_GLOBS: readonly string[] = ['~/.ssh/**', '**/.env*', '**/credentials*'];

/** シークレット・設定ファイルへの書き込みを禁止する `Write()` グロブ一覧。 */
export const DEVIN_GUARD_SECRET_WRITE_GLOBS: readonly string[] = ['/etc/**', '~/.ssh/**', '**/.env*'];

/** `collectDenyRules()` に渡すルール素材。各カテゴリは省略可（省略時はそのカテゴリを生成しない）。 */
export interface DevinGuardRuleSet {
  /** `Exec(<prefix>)` に変換するコマンドプレフィックス一覧（glob を含むものは黒く除外される）。 */
  denyExecPrefixes?: readonly string[];
  /** `Read(<glob>)` に変換するグロブ一覧。 */
  denyReadGlobs?: readonly string[];
  /** `Write(<glob>)` に変換するグロブ一覧。 */
  denyWriteGlobs?: readonly string[];
  /** `Fetch(<pattern>)` に変換する URL パターン一覧。 */
  denyFetchPatterns?: readonly string[];
}

/**
 * ルール素材から deny ルール文字列の配列を組み立てる。
 * `isValidDevinPermissionRule()` が false を返す無効なルールは黙って除外し（静かな劣化だが、
 * 無効ルール＝元から機能しないものを除くだけなので安全側）、重複は除去し、入力順を保って返す。
 * 例外を投げない。
 */
function collectDenyRules(opts: DevinGuardRuleSet): string[] {
  const raw: string[] = [
    ...(opts.denyExecPrefixes ?? []).map((p) => `Exec(${p})`),
    ...(opts.denyReadGlobs ?? []).map((g) => `Read(${g})`),
    ...(opts.denyWriteGlobs ?? []).map((g) => `Write(${g})`),
    ...(opts.denyFetchPatterns ?? []).map((p) => `Fetch(${p})`),
  ];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const rule of raw) {
    if (!isValidDevinPermissionRule(rule)) continue;
    if (seen.has(rule)) continue;
    seen.add(rule);
    result.push(rule);
  }
  return result;
}

/**
 * （未配線・将来 Phase 2 用）`--agent-config` に渡す構成。
 * `allow`/`ask` キーは**型レベルで一切持たない**（#362〜#368 の罠 — allow-list 方式による
 * 無言終了 — を再発させないための構造的制約。「空配列を入れ忘れた」ではなく「そもそも書けない」）。
 */
export interface DevinAgentConfig {
  permissions: { deny: string[] };
}

/**
 * （未配線・将来 Phase 2 用）`--agent-config` に渡す deny-only の構成を組み立てる。
 * `allow`/`ask` キーは構造的に生成しない。
 */
export function buildDevinAgentConfig(opts: DevinGuardRuleSet): DevinAgentConfig {
  return { permissions: { deny: collectDenyRules(opts) } };
}

/**
 * Devin 組織ダッシュボード（Terminal Permissions）に貼り付ける構成。
 * ダッシュボード UI は `deny`/`ask`/`allow` の3キーを要求するため、`ask`/`allow` は明示的に
 * 空配列にする（#347 Phase0 実測: 非対話 `-p` では `ask` が無音 exit 0 になるため、
 * 絶対に `ask` へ値を入れてはならない。`allow` も罠再発防止のため常に空）。
 */
export interface DevinOrgPolicy {
  deny: string[];
  ask: string[];
  allow: string[];
}

/**
 * Devin 組織ダッシュボードに貼り付ける deny-only の構成を組み立てる。
 * `ask`/`allow` は常に空配列（呼び出し側の入力に関わらず上書きされる）。
 */
export function buildDevinGuardOrgPolicy(opts: DevinGuardRuleSet): DevinOrgPolicy {
  return { deny: collectDenyRules(opts), ask: [], allow: [] };
}
