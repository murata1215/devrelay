/**
 * サイクルP1: Claude Code plugin capability の純粋ロジック（外部 import ゼロ）。
 * `claude-plugin-adapter.ts`（CLI 実行・ファイル読み取りを担う I/O 層）から呼ばれる。
 *
 * 実機確認済み（`claude --version` 2.1.263, Step 0）:
 * - `claude plugin list --json` は配列（未インストール時は `[]`）を返すクリーンな JSON
 * - `claude plugin marketplace list --json` は `[{ name, source, repo, installLocation }]`
 * - `claude plugin list`（プレーンテキスト）は未インストール時 "No plugins installed. ..." の1行
 * populated 時のテキスト行フォーマットは未確認（このマシンに plugin が未インストールのため）。
 * そのため JSON を最優先し、失敗時のみテキストへフォールバックする（`name@marketplace` パターンの
 * ベストエフォート抽出、一致しない行は無視する fail-open 設計）。
 *
 * scope の一次情報源は `claude plugin list` ではなく設定ファイルの同一性
 * （user=`~/.claude/settings.json` / project=`<proj>/.claude/settings.json` /
 * local=`<proj>/.claude/settings.local.json` の `enabledPlugins`）。
 * `plugin list` はあくまで cross-check に留める。
 */

// -----------------------------------------------------------------------------
// plugin list パーサー（JSON 優先、テキストへフォールバック）
// -----------------------------------------------------------------------------

export interface ParsedPluginEntry {
  name: string;
  scope?: string;
  version?: string;
  enabled?: boolean;
}

/** `claude plugin list --json` の出力を解析する。配列でない/JSON でなければ null */
export function parsePluginListJson(raw: string): ParsedPluginEntry[] | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(data)) return null;

  const result: ParsedPluginEntry[] = [];
  for (const item of data) {
    if (typeof item !== 'object' || item === null) continue;
    const obj = item as Record<string, unknown>;
    if (typeof obj.name !== 'string') continue;
    result.push({
      name: obj.name,
      scope: typeof obj.scope === 'string' ? obj.scope : undefined,
      version: typeof obj.version === 'string' ? obj.version : undefined,
      enabled: typeof obj.enabled === 'boolean' ? obj.enabled : undefined,
    });
  }
  return result;
}

/**
 * `claude plugin list`（プレーンテキスト）をトレラントに解析する。
 * 実機確認済みの空状態文言を空配列として認識し、それ以外は `name@marketplace` パターンを
 * 含む行からベストエフォートで抽出する（一致しない行は無視、throw しない）。
 */
export function parsePluginListText(raw: string): ParsedPluginEntry[] {
  if (/No plugins installed/i.test(raw)) return [];
  const result: ParsedPluginEntry[] = [];
  const pattern = /([a-zA-Z0-9_.-]+@[a-zA-Z0-9_.-]+)/;
  for (const line of raw.split(/\r?\n/)) {
    const m = pattern.exec(line);
    if (m) result.push({ name: m[1] });
  }
  return result;
}

/** JSON 優先で解析し、失敗時のみテキストパーサーへフォールバックする入口 */
export function parsePluginList(raw: string, jsonAttempted: boolean): ParsedPluginEntry[] {
  if (jsonAttempted) {
    const jsonResult = parsePluginListJson(raw);
    if (jsonResult !== null) return jsonResult;
  }
  return parsePluginListText(raw);
}

// -----------------------------------------------------------------------------
// enabledPlugins 抽出 + scope 判定
// -----------------------------------------------------------------------------

/** `.claude/settings.json` 等をパースした結果から `enabledPlugins` を安全に取り出す */
export function extractEnabledPlugins(settings: unknown): Record<string, boolean> {
  if (typeof settings !== 'object' || settings === null) return {};
  const raw = (settings as Record<string, unknown>).enabledPlugins;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};

  const result: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'boolean') result[key] = value;
  }
  return result;
}

export type Scope = 'user' | 'project' | 'local';

export interface ScopeEnabledMaps {
  user: Record<string, boolean>;
  project: Record<string, boolean>;
  local: Record<string, boolean>;
}

export interface ScopeDecision {
  scope: Scope | 'unknown';
  enabled: boolean;
}

/**
 * pluginId のスコープを決定論的に導く（純粋関数）。
 * local > project > user の優先順で「そのファイルにキーが存在する」scope を採用する
 * （値が true/false のどちらであっても、そのファイルがこの plugin を明示的に管理しているとみなす）。
 * どのファイルにも存在しなければ 'unknown'。
 */
export function determinePluginScope(pluginId: string, maps: ScopeEnabledMaps): ScopeDecision {
  if (pluginId in maps.local) return { scope: 'local', enabled: maps.local[pluginId] };
  if (pluginId in maps.project) return { scope: 'project', enabled: maps.project[pluginId] };
  if (pluginId in maps.user) return { scope: 'user', enabled: maps.user[pluginId] };
  return { scope: 'unknown', enabled: false };
}

// -----------------------------------------------------------------------------
// marketplace 登録確認 + blocklist 判定
// -----------------------------------------------------------------------------

export interface KnownMarketplaceEntry {
  source?: { repo?: string; url?: string };
}

export type MarketplaceCheckResult = 'ok' | 'not-registered' | 'name-mismatch';

/**
 * `known_marketplaces.json`（marketplace 名をキーにした JSON、実機確認済み）に対して、
 * 期待する marketplace が正しく登録されているかを JSON の完全一致で判定する
 * （テキスト解析ではなく、`source.repo`/`source.url` の値比較）。
 */
export function checkMarketplaceRegistration(
  known: Record<string, KnownMarketplaceEntry>,
  expectedMarketplaceName: string,
  expectedSource: string,
): MarketplaceCheckResult {
  const entry = known[expectedMarketplaceName];
  if (!entry) return 'not-registered';
  const actualSource = entry.source?.repo ?? entry.source?.url;
  return actualSource === expectedSource ? 'ok' : 'name-mismatch';
}

export interface BlocklistEntry {
  id?: string;
  name?: string;
  reason?: string;
}

/** `blocklist.json`（実機確認済みに存在するファイル）に該当 plugin が含まれているか判定する */
export function findBlockedEntry(blocklist: BlocklistEntry[], pluginId: string): BlocklistEntry | null {
  return blocklist.find(e => e.id === pluginId || e.name === pluginId) ?? null;
}

// -----------------------------------------------------------------------------
// 差分計算
// -----------------------------------------------------------------------------

export interface InstallDiffResult {
  /** scope 不明（未インストール扱いに倒す。install --scope user は冪等なため安全側） */
  toInstall: string[];
  /** 既にどこかの scope で enabled:true */
  alreadyEnabled: string[];
  /** scope は判明しているが enabled:false（enable が必要） */
  disabledNeedsEnable: string[];
}

/**
 * `capabilityConfig.items` の desired plugin id 一覧と、現在の scope 設定を突き合わせて
 * install/enable が必要な差分を計算する（純粋関数）。
 * scope 不明時は「未インストール扱い」に倒す（§8.1-6: 不明を present 扱いにすると
 * test010 で実際に起きた誤認事故そのものになるため）。
 */
export function computeInstallDiff(desiredIds: string[], maps: ScopeEnabledMaps): InstallDiffResult {
  const toInstall: string[] = [];
  const alreadyEnabled: string[] = [];
  const disabledNeedsEnable: string[] = [];

  for (const id of desiredIds) {
    const decision = determinePluginScope(id, maps);
    if (decision.scope === 'unknown') {
      toInstall.push(id);
    } else if (decision.enabled) {
      alreadyEnabled.push(id);
    } else {
      disabledNeedsEnable.push(id);
    }
  }

  return { toInstall, alreadyEnabled, disabledNeedsEnable };
}
