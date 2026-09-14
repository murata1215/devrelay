/**
 * サイクル P3-A: Devin native skill capability の I/O 層（provider=devin, kind=skill の唯一の実装）。
 *
 * `git`/Devin CLI 呼び出し・marketplace リポジトリの clone/fetch・skill ツリーのコピー/削除を
 * **すべてここに閉じ込める**（共通層 `capability-sync.ts` は本ファイルの存在を知らず、
 * `CapabilityAdapter` インタフェース越しにしか呼ばない）。判断ロジックは全て
 * `devin-skill-rules.ts`（外部 import ゼロの純関数）に委譲し、ここではファイル I/O・CLI 実行・
 * オーケストレーションだけを行う。`claude-plugin-adapter.ts` と同じ deps 注入形にし、
 * テストで spawn ゼロの fake deps に差し替えられるようにする。
 *
 * 承認ノート #6: Devin CLI 未検出時の早期 return は active reconcile（install/update/present）
 * のみに適用する。`ctx.items.length === 0`（provider OFF や `capabilityConfig` 全体 null による
 * cleanup 呼び出し）は git/Devin CLI を一切呼ばず、filesystem 操作（marker 走査 + 削除）だけで
 * 撤去を完了する。
 *
 * 承認ノート #8（CRITICAL RULE）: marketplace の clone/fetch/manifest 解析失敗時は
 * desired state を確定できなかったものとして撤去を一切行わず、既存 managed skill を
 * last-known-good として保持し `failed` を報告する（`devin-skill-rules.ts` の
 * `canPerformRemoval()` で判定を 1 箇所に集約）。
 *
 * 承認ノート #9: 宛先と同名の非管理ディレクトリは上書きも削除もせず `failed` として報告する。
 */
import { writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import * as os from 'os';
import type { CapabilityResult, CapabilityDevinProviderConfig } from '@devrelay/shared';
import { resolveSystemDevin, resolveDevinRuntimeVersion } from '../devin-path.js';
import type { CapabilityAdapter, CapabilityCtx } from '../capability-sync.js';
import { getConfigDir } from '../config.js';
import { execFileGitRunner, resolveSystemGit, type GitCliRunner } from './git-cli.js';
import {
  copyTreeSafe,
  hashTree,
  atomicSwapDir,
  removeManagedDir,
  cleanupResidue,
  listDirNames,
  readJsonSafe,
  ensureDir,
  type TreeLimits,
  type AtomicSwapResult,
  type CopyTreeResult,
} from './skill-tree-io.js';
import {
  resolveDevinSkillsDirPath,
  resolveGitCloneUrl,
  resolvePluginSourceRelPath,
  sanitizeMarketplaceDirName,
  allocateGitTimeoutMs,
  GIT_TOTAL_BUDGET_MS,
  parseMarketplaceManifest,
  parsePluginManifest,
  isOwnedMarker,
  buildSkillMarker,
  decideSkillActionFast,
  decideSkillActionSlow,
  buildDesiredSkillPlan,
  decideRemovals,
  canPerformRemoval,
  resolveFailureIds,
  SKILL_TREE_MAX_BYTES,
  SKILL_TREE_MAX_FILES,
  SKILL_TREE_MAX_DEPTH,
  type ResolveDevinSkillsDirResult,
  type DesiredSkillPluginInput,
  type DesiredSkillEntry,
  type SkillMarker,
  type IndexOutcome,
} from './devin-skill-rules.js';
import { nextUniqueSuffix } from '../atomic-write.js';

// -----------------------------------------------------------------------------
// deps 注入（テストで CLI/git 呼び出しを spawn ゼロで検証できるようにする）
// -----------------------------------------------------------------------------

/** `devin-skill-adapter.ts` が使う外部依存の束（テストでは全て fake に差し替える） */
export interface DevinSkillDeps {
  /** 既定: `devin-path.js` の `resolveSystemDevin` */
  resolveDevinPath: () => string | null;
  /** 既定: `git-cli.js` の `resolveSystemGit` */
  resolveGitPath: () => string | null;
  /** 既定: `git-cli.js` の `execFileGitRunner`（cwd 必須） */
  runGit: GitCliRunner;
  /** 既定: `devin-path.js` の `resolveDevinRuntimeVersion`（モジュール内 6 時間キャッシュ付き） */
  resolveRuntimeVersion: (devinPath: string) => Promise<string | null>;
  /** JSON ファイルを読んでパースする。存在しない/壊れている場合は null（throw しない） */
  readJson: (filePath: string) => Promise<unknown>;
  /** marketplace clone の親ディレクトリの基点。既定 `getConfigDir()`（`claude-plugin-adapter.ts` と同じ流儀） */
  machineCwd: () => string;
  /** Devin CLI のグローバル skills ディレクトリを解決する（純関数のラッパー） */
  resolveSkillsDir: () => ResolveDevinSkillsDirResult;
  /** symlink 安全な再帰コピー */
  copyTree: (src: string, dest: string, limits: TreeLimits) => Promise<CopyTreeResult>;
  /** 決定的な再帰 sha256 */
  hashTree: (dir: string) => Promise<string>;
  /** staging → dest のアトミック差し替え */
  atomicSwap: (stagingDir: string, destDir: string, trashDir: string) => Promise<AtomicSwapResult>;
  /** 管理下ディレクトリの削除（symlink は unlink のみ） */
  removeManagedDir: (targetDir: string) => Promise<void>;
  /** ディレクトリ直下のディレクトリ名一覧（symlink・ファイルは除外） */
  listDirNames: (dir: string) => Promise<string[]>;
  /** `mkdir -p` 相当 */
  ensureDir: (dir: string) => Promise<void>;
  /** `.devrelay-staging` / `.devrelay-trash` の残骸掃除 */
  cleanupResidue: (skillsDir: string) => Promise<void>;
  /** staging/trash ディレクトリ名の一意サフィックス */
  uniqueSuffix: () => string;
  /** marker の `installedAt` に使う ISO 時刻 */
  nowIso: () => string;
  /** marker ファイルを書き込む（staging 内で完結するため atomic-write は使わない） */
  writeMarker: (filePath: string, marker: SkillMarker) => Promise<void>;
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
export const defaultDeps: DevinSkillDeps = {
  resolveDevinPath: resolveSystemDevin,
  resolveGitPath: resolveSystemGit,
  runGit: execFileGitRunner,
  resolveRuntimeVersion: resolveDevinRuntimeVersion,
  readJson: readJsonSafe,
  machineCwd: defaultMachineCwd,
  resolveSkillsDir: () => resolveDevinSkillsDirPath({ platform: process.platform, env: process.env, homeDir: os.homedir() }),
  copyTree: copyTreeSafe,
  hashTree,
  atomicSwap: atomicSwapDir,
  removeManagedDir,
  listDirNames,
  ensureDir,
  cleanupResidue,
  uniqueSuffix: nextUniqueSuffix,
  nowIso: () => new Date().toISOString(),
  writeMarker: async (filePath, marker) => {
    await writeFile(filePath, JSON.stringify(marker, null, 2), 'utf-8');
  },
};

function emptyResult(): CapabilityResult {
  return { provider: 'devin', kind: 'skill', runtimeVersion: null, installed: [], updated: [], present: [], failed: [], notAllowed: [] };
}

// -----------------------------------------------------------------------------
// marker 走査・削除の共通ヘルパ
// -----------------------------------------------------------------------------

/** `skillsDir` 直下を走査し、devrelay 管理下（`isOwnedMarker`）の skill 名 → marker を返す */
async function scanOwnedSkills(deps: DevinSkillDeps, skillsDir: string): Promise<Map<string, SkillMarker>> {
  const names = await deps.listDirNames(skillsDir);
  const owned = new Map<string, SkillMarker>();
  for (const name of names) {
    const data = await deps.readJson(join(skillsDir, name, '.devrelay-capability.json'));
    if (isOwnedMarker(data)) owned.set(name, data);
  }
  return owned;
}

/** `names` を 1 件ずつ削除し、成功したものだけ `removedIds` に積む（失敗は failed へ） */
async function performRemovals(
  deps: DevinSkillDeps,
  skillsDir: string,
  names: string[],
  result: CapabilityResult,
  removedIds: string[],
): Promise<void> {
  for (const name of names) {
    try {
      await deps.removeManagedDir(join(skillsDir, name));
      removedIds.push(name);
    } catch (err) {
      result.failed.push({ id: name, reason: (err as Error)?.message || 'remove-failed' });
    }
  }
}

/**
 * `ctx.items` が空のときの cleanup-only 経路（承認ノート#6）。
 * git/Devin CLI を一切呼ばず、marker 走査 + 削除だけで完結する。desired = 空集合のため
 * managed（marker 所有）な skill はすべて撤去対象になる。
 */
async function finalizeCleanupOnly(
  deps: DevinSkillDeps,
  skillsDir: string,
  result: CapabilityResult,
  removedIds: string[],
): Promise<void> {
  await deps.cleanupResidue(skillsDir);
  const ownedMarkers = await scanOwnedSkills(deps, skillsDir);
  await performRemovals(deps, skillsDir, Array.from(ownedMarkers.keys()), result, removedIds);
}

// -----------------------------------------------------------------------------
// marketplace リポジトリの clone/fetch（§3-1）
// -----------------------------------------------------------------------------

/**
 * marketplace リポジトリを `<cloneParentDir>/<dirName>` に shallow clone し、無ければ作成・
 * 既にあれば fetch + reset --hard + clean -fdx でリセットする。失敗したら `ok:false`
 * （呼び出し側は既存 managed skill を last-known-good として保持し、撤去しない）。
 * 存在確認は `deps.listDirNames()` のみで行う（fake deps でも spawn ゼロで検証できるようにするため）。
 */
async function ensureMarketplaceClone(
  deps: DevinSkillDeps,
  cloneParentDir: string,
  dirName: string,
  gitPath: string,
  url: string,
): Promise<{ ok: true; cloneDir: string; commit: string | null } | { ok: false }> {
  const cloneDir = join(cloneParentDir, dirName);
  const parentNames = await deps.listDirNames(cloneParentDir);
  const cloneExists = parentNames.includes(dirName);

  if (!cloneExists) {
    const timeoutMs = allocateGitTimeoutMs(GIT_TOTAL_BUDGET_MS, 2);
    const cloneResult = await deps.runGit(gitPath, ['clone', '--depth', '1', '--single-branch', '--', url, cloneDir], cloneParentDir, timeoutMs);
    if (!cloneResult.ok) {
      await deps.removeManagedDir(cloneDir).catch(() => {}); // 部分 clone の残骸を掃除し次回リトライを新規 clone にする
      return { ok: false };
    }
  } else {
    const timeoutMs = allocateGitTimeoutMs(GIT_TOTAL_BUDGET_MS, 5);
    const steps: string[][] = [
      ['remote', 'set-url', 'origin', url],
      ['fetch', '--depth', '1', 'origin', 'HEAD'],
      ['reset', '--hard', 'FETCH_HEAD'],
      ['clean', '-fdx'],
    ];
    for (const args of steps) {
      const stepResult = await deps.runGit(gitPath, args, cloneDir, timeoutMs);
      if (!stepResult.ok) return { ok: false };
    }
  }

  const revParseTimeout = allocateGitTimeoutMs(GIT_TOTAL_BUDGET_MS, 1);
  const revParseResult = await deps.runGit(gitPath, ['rev-parse', 'HEAD'], cloneDir, revParseTimeout);
  const commit = revParseResult.ok ? (revParseResult.stdout.trim() || null) : null;
  return { ok: true, cloneDir, commit };
}

// -----------------------------------------------------------------------------
// skill 1 件の install/update（staging → marker 書き込み → atomic swap）
// -----------------------------------------------------------------------------

/** copyTreeSafe の失敗理由 → CapabilityResult の failed reason へのマッピング */
const COPY_FAILURE_REASON: Record<string, string> = {
  'too-large': 'skill-too-large',
  'too-many-files': 'skill-too-many-files',
  'too-deep': 'skill-too-deep',
};

async function installOrUpdateSkill(
  deps: DevinSkillDeps,
  sourceSkillDir: string,
  entry: DesiredSkillEntry,
  indexCommit: string | null,
  providerConfig: CapabilityDevinProviderConfig,
  skillsDir: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const suffix = deps.uniqueSuffix();
  const stagingDir = join(skillsDir, '.devrelay-staging', `${entry.skillName}-${suffix}`);
  const trashDir = join(skillsDir, '.devrelay-trash', `${entry.skillName}-${suffix}`);
  const destDir = join(skillsDir, entry.skillName);

  const limits: TreeLimits = { maxBytes: SKILL_TREE_MAX_BYTES, maxFiles: SKILL_TREE_MAX_FILES, maxDepth: SKILL_TREE_MAX_DEPTH };
  const copyResult = await deps.copyTree(sourceSkillDir, stagingDir, limits);
  if (!copyResult.ok) {
    await deps.removeManagedDir(stagingDir).catch(() => {});
    return { ok: false, reason: COPY_FAILURE_REASON[copyResult.reason] ?? copyResult.reason };
  }

  const contentHash = await deps.hashTree(stagingDir);
  const marker = buildSkillMarker({
    marketplaceName: providerConfig.marketplaceName,
    marketplaceSource: providerConfig.marketplaceSource,
    pluginId: entry.pluginId,
    pluginVersion: entry.desiredVersion,
    skillName: entry.skillName,
    sourceCommit: indexCommit,
    contentHash,
    nowIso: deps.nowIso(),
  });
  try {
    await deps.writeMarker(join(stagingDir, '.devrelay-capability.json'), marker);
  } catch {
    await deps.removeManagedDir(stagingDir).catch(() => {});
    return { ok: false, reason: 'marker-write-failed' };
  }

  const swapResult = await deps.atomicSwap(stagingDir, destDir, trashDir);
  if (!swapResult.ok) {
    await deps.removeManagedDir(stagingDir).catch(() => {});
    return { ok: false, reason: swapResult.error || 'swap-failed' };
  }
  return { ok: true };
}

// -----------------------------------------------------------------------------
// machine scope の reconcile（trigger connect/config/idle/manual、および D4 cleanup パス）
// -----------------------------------------------------------------------------

/**
 * machine scope の reconcile。
 *
 * - `ctx.items.length === 0`: cleanup-only 経路（承認ノート#6）。git/Devin CLI を呼ばず
 *   filesystem 操作だけで managed skill を全撤去する。
 * - それ以外: providerConfig 確認 → Devin CLI 検出 → git 検出 → marketplace clone/fetch →
 *   manifest 解析 → 1 plugin ずつ desired skill 一覧を構築 → 1 skill ずつ install/update/present
 *   を判定・実行 → 最後に非desiredな managed skill を撤去する
 *   （承認ノート#8: clone/fetch/manifest 解析が失敗した場合はここまで到達せず、既存 skill は
 *   last-known-good のまま保持される）。
 */
export async function reconcileMachineWithDeps(ctx: CapabilityCtx, deps: DevinSkillDeps): Promise<CapabilityResult> {
  const result = emptyResult();
  const removedIds: string[] = [];

  const skillsDirResult = deps.resolveSkillsDir();
  if (!skillsDirResult.ok) {
    for (const id of resolveFailureIds(ctx.items.map(i => i.id), 'devin:skill')) {
      result.failed.push({ id, reason: `skills-dir-${skillsDirResult.reason}` });
    }
    return result;
  }
  const skillsDir = skillsDirResult.dir;

  if (ctx.items.length === 0) {
    await finalizeCleanupOnly(deps, skillsDir, result, removedIds);
    if (removedIds.length > 0) result.removed = removedIds;
    return result;
  }

  const providerConfig: CapabilityDevinProviderConfig | undefined = ctx.config.providers.devin;
  if (!providerConfig) {
    for (const id of resolveFailureIds(ctx.items.map(i => i.id), 'devin:skill')) {
      result.failed.push({ id, reason: 'missing-provider-config' });
    }
    return result;
  }

  const devinPath = deps.resolveDevinPath();
  if (!devinPath) {
    for (const id of resolveFailureIds(ctx.items.map(i => i.id), 'devin:skill')) {
      result.failed.push({ id, reason: 'devin-not-found' });
    }
    return result;
  }
  result.runtimeVersion = await deps.resolveRuntimeVersion(devinPath);

  const gitPath = deps.resolveGitPath();
  if (!gitPath) {
    for (const id of resolveFailureIds(ctx.items.map(i => i.id), 'devin:skill')) {
      result.failed.push({ id, reason: 'git-not-found' });
    }
    return result;
  }

  const urlResult = resolveGitCloneUrl(providerConfig.marketplaceSource);
  if (!urlResult.ok) {
    for (const id of resolveFailureIds(ctx.items.map(i => i.id), 'devin:skill')) {
      result.failed.push({ id, reason: 'unsupported-source-format' });
    }
    return result;
  }

  await deps.cleanupResidue(skillsDir);
  await deps.ensureDir(skillsDir);
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
    // 承認ノート#8: desired state 未確定 → 撤去しない。既存 managed skill は last-known-good のまま
    for (const id of resolveFailureIds(ctx.items.map(i => i.id), 'devin:skill')) {
      result.failed.push({ id, reason: 'clone-failed' });
    }
    return result;
  }
  const { cloneDir, commit: indexCommit } = cloneOutcome;

  const manifest = parseMarketplaceManifest(await deps.readJson(join(cloneDir, '.claude-plugin', 'marketplace.json')));
  if (!manifest) {
    // 承認ノート#8: manifest 解析失敗 → 撤去しない
    for (const id of resolveFailureIds(ctx.items.map(i => i.id), 'devin:skill')) {
      result.failed.push({ id, reason: 'manifest-invalid' });
    }
    return result;
  }

  // 1 plugin ずつ desired plan 構築の入力を集める（plugin.json 読み取り + skills/ 一覧）
  const pluginInputs: DesiredSkillPluginInput[] = [];
  const pluginSkillsRoot = new Map<string, string>();
  for (const item of ctx.items) {
    const manifestEntry = manifest.plugins.find(p => p.name === item.id) ?? null;
    if (!manifestEntry) {
      pluginInputs.push({ pluginId: item.id, manifestEntry: null, pluginJsonVersion: null, skillDirNames: [] });
      continue;
    }
    const sourceRel = resolvePluginSourceRelPath(manifestEntry.source);
    if (!sourceRel.ok) {
      // 個別 plugin の source が安全でない場合、その plugin の desired 集合は組み立てられないため
      // 既存 managed skill（あれば）も次の撤去判定で「desired に無い」として扱われ撤去される
      // （信頼できない設定を検証不能な状態のまま残置しない、という安全側の判断）
      result.failed.push({ id: item.id, reason: 'unsafe-plugin-source' });
      continue;
    }
    const pluginDir = join(cloneDir, ...sourceRel.relPath.split('/'));
    const skillsRootDir = join(pluginDir, 'skills');
    pluginSkillsRoot.set(item.id, skillsRootDir);
    const pluginManifest = parsePluginManifest(await deps.readJson(join(pluginDir, '.claude-plugin', 'plugin.json')));
    const skillDirNames = await deps.listDirNames(skillsRootDir);
    pluginInputs.push({
      pluginId: item.id,
      manifestEntry,
      pluginJsonVersion: pluginManifest?.version ?? null,
      skillDirNames,
    });
  }

  const plan = buildDesiredSkillPlan(pluginInputs);
  result.notAllowed.push(...plan.notAllowed);
  result.present.push(...plan.noSkillsPresent);
  result.failed.push(...plan.failed);

  const allDestNames = new Set(await deps.listDirNames(skillsDir));
  const ownedMarkers = await scanOwnedSkills(deps, skillsDir);

  for (const entry of plan.desired) {
    const marker = ownedMarkers.get(entry.skillName) ?? null;
    const destExists = allDestNames.has(entry.skillName);
    const action = decideSkillActionFast(destExists, marker, indexCommit);

    if (action === 'conflict-unmanaged') {
      // 承認ノート#9: 同名の非管理ディレクトリは上書きも削除もしない
      result.failed.push({ id: entry.resultId, reason: 'dest-occupied-unmanaged' });
      continue;
    }
    if (action === 'present') {
      result.present.push(entry.resultId);
      continue;
    }

    const sourceSkillDir = join(pluginSkillsRoot.get(entry.pluginId)!, entry.skillName);

    if (action === 'install') {
      const outcome = await installOrUpdateSkill(deps, sourceSkillDir, entry, indexCommit, providerConfig, skillsDir);
      if (outcome.ok) result.installed.push(entry.resultId);
      else result.failed.push({ id: entry.resultId, reason: outcome.reason });
      continue;
    }

    // needs-comparison: version/content hash で詳細比較する（承認ノート#7）
    const actualHash = await deps.hashTree(sourceSkillDir);
    const slowAction = decideSkillActionSlow(
      marker?.pluginVersion ?? null,
      entry.desiredVersion,
      marker?.contentHash ?? null,
      actualHash,
    );
    if (slowAction === 'update') {
      const outcome = await installOrUpdateSkill(deps, sourceSkillDir, entry, indexCommit, providerConfig, skillsDir);
      if (outcome.ok) result.updated.push(entry.resultId);
      else result.failed.push({ id: entry.resultId, reason: outcome.reason });
      continue;
    }
    // refresh-marker: 内容は同一だが commit のみ変化 → marker だけ差し替えて present 扱い
    const refreshed = buildSkillMarker({
      marketplaceName: providerConfig.marketplaceName,
      marketplaceSource: providerConfig.marketplaceSource,
      pluginId: entry.pluginId,
      pluginVersion: entry.desiredVersion,
      skillName: entry.skillName,
      sourceCommit: indexCommit,
      contentHash: actualHash,
      nowIso: deps.nowIso(),
    });
    try {
      await deps.writeMarker(join(skillsDir, entry.skillName, '.devrelay-capability.json'), refreshed);
      result.present.push(entry.resultId);
    } catch {
      result.failed.push({ id: entry.resultId, reason: 'marker-refresh-failed' });
    }
  }

  // desired state が確定した（clone/fetch/manifest 解析が成功した）ので撤去を実行してよい
  const indexOutcome: IndexOutcome = 'ok';
  if (canPerformRemoval(indexOutcome)) {
    const desiredNames = plan.desired.map(d => d.skillName);
    const toRemove = decideRemovals(Array.from(ownedMarkers.keys()), desiredNames);
    await performRemovals(deps, skillsDir, toRemove, result, removedIds);
  }

  if (removedIds.length > 0) result.removed = removedIds;
  return result;
}

// -----------------------------------------------------------------------------
// project/prelaunch scope（v1 対象外。Plan §3-9・§10 未決事項に基づき常に空を返す）
// -----------------------------------------------------------------------------

/** v1 では project/prelaunch scope 未対応（常に空結果を返し、deps を一切呼ばない） */
export async function reconcileProjectWithDeps(
  _ctx: CapabilityCtx,
  _projectPath: string,
  _deps: DevinSkillDeps,
): Promise<CapabilityResult> {
  return emptyResult();
}

// -----------------------------------------------------------------------------
// hasManagedState（D4 の cleanup パスが撤去要否を判定するために使う）
// -----------------------------------------------------------------------------

/**
 * このマシンに devrelay 管理下の skill が 1 件でも残っているかを判定する。
 * throw / 例外は false 扱い（fail-closed: 判定できないなら破壊的操作をしない）。
 */
export async function hasManagedStateWithDeps(deps: DevinSkillDeps): Promise<boolean> {
  try {
    const skillsDirResult = deps.resolveSkillsDir();
    if (!skillsDirResult.ok) return false;
    const owned = await scanOwnedSkills(deps, skillsDirResult.dir);
    return owned.size > 0;
  } catch {
    return false;
  }
}

/**
 * Devin native skill adapter 本体（`capability-sync.ts` の `registerCapabilityAdapter()` に登録する）。
 * `hasManagedState` は `CapabilityAdapter` インタフェースへの optional 追加（D4）を先取りして実装している
 * （D4 がインタフェースへ `hasManagedState?()` を追加するまでは余剰プロパティとして無害に存在する）。
 */
export const devinSkillAdapter: CapabilityAdapter & { hasManagedState: () => Promise<boolean> } = {
  provider: 'devin',
  kind: 'skill',
  reconcileMachine: (ctx) => reconcileMachineWithDeps(ctx, defaultDeps),
  reconcileProject: (ctx, projectPath) => reconcileProjectWithDeps(ctx, projectPath, defaultDeps),
  hasManagedState: () => hasManagedStateWithDeps(defaultDeps),
};
