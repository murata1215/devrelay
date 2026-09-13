/**
 * サイクルP1: Claude Code plugin capability の I/O 層（provider=claude, kind=plugin の唯一の実装）。
 *
 * `claude plugin ...` の CLI 実行・marketplace 操作・`.claude/settings*.json` の読み取りを
 * **すべてここに閉じ込める**（共通層 `capability-sync.ts` は本ファイルの存在を知らず、
 * `CapabilityAdapter` インタフェース越しにしか呼ばない）。判断ロジックは全て
 * `claude-plugin-rules.ts`（外部 import ゼロの純関数）に委譲し、ここでは
 * ファイル読み取り・CLI 実行という I/O だけを行う。
 *
 * `claude` 実行ファイルの解決は ai-runner.ts と同じ `resolveSystemClaude()` を使う
 * （`claude-auth.ts` に同じ先例あり）。実行は `execFile` でコマンドと引数を分離し、
 * シェル文字列連結は行わない（Web 経由の plugin id / marketplaceSource を安全に扱うため）。
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFile } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import type { CapabilityResult, CapabilityClaudeProviderConfig } from '@devrelay/shared';
import { resolveSystemClaude } from '../ai-runner.js';
import type { CapabilityAdapter, CapabilityCtx } from '../capability-sync.js';
import {
  parsePluginList,
  extractEnabledPlugins,
  checkMarketplaceRegistration,
  findBlockedEntry,
  computeInstallDiff,
  resolveFailureIds,
  type ParsedPluginEntry,
  type KnownMarketplaceEntry,
  type BlocklistEntry,
  type ScopeEnabledMaps,
} from './claude-plugin-rules.js';

const execFileAsync = promisify(execFile);

/** CLI 呼び出し 1 回あたりの個別タイムアウト（共通層の 3 分枠の内側で使う軽量な安全弁） */
const CLI_TIMEOUT_MS = 60 * 1000;

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

/** `enabledPlugins` を持つ settings ファイルを読んで `Record<string, boolean>` に変換する */
async function readEnabledPlugins(filePath: string): Promise<Record<string, boolean>> {
  const data = await readJsonSafe(filePath);
  return extractEnabledPlugins(data);
}

function emptyResult(): CapabilityResult {
  return { provider: 'claude', kind: 'plugin', runtimeVersion: null, installed: [], updated: [], present: [], failed: [], notAllowed: [] };
}

/** 個別 CLI 呼び出しの成否だけを見る薄いラッパー（stdout は呼び出し元で使う） */
async function runClaude(claudePath: string, args: string[]): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  try {
    const { stdout } = await execFileAsync(claudePath, args, { timeout: CLI_TIMEOUT_MS, windowsHide: true });
    return { ok: true, stdout };
  } catch (err) {
    return { ok: false, error: (err as Error)?.message || 'error' };
  }
}

/** `claude plugin list` を JSON 優先・失敗時テキストへフォールバックして取得する */
async function fetchPluginList(claudePath: string): Promise<ParsedPluginEntry[]> {
  const jsonAttempt = await runClaude(claudePath, ['plugin', 'list', '--json']);
  if (jsonAttempt.ok) return parsePluginList(jsonAttempt.stdout, true);
  const textAttempt = await runClaude(claudePath, ['plugin', 'list']);
  if (textAttempt.ok) return parsePluginList(textAttempt.stdout, false);
  return [];
}

/** marketplace 登録済みかを確認し、未登録なら add する。結果は 'ok' | 'name-mismatch' | 'add-failed' */
async function ensureMarketplaceRegistered(
  claudePath: string,
  marketplaceName: string,
  marketplaceSource: string,
): Promise<'ok' | 'name-mismatch' | 'add-failed'> {
  const known = ((await readJsonSafe(knownMarketplacesPath())) ?? {}) as Record<string, KnownMarketplaceEntry>;
  const initial = checkMarketplaceRegistration(known, marketplaceName, marketplaceSource);
  if (initial === 'ok') return 'ok';
  if (initial === 'name-mismatch') return 'name-mismatch';

  // not-registered → add を試みる
  const addResult = await runClaude(claudePath, ['plugin', 'marketplace', 'add', marketplaceSource]);
  if (!addResult.ok) return 'add-failed';

  const reread = ((await readJsonSafe(knownMarketplacesPath())) ?? {}) as Record<string, KnownMarketplaceEntry>;
  const after = checkMarketplaceRegistration(reread, marketplaceName, marketplaceSource);
  return after === 'ok' ? 'ok' : 'name-mismatch';
}

/**
 * machine/user scope の reconcile（trigger connect/config/idle/manual）。
 * §8.1 の手順どおり: 存在確認 → runtimeVersion → marketplace 登録確認/追加 → marketplace update
 * → user scope での install/update 差分計算 → 1 件ずつ実行（失敗しても次へ進む）。
 *
 * サイクルP1.2: `ctx.items` が空（`providers.claude` は設定済みだが Plugin 未指定）でも
 * ここまで（存在確認〜marketplace update）は必ず実行する（`capability-sync.ts` の
 * `resolveReconcileTargets()` が items 0 件でも provider 設定があればこの adapter を呼ぶため）。
 * 失敗時は `resolveFailureIds()` で fallback id を積み、無言の `done` にしない。
 */
async function reconcileMachine(ctx: CapabilityCtx): Promise<CapabilityResult> {
  const result = emptyResult();
  const providerConfig: CapabilityClaudeProviderConfig | undefined = ctx.config.providers.claude;

  if (!providerConfig) {
    // サイクルP1.2: items 0 件でも無言 done にしないよう fallback id（`claude:plugin`）で報告する
    for (const id of resolveFailureIds(ctx.items.map(i => i.id), 'claude:plugin')) {
      result.failed.push({ id, reason: 'missing-provider-config' });
    }
    return result;
  }

  const claudePath = resolveSystemClaude();
  if (!claudePath) {
    for (const id of resolveFailureIds(ctx.items.map(i => i.id), 'claude:plugin')) {
      result.failed.push({ id, reason: 'claude-not-found' });
    }
    return result;
  }

  const versionResult = await runClaude(claudePath, ['--version']);
  result.runtimeVersion = versionResult.ok ? versionResult.stdout.trim() : null;

  const { marketplaceName, marketplaceSource } = providerConfig;
  const marketplaceState = await ensureMarketplaceRegistered(claudePath, marketplaceName, marketplaceSource);
  if (marketplaceState !== 'ok') {
    // marketplace 自体が使えないと個々の plugin 判定が無意味なので打ち切る（§8.1-3）
    const reason = marketplaceState === 'name-mismatch' ? 'marketplace-name-mismatch' : 'marketplace-not-registered';
    for (const id of resolveFailureIds(ctx.items.map(i => i.id), `marketplace:${marketplaceName}`)) {
      result.failed.push({ id, reason });
    }
    return result;
  }

  // オフライン等の失敗は続行する（§8.1-4）
  const updateResult = await runClaude(claudePath, ['plugin', 'marketplace', 'update', marketplaceName]);
  if (!updateResult.ok) result.failed.push({ id: `marketplace:${marketplaceName}`, reason: 'marketplace-update-failed' });

  // サイクルP1.2: items 0 件なら install/update 差分計算は必ず空になるため、
  // ここで打ち切って settings/blocklist の読み取りを省く（marketplace 登録/update までは完了済み）。
  if (ctx.items.length === 0) return result;

  const [userEnabled, blocklistRaw] = await Promise.all([
    readEnabledPlugins(userSettingsPath()),
    readJsonSafe(blocklistPath()),
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
    const installResult = await runClaude(claudePath, ['plugin', 'install', fullId, '--scope', 'user']);
    if (installResult.ok) result.installed.push(fullId);
    else result.failed.push({ id: fullId, reason: installResult.error });
  }

  // 既に user scope に存在するもの → update を試み、版が変わったかで updated/present を分ける
  if (diff.alreadyEnabled.length > 0) {
    const beforeList = await fetchPluginList(claudePath);
    const beforeVersions = new Map(beforeList.map(e => [e.name, e.version ?? null]));

    for (const fullId of diff.alreadyEnabled) {
      const blocked = findBlockedEntry(blocklist, fullId);
      if (blocked) {
        result.failed.push({ id: fullId, reason: blocked.reason ?? 'blocked' });
        continue;
      }
      const updateOutcome = await runClaude(claudePath, ['plugin', 'update', fullId]);
      if (!updateOutcome.ok) {
        result.failed.push({ id: fullId, reason: updateOutcome.error });
        continue;
      }
      // 直後に list を取り直して version 変化を確認する（§8.1-8: sha だけでは更新されないことがある）
      const afterList = await fetchPluginList(claudePath);
      const afterEntry = afterList.find(e => e.name === fullId);
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

/**
 * project/prelaunch scope の reconcile（trigger prelaunch）。
 * §8.2 のとおり、desired ID は **project/local の `.claude/settings*.json` 自身の `enabledPlugins`**
 * から読む（machine 側の `capabilityConfig.items` ではない）。設定済み marketplace と異なる
 * marketplace 修飾子を持つ ID は `notAllowed`（install しない）。
 */
async function reconcileProject(ctx: CapabilityCtx, projectPath: string): Promise<CapabilityResult> {
  const result = emptyResult();
  const providerConfig: CapabilityClaudeProviderConfig | undefined = ctx.config.providers.claude;
  if (!providerConfig) return result;

  const [projectEnabled, localEnabled] = await Promise.all([
    readEnabledPlugins(projectSettingsPath(projectPath)),
    readEnabledPlugins(localSettingsPath(projectPath)),
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

  const claudePath = resolveSystemClaude();
  if (!claudePath) {
    for (const id of allowedCandidates) result.failed.push({ id, reason: 'claude-not-found' });
    return result;
  }

  const [userEnabled, blocklistRaw] = await Promise.all([
    readEnabledPlugins(userSettingsPath()),
    readJsonSafe(blocklistPath()),
  ]);
  const blocklist: BlocklistEntry[] = Array.isArray(blocklistRaw) ? (blocklistRaw as BlocklistEntry[]) : [];

  // user scope で既に有効なものは local へ重複 install しない（§8.2）
  const notYetPresentAtUser = allowedCandidates.filter(id => !userEnabled[id]);
  for (const id of allowedCandidates.filter(id => userEnabled[id])) result.present.push(id);
  if (notYetPresentAtUser.length === 0) return result;

  // 実際にインストール済みかどうかは list（プロセス内の直近取得。長期キャッシュは持たない）で確認する。
  // これにより「settings.json は true と宣言しているが実体は uninstall 済み」（test010）を検出する。
  const installedList = await fetchPluginList(claudePath);
  const installedNames = new Set(installedList.map(e => e.name));

  for (const id of notYetPresentAtUser) {
    if (installedNames.has(id)) {
      result.present.push(id);
      continue;
    }
    const blocked = findBlockedEntry(blocklist, id);
    if (blocked) {
      result.failed.push({ id, reason: blocked.reason ?? 'blocked' });
      continue;
    }
    const installResult = await runClaude(claudePath, ['plugin', 'install', id, '--scope', 'local']);
    if (installResult.ok) result.installed.push(id);
    else result.failed.push({ id, reason: installResult.error });
  }

  return result;
}

/** Claude Code plugin adapter 本体（`capability-sync.ts` の `registerCapabilityAdapter()` に登録する） */
export const claudePluginAdapter: CapabilityAdapter = {
  provider: 'claude',
  kind: 'plugin',
  reconcileMachine,
  reconcileProject,
};
