/**
 * サイクルP1: Claude Code plugin capability の純粋ロジック（外部 import ゼロ）。
 * `claude-plugin-adapter.ts`（CLI 実行・ファイル読み取りを担う I/O 層）から呼ばれる。
 *
 * 実機確認済み（`claude --version` 2.1.263, Step 0）:
 * - `claude plugin list --json` は配列（未インストール時は `[]`）を返すクリーンな JSON。
 *   要素の実フィールドは `{ id, version, scope, enabled, installPath, installedAt, lastUpdated, projectPath? }`
 *   （P1/P1.2 は未検証のまま `name` を前提にしていたが、実機は `id`。P1.3 Step 0 で判明した既存バグ。
 *   `projectPath` は scope が `project`/`local` のときのみ存在し、`user` scope には無い）。
 * - `enabled: true` は「今のカレントディレクトリの有効な設定がこの id を true にしている」ことしか
 *   意味しない。**実際にインストールされている entry の `scope`/`projectPath` が宣言元と一致しているかは
 *   別途 `projectPath`/`scope` を突き合わせる必要がある**（別プロジェクトの local scope entry が、
 *   たまたま同じ id を宣言している無関係な cwd から `enabled:true` に見える実機再現あり）。
 * - `claude plugin marketplace list --json` は `[{ name, source, repo, installLocation }]`
 *   （`source` は `'github'` 等の文字列、`repo` が `owner/repo`）。
 * - `claude plugin list`（プレーンテキスト）は未インストール時 "No plugins installed. ..." の1行
 * populated 時のテキスト行フォーマットは未確認（このマシンに plugin が未インストールのため）。
 * そのため JSON を最優先し、失敗時のみテキストへフォールバックする（`name@marketplace` パターンの
 * ベストエフォート抽出、一致しない行は無視する fail-open 設計）。
 * - 未知 plugin id の install 失敗は **stdout**（stderr ではない）に
 *   `Plugin "<name>" not found in marketplace "<marketplace>"`（exit code 1）。
 *
 * scope の一次情報源は `claude plugin list` ではなく設定ファイルの同一性
 * （user=`~/.claude/settings.json` / project=`<proj>/.claude/settings.json` /
 * local=`<proj>/.claude/settings.local.json` の `enabledPlugins`）。
 * `plugin list` はあくまで cross-check に留める。
 */

// -----------------------------------------------------------------------------
// plugin list パーサー（JSON 優先、テキストへフォールバック）
// -----------------------------------------------------------------------------

/**
 * `claude plugin list --json` の 1 要素をトレラントに解析した結果。
 * `id` が正式フィールド（実機確認済み）。`name` は既存呼び出し元/既存テストとの後方互換のため
 * `id` と同値を持つエイリアスとして常に埋める（P1/P1.2 は `name` 前提で書かれていたため）。
 */
export interface ParsedPluginEntry {
  id: string;
  /** @deprecated 後方互換のためのエイリアス。常に `id` と同じ値。新規コードは `id` を使うこと */
  name: string;
  scope?: string;
  version?: string;
  enabled?: boolean;
  /** 実機の `status` 相当フィールド（キー名がぶれる可能性があるためエイリアス吸収する） */
  status?: string;
  /** scope が project/local のときのみ実機に存在。cross-check で使う */
  projectPath?: string;
  /** 元の生オブジェクト（将来の cross-check 拡張用。テストでは未使用） */
  raw?: Record<string, unknown>;
}

/** id 相当のキー候補（実機は `id`。将来の CLI 変更に備え `name` もフォールバックで許容） */
const ID_KEYS = ['id', 'name'] as const;
/** enabled 相当のキー候補 */
const ENABLED_KEYS = ['enabled', 'isEnabled'] as const;
/** status 相当のキー候補 */
const STATUS_KEYS = ['status', 'state'] as const;
/** projectPath 相当のキー候補 */
const PROJECT_PATH_KEYS = ['projectPath', 'project_path', 'path'] as const;

function pickString(obj: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string') return v;
  }
  return undefined;
}

function pickBoolean(obj: Record<string, unknown>, keys: readonly string[]): boolean | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'boolean') return v;
  }
  return undefined;
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
    const id = pickString(obj, ID_KEYS);
    if (id === undefined) continue;
    result.push({
      id,
      name: id,
      scope: typeof obj.scope === 'string' ? obj.scope : undefined,
      version: typeof obj.version === 'string' ? obj.version : undefined,
      enabled: pickBoolean(obj, ENABLED_KEYS),
      status: pickString(obj, STATUS_KEYS),
      projectPath: pickString(obj, PROJECT_PATH_KEYS),
      raw: obj,
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
    if (m) result.push({ id: m[1], name: m[1] });
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

/**
 * install scope を「宣言元」に合わせて決定する（純粋関数、要件2）。
 * project にキーがあれば local にもあっても project を優先する（1回だけ install し、より広い scope を選ぶ）。
 * project に無く local にのみあれば local。どちらにも無ければ install不要（null）。
 * `user` scope 宣言（`~/.claude/settings.json`）は v1 の対象外（machine 経路が別途担当するため、
 * ここでは project/local の 2 値のみを扱う）。
 */
export function resolveInstallScope(
  id: string,
  projectEnabled: Record<string, boolean>,
  localEnabled: Record<string, boolean>,
): 'project' | 'local' | null {
  if (id in projectEnabled) return 'project';
  if (id in localEnabled) return 'local';
  return null;
}

// -----------------------------------------------------------------------------
// scope × projectPath cross-check（要件3: 実機で `enabled:true` だけでは
// 宣言元と一致した実体が入っているか判定できないことが判明したための追加）
// -----------------------------------------------------------------------------

export type ScopeSatisfaction = 'satisfied' | 'wrong-scope' | 'disabled' | 'not-installed';

/**
 * `unknownScopePolicy`: entries に scope 情報が無い/読み取れない場合の倒し方。
 * 既定は `'accept'`（fail-open）。理由: 実機の list に scope が出ない場合に `'reject'` だと
 * 再検証が常に失敗し、毎 prelaunch で全プラグインを再 install する install storm になる
 * （P1.2 実測で 1 件 ~20.7 秒）。
 */
export type UnknownScopePolicy = 'accept' | 'reject';

/**
 * `claude plugin list --json` の解析結果から、id が「宣言した scope で実際に有効か」を判定する（純粋関数）。
 * 実機で判明した重要な注意点: `enabled:true` は「今のカレントディレクトリの有効な設定がこの id を
 * true にしている」ことしか意味せず、entry 自体の `scope`/`projectPath` が宣言元と一致しているかは
 * 別途確認しないと誤判定する（無関係な project の local scope entry が、たまたま同じ id を宣言する
 * 別の cwd から見ると `enabled:true` に見える再現あり）。
 * - scope が project/local のときは `entry.projectPath === projectPath` も一致必須。
 * - entries に scope が全く無い（`undefined`）場合は `unknownScopePolicy` に従う
 *   （'accept' なら enabled 値のみで判定、'reject' なら常に 'wrong-scope' 扱いで再 install させる）。
 */
export function evaluatePluginAtScope(
  entries: ParsedPluginEntry[],
  id: string,
  scope: 'project' | 'local',
  projectPath: string,
  unknownScopePolicy: UnknownScopePolicy = 'accept',
): ScopeSatisfaction {
  const entry = entries.find(e => e.id === id);
  if (!entry) return 'not-installed';

  if (entry.scope === undefined) {
    if (unknownScopePolicy === 'reject') return 'wrong-scope';
    return entry.enabled ? 'satisfied' : 'disabled';
  }

  if (entry.scope !== scope) return 'wrong-scope';
  if ((scope === 'project' || scope === 'local') && entry.projectPath !== undefined && entry.projectPath !== projectPath) {
    return 'wrong-scope';
  }
  return entry.enabled ? 'satisfied' : 'disabled';
}

/** `evaluatePluginAtScope` の真偽値版（`'satisfied'` のみ true） */
export function isSatisfiedAtScope(
  entries: ParsedPluginEntry[],
  id: string,
  scope: 'project' | 'local',
  projectPath: string,
  unknownScopePolicy: UnknownScopePolicy = 'accept',
): boolean {
  return evaluatePluginAtScope(entries, id, scope, projectPath, unknownScopePolicy) === 'satisfied';
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

// -----------------------------------------------------------------------------
// サイクルP1.3 要件5: `claude plugin marketplace list --json` による初回登録確認
// （`checkMarketplaceRegistration` が読む `known_marketplaces.json` とはファイル/形状が別物のため
// 専用のパーサー・判定関数を用意する。実機確認済み形状: `[{ name, source, repo, installLocation }]`）
// -----------------------------------------------------------------------------

export interface ParsedMarketplaceEntry {
  name: string;
  source?: string;
  repo?: string;
}

/** `claude plugin marketplace list --json` の出力を解析する。配列でない/JSON でなければ null */
export function parseMarketplaceListJson(raw: string): ParsedMarketplaceEntry[] | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(data)) return null;

  const result: ParsedMarketplaceEntry[] = [];
  for (const item of data) {
    if (typeof item !== 'object' || item === null) continue;
    const obj = item as Record<string, unknown>;
    if (typeof obj.name !== 'string') continue;
    result.push({
      name: obj.name,
      source: typeof obj.source === 'string' ? obj.source : undefined,
      repo: typeof obj.repo === 'string' ? obj.repo : undefined,
    });
  }
  return result;
}

export type MarketplaceListVerdict = 'registered' | 'not-registered' | 'name-mismatch' | 'unknown';

/**
 * marketplace が登録済みかを判定する（純粋関数、要件5）。
 * `entries === null`（パース不能/CLI失敗）は `'unknown'` を返す ＝ **fail-open**
 * （起動をブロックしないため、呼び出し側は 'unknown' を「登録済みとみなして続行」に倒す）。
 * `expectedSource`（`owner/repo` 形式を想定）が渡された場合のみ `repo` の一致を見る。
 */
export function evaluateMarketplaceList(
  entries: ParsedMarketplaceEntry[] | null,
  marketplaceName: string,
  expectedSource?: string,
): MarketplaceListVerdict {
  if (entries === null) return 'unknown';
  const entry = entries.find(e => e.name === marketplaceName);
  if (!entry) return 'not-registered';
  if (expectedSource !== undefined && entry.repo !== undefined && entry.repo !== expectedSource) {
    return 'name-mismatch';
  }
  return 'registered';
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
// サイクルP1.3 要件4: 索引未知 ID エラーの分類（marketplace update 1回リトライの起点判定）
// -----------------------------------------------------------------------------

/**
 * 「plugin id が marketplace 索引に存在しない」エラーの実文言パターン（大小文字無視で部分一致）。
 * 実機確認済み（Step 0）の文言を先頭に、CLI バージョン差分に備えた保守的な候補を並べる。
 * exit code や stdout/stderr の位置がバージョンで揺れる可能性があるため、message/stdout/stderr の
 * いずれかに含まれていれば良いという寛容な判定にする（`isPluginNotInIndexError` 側で吸収）。
 */
export const PLUGIN_NOT_IN_INDEX_PATTERNS: readonly string[] = [
  'not found in marketplace',
  'not found in the marketplace',
  'no such plugin',
  'unknown plugin',
  'plugin not found',
];

/** `isPluginNotInIndexError` に渡す最小限の CLI 失敗情報 */
export interface PluginInstallFailureInfo {
  message?: string;
  stdout?: string;
  stderr?: string;
  code?: number | string | null;
  killed?: boolean;
}

/**
 * install 失敗が「plugin id が marketplace 索引に存在しない」ことに起因するかを判定する（純粋関数）。
 * timeout kill（`killed:true`）・spawn 失敗（`code` が文字列、例 'ENOENT'）・
 * message/stdout/stderr がすべて空は、索引ミスと誤分類しないため常に false
 * （`cli-failure.ts` の「シグナル終了は CLI 自体の失敗ではない」という既存ガードと同じ考え方）。
 */
export function isPluginNotInIndexError(
  failure: PluginInstallFailureInfo,
  patterns: readonly string[] = PLUGIN_NOT_IN_INDEX_PATTERNS,
): boolean {
  if (failure.killed) return false;
  if (typeof failure.code === 'string') return false;

  const haystacks = [failure.message, failure.stdout, failure.stderr].filter(
    (s): s is string => typeof s === 'string' && s.length > 0,
  );
  if (haystacks.length === 0) return false;

  const combined = haystacks.join('\n').toLowerCase();
  return patterns.some(p => combined.includes(p.toLowerCase()));
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

// -----------------------------------------------------------------------------
// サイクルP1.2: items 0 件でも失敗を無言にしないための ID 解決
// -----------------------------------------------------------------------------

/**
 * `reconcileMachine` の失敗（`claude-not-found` / `missing-provider-config` / `marketplace-*`）を
 * `result.failed` に積むときの id 一覧を返す（純粋関数）。
 * `ctx.items` が 1 件以上あれば各 item の id をそのまま使う（既存挙動）。
 * `ctx.items` が空（サイクルP1.2 で新たに reconcile 対象になったケース）の場合は、
 * `buildUnsupportedResult`/`marketplace-update-failed` と同じ「provider×kind 全体の失敗」ID 規約
 * （`fallbackId`）に倣って 1 件だけ積む（無言の `done` を防ぐ）。
 */
export function resolveFailureIds(itemIds: string[], fallbackId: string): string[] {
  return itemIds.length > 0 ? itemIds : [fallbackId];
}
