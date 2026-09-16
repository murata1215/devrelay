/**
 * サイクル P3-B: Agent Skills 標準 adapter（`agent-skills:standard`）の純粋関数群（外部 import ゼロ）。
 *
 * サイクル P3-A で `devin:skill`（Devin という「ツール名」に紐づく adapter）として実装したものを、
 * 配布フォーマット単位の adapter へ昇格したもの（`devin-skill-rules.ts` からのリネーム改造）。
 * 配布先は `~/.agents/skills/<name>/SKILL.md`（Agent Skills 標準。Devin CLI と Codex の両方が読む）。
 *
 * `claude-plugin-rules.ts` と同じ流儀: I/O は一切行わず、コンパイル済み dist を直接
 * `node --test` から import して単体検証する。`agent-skills-adapter.ts`（I/O 層）からのみ呼ばれる。
 *
 * `isSafeRelativePath()` は `git-guard-core.ts:90` と同一の判定式を意図的に再実装したもの
 * （rules ファイルは外部 import ゼロ規約のため import できない）。変更する場合は両方を確認すること。
 *
 * 承認ノート #3（P3-A）: skill tree の安全上限は v1 では aggregate size 20MB / files 500 / depth 16。
 * 承認ノート #7（P3-A）: 更新判定は sourceCommit 単独ではなく plugin.json version → marketplace entry
 * version → content hash の順（sourceCommit は marker の provenance としてのみ保持）。
 * 承認ノート #5（P3-B）: 上記 P3-A の確認事項（移行ゲート・unmanaged 非干渉・last-known-good）は
 * そのまま拘束力を持つ（削除も上書きもしない）。
 */

// -----------------------------------------------------------------------------
// 安全上限（P3-A 承認ノート #3。定数化し単体テストする）
// -----------------------------------------------------------------------------

/** 1 skill あたりの合計バイト数上限（v1 暫定値） */
export const SKILL_TREE_MAX_BYTES = 20 * 1024 * 1024;
/** 1 skill あたりのファイル数上限（v1 暫定値） */
export const SKILL_TREE_MAX_FILES = 500;
/** 1 skill あたりの再帰深さ上限（v1 暫定値） */
export const SKILL_TREE_MAX_DEPTH = 16;

// -----------------------------------------------------------------------------
// §5-2: 配布先ディレクトリの OS 別パス解決（新配布先 + legacy 移行元）
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

export interface ResolveSkillsDirInput {
  /** `process.platform` の値 */
  platform: string;
  /** `process.env` 相当 */
  env: Record<string, string | undefined>;
  /** `os.homedir()` の値（win32 では `%USERPROFILE%` 相当） */
  homeDir: string;
}

export type ResolveSkillsDirResult =
  | { ok: true; dir: string; source: 'env-override' | 'appdata' | 'xdg' | 'home-default' }
  | { ok: false; reason: 'home-missing' | 'override-not-absolute' };

/** 後方互換のための型エイリアス（P3-A 由来の呼び出し元向け） */
export type ResolveDevinSkillsDirInput = ResolveSkillsDirInput;
export type ResolveDevinSkillsDirResult = ResolveSkillsDirResult;

/**
 * サイクル P3-B §5-2: Agent Skills 標準の配布先ディレクトリを解決する（新配布先。desired-state 側）。
 * 1. `env.DEVRELAY_AGENT_SKILLS_DIR` が非空なら最優先（絶対パスのときのみ採用。相対なら `ok:false`）
 * 2. `<home>/.agents/skills`（win32 は `%USERPROFILE%` 起点、posix は `$HOME` 起点。XDG 分岐は持たない
 *    ― Agent Skills 標準の置き場は固定パスであり、XDG 分岐は legacy 側にのみ残す）
 */
export function resolveAgentSkillsDirPath(input: ResolveSkillsDirInput): ResolveSkillsDirResult {
  const { platform, env, homeDir } = input;

  const override = env.DEVRELAY_AGENT_SKILLS_DIR;
  if (override !== undefined && override.length > 0) {
    const isAbs = platform === 'win32' ? isAbsoluteWinPath(override) : isAbsolutePosixPath(override);
    if (!isAbs) return { ok: false, reason: 'override-not-absolute' };
    return { ok: true, dir: override, source: 'env-override' };
  }

  if (!homeDir) return { ok: false, reason: 'home-missing' };
  if (platform === 'win32') {
    return { ok: true, dir: joinWin(homeDir, '.agents', 'skills'), source: 'home-default' };
  }
  return { ok: true, dir: joinPosix(homeDir, '.agents', 'skills'), source: 'home-default' };
}

/**
 * サイクル P3-B §5-2: legacy（P3-A 由来）の Devin 専用 skills ディレクトリを解決する
 * （移行スキャン専用。新規配布には使わない）。P3-A の `resolveDevinSkillsDirPath()` を改名したもの。
 * 1. `env.DEVRELAY_DEVIN_SKILLS_DIR` が非空なら最優先（絶対パスのときのみ採用）
 * 2. win32 → `%APPDATA%\devin\skills`（`APPDATA` 未設定なら `<home>\AppData\Roaming\devin\skills`）
 * 3. その他 → `XDG_CONFIG_HOME`（絶対のときのみ採用）→ `<home>/.config`、その下に `devin/skills`
 */
export function resolveLegacyDevinSkillsDirPath(input: ResolveSkillsDirInput): ResolveSkillsDirResult {
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
// §3-1（P3-A）: 配布元 URL 変換・パス安全性
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
// §5-9: item id の二重サフィックス防止（Agent 側防御）
// -----------------------------------------------------------------------------

/**
 * item id に既に `@<marketplaceName>` サフィックスが付いていた場合に剥がす（冪等）。
 * items[].id は本来 bare な pluginId のはずだが、DB に残った二重サフィックス値
 * （`foo@devrelay@devrelay` 等）の後方互換防御として使う。1 回だけ剥がす（多重サフィックスは
 * 呼び出し側の web 正規化で防ぐため、ここでは 1 回で十分）。
 */
export function stripMarketplaceSuffix(id: string, marketplaceName: string): string {
  if (typeof id !== 'string' || typeof marketplaceName !== 'string' || marketplaceName.length === 0) return id;
  const suffix = `@${marketplaceName}`;
  return id.endsWith(suffix) ? id.slice(0, -suffix.length) : id;
}

// -----------------------------------------------------------------------------
// §3-1（P3-A）: git 呼び出し予算配分
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
// §5-2（P3-A）: marketplace.json / plugin.json のパース
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

/** plugin.json の version → marketplace entry の version の順で「望ましい版」を決める（P3-A 承認ノート #7） */
export function resolveDesiredPluginVersion(
  pluginJsonVersion: string | null,
  marketplaceEntryVersion: string | null,
): string | null {
  return pluginJsonVersion ?? marketplaceEntryVersion ?? null;
}

// -----------------------------------------------------------------------------
// §5-5: marker ファイル（新配布先 = Agent Skills 標準 / legacy = P3-A Devin 専用）
// -----------------------------------------------------------------------------

export interface SkillMarker {
  schema: number;
  managedBy: string;
  /** サイクル P3-B §5-5: 実装差し替えに耐えるための一次識別キー。新 marker は必ず持つ */
  adapter?: string;
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

/** 新 marker（Agent Skills 標準）の `adapter` 識別子 */
export const AGENT_SKILLS_MARKER_ADAPTER = 'agent-skills-standard';

/**
 * サイクル P3-B §5-5: marker が devrelay 管理下の Agent Skills 標準 skill であるかを判定する（型ガード）。
 * `adapter` フィールドを一次キーとし、無ければ `provider==='agent-skills' && kind==='standard'`
 * （前方互換の二重条件）で判定する。`marketplaceName` は所有権の条件に**含めない**
 * （索引を乗り換えた後も自分が置いた古いディレクトリを回収できるようにするため）。
 *
 * legacy な P3-A marker（`provider==='devin'`）は**所有扱いしない**
 * （新配布先に P3-A marker が存在することは有り得ず、移行コードが誤って
 * legacy marker を新配布先の所有物とみなす事故を型レベルで防ぐ）。
 */
export function isOwnedAgentSkillsMarker(data: unknown): data is SkillMarker {
  if (!data || typeof data !== 'object') return false;
  const m = data as Record<string, unknown>;
  if (m.schema !== 1 || m.managedBy !== 'devrelay') return false;
  if (typeof m.skillName !== 'string' || m.skillName.length === 0) return false;
  if (m.adapter === AGENT_SKILLS_MARKER_ADAPTER) return true;
  return m.provider === 'agent-skills' && m.kind === 'standard';
}

/**
 * サイクル P3-B §5-5: marker が P3-A（legacy）の Devin 専用 skill 配布物であるかを判定する（型ガード）。
 * P3-A の `isOwnedMarker()` をそのまま改名したもの（判定式は完全に同一）。**移行の削除対象判定にのみ使う**
 * （新配布先の所有判定 = `isOwnedAgentSkillsMarker` とは別関数にすることで、両者を取り違える事故を防ぐ）。
 */
export function isOwnedLegacyDevinMarker(data: unknown): data is SkillMarker {
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

/** 新 marker（Agent Skills 標準）ファイルの内容を組み立てる純関数（書き込みは呼び出し側の I/O 層が行う） */
export function buildSkillMarker(input: BuildSkillMarkerInput): SkillMarker {
  return {
    schema: 1,
    managedBy: 'devrelay',
    adapter: AGENT_SKILLS_MARKER_ADAPTER,
    provider: 'agent-skills',
    kind: 'standard',
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
// §3-3（P3-A）: action 判定（fast path つき2段構え）
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
// §3-2/§3-4（P3-A）: desired plan 構築・削除判定
// -----------------------------------------------------------------------------

export interface DesiredSkillPluginInput {
  /** items[].id（= plugin 名。二重サフィックスは呼び出し側で `stripMarketplaceSuffix()` 済みの前提） */
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
 * 非管理ディレクトリはここに含めない（呼び出し側が `isOwnedAgentSkillsMarker` で事前に絞り込む前提）。
 */
export function decideRemovals(existingManagedNames: string[], desiredSkillNames: string[]): string[] {
  const desiredSet = new Set(desiredSkillNames);
  return existingManagedNames.filter((n) => !desiredSet.has(n));
}

// -----------------------------------------------------------------------------
// §3-1/§5-4 CRITICAL RULE（P3-A）: 索引取得結果 → 撤去可否
// -----------------------------------------------------------------------------

export type IndexOutcome =
  | 'ok'
  | 'skipped-empty-items'
  | 'clone-failed'
  | 'manifest-invalid'
  | 'devin-not-found'
  | 'git-not-found'
  | 'missing-marketplace-config';

/**
 * CRITICAL RULE（P3-A 承認ノート #8）: marketplace clone/fetch/manifest 解析失敗、tree 検証失敗時は
 * desired state を確定できなかったものとして撤去しない。`ok` と、items が空で clone 自体
 * 不要だった `skipped-empty-items`（cleanup パスの filesystem-only 実行）のみ撤去可能。
 */
export function canPerformRemoval(outcome: IndexOutcome): boolean {
  return outcome === 'ok' || outcome === 'skipped-empty-items';
}

// -----------------------------------------------------------------------------
// §5-4: legacy（P3-A）からの移行判定（純粋関数。実際の fs 操作は adapter 側が行う）
// -----------------------------------------------------------------------------

export type LegacyMigrationDecision = 'remove-legacy' | 'keep-legacy' | 'no-legacy';

export interface DecideLegacyMigrationInput {
  /** legacy dir にこの skill の owned（P3-A marker 所有）ディレクトリが存在するか */
  hasLegacyOwnedDir: boolean;
  /** 新配布先へ書き込んだ marker を読み直して `isOwnedAgentSkillsMarker()` が真だったか */
  newMarkerVerified: boolean;
  /** この skill の新配布先への install/update が成功したか（present も成功扱い） */
  newInstallSucceeded: boolean;
  /** `canPerformRemoval(indexOutcome)`（索引取得が last-known-good を維持できているか） */
  canRemove: boolean;
}

/**
 * サイクル P3-B §5-4: 1 skill 単位の legacy 回収可否を判定する（純粋関数）。
 * 4 条件すべてが揃わない限り legacy を削除しない（last-known-good を保全する fail-safe）。
 * - legacy に所有ディレクトリが無ければ `no-legacy`（触るものが無い）
 * - `canRemove` が false（索引取得失敗等）なら `keep-legacy`
 * - 新配布先への install/update が失敗していれば `keep-legacy`
 * - marker 再読込検証が偽なら `keep-legacy`
 * - すべて真なら `remove-legacy`
 */
export function decideLegacyMigration(input: DecideLegacyMigrationInput): LegacyMigrationDecision {
  if (!input.hasLegacyOwnedDir) return 'no-legacy';
  if (!input.canRemove) return 'keep-legacy';
  if (!input.newInstallSucceeded) return 'keep-legacy';
  if (!input.newMarkerVerified) return 'keep-legacy';
  return 'remove-legacy';
}

// -----------------------------------------------------------------------------
// §5-6: ランタイム診断（配布判断には非関与。表示専用の文字列組み立てのみ）
// -----------------------------------------------------------------------------

export interface RuntimeDiagnosticEntry {
  /** 表示ラベル（例: 'Devin' / 'Codex'） */
  label: string;
  /** 検出/設定ありと判定されたか */
  detected: boolean;
  /** 判定根拠。P3-B 承認ノート#2: 根拠が異なる語彙で表現し、実機検出だと誤解させない */
  basis: 'runtime-detection' | 'config-presence';
  /** runtime-detection のときだけ使う版文字列（無ければ省略） */
  version?: string | null;
}

/**
 * サイクル P3-C（T3）: `devin --version` 等の生出力から診断文字列に埋め込む版文字列を作る純粋関数。
 * `Devin devin 3000.6.7 (260a97c8) 検出` のような接頭辞重複を防ぐため、raw 出力の先頭に付いた
 * label トークン（大小文字無視）を除去してから `buildRuntimeDiagnostics()` に渡す。
 * 1. null / 空白のみ → null（「検出はできたが版が取れない」を表す。呼び出し側は `${label} 検出` にする）
 * 2. 複数行対策として最初の非空行だけを採用して trim する
 * 3. 先頭が label と大小文字無視で一致し、直後が空白または文字列末尾なら、その label トークンを
 *    除去する（`^devin\s+` 等、または `devin` のみ＝版が取れない場合も含む）
 * 4. 除去後が空なら null。80 文字超は先頭 80 文字 + `…` に丸める（payload 肥大防止）
 * `devin-path.ts` 側の生値はここでは変更しない（他の利用者向けに raw のまま残す）。
 */
export function formatRuntimeVersion(label: string, version: string | null | undefined): string | null {
  if (version === null || version === undefined) return null;
  const firstNonEmptyLine = version.split(/\r?\n/).find((line) => line.trim().length > 0);
  if (!firstNonEmptyLine) return null;
  const trimmed = firstNonEmptyLine.trim();
  // 直後が空白（`devin 3000.6.7...`）または文字列末尾（`devin` のみ＝版が取れない）のどちらでも除去する
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const stripped = trimmed.replace(new RegExp(`^${escapedLabel}(\\s+|$)`, 'i'), '').trim();
  if (!stripped) return null;
  return stripped.length > 80 ? `${stripped.slice(0, 80)}…` : stripped;
}

/**
 * サイクル P3-B §5-6（承認ノート#2）: 診断文字列を組み立てる純粋関数。
 * Devin は実機検出（`devin --version`）、Codex は DevRelay `config.aiTools` の設定有無であり、
 * 両者は判定根拠が異なるため**語彙を変えて**表現する（「未検出」に統一すると Codex も実機検出した
 * ように誤解される）。配布可否には一切使わない（`CapabilityResult.runtimeVersion` に入れるだけ）。
 * サイクル P3-C（T3）: `runtime-detection` の版文字列は `formatRuntimeVersion()` 経由にし、
 * label 接頭辞の二重表示（`Devin devin 3000.6.7...`）を解消した。
 */
export function buildRuntimeDiagnostics(entries: RuntimeDiagnosticEntry[]): string {
  return entries
    .map((e) => {
      if (e.basis === 'runtime-detection') {
        if (!e.detected) return `${e.label} 未検出`;
        const formatted = formatRuntimeVersion(e.label, e.version);
        return formatted ? `${e.label} ${formatted} 検出` : `${e.label} 検出`;
      }
      return e.detected ? `${e.label}: 設定あり` : `${e.label}: 設定なし`;
    })
    .join(' / ');
}

// -----------------------------------------------------------------------------
// 共通ヘルパ（claude-plugin-rules.ts の resolveFailureIds を複製。zero-import 規約のため import しない）
// -----------------------------------------------------------------------------

/** items が空のときに fallback id 1件を使い、無言の空 failed にしない */
export function resolveFailureIds(itemIds: string[], fallbackId: string): string[] {
  return itemIds.length > 0 ? itemIds : [fallbackId];
}
