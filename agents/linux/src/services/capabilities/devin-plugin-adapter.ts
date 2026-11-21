/**
 * サイクル P4-A: Devin CLI plugin capability（`devin:plugin`）の I/O 層。
 *
 * 2026-09-15（サイクル P3-A/P3-B）時点では Devin CLI に plugin 概念が無く、Claude plugin の
 * `skills/<name>/` だけを `~/.agents/skills/` に抜き出す回避策（`agent-skills:standard`）しか
 * 無かった。2026-10 時点の Devin CLI 公式ドキュメント（docs.devin.ai）で `devin plugins
 * install/list/info/update/remove/prune` の実在と、manifest 優先順
 * `.devin-plugin/plugin.json` > `.claude-plugin/plugin.json` > `plugin.json`（＝ Claude plugin が
 * 変換なしにそのまま読める）ことを確認し、実機（devin 3000.6.14、2026-10-31、DESKTOP-5U400FO/lfuser
 * `TEST` プロジェクト経由の MCP `ask_project`）で `-y, --yes` / `--local` フラグと
 * `owner/repo#path/to/plugin` の install ソース構文を確認した上で新設した adapter。
 *
 * **設計の核心（パーサ非依存）**: `devin plugins list` の標準出力には chisel のログ行が混ざることを
 * 実機確認済みで、将来のバージョンでも機械可読性は保証されない。そのため本 adapter は list 出力を
 * **一切パースしない**。冪等性は DevRelay 独自のサイドカー state（`devin-plugins.json`。Devin の
 * install 先ディレクトリには置かない＝所有権侵害を避け `devin plugins prune` にも消されない）と
 * `devin plugins info <id>` の **exit code のみ**で判定する。壊れるとしたら exit code 規約が
 * 変わったときだけ。
 *
 * 索引解決: `agent-skills:standard` が既に維持している marketplace clone
 * （`<configDir>/capabilities/marketplaces/<name>`）を**索引としてだけ**読み、
 * `plugins[].source`（例 `./plugins/context7`）を `owner/repo#plugins/context7` に翻訳して
 * `devin plugins install` に渡す。配布物のコピーはしない（Devin が自前で fetch する）。
 * clone/fetch/manifest 解析が失敗した場合は、既存 CRITICAL RULE（P3-A 承認ノート#8）を複製し、
 * 撤去を一切行わず state を last-known-good のまま保持する。
 *
 * `agent-skills:standard` との関係: **廃止せず併存**する。`~/.agents/skills` は Codex も読む
 * 共有ディレクトリであり Devin 都合で消せない。二重露出が有害と判明した場合のみ
 * `DEVRELAY_DEVIN_PLUGIN_EXCLUSIVE`（本サイクル未実装、Phase 3 扱い）で切り替える想定。
 *
 * 判断ロジックは全て `devin-plugin-rules.ts`（外部 import ゼロの純関数）に委譲し、
 * ここではファイル I/O・CLI 実行・オーケストレーションだけを行う（`claude-plugin-adapter.ts` /
 * `agent-skills-adapter.ts` と同じ deps 注入形）。
 */
import { existsSync } from 'fs';
import { join } from 'path';
import * as os from 'os';
import type { CapabilityResult, CapabilityClaudeProviderConfig } from '@devrelay/shared';
import { resolveSystemDevin, resolveDevinRuntimeVersion } from '../devin-path.js';
import type { CapabilityAdapter, CapabilityCtx } from '../capability-sync.js';
import { getConfigDir } from '../config.js';
import { execFileGitRunner, resolveSystemGit, type GitCliRunner } from './git-cli.js';
import { execFileDevinRunner, type DevinCliRunner } from './devin-cli.js';
import { ensureMarketplaceClone } from './marketplace-clone.js';
import { readJsonSafe, ensureDir, removeManagedDir, listDirNames } from './skill-tree-io.js';
import { resolveGitCloneUrl, resolvePluginSourceRelPath, sanitizeMarketplaceDirName, parseMarketplaceManifest } from './agent-skills-rules.js';
import { writeFileAtomic } from '../atomic-write.js';
import {
  isDevinPluginEnabled,
  resolveDevinPluginStatePath,
  buildDevinInstallSource,
  buildDevinPluginState,
  isOwnedDevinPluginState,
  decideDevinPluginAction,
  decideDevinPluginRemovals,
  buildDevinPluginDiagnostics,
  hasBudgetLeft,
  resolveFailureIds,
  type DevinPluginState,
  type DevinPluginEntry,
  type ResolveDevinPluginStatePathResult,
} from './devin-plugin-rules.js';

// -----------------------------------------------------------------------------
// deps 注入（テストで CLI/git 呼び出しを spawn ゼロで検証できるようにする）
// -----------------------------------------------------------------------------

/** `devin-plugin-adapter.ts` が使う外部依存の束（テストでは全て fake に差し替える） */
export interface DevinPluginDeps {
  /** キルスイッチ `DEVRELAY_DEVIN_PLUGIN`（既定 enabled） */
  isEnabled: () => boolean;
  /** 既定: `devin-path.js` の `resolveSystemDevin` */
  resolveDevinPath: () => string | null;
  /** 既定: `devin-cli.js` の `execFileDevinRunner`（cwd 必須） */
  runDevin: DevinCliRunner;
  /** 既定: `devin-path.js` の `resolveDevinRuntimeVersion`（モジュール内 6 時間キャッシュ付き。診断専用） */
  resolveRuntimeVersion: (devinPath: string) => Promise<string | null>;
  /** 既定: `git-cli.js` の `resolveSystemGit`（marketplace 索引の clone 用） */
  resolveGitPath: () => string | null;
  /** 既定: `git-cli.js` の `execFileGitRunner`（cwd 必須） */
  runGit: GitCliRunner;
  /** JSON ファイルを読んでパースする。存在しない/壊れている場合は null（throw しない） */
  readJson: (filePath: string) => Promise<unknown>;
  /** state ファイルをアトミックに書き込む（既定: `atomic-write.js` の `writeFileAtomic`） */
  writeState: (filePath: string, state: DevinPluginState) => Promise<void>;
  /** machine scope reconcile の cwd。既定は `getConfigDir()`（他 adapter と同じ流儀） */
  machineCwd: () => string;
  /** marketplace clone の残骸掃除（symlink は unlink のみ） */
  removeManagedDir: (targetDir: string) => Promise<void>;
  /** ディレクトリ直下のディレクトリ名一覧（clone 存在確認用） */
  listDirNames: (dir: string) => Promise<string[]>;
  /** `mkdir -p` 相当 */
  ensureDir: (dir: string) => Promise<void>;
  /** state ファイルパスを解決する（純関数のラッパー） */
  resolveStatePath: () => ResolveDevinPluginStatePathResult;
  /** marker の `installedAt` に使う ISO 時刻 */
  nowIso: () => string;
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

function defaultIsEnabled(): boolean {
  return isDevinPluginEnabled(process.env);
}

function defaultResolveStatePath(): ResolveDevinPluginStatePathResult {
  return resolveDevinPluginStatePath({ platform: process.platform, env: process.env, configDir: defaultMachineCwd() });
}

/** 本番用の既定 deps */
export const defaultDeps: DevinPluginDeps = {
  isEnabled: defaultIsEnabled,
  resolveDevinPath: resolveSystemDevin,
  runDevin: execFileDevinRunner,
  resolveRuntimeVersion: resolveDevinRuntimeVersion,
  resolveGitPath: resolveSystemGit,
  runGit: execFileGitRunner,
  readJson: readJsonSafe,
  writeState: async (filePath, state) => {
    await writeFileAtomic(filePath, JSON.stringify(state, null, 2));
  },
  machineCwd: defaultMachineCwd,
  removeManagedDir,
  listDirNames,
  ensureDir,
  resolveStatePath: defaultResolveStatePath,
  nowIso: () => new Date().toISOString(),
};

function emptyResult(): CapabilityResult {
  return { provider: 'devin', kind: 'plugin', runtimeVersion: null, installed: [], updated: [], present: [], failed: [], notAllowed: [] };
}

/** state の読み込み（壊れている/無ければ空 state） */
async function loadState(deps: DevinPluginDeps, statePath: string): Promise<DevinPluginState> {
  const raw = await deps.readJson(statePath);
  return isOwnedDevinPluginState(raw) ? raw : buildDevinPluginState([]);
}

// -----------------------------------------------------------------------------
// cleanup-only 経路（ctx.items が空。provider OFF や capabilityConfig 全体 null による撤去）
// -----------------------------------------------------------------------------

async function runCleanupOnly(
  deps: DevinPluginDeps,
  devinPath: string,
  cwd: string,
  statePath: string,
  state: DevinPluginState,
  result: CapabilityResult,
): Promise<void> {
  const removedIds: string[] = [];
  const remainingEntries: DevinPluginEntry[] = [];
  for (const entry of state.entries) {
    const removeResult = await deps.runDevin(devinPath, ['plugins', 'remove', entry.pluginId, '--yes'], cwd);
    if (removeResult.ok) {
      removedIds.push(entry.pluginId);
    } else {
      result.failed.push({ id: entry.pluginId, reason: removeResult.error ?? 'remove-failed' });
      remainingEntries.push(entry); // 失敗分は state に残す（次回リトライ）
    }
  }
  if (removedIds.length > 0) result.removed = removedIds;
  await deps.writeState(statePath, buildDevinPluginState(remainingEntries));
}

// -----------------------------------------------------------------------------
// machine scope の reconcile
// -----------------------------------------------------------------------------

/** 1 件の desired item（manifest 解決済み・install ソース確定済み） */
interface ValidatedItem {
  id: string;
  source: string;
}

export async function reconcileMachineWithDeps(ctx: CapabilityCtx, deps: DevinPluginDeps): Promise<CapabilityResult> {
  const result = emptyResult();

  if (!deps.isEnabled()) return result;

  const statePathResult = deps.resolveStatePath();
  if (!statePathResult.ok) {
    for (const id of resolveFailureIds(ctx.items.map((i) => i.id), 'devin:plugin')) {
      result.failed.push({ id, reason: `state-path-${statePathResult.reason}` });
    }
    return result;
  }
  const statePath = statePathResult.path;

  const devinPath = deps.resolveDevinPath();
  if (!devinPath) {
    // Devin 未検出 → fail-safe（claude/codex 専用機で毎回エラー表示にならないようにする。承認ノート
    // P3-B §5-6 の「ランタイム検出は配布判断から切り離す」思想を踏襲）。failed は積まない。
    result.runtimeVersion = 'Devin 未検出';
    return result;
  }

  const cwd = deps.machineCwd();
  const version = await deps.resolveRuntimeVersion(devinPath);

  // 自己 probe: plugins サブコマンドの有無（probeDevinCapabilities() と同じ「実行して確かめる」方針）
  const pluginsHelpResult = await deps.runDevin(devinPath, ['plugins', '--help'], cwd);
  const pluginsSupported = pluginsHelpResult.ok;
  result.runtimeVersion = buildDevinPluginDiagnostics({ devinDetected: true, version, pluginsSupported });

  const state = await loadState(deps, statePath);

  if (!pluginsSupported) {
    // この devin 版には plugins サブコマンドが無い。items 0 件（cleanup-only）なら何もできずそのまま終了。
    if (ctx.items.length === 0) return result;
    for (const id of resolveFailureIds(ctx.items.map((i) => i.id), 'devin:plugin')) {
      result.failed.push({ id, reason: 'plugins-subcommand-unsupported' });
    }
    return result;
  }

  if (ctx.items.length === 0) {
    await runCleanupOnly(deps, devinPath, cwd, statePath, state, result);
    return result;
  }

  const providerConfig: CapabilityClaudeProviderConfig | undefined = ctx.config.providers.claude;
  if (!providerConfig) {
    for (const id of resolveFailureIds(ctx.items.map((i) => i.id), 'devin:plugin')) {
      result.failed.push({ id, reason: 'missing-marketplace-config' });
    }
    return result;
  }

  const gitPath = deps.resolveGitPath();
  if (!gitPath) {
    for (const id of resolveFailureIds(ctx.items.map((i) => i.id), 'devin:plugin')) {
      result.failed.push({ id, reason: 'git-not-found' });
    }
    return result;
  }

  const urlResult = resolveGitCloneUrl(providerConfig.marketplaceSource);
  if (!urlResult.ok) {
    for (const id of resolveFailureIds(ctx.items.map((i) => i.id), 'devin:plugin')) {
      result.failed.push({ id, reason: 'unsupported-source-format' });
    }
    return result;
  }

  const cloneParentDir = join(deps.machineCwd(), 'capabilities', 'marketplaces');
  await deps.ensureDir(cloneParentDir);

  const cloneOutcome = await ensureMarketplaceClone(
    deps,
    cloneParentDir,
    sanitizeMarketplaceDirName(providerConfig.marketplaceName),
    gitPath,
    urlResult.url,
  );
  if (!cloneOutcome.ok) {
    // CRITICAL RULE（P3-A 承認ノート#8 を複製）: 索引取得失敗時は desired state を確定できないため
    // 撤去を一切行わない。既存 state は last-known-good のまま触らず return する。
    for (const id of resolveFailureIds(ctx.items.map((i) => i.id), 'devin:plugin')) {
      result.failed.push({ id, reason: 'clone-failed' });
    }
    return result;
  }
  const { cloneDir, commit: indexCommit } = cloneOutcome;

  const manifest = parseMarketplaceManifest(await deps.readJson(join(cloneDir, '.claude-plugin', 'marketplace.json')));
  if (!manifest) {
    for (const id of resolveFailureIds(ctx.items.map((i) => i.id), 'devin:plugin')) {
      result.failed.push({ id, reason: 'manifest-invalid' });
    }
    return result;
  }

  // ---- Pass 1: 各 item を manifest と照合し、install ソースを確定する（CLI は呼ばない） ----
  const validatedItems: ValidatedItem[] = [];
  for (const item of ctx.items) {
    const manifestEntry = manifest.plugins.find((p) => p.name === item.id) ?? null;
    if (!manifestEntry) {
      result.notAllowed.push(item.id);
      continue;
    }
    const sourceRel = resolvePluginSourceRelPath(manifestEntry.source);
    if (!sourceRel.ok) {
      result.failed.push({ id: item.id, reason: 'unsafe-plugin-source' });
      continue;
    }
    const sourceResult = buildDevinInstallSource(providerConfig.marketplaceSource, sourceRel.relPath);
    if (!sourceResult.ok) {
      result.failed.push({ id: item.id, reason: sourceResult.reason });
      continue;
    }
    validatedItems.push({ id: item.id, source: sourceResult.source });
  }

  // desiredIds は Pass 1 を通過した item のみ（budget 切れで未処理でも「desired から外れた」扱いに
  // しない＝除去計算を誤らせないための集合。budget 切れの item は state を last-known-good のまま
  // updatedEntries に積む形で保持する）。
  const desiredIds = validatedItems.map((v) => v.id);
  const stateByPluginId = new Map(state.entries.map((e) => [e.pluginId, e]));
  const updatedEntries: DevinPluginEntry[] = [];

  // ---- Pass 2: 1 item ずつ処理する（予算切れで自発的に打ち切る） ----
  const startedAtMs = Date.now();
  for (let i = 0; i < validatedItems.length; i++) {
    if (!hasBudgetLeft(startedAtMs, Date.now(), 10_000)) {
      for (let j = i; j < validatedItems.length; j++) {
        const id = validatedItems[j].id;
        result.failed.push({ id, reason: 'budget-exhausted' });
        const stale = stateByPluginId.get(id);
        if (stale) updatedEntries.push(stale); // last-known-good を保持
      }
      break;
    }

    const { id, source } = validatedItems[i];
    const existingEntry = stateByPluginId.get(id) ?? null;

    // info で実在確認（conflict-unmanaged 判定 + self-heal 判定の両方に使う。list はパースしない）
    const infoResult = await deps.runDevin(devinPath, ['plugins', 'info', id], cwd);
    const action = decideDevinPluginAction({
      hasStateEntry: existingEntry !== null,
      infoOk: infoResult.ok,
      stateIndexCommit: existingEntry?.indexCommit ?? null,
      currentIndexCommit: indexCommit,
    });

    if (action === 'conflict-unmanaged') {
      // 人間が手で入れた plugin とみなし上書きも削除もしない（agent-skills 承認ノート#9 と同じ思想）
      result.failed.push({ id, reason: 'unmanaged-conflict' });
      continue;
    }
    if (action === 'present') {
      result.present.push(id);
      if (existingEntry) updatedEntries.push(existingEntry);
      continue;
    }

    if (action === 'install') {
      const installResult = await deps.runDevin(devinPath, ['plugins', 'install', source, '--yes'], cwd);
      if (!installResult.ok) {
        result.failed.push({ id, reason: installResult.error ?? 'install-failed' });
        if (existingEntry) updatedEntries.push(existingEntry); // 失敗時は既存 state を保持（last-known-good）
        continue;
      }
      const verify = await deps.runDevin(devinPath, ['plugins', 'info', id], cwd);
      if (!verify.ok) {
        result.failed.push({ id, reason: 'install-verify-failed' });
        continue;
      }
      result.installed.push(id);
      updatedEntries.push({ pluginId: id, installSource: source, indexCommit, installedAt: deps.nowIso() });
      continue;
    }

    // action === 'update'
    const updateResult = await deps.runDevin(devinPath, ['plugins', 'update', id, '--yes'], cwd);
    if (!updateResult.ok) {
      result.failed.push({ id, reason: updateResult.error ?? 'update-failed' });
      if (existingEntry) updatedEntries.push(existingEntry);
      continue;
    }
    const verifyAfterUpdate = await deps.runDevin(devinPath, ['plugins', 'info', id], cwd);
    if (!verifyAfterUpdate.ok) {
      result.failed.push({ id, reason: 'update-verify-failed' });
      if (existingEntry) updatedEntries.push(existingEntry);
      continue;
    }
    result.updated.push(id);
    updatedEntries.push({ pluginId: id, installSource: source, indexCommit, installedAt: deps.nowIso() });
  }

  // ---- 撤去: state にあるが desired に無いものを削除する ----
  const removalIds = decideDevinPluginRemovals(state.entries.map((e) => e.pluginId), desiredIds);
  const removedIds: string[] = [];
  for (const id of removalIds) {
    const removeResult = await deps.runDevin(devinPath, ['plugins', 'remove', id, '--yes'], cwd);
    if (removeResult.ok) {
      removedIds.push(id);
    } else {
      result.failed.push({ id, reason: removeResult.error ?? 'remove-failed' });
      const stale = stateByPluginId.get(id);
      if (stale) updatedEntries.push(stale); // 削除失敗 → state に残す（次回リトライ）
    }
  }
  if (removedIds.length > 0) result.removed = removedIds;

  await deps.writeState(statePath, buildDevinPluginState(updatedEntries));
  return result;
}

// -----------------------------------------------------------------------------
// project/prelaunch scope（v1 対象外。常に空を返す）
// -----------------------------------------------------------------------------

/** v1 では project/prelaunch scope 未対応（常に空結果を返し、deps を一切呼ばない） */
export async function reconcileProjectWithDeps(
  _ctx: CapabilityCtx,
  _projectPath: string,
  _deps: DevinPluginDeps,
): Promise<CapabilityResult> {
  return emptyResult();
}

// -----------------------------------------------------------------------------
// hasManagedState（撤去経路が「このマシンに管理下の plugin が残っているか」を判定するために使う）
// -----------------------------------------------------------------------------

/**
 * state に 1 件以上エントリがあれば true。throw / 例外は false 扱い
 * （fail-closed: 判定できないなら破壊的操作をしない）。キルスイッチ OFF 時も false。
 */
export async function hasManagedStateWithDeps(deps: DevinPluginDeps): Promise<boolean> {
  if (!deps.isEnabled()) return false;
  try {
    const statePathResult = deps.resolveStatePath();
    if (!statePathResult.ok) return false;
    const data = await deps.readJson(statePathResult.path);
    if (!isOwnedDevinPluginState(data)) return false;
    return data.entries.length > 0;
  } catch {
    return false;
  }
}

/**
 * Devin plugin adapter 本体（`capability-sync.ts` の `registerCapabilityAdapter()` に登録する）。
 * `hasManagedState` は `CapabilityAdapter` インタフェースへの optional 追加（P3-A D4）を使う。
 */
export const devinPluginAdapter: CapabilityAdapter & { hasManagedState: () => Promise<boolean> } = {
  provider: 'devin',
  kind: 'plugin',
  reconcileMachine: (ctx) => reconcileMachineWithDeps(ctx, defaultDeps),
  reconcileProject: (ctx, projectPath) => reconcileProjectWithDeps(ctx, projectPath, defaultDeps),
  hasManagedState: () => hasManagedStateWithDeps(defaultDeps),
};
