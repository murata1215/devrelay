/**
 * サイクル P4-A: Devin CLI plugin capability（`devin:plugin`）の純粋ロジック（外部 import ゼロ）。
 * `devin-plugin-adapter.ts`（CLI 実行・ファイル読み取りを担う I/O 層）から呼ばれる。
 *
 * 設計の核心（実機確認済み: devin 3000.6.14、2026-10-31、DESKTOP-5U400FO/lfuser `TEST` プロジェクト経由）:
 * - `devin plugins install/list/info/update/remove/prune` が実在し、`-y, --yes`（対話トラストプロンプト
 *   を飛ばす）/ `--local` フラグも公式ヘルプどおり確認済み。
 * - install ソース形式は `owner/repo#path/to/plugin`。manifest 優先順は
 *   `.devin-plugin/plugin.json` > `.claude-plugin/plugin.json` > `plugin.json`（Claude plugin が
 *   そのまま読める）。
 * - `devin plugins list` の標準出力には chisel のログ行（タイムスタンプ付き）が混ざる
 *   （実機確認済み）。**この adapter は `list` の出力を一切パースしない**（デザインの核心）。
 *   代わりに DevRelay 独自のサイドカー state（`devin-plugins.json`）+ `plugins info <id>` の
 *   exit code のみで冪等性を判定する。壊れるとしたら exit code 規約が変わったときだけ。
 * - Devin の install 先ディレクトリは公式未記載・未実測のため一切走査しない
 *   （相手の所有領域。`devin plugins prune` に消されうる場所に marker を置かない）。
 *
 * `claude-plugin-rules.ts` / `agent-skills-rules.ts` と同じ流儀: I/O は一切行わず、
 * コンパイル済み dist を直接 `node --test` から import して単体検証する。
 */

// -----------------------------------------------------------------------------
// キルスイッチ（既定 ON。`0` で adapter 全体を no-op にする）
// -----------------------------------------------------------------------------

/** `DEVRELAY_DEVIN_PLUGIN` キルスイッチの判定（既定 enabled。`'0'` のときだけ無効） */
export function isDevinPluginEnabled(env: Record<string, string | undefined>): boolean {
  return env.DEVRELAY_DEVIN_PLUGIN !== '0';
}

// -----------------------------------------------------------------------------
// state ファイルの配置先解決（`agent-skills-rules.ts` の `resolveAgentSkillsDirPath()` と同じ流儀。
// zero-import 規約のため絶対パス判定ヘルパーを本ファイル内に複製する）
// -----------------------------------------------------------------------------

function isAbsolutePathForPlatform(p: string, platform: string): boolean {
  if (typeof p !== 'string' || p.length === 0) return false;
  if (platform === 'win32') return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\');
  return p.startsWith('/');
}

export interface ResolveDevinPluginStatePathInput {
  /** `process.platform` の値 */
  platform: string;
  /** `process.env` 相当 */
  env: Record<string, string | undefined>;
  /** 呼び出し側が解決済みの configDir（`getConfigDir()` 相当の絶対パス） */
  configDir: string;
}

export type ResolveDevinPluginStatePathResult =
  | { ok: true; path: string }
  | { ok: false; reason: 'override-not-absolute' | 'config-dir-missing' };

/**
 * state ファイル（`<configDir>/capabilities/devin-plugins.json`）の絶対パスを解決する。
 * 1. `env.DEVRELAY_DEVIN_PLUGIN_STATE` が非空なら最優先（絶対パスのときのみ採用。相対なら `ok:false`。
 *    `resolveAgentSkillsDirPath()` と同じく「静かなフォールバック禁止」= 曖昧な入力は失敗させる）
 * 2. `<configDir>/capabilities/devin-plugins.json`
 */
export function resolveDevinPluginStatePath(input: ResolveDevinPluginStatePathInput): ResolveDevinPluginStatePathResult {
  const { platform, env, configDir } = input;

  const override = env.DEVRELAY_DEVIN_PLUGIN_STATE;
  if (override !== undefined && override.length > 0) {
    if (!isAbsolutePathForPlatform(override, platform)) return { ok: false, reason: 'override-not-absolute' };
    return { ok: true, path: override };
  }

  if (!configDir) return { ok: false, reason: 'config-dir-missing' };
  const sep = platform === 'win32' ? '\\' : '/';
  const cleaned = configDir.replace(/[\\/]+$/, '');
  return { ok: true, path: `${cleaned}${sep}capabilities${sep}devin-plugins.json` };
}

// -----------------------------------------------------------------------------
// install ソースの組み立て（`owner/repo#path` 形式、実機確認済み構文）
// -----------------------------------------------------------------------------

/**
 * `marketplaceSource` が `owner/repo` 形式かどうか（`agent-skills-rules.ts` の
 * `resolveGitCloneUrl()` と同一パターン。zero-import 規約のため複製）。
 */
const OWNER_REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** `https://github.com/owner/repo(.git)` 形式 */
const HTTPS_GITHUB_PATTERN = /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+(\.git)?$/;

export type BuildDevinInstallSourceResult =
  | { ok: true; source: string }
  | { ok: false; reason: 'unsupported-source-format' | 'unsafe-path' };

/**
 * `devin plugins install` に渡すソース文字列（`owner/repo#relPath` or `https://.../repo.git#relPath`）を
 * 組み立てる。`marketplaceSource` が `owner/repo` または GitHub https URL のときのみ許可し、それ以外
 * （`git@` / `ssh://` / `-` 始まり / `..` を含む等）は拒否する（v1 は GitHub 限定。やらないこと参照）。
 * `relPath` は呼び出し側が `resolvePluginSourceRelPath()`（`agent-skills-rules.ts`）で安全性検証済みの
 * 相対パスを渡す前提だが、念のため NUL バイトのみ再チェックする。
 */
export function buildDevinInstallSource(marketplaceSource: string, relPath: string): BuildDevinInstallSourceResult {
  if (typeof marketplaceSource !== 'string' || marketplaceSource.length === 0) {
    return { ok: false, reason: 'unsupported-source-format' };
  }
  if (marketplaceSource.startsWith('-')) return { ok: false, reason: 'unsupported-source-format' };
  if (marketplaceSource.includes('..')) return { ok: false, reason: 'unsupported-source-format' };
  const isOwnerRepo = OWNER_REPO_PATTERN.test(marketplaceSource);
  const isHttpsGithub = HTTPS_GITHUB_PATTERN.test(marketplaceSource);
  if (!isOwnerRepo && !isHttpsGithub) return { ok: false, reason: 'unsupported-source-format' };

  if (typeof relPath !== 'string' || relPath.length === 0 || relPath.includes('\0')) {
    return { ok: false, reason: 'unsafe-path' };
  }
  return { ok: true, source: `${marketplaceSource}#${relPath}` };
}

// -----------------------------------------------------------------------------
// state の型・所有判定（Devin の install 先には置かない。DevRelay 独自サイドカー）
// -----------------------------------------------------------------------------

export const DEVIN_PLUGIN_STATE_ADAPTER = 'devin-plugin';

export interface DevinPluginEntry {
  pluginId: string;
  installSource: string;
  /** install/update 時点の marketplace clone の commit SHA（取得できなければ null） */
  indexCommit: string | null;
  installedAt: string;
}

export interface DevinPluginState {
  schema: number;
  managedBy: string;
  adapter: string;
  entries: DevinPluginEntry[];
}

/** state ファイルの内容を組み立てる純関数（書き込みは呼び出し側の I/O 層が行う） */
export function buildDevinPluginState(entries: DevinPluginEntry[]): DevinPluginState {
  return { schema: 1, managedBy: 'devrelay', adapter: DEVIN_PLUGIN_STATE_ADAPTER, entries };
}

/** state ファイルが DevRelay 管理下のものかを判定する（型ガード） */
export function isOwnedDevinPluginState(data: unknown): data is DevinPluginState {
  if (!data || typeof data !== 'object') return false;
  const m = data as Record<string, unknown>;
  if (m.schema !== 1 || m.managedBy !== 'devrelay' || m.adapter !== DEVIN_PLUGIN_STATE_ADAPTER) return false;
  return Array.isArray(m.entries);
}

// -----------------------------------------------------------------------------
// action 判定（パーサ非依存。`plugins info <id>` の exit code + state の有無だけで決める）
// -----------------------------------------------------------------------------

export type DevinPluginAction = 'install' | 'update' | 'present' | 'conflict-unmanaged';

export interface DecideDevinPluginActionInput {
  /** DevRelay state に既存エントリがあるか（＝過去にこの adapter が install したか） */
  hasStateEntry: boolean;
  /** `devin plugins info <id>` が exit 0 だったか（＝ Devin 側に実在するか） */
  infoOk: boolean;
  /** state エントリの indexCommit（state 無しなら null） */
  stateIndexCommit: string | null;
  /** 今回の marketplace clone の commit（取得できなければ null） */
  currentIndexCommit: string | null;
}

/**
 * - state 無し & info ok（Devin に実在）→ 人間が手で入れた plugin とみなし触らない（conflict-unmanaged）
 * - state 無し & info NG（Devin に不在）→ install
 * - state あり & info NG（state 上は管理下のはずが Devin 側に無い）→ self-heal として install
 *   （ユーザーが `devin plugins remove` した、prune された等。desired-state への回復）
 * - state あり & info ok & commit 一致 → present（何もしない）
 * - state あり & info ok & commit 不一致（または取得不能）→ update
 */
export function decideDevinPluginAction(input: DecideDevinPluginActionInput): DevinPluginAction {
  const { hasStateEntry, infoOk, stateIndexCommit, currentIndexCommit } = input;
  if (!hasStateEntry) return infoOk ? 'conflict-unmanaged' : 'install';
  if (!infoOk) return 'install';
  if (currentIndexCommit !== null && stateIndexCommit === currentIndexCommit) return 'present';
  return 'update';
}

/** state にあるが今回の desired 集合に無い pluginId 一覧を返す（`agent-skills-rules.ts` の `decideRemovals()` と同型） */
export function decideDevinPluginRemovals(existingStateIds: string[], desiredIds: string[]): string[] {
  const desiredSet = new Set(desiredIds);
  return existingStateIds.filter((id) => !desiredSet.has(id));
}

// -----------------------------------------------------------------------------
// 予算管理（adapter 全体 3 分枠を守るための安全弁。common 層の `ADAPTER_TIMEOUT_MS` と値を揃えて
// 手動同期する。common 層からは import しない＝zero-import 規約）
// -----------------------------------------------------------------------------

/** adapter 全体の予算（`capability-sync.ts` の `ADAPTER_TIMEOUT_MS` と同値。変更時は両方確認すること） */
export const DEVIN_PLUGIN_ADAPTER_BUDGET_MS = 3 * 60 * 1000;

/** 残り予算が `reserveMs` を上回っているか（outer timeout に巻き取られる前に自発的に打ち切るための判定） */
export function hasBudgetLeft(startedAtMs: number, nowMs: number, reserveMs: number): boolean {
  return nowMs - startedAtMs < DEVIN_PLUGIN_ADAPTER_BUDGET_MS - reserveMs;
}

// -----------------------------------------------------------------------------
// 診断文字列（配布判断には無関係。表示専用。`agent-skills-rules.ts` の `formatRuntimeVersion()` は
// 80 文字上限で既存回帰のため触らない。本ファイルは独自に 240 文字上限で複製する）
// -----------------------------------------------------------------------------

const DIAGNOSTIC_VERSION_MAX_LENGTH = 240;

/** `devin --version` の生出力（例: `devin 3000.6.14 (18033302)`）から表示用の版文字列を作る */
export function formatDevinPluginVersion(version: string | null | undefined): string | null {
  if (version === null || version === undefined) return null;
  const firstNonEmptyLine = version.split(/\r?\n/).find((line) => line.trim().length > 0);
  if (!firstNonEmptyLine) return null;
  const trimmed = firstNonEmptyLine.trim();
  const stripped = trimmed.replace(/^devin\s+/i, '').trim();
  if (!stripped) return null;
  return stripped.length > DIAGNOSTIC_VERSION_MAX_LENGTH
    ? `${stripped.slice(0, DIAGNOSTIC_VERSION_MAX_LENGTH)}…`
    : stripped;
}

export interface BuildDevinPluginDiagnosticsInput {
  devinDetected: boolean;
  version: string | null;
  /** `devin plugins --help` が exit 0 だったか。`devinDetected:false` のときは無視される */
  pluginsSupported: boolean;
}

/** `CapabilityResult.runtimeVersion` に入れる診断文字列を組み立てる（配布判断には使わない） */
export function buildDevinPluginDiagnostics(input: BuildDevinPluginDiagnosticsInput): string {
  if (!input.devinDetected) return 'Devin 未検出';
  const formatted = formatDevinPluginVersion(input.version);
  const versionPart = formatted ? `Devin ${formatted} 検出` : 'Devin 検出';
  const pluginsPart = input.pluginsSupported ? 'plugins: 対応' : 'plugins: 非対応';
  return `${versionPart} / ${pluginsPart}`;
}

// -----------------------------------------------------------------------------
// 共通ヘルパ（claude-plugin-rules.ts の resolveFailureIds を複製。zero-import 規約のため import しない）
// -----------------------------------------------------------------------------

/** `ctx.items` が空でも失敗を無言にしないための ID 解決（既存 2 ファイルと同一ロジック） */
export function resolveFailureIds(itemIds: string[], fallbackId: string): string[] {
  return itemIds.length > 0 ? itemIds : [fallbackId];
}
