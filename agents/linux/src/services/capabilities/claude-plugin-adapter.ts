/**
 * サイクルP1〜P1.3: Claude Code plugin capability の I/O 層（provider=claude, kind=plugin の唯一の実装）。
 *
 * `claude plugin ...` の CLI 実行・marketplace 操作・`.claude/settings*.json` の読み取りを
 * **すべてここに閉じ込める**（共通層 `capability-sync.ts` は本ファイルの存在を知らず、
 * `CapabilityAdapter` インタフェース越しにしか呼ばない）。判断ロジックは全て
 * `claude-plugin-rules.ts`（外部 import ゼロの純関数）に委譲し、ここでは
 * ファイル読み取り・CLI 実行という I/O だけを行う。
 *
 * サイクルP1.3 で全面的に deps 注入形へ分解した（`reconcileMachineWithDeps`/`reconcileProjectWithDeps`）。
 * 理由: hp630g9/fwjg2 実機（claude 2.1.266）で「プロジェクトへの install が Agent 自身の cwd に
 * 対して行われる」「install scope が宣言元と不一致で `failed to load` になる」の 2 バグが判明したため
 * （詳細は devlog 参照）。テストで「CLI 呼び出しに渡る cwd/args」を直接検証できるようにする。
 *
 * `claude` 実行ファイルの解決は `claude-path.ts` の `resolveSystemClaude()` を使う
 * （P1.3 で `ai-runner.ts` から切り出し。SDK 一式を引き込む import 循環を避けるため）。
 * 実行は `claude-cli.ts` の `execFileClaudeRunner`（`cwd` 必須）を使い、
 * シェル文字列連結は行わない（Web 経由の plugin id / marketplaceSource を安全に扱うため）。
 */
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { CapabilityResult, CapabilityClaudeProviderConfig } from '@devrelay/shared';
import { resolveSystemClaude } from '../claude-path.js';
import type { CapabilityAdapter, CapabilityCtx } from '../capability-sync.js';
import { getConfigDir } from '../config.js';
import { execFileClaudeRunner, type ClaudeCliRunner, type ClaudeCliResult } from './claude-cli.js';
import {
  parsePluginList,
  extractEnabledPlugins,
  checkMarketplaceRegistration,
  findBlockedEntry,
  computeInstallDiff,
  resolveFailureIds,
  resolveInstallScope,
  evaluatePluginAtScope,
  parseMarketplaceListJson,
  evaluateMarketplaceList,
  isPluginNotInIndexError,
  type ParsedPluginEntry,
  type KnownMarketplaceEntry,
  type BlocklistEntry,
  type ScopeEnabledMaps,
} from './claude-plugin-rules.js';

// -----------------------------------------------------------------------------
// パス解決ヘルパー（挙動変更なし。P1/P1.2 から移設）
// -----------------------------------------------------------------------------

/** `~/.claude/plugins/known_marketplaces.json` の絶対パス */
function knownMarketplacesPath(): string {
  return path.join(os.homedir(), '.claude', 'plugins', 'known_marketplaces.json');
}

/** `~/.claude/plugins/blocklist.json` の絶対パス */
function blocklistPath(): string {
  return path.join(os.homedir(), '.claude', 'plugins', 'blocklist.json');
}

/** `~/.claude/settings.json`（user scope）の絶対パス */
function userSettingsPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

/** `<projectPath>/.claude/settings.json`（project scope）の絶対パス */
function projectSettingsPath(projectPath: string): string {
  return path.join(projectPath, '.claude', 'settings.json');
}

/** `<projectPath>/.claude/settings.local.json`（local scope）の絶対パス */
function localSettingsPath(projectPath: string): string {
  return path.join(projectPath, '.claude', 'settings.local.json');
}

/** JSON ファイルを読んでパースする。存在しない/壊れている場合は null（throw しない） */
async function readJsonSafe(filePath: string): Promise<unknown> {
  try {
    const content = await readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function emptyResult(): CapabilityResult {
  return { provider: 'claude', kind: 'plugin', runtimeVersion: null, installed: [], updated: [], present: [], failed: [], notAllowed: [] };
}

// -----------------------------------------------------------------------------
// サイクルP1.3: deps 注入（テストで CLI 呼び出しを spawn ゼロで検証できるようにする）
// -----------------------------------------------------------------------------

/** `claude-plugin-adapter.ts` が使う外部依存の束（テストでは全て fake に差し替える） */
export interface ClaudePluginDeps {
  /** 既定: `claude-path.js` の `resolveSystemClaude` */
  resolveClaudePath: () => string | null;
  /** 既定: `claude-cli.js` の `execFileClaudeRunner`（cwd 必須） */
  runClaude: ClaudeCliRunner;
  /** 既定: 上記 `readJsonSafe`（throw しない） */
  readJson: (p: string) => Promise<unknown>;
  /**
   * machine scope reconcile の cwd。既定は `getConfigDir()`（`~/.devrelay` 等、`ensureConfigDir()` で
   * 常に存在し agent 所有・world-writable でない）。存在しなければ `os.homedir()` にフォールバックする。
   * `os.tmpdir()` は使わない（他ユーザーに `/tmp/.claude/settings.json` を置かれうるため）。
   */
  machineCwd: () => string;
}

/** `machineCwd` の既定実装。`getConfigDir()` が存在しない異常系のみ homedir にフォールバックする */
function defaultMachineCwd(): string {
  const dir = getConfigDir();
  try {
    if (existsSync(dir)) return dir;
  } catch {
    // fall through
  }
  return os.homedir();
}

/** 本番用の既定 deps */
export const defaultDeps: ClaudePluginDeps = {
  resolveClaudePath: resolveSystemClaude,
  runClaude: execFileClaudeRunner,
  readJson: readJsonSafe,
  machineCwd: defaultMachineCwd,
};

/** `enabledPlugins` を持つ settings ファイルを読んで `Record<string, boolean>` に変換する */
async function readEnabledPlugins(deps: ClaudePluginDeps, filePath: string): Promise<Record<string, boolean>> {
  const data = await deps.readJson(filePath);
  return extractEnabledPlugins(data);
}

/** `claude plugin list` を JSON 優先・失敗時テキストへフォールバックして取得する（cwd 必須） */
async function fetchPluginList(deps: ClaudePluginDeps, claudePath: string, cwd: string): Promise<ParsedPluginEntry[]> {
  const jsonAttempt = await deps.runClaude(claudePath, ['plugin', 'list', '--json'], cwd);
  if (jsonAttempt.ok) return parsePluginList(jsonAttempt.stdout, true);
  const textAttempt = await deps.runClaude(claudePath, ['plugin', 'list'], cwd);
  if (textAttempt.ok) return parsePluginList(textAttempt.stdout, false);
  return [];
}

/** marketplace 登録済みかを確認し、未登録なら add する（machine scope 専用）。結果は 'ok' | 'name-mismatch' | 'add-failed' */
async function ensureMarketplaceRegistered(
  deps: ClaudePluginDeps,
  claudePath: string,
  cwd: string,
  marketplaceName: string,
  marketplaceSource: string,
): Promise<'ok' | 'name-mismatch' | 'add-failed'> {
  const known = ((await deps.readJson(knownMarketplacesPath())) ?? {}) as Record<string, KnownMarketplaceEntry>;
  const initial = checkMarketplaceRegistration(known, marketplaceName, marketplaceSource);
  if (initial === 'ok') return 'ok';
  if (initial === 'name-mismatch') return 'name-mismatch';

  // not-registered → add を試みる（machine scope のみ。prelaunch は要件5により add しない）
  const addResult = await deps.runClaude(claudePath, ['plugin', 'marketplace', 'add', marketplaceSource], cwd);
  if (!addResult.ok) return 'add-failed';

  const reread = ((await deps.readJson(knownMarketplacesPath())) ?? {}) as Record<string, KnownMarketplaceEntry>;
  const after = checkMarketplaceRegistration(reread, marketplaceName, marketplaceSource);
  return after === 'ok' ? 'ok' : 'name-mismatch';
}

/**
 * scope 不明（実機の list に scope が出ない異常系）を fail-open で present 扱いにしたときに
 * 1 行だけ warn ログを出す（result payload には含めない。承認ノートの要求）。
 */
function isSatisfiedWithWarnLog(
  entries: ParsedPluginEntry[],
  id: string,
  scope: 'project' | 'local',
  projectPath: string,
): boolean {
  const verdict = evaluatePluginAtScope(entries, id, scope, projectPath, 'accept');
  if (verdict !== 'satisfied') return false;
  const entry = entries.find(e => e.id === id);
  if (entry && entry.scope === undefined) {
    // eslint 等の外部 lint 設定は本ファイルの対象外。console.warn は agent.log に流れる想定。
    console.warn(
      `[capabilities:claude-plugin] scope 不明のため fail-open で present 扱い: id=${id} declaredScope=${scope} reason=unknown-scope-accept`,
    );
  }
  return true;
}

// -----------------------------------------------------------------------------
// machine/user scope の reconcile（trigger connect/config/idle/manual）
// -----------------------------------------------------------------------------

/**
 * machine/user scope の reconcile。§8.1 の手順どおり: 存在確認 → runtimeVersion →
 * marketplace 登録確認/追加 → marketplace update → user scope での install/update 差分計算 →
 * 1 件ずつ実行（失敗しても次へ進む）。
 *
 * サイクルP1.3: すべての CLI 呼び出しに `cwd = deps.machineCwd()` を渡す（要件1）。
 * プロジェクトに紐付かない安定した場所（既定 `~/.devrelay`）を使い、Agent 自身の cwd
 * （`u` で消える場所）が誤って install 先になっていた P1/P1.2 のバグを根治する。
 *
 * サイクルP1.2: `ctx.items` が空（`providers.claude` は設定済みだが Plugin 未指定）でも
 * ここまで（存在確認〜marketplace update）は必ず実行する。失敗時は `resolveFailureIds()` で
 * fallback id を積み、無言の `done` にしない。
 */
export async function reconcileMachineWithDeps(ctx: CapabilityCtx, deps: ClaudePluginDeps): Promise<CapabilityResult> {
  const result = emptyResult();
  const providerConfig: CapabilityClaudeProviderConfig | undefined = ctx.config.providers.claude;

  if (!providerConfig) {
    for (const id of resolveFailureIds(ctx.items.map(i => i.id), 'claude:plugin')) {
      result.failed.push({ id, reason: 'missing-provider-config' });
    }
    return result;
  }

  const claudePath = deps.resolveClaudePath();
  if (!claudePath) {
    for (const id of resolveFailureIds(ctx.items.map(i => i.id), 'claude:plugin')) {
      result.failed.push({ id, reason: 'claude-not-found' });
    }
    return result;
  }

  const cwd = deps.machineCwd();

  const versionResult = await deps.runClaude(claudePath, ['--version'], cwd);
  result.runtimeVersion = versionResult.ok ? versionResult.stdout.trim() : null;

  const { marketplaceName, marketplaceSource } = providerConfig;
  const marketplaceState = await ensureMarketplaceRegistered(deps, claudePath, cwd, marketplaceName, marketplaceSource);
  if (marketplaceState !== 'ok') {
    const reason = marketplaceState === 'name-mismatch' ? 'marketplace-name-mismatch' : 'marketplace-not-registered';
    for (const id of resolveFailureIds(ctx.items.map(i => i.id), `marketplace:${marketplaceName}`)) {
      result.failed.push({ id, reason });
    }
    return result;
  }

  // オフライン等の失敗は続行する（§8.1-4）
  const updateResult = await deps.runClaude(claudePath, ['plugin', 'marketplace', 'update', marketplaceName], cwd);
  if (!updateResult.ok) result.failed.push({ id: `marketplace:${marketplaceName}`, reason: 'marketplace-update-failed' });

  // サイクルP1.2: items 0 件なら install/update 差分計算は必ず空になるため打ち切る
  if (ctx.items.length === 0) return result;

  const [userEnabled, blocklistRaw] = await Promise.all([
    readEnabledPlugins(deps, userSettingsPath()),
    deps.readJson(blocklistPath()),
  ]);
  const blocklist: BlocklistEntry[] = Array.isArray(blocklistRaw) ? (blocklistRaw as BlocklistEntry[]) : [];

  // §8.1-6: project/local にしか無いものを present と誤認しないため、user scope だけで判定する
  const maps: ScopeEnabledMaps = { user: userEnabled, project: {}, local: {} };
  const desiredIds = ctx.items.map(item => `${item.id}@${marketplaceName}`);
  const diff = computeInstallDiff(desiredIds, maps);
  const idToItem = new Map(ctx.items.map(item => [`${item.id}@${marketplaceName}`, item]));

  // まだ user scope に存在しない（未 install または disabled で scope 不明扱いのもの含む）→ install
  for (const fullId of [...diff.toInstall, ...diff.disabledNeedsEnable]) {
    const item = idToItem.get(fullId);
    const blocked = findBlockedEntry(blocklist, fullId) ?? (item ? findBlockedEntry(blocklist, item.id) : null);
    if (blocked) {
      result.failed.push({ id: fullId, reason: blocked.reason ?? 'blocked' });
      continue;
    }
    const installResult = await deps.runClaude(claudePath, ['plugin', 'install', fullId, '--scope', 'user'], cwd);
    if (installResult.ok) result.installed.push(fullId);
    else result.failed.push({ id: fullId, reason: installResult.error ?? 'install-failed' });
  }

  // 既に user scope に存在するもの → update を試み、版が変わったかで updated/present を分ける
  if (diff.alreadyEnabled.length > 0) {
    const beforeList = await fetchPluginList(deps, claudePath, cwd);
    const beforeVersions = new Map(beforeList.map(e => [e.id, e.version ?? null]));

    for (const fullId of diff.alreadyEnabled) {
      const blocked = findBlockedEntry(blocklist, fullId);
      if (blocked) {
        result.failed.push({ id: fullId, reason: blocked.reason ?? 'blocked' });
        continue;
      }
      const updateOutcome = await deps.runClaude(claudePath, ['plugin', 'update', fullId], cwd);
      if (!updateOutcome.ok) {
        result.failed.push({ id: fullId, reason: updateOutcome.error ?? 'update-failed' });
        continue;
      }
      // 直後に list を取り直して version 変化を確認する（§8.1-8: sha だけでは更新されないことがある）
      const afterList = await fetchPluginList(deps, claudePath, cwd);
      const afterEntry = afterList.find(e => e.id === fullId);
      const beforeVersion = beforeVersions.get(fullId) ?? null;
      if (afterEntry && afterEntry.version && afterEntry.version !== beforeVersion) {
        result.updated.push(fullId);
      } else {
        result.present.push(fullId);
      }
    }
  }

  return result;
}

// -----------------------------------------------------------------------------
// project/prelaunch scope の reconcile（trigger prelaunch）
// -----------------------------------------------------------------------------

/**
 * project/prelaunch scope の reconcile。§8.2 のとおり、desired ID は
 * **project/local の `.claude/settings*.json` 自身の `enabledPlugins`** から読む
 * （machine 側の `capabilityConfig.items` ではない）。設定済み marketplace と異なる
 * marketplace 修飾子を持つ ID は `notAllowed`（install しない）。
 *
 * サイクルP1.3 での変更点（実機 hp630g9/fwjg2, claude 2.1.266 のバグを根治）:
 * - 要件1: 全 CLI 呼び出しに `cwd = projectPath` を渡す（Agent 自身の cwd に install される事故を根治）。
 * - 要件2: install scope を宣言元（`.claude/settings.json`=project / `settings.local.json`=local）に
 *   一致させる（両方に宣言されていれば project を優先し 1 回だけ install）。
 * - 要件3: present 判定は「宣言 scope で実際に installed かつ enabled」まで確認し、
 *   install 成功後は直後の list を取り直して再検証してから `installed` に数える。
 * - 要件4: 未知 id エラー（marketplace 索引ミス）は `marketplace update` を 1 回だけ実行して
 *   install を 1 回だけ再試行する（この呼び出し内のローカル変数で制御。モジュールフラグにしない）。
 * - 要件5: `marketplace list --json` で未登録と判明したら `marketplace add` はせず、
 *   `ctx.requestMachineReconcile?.()` を 1 回だけ呼んで machine キューへ委譲し、即 return する。
 */
export async function reconcileProjectWithDeps(
  ctx: CapabilityCtx,
  projectPath: string,
  deps: ClaudePluginDeps,
): Promise<CapabilityResult> {
  const result = emptyResult();
  const providerConfig: CapabilityClaudeProviderConfig | undefined = ctx.config.providers.claude;
  if (!providerConfig) return result;

  const [projectEnabled, localEnabled] = await Promise.all([
    readEnabledPlugins(deps, projectSettingsPath(projectPath)),
    readEnabledPlugins(deps, localSettingsPath(projectPath)),
  ]);

  const candidates = new Set<string>();
  for (const [id, enabled] of Object.entries(projectEnabled)) if (enabled) candidates.add(id);
  for (const [id, enabled] of Object.entries(localEnabled)) if (enabled) candidates.add(id);

  // 差分が無ければ CLI を一切呼ばない（§8.2 末尾）
  if (candidates.size === 0) return result;

  const marketplaceSuffix = `@${providerConfig.marketplaceName}`;
  const allowedCandidates: string[] = [];
  for (const id of candidates) {
    if (id.endsWith(marketplaceSuffix)) allowedCandidates.push(id);
    else result.notAllowed.push(id);
  }
  if (allowedCandidates.length === 0) return result;

  const claudePath = deps.resolveClaudePath();
  if (!claudePath) {
    for (const id of allowedCandidates) result.failed.push({ id, reason: 'claude-not-found' });
    return result;
  }

  // 要件5: marketplace 登録確認（`marketplace add` はしない。未登録なら machine へ委譲して即 return）
  const marketplaceListResult = await deps.runClaude(claudePath, ['plugin', 'marketplace', 'list', '--json'], projectPath);
  const marketplaceEntries = marketplaceListResult.ok ? parseMarketplaceListJson(marketplaceListResult.stdout) : null;
  const marketplaceVerdict = evaluateMarketplaceList(marketplaceEntries, providerConfig.marketplaceName, providerConfig.marketplaceSource);
  if (marketplaceVerdict === 'not-registered') {
    ctx.requestMachineReconcile?.();
    result.failed.push({ id: `marketplace:${providerConfig.marketplaceName}`, reason: 'marketplace-not-registered' });
    return result;
  }
  // 'unknown'（パース不能/CLI失敗）・'registered'・'name-mismatch' は fail-open で続行する
  // （prelaunch は起動をブロックしない設計を優先し、name-mismatch の是正は machine 側に委ねる）。

  const blocklistRaw = await deps.readJson(blocklistPath());
  const blocklist: BlocklistEntry[] = Array.isArray(blocklistRaw) ? (blocklistRaw as BlocklistEntry[]) : [];

  // 要件2: 宣言元 scope を解決する（project にあれば local にもあっても project を優先、1 回だけ install）
  const scopedCandidates: Array<{ id: string; scope: 'project' | 'local' }> = [];
  for (const id of allowedCandidates) {
    const scope = resolveInstallScope(id, projectEnabled, localEnabled);
    if (scope) scopedCandidates.push({ id, scope });
  }

  let currentList = await fetchPluginList(deps, claudePath, projectPath);
  // 要件4: 索引ミスによる marketplace update は「この reconcileProjectWithDeps 呼び出し内で 1 回だけ」
  // （ローカル変数。モジュールフラグにはしない＝呼び出しごとに独立）
  let indexRefreshed = false;

  for (const { id, scope } of scopedCandidates) {
    if (isSatisfiedWithWarnLog(currentList, id, scope, projectPath)) {
      result.present.push(id);
      continue;
    }

    const blocked = findBlockedEntry(blocklist, id);
    if (blocked) {
      result.failed.push({ id, reason: blocked.reason ?? 'blocked' });
      continue;
    }

    let installOutcome: ClaudeCliResult = await deps.runClaude(claudePath, ['plugin', 'install', id, '--scope', scope], projectPath);

    if (
      !installOutcome.ok &&
      !indexRefreshed &&
      isPluginNotInIndexError({
        message: installOutcome.error,
        stdout: installOutcome.stdout,
        stderr: installOutcome.stderr,
        code: installOutcome.code,
        killed: installOutcome.killed,
      })
    ) {
      indexRefreshed = true;
      await deps.runClaude(claudePath, ['plugin', 'marketplace', 'update', providerConfig.marketplaceName], projectPath);
      installOutcome = await deps.runClaude(claudePath, ['plugin', 'install', id, '--scope', scope], projectPath);
    }

    if (!installOutcome.ok) {
      result.failed.push({ id, reason: installOutcome.error ?? 'install-failed' });
      continue;
    }

    // 要件3: install 成功後に list を取り直して再検証し、satisfied になって初めて installed とする
    currentList = await fetchPluginList(deps, claudePath, projectPath);
    if (isSatisfiedWithWarnLog(currentList, id, scope, projectPath)) {
      result.installed.push(id);
    } else {
      result.failed.push({ id, reason: 'install-verify-failed' });
    }
  }

  return result;
}

/** Claude Code plugin adapter 本体（`capability-sync.ts` の `registerCapabilityAdapter()` に登録する） */
export const claudePluginAdapter: CapabilityAdapter = {
  provider: 'claude',
  kind: 'plugin',
  reconcileMachine: (ctx) => reconcileMachineWithDeps(ctx, defaultDeps),
  reconcileProject: (ctx, projectPath) => reconcileProjectWithDeps(ctx, projectPath, defaultDeps),
};
