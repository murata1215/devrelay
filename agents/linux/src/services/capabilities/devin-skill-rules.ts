/**
 * サイクル P3-A: Devin native skill 配布 adapter（`devin:skill`）の純粋関数群（外部 import ゼロ）。
 *
 * `claude-plugin-rules.ts` と同じ流儀: I/O は一切行わず、コンパイル済み dist を直接
 * `node --test` から import して単体検証する。`devin-skill-adapter.ts`（I/O 層）からのみ呼ばれる。
 *
 * `isSafeRelativePath()` は `git-guard-core.ts:90` と同一の判定式を意図的に再実装したもの
 * （rules ファイルは外部 import ゼロ規約のため import できない）。変更する場合は両方を確認すること。
 *
 * 承認ノート #3: skill tree の安全上限は v1 では aggregate size 20MB / files 500 / depth 16。
 * 承認ノート #7: 更新判定は sourceCommit 単独ではなく plugin.json version → marketplace entry
 * version → content hash の順（sourceCommit は marker の provenance としてのみ保持）。
 */

// -----------------------------------------------------------------------------
// 安全上限（承認ノート #3。定数化し単体テストする）
// -----------------------------------------------------------------------------

/** 1 skill あたりの合計バイト数上限（v1 暫定値） */
export const SKILL_TREE_MAX_BYTES = 20 * 1024 * 1024;
/** 1 skill あたりのファイル数上限（v1 暫定値） */
export const SKILL_TREE_MAX_FILES = 500;
/** 1 skill あたりの再帰深さ上限（v1 暫定値） */
export const SKILL_TREE_MAX_DEPTH = 16;

// -----------------------------------------------------------------------------
// §3-6: Devin skills dir の OS 別パス解決
// -----------------------------------------------------------------------------

/** Windows の絶対パス（ドライブレター or UNC）かどうか */
function isAbsoluteWinPath(p: string): boolean {
  if (typeof p !== 'string' || p.length === 0) return false;
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\');
}

/** POSIX の絶対パス（`/` 始まり）かどうか */
function isAbsolutePosixPath(p: string): boolean {
  return typeof p === 'string' && p.startsWith('/');
}

/** Windows パス結合（`path.win32.join` を使わず素朴に連結する。区切りは `\`） */
function joinWin(...parts: string[]): string {
  const cleaned = parts.map((p) => p.replace(/[\\/]+$/, ''));
  return cleaned.join('\\');
}

/** POSIX パス結合（`path.posix.join` を使わず素朴に連結する。区切りは `/`） */
function joinPosix(...parts: string[]): string {
  const cleaned = parts.map((p) => p.replace(/\/+$/, ''));
  return cleaned.join('/');
}

export interface ResolveDevinSkillsDirInput {
  /** `process.platform` の値 */
  platform: string;
  /** `process.env` 相当 */
  env: Record<string, string | undefined>;
  /** `os.homedir()` の値 */
  homeDir: string;
}

export type ResolveDevinSkillsDirResult =
  | { ok: true; dir: string; source: 'env-override' | 'appdata' | 'xdg' | 'home-default' }
  | { ok: false; reason: 'home-missing' | 'override-not-absolute' };

/**
 * Devin CLI のグローバル skills ディレクトリを解決する。
 * 1. `env.DEVRELAY_DEVIN_SKILLS_DIR` が非空なら最優先（絶対パスのときのみ採用。相対なら `ok:false` — 黙って無視しない）
 * 2. win32 → `%APPDATA%\devin\skills`（`APPDATA` 未設定なら `<home>\AppData\Roaming\devin\skills`）
 * 3. その他 → `XDG_CONFIG_HOME`（絶対のときのみ採用）→ `<home>/.config`、その下に `devin/skills`
 *
 * `providers.devin.skillsDir` は実装しない（承認ノート #4）。
 */
export function resolveDevinSkillsDirPath(input: ResolveDevinSkillsDirInput): ResolveDevinSkillsDirResult {
  const { platform, env, homeDir } = input;

  const override = env.DEVRELAY_DEVIN_SKILLS_DIR;
  if (override !== undefined && override.length > 0) {
    const isAbs = platform === 'win32' ? isAbsoluteWinPath(override) : isAbsolutePosixPath(override);
    if (!isAbs) return { ok: false, reason: 'override-not-absolute' };
    return { ok: true, dir: override, source: 'env-override' };
  }

  if (platform === 'win32') {
    const appData = env.APPDATA;
    if (appData && isAbsoluteWinPath(appData)) {
      return { ok: true, dir: joinWin(appData, 'devin', 'skills'), source: 'appdata' };
    }
    if (!homeDir) return { ok: false, reason: 'home-missing' };
    return { ok: true, dir: joinWin(homeDir, 'AppData', 'Roaming', 'devin', 'skills'), source: 'appdata' };
  }

  const xdg = env.XDG_CONFIG_HOME;
  if (xdg && isAbsolutePosixPath(xdg)) {
    return { ok: true, dir: joinPosix(xdg, 'devin', 'skills'), source: 'xdg' };
  }
  if (!homeDir) return { ok: false, reason: 'home-missing' };
  return { ok: true, dir: joinPosix(homeDir, '.config', 'devin', 'skills'), source: 'home-default' };
}

// -----------------------------------------------------------------------------
// §3-1: 配布元 URL 変換・パス安全性
// -----------------------------------------------------------------------------

export type ResolveGitCloneUrlResult = { ok: true; url: string } | { ok: false; reason: 'unsupported-source-format' };

/**
 * `marketplaceSource` を git clone 可能な URL に変換する。
 * `owner/repo` 形式または `https://github.com/...` はそのまま許可し、それ以外
 * （`git@` / `ssh://` / `file://` / `-` 始まり / `..` を含む等）は拒否する
 * （`-` 始まりは execFile でも argv がオプション扱いされうるため）。
 */
export function resolveGitCloneUrl(marketplaceSource: string): ResolveGitCloneUrlResult {
  if (typeof marketplaceSource !== 'string' || marketplaceSource.length === 0) {
    return { ok: false, reason: 'unsupported-source-format' };
  }
  if (marketplaceSource.startsWith('-')) return { ok: false, reason: 'unsupported-source-format' };
  if (marketplaceSource.includes('..')) return { ok: false, reason: 'unsupported-source-format' };

  const ownerRepoPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
  if (ownerRepoPattern.test(marketplaceSource)) {
    return { ok: true, url: `https://github.com/${marketplaceSource}.git` };
  }

  const httpsPattern = /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+(\.git)?$/;
  if (httpsPattern.test(marketplaceSource)) {
    return { ok: true, url: marketplaceSource };
  }

  return { ok: false, reason: 'unsupported-source-format' };
}

/**
 * パストラバーサル・絶対パス・NUL バイトを含む危険な相対パスを拒否する構造ガード。
 * `git-guard-core.ts:90` の `isSafeRelativePath()` と**同一の判定式**（rules ファイルの
 * 外部 import ゼロ規約のため再実装。変更する場合は両方を確認すること）。
 */
export function isSafeRelativePath(relPath: string): boolean {
  if (!relPath) return false;
  if (relPath.includes('\0')) return false;
  const normalized = relPath.replace(/\\/g, '/');
  if (normalized.startsWith('/')) return false;
  if (/^[a-zA-Z]:\//.test(normalized)) return false;
  if (/^[a-zA-Z]:$/.test(normalized)) return false;
  const segments = normalized.split('/');
  if (segments.some((seg) => seg === '..')) return false;
  return true;
}

export type ResolvePluginSourceRelPathResult = { ok: true; relPath: string } | { ok: false; reason: 'unsafe-path' };

/** `marketplace.json` の plugin `source`（例: `./plugins/access-migration`）を安全な相対パスへ正規化する */
export function resolvePluginSourceRelPath(source: string): ResolvePluginSourceRelPathResult {
  if (typeof source !== 'string' || source.length === 0) return { ok: false, reason: 'unsafe-path' };
  let normalized = source.replace(/\\/g, '/');
  if (normalized.startsWith('./')) normalized = normalized.slice(2);
  if (!isSafeRelativePath(normalized)) return { ok: false, reason: 'unsafe-path' };
  return { ok: true, relPath: normalized };
}

const WINDOWS_RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

/**
 * skill ディレクトリ名として安全かどうかを判定する。
 * 空 / `.` / `..` / `/` `\` 含み / 制御文字 / 先頭ドット / 末尾ドット・空白 /
 * Windows 予約名 / 64 文字超を拒否する。
 */
export function isSafeSkillDirName(name: string): boolean {
  if (typeof name !== 'string' || name.length === 0) return false;
  if (name.length > 64) return false;
  if (name === '.' || name === '..') return false;
  if (name.includes('/') || name.includes('\\')) return false;
  if (/[\x00-\x1f]/.test(name)) return false;
  if (name.startsWith('.')) return false;
  if (name.endsWith('.') || name.endsWith(' ')) return false;
  const base = name.split('.')[0]?.toUpperCase() ?? '';
  if (WINDOWS_RESERVED_NAMES.has(base)) return false;
  return true;
}

/** clone した marketplace リポジトリを置くローカルディレクトリ名を安全な文字だけに変換する */
export function sanitizeMarketplaceDirName(name: string): string {
  if (typeof name !== 'string' || name.length === 0) return 'marketplace';
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, '_');
  return cleaned.length > 0 ? cleaned : 'marketplace';
}

// -----------------------------------------------------------------------------
// §3-1: git 呼び出し予算配分
// -----------------------------------------------------------------------------

/** git 呼び出し全体に許される予算（3 分の adapter 予算のうち git に割り当てる分。§7.3） */
export const GIT_TOTAL_BUDGET_MS = 90 * 1000;

/**
 * 残り時間と予定される git 呼び出し回数から、1 回あたりのタイムアウトを配分する。
 * `withTimeout()` が全体を中断しない設計のため、個々の呼び出しは短く区切って安全弁とする。
 */
export function allocateGitTimeoutMs(remainingMs: number, plannedCalls: number): number {
  if (plannedCalls <= 0) return 0;
  const budget = Math.max(0, Math.min(remainingMs, GIT_TOTAL_BUDGET_MS));
  return Math.max(1000, Math.floor(budget / plannedCalls));
}

// -----------------------------------------------------------------------------
// §5-2: marketplace.json / plugin.json のパース
// -----------------------------------------------------------------------------

export interface MarketplacePluginEntry {
  name: string;
  source: string;
  version: string | null;
}

export interface MarketplaceManifest {
  name: string;
  plugins: MarketplacePluginEntry[];
}

/** `.claude-plugin/marketplace.json` をパースする。壊れている/形が違う場合は null（throw しない） */
export function parseMarketplaceManifest(data: unknown): MarketplaceManifest | null {
  if (!data || typeof data !== 'object') return null;
  const obj = data as Record<string, unknown>;
  if (typeof obj.name !== 'string' || !Array.isArray(obj.plugins)) return null;
  const plugins: MarketplacePluginEntry[] = [];
  for (const raw of obj.plugins) {
    if (raw && typeof raw === 'object') {
      const p = raw as Record<string, unknown>;
      if (typeof p.name === 'string' && typeof p.source === 'string') {
        plugins.push({ name: p.name, source: p.source, version: typeof p.version === 'string' ? p.version : null });
      }
    }
  }
  return { name: obj.name, plugins };
}

export interface PluginManifest {
  name: string;
  version: string | null;
}

/** `plugins/<id>/.claude-plugin/plugin.json` をパースする。壊れている場合は null（throw しない） */
export function parsePluginManifest(data: unknown): PluginManifest | null {
  if (!data || typeof data !== 'object') return null;
  const obj = data as Record<string, unknown>;
  if (typeof obj.name !== 'string') return null;
  return { name: obj.name, version: typeof obj.version === 'string' ? obj.version : null };
}

/** plugin.json の version → marketplace entry の version の順で「望ましい版」を決める（承認ノート #7） */
export function resolveDesiredPluginVersion(
  pluginJsonVersion: string | null,
  marketplaceEntryVersion: string | null,
): string | null {
  return pluginJsonVersion ?? marketplaceEntryVersion ?? null;
}

// -----------------------------------------------------------------------------
// §3-3: marker ファイル（所有権・更新判定）
// -----------------------------------------------------------------------------

export interface SkillMarker {
  schema: number;
  managedBy: string;
  provider: string;
  kind: string;
  marketplaceName?: string;
  marketplaceSource?: string;
  pluginId?: string;
  pluginVersion?: string | null;
  skillName: string;
  sourceCommit?: string | null;
  contentHash?: string | null;
  installedAt?: string;
}

/**
 * marker が devrelay 管理下の devin skill であるかを判定する（型ガード）。
 * `marketplaceName` は所有権の条件に**含めない**（索引を乗り換えた後も自分が置いた
 * 古いディレクトリを回収できるようにするため）。
 */
export function isOwnedMarker(data: unknown): data is SkillMarker {
  if (!data || typeof data !== 'object') return false;
  const m = data as Record<string, unknown>;
  return (
    m.schema === 1 &&
    m.managedBy === 'devrelay' &&
    m.provider === 'devin' &&
    m.kind === 'skill' &&
    typeof m.skillName === 'string' &&
    m.skillName.length > 0
  );
}

export interface BuildSkillMarkerInput {
  marketplaceName: string;
  marketplaceSource: string;
  pluginId: string;
  pluginVersion: string | null;
  skillName: string;
  sourceCommit: string | null;
  contentHash: string;
  nowIso: string;
}

/** marker ファイルの内容を組み立てる純関数（書き込みは呼び出し側の I/O 層が行う） */
export function buildSkillMarker(input: BuildSkillMarkerInput): SkillMarker {
  return {
    schema: 1,
    managedBy: 'devrelay',
    provider: 'devin',
    kind: 'skill',
    marketplaceName: input.marketplaceName,
    marketplaceSource: input.marketplaceSource,
    pluginId: input.pluginId,
    pluginVersion: input.pluginVersion,
    skillName: input.skillName,
    sourceCommit: input.sourceCommit,
    contentHash: input.contentHash,
    installedAt: input.nowIso,
  };
}

// -----------------------------------------------------------------------------
// §3-3: action 判定（fast path つき2段構え）
// -----------------------------------------------------------------------------

export type SkillActionFast = 'install' | 'conflict-unmanaged' | 'present' | 'needs-comparison';

/**
 * hash 計算前に判定できる範囲（fast path）。
 * `marker.sourceCommit === indexCommit` が一致すれば、ハッシュ計算すら行わず `present` で打ち切る。
 */
export function decideSkillActionFast(
  destExists: boolean,
  marker: SkillMarker | null,
  indexCommit: string | null,
): SkillActionFast {
  if (!destExists) return 'install';
  if (!marker) return 'conflict-unmanaged';
  if (indexCommit !== null && marker.sourceCommit !== undefined && marker.sourceCommit === indexCommit) {
    return 'present';
  }
  return 'needs-comparison';
}

export type SkillActionSlow = 'update' | 'refresh-marker';

/**
 * fast path で打ち切れなかった場合の詳細比較。
 * version が両方非 null かつ異なれば update。決まらなければ contentHash を比較する。
 * 内容同一だが commit だけ違う場合は marker だけ差し替える（`refresh-marker`）。
 */
export function decideSkillActionSlow(
  markerVersion: string | null,
  desiredVersion: string | null,
  markerHash: string | null,
  actualContentHash: string,
): SkillActionSlow {
  if (markerVersion !== null && desiredVersion !== null && markerVersion !== desiredVersion) return 'update';
  if (markerHash !== null && markerHash !== actualContentHash) return 'update';
  return 'refresh-marker';
}

// -----------------------------------------------------------------------------
// §3-2/§3-4: desired plan 構築・削除判定
// -----------------------------------------------------------------------------

export interface DesiredSkillPluginInput {
  /** items[].id（= plugin 名） */
  pluginId: string;
  /** marketplace.json で見つかったエントリ。見つからなければ null（→ notAllowed） */
  manifestEntry: MarketplacePluginEntry | null;
  /** plugin.json の version（読めなければ null） */
  pluginJsonVersion: string | null;
  /** `skills/` 直下のディレクトリ名（既に lstat でディレクトリのみに絞った後の生の名前） */
  skillDirNames: string[];
}

export interface DesiredSkillEntry {
  pluginId: string;
  skillName: string;
  /** 望ましい版（plugin.json → marketplace entry の順で解決済み） */
  desiredVersion: string | null;
  /** `CapabilityResult` の id 形式（`<pluginId>/<skillName>`） */
  resultId: string;
}

export interface DesiredSkillPlanResult {
  desired: DesiredSkillEntry[];
  /** 索引に無い plugin id（`notAllowed` へ計上） */
  notAllowed: string[];
  /** `skills/` が無い plugin。id 形式は `<pluginId>:no-skills`（`present` へ計上） */
  noSkillsPresent: string[];
  /** 安全でない名前 / 同名衝突（`failed` へ計上） */
  failed: Array<{ id: string; reason: string }>;
}

/**
 * `items[]` と marketplace 索引・各 plugin の `skills/` 一覧から「あるべき skill 一覧」を構築する。
 * 同名衝突は先着優先にせず、衝突した全 plugin ぶん `failed` を積む（非決定的な silent 上書き回避）。
 */
export function buildDesiredSkillPlan(inputs: DesiredSkillPluginInput[]): DesiredSkillPlanResult {
  const notAllowed: string[] = [];
  const noSkillsPresent: string[] = [];
  const failed: Array<{ id: string; reason: string }> = [];
  const perPlugin: Array<{ pluginId: string; desiredVersion: string | null; names: string[] }> = [];

  for (const input of inputs) {
    if (!input.manifestEntry) {
      notAllowed.push(input.pluginId);
      continue;
    }
    const desiredVersion = resolveDesiredPluginVersion(input.pluginJsonVersion, input.manifestEntry.version);
    const safeNames: string[] = [];
    for (const name of input.skillDirNames) {
      if (!isSafeSkillDirName(name)) {
        failed.push({ id: `${input.pluginId}/${name}`, reason: 'unsafe-skill-name' });
        continue;
      }
      safeNames.push(name);
    }
    if (safeNames.length === 0) {
      noSkillsPresent.push(`${input.pluginId}:no-skills`);
      continue;
    }
    perPlugin.push({ pluginId: input.pluginId, desiredVersion, names: safeNames });
  }

  const owners = new Map<string, string[]>();
  for (const p of perPlugin) {
    for (const name of p.names) {
      const list = owners.get(name) ?? [];
      list.push(p.pluginId);
      owners.set(name, list);
    }
  }
  const conflicted = new Set<string>();
  for (const [name, ownerIds] of owners) {
    if (ownerIds.length > 1) conflicted.add(name);
  }

  const desired: DesiredSkillEntry[] = [];
  for (const p of perPlugin) {
    for (const name of p.names) {
      if (conflicted.has(name)) {
        failed.push({ id: `${p.pluginId}/${name}`, reason: 'skill-name-conflict' });
        continue;
      }
      desired.push({ pluginId: p.pluginId, skillName: name, desiredVersion: p.desiredVersion, resultId: `${p.pluginId}/${name}` });
    }
  }

  return { desired, notAllowed, noSkillsPresent, failed };
}

/**
 * 現在 managed（marker 所有）な skill 名一覧のうち、desired に無いものを削除対象として返す。
 * 非管理ディレクトリはここに含めない（呼び出し側が isOwnedMarker で事前に絞り込む前提）。
 */
export function decideRemovals(existingManagedNames: string[], desiredSkillNames: string[]): string[] {
  const desiredSet = new Set(desiredSkillNames);
  return existingManagedNames.filter((n) => !desiredSet.has(n));
}

// -----------------------------------------------------------------------------
// §3-1/§5-4 CRITICAL RULE: 索引取得結果 → 撤去可否
// -----------------------------------------------------------------------------

export type IndexOutcome =
  | 'ok'
  | 'skipped-empty-items'
  | 'clone-failed'
  | 'manifest-invalid'
  | 'devin-not-found'
  | 'git-not-found';

/**
 * CRITICAL RULE（承認ノート #8）: marketplace clone/fetch/manifest 解析失敗、tree 検証失敗時は
 * desired state を確定できなかったものとして撤去しない。`ok` と、items が空で clone 自体
 * 不要だった `skipped-empty-items`（cleanup パスの filesystem-only 実行）のみ撤去可能。
 */
export function canPerformRemoval(outcome: IndexOutcome): boolean {
  return outcome === 'ok' || outcome === 'skipped-empty-items';
}

// -----------------------------------------------------------------------------
// 共通ヘルパ（claude-plugin-rules.ts の resolveFailureIds を複製。zero-import 規約のため import しない）
// -----------------------------------------------------------------------------

/** items が空のときに fallback id 1件を使い、無言の空 failed にしない */
export function resolveFailureIds(itemIds: string[], fallbackId: string): string[] {
  return itemIds.length > 0 ? itemIds : [fallbackId];
}
