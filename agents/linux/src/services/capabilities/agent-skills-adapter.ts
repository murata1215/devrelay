/**
 * サイクル P3-B: Agent Skills 標準 capability（`agent-skills:standard`）の I/O 層。
 *
 * サイクル P3-A で `devin:skill`（Devin という「ツール名」に紐づく adapter）として実装したものを、
 * 配布フォーマット単位の adapter へ昇格したもの（`devin-skill-adapter.ts` からのリネーム改造）。
 * 配布先は `~/.agents/skills/<name>/SKILL.md`（Agent Skills 標準。Devin CLI と Codex の両方が読む）。
 * 索引宣言は `ctx.config.providers.claude`（Claude adapter と同じ marketplace 索引）を単一情報源として
 * 流用する（D-5: server 側の再構築ロジックが `providers.<key>` を `marketplaceName`/`marketplaceSource`
 * 必須の既知2フィールドにしか通さないため、新しい top-level キーを足すと server 変更が必要になる）。
 *
 * `git`/marketplace リポジトリの clone/fetch・skill ツリーのコピー/削除を**すべてここに閉じ込める**
 * （共通層 `capability-sync.ts` は本ファイルの存在を知らず、`CapabilityAdapter` インタフェース越しにしか
 * 呼ばない）。判断ロジックは全て `agent-skills-rules.ts`（外部 import ゼロの純関数）に委譲し、
 * ここではファイル I/O・CLI 実行・オーケストレーションだけを行う。`claude-plugin-adapter.ts` と
 * 同じ deps 注入形にし、テストで spawn ゼロの fake deps に差し替えられるようにする。
 *
 * 承認ノート #6（P3-A）: `ctx.items.length === 0`（provider OFF や `capabilityConfig` 全体 null による
 * cleanup 呼び出し）は git CLI を一切呼ばず、filesystem 操作（marker 走査 + 削除）だけで撤去を完了する。
 * 承認ノート #8（P3-A CRITICAL RULE）: marketplace の clone/fetch/manifest 解析失敗時は desired state を
 * 確定できなかったものとして撤去を一切行わず、既存 managed skill を last-known-good として保持し
 * `failed` を報告する（`canPerformRemoval()` で判定を 1 箇所に集約）。
 * 承認ノート #9（P3-A）: 宛先と同名の非管理ディレクトリは上書きも削除もせず `failed` として報告する。
 *
 * サイクル P3-B §5-4（新規・最重要）: legacy（P3-A が `%APPDATA%\devin\skills` 等に作った managed 状態）
 * の回収は「新配布先への install/update が成功し、書き込んだ marker を再読込して確認できた skill」
 * だけに限定する（`decideLegacyMigration()`）。索引取得失敗時（last-known-good 維持中）は legacy にも
 * 一切触らない。
 * サイクル P3-B §5-6: ランタイム検出（Devin `--version` / Codex 設定有無）は**配布判断から完全に
 * 切り離し**、`CapabilityResult.runtimeVersion` に表示専用の診断文字列を入れるだけに使う。
 */
import { existsSync } from 'fs';
import { writeFile } from 'fs/promises';
import { join } from 'path';
import * as os from 'os';
import type { CapabilityResult, CapabilityClaudeProviderConfig } from '@devrelay/shared';
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
  resolveAgentSkillsDirPath,
  resolveLegacyDevinSkillsDirPath,
  resolveGitCloneUrl,
  resolvePluginSourceRelPath,
  sanitizeMarketplaceDirName,
  stripMarketplaceSuffix,
  allocateGitTimeoutMs,
  GIT_TOTAL_BUDGET_MS,
  parseMarketplaceManifest,
  parsePluginManifest,
  isOwnedAgentSkillsMarker,
  isOwnedLegacyDevinMarker,
  buildSkillMarker,
  decideSkillActionFast,
  decideSkillActionSlow,
  buildDesiredSkillPlan,
  decideRemovals,
  canPerformRemoval,
  decideLegacyMigration,
  buildRuntimeDiagnostics,
  resolveFailureIds,
  SKILL_TREE_MAX_BYTES,
  SKILL_TREE_MAX_FILES,
  SKILL_TREE_MAX_DEPTH,
  type ResolveSkillsDirResult,
  type DesiredSkillPluginInput,
  type DesiredSkillEntry,
  type SkillMarker,
  type IndexOutcome,
} from './agent-skills-rules.js';
import { nextUniqueSuffix } from '../atomic-write.js';

// -----------------------------------------------------------------------------
// deps 注入（テストで CLI/git 呼び出しを spawn ゼロで検証できるようにする）
// -----------------------------------------------------------------------------

/** `agent-skills-adapter.ts` が使う外部依存の束（テストでは全て fake に差し替える） */
export interface AgentSkillsDeps {
  /** 既定: `devin-path.js` の `resolveSystemDevin`（§5-6: 診断専用。配布判断には使わない） */
  resolveDevinPath: () => string | null;
  /** 既定: `git-cli.js` の `resolveSystemGit` */
  resolveGitPath: () => string | null;
  /** 既定: `git-cli.js` の `execFileGitRunner`（cwd 必須） */
  runGit: GitCliRunner;
  /** 既定: `devin-path.js` の `resolveDevinRuntimeVersion`（モジュール内 6 時間キャッシュ付き。診断専用） */
  resolveRuntimeVersion: (devinPath: string) => Promise<string | null>;
  /**
   * サイクル P3-B §5-6: `config.aiTools[name]` が設定されているかどうかだけを見る（spawn ゼロ）。
   * Codex には locator が存在しない（D-3）ため、ランタイム検出ではなく設定有無で診断する。
   * 既定実装は `connection.ts` が `setAiToolsSnapshot()` で注入したスナップショットを参照する。
   */
  hasAiTool: (name: string) => boolean;
  /** JSON ファイルを読んでパースする。存在しない/壊れている場合は null（throw しない） */
  readJson: (filePath: string) => Promise<unknown>;
  /** marketplace clone の親ディレクトリの基点。既定 `getConfigDir()`（`claude-plugin-adapter.ts` と同じ流儀） */
  machineCwd: () => string;
  /** Agent Skills 標準の新配布先ディレクトリを解決する（純関数のラッパー） */
  resolveSkillsDir: () => ResolveSkillsDirResult;
  /** legacy（P3-A Devin 専用）の移行元ディレクトリを解決する（移行スキャン専用） */
  resolveLegacySkillsDir: () => ResolveSkillsDirResult;
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

/**
 * サイクル P3-B §5-6: `connection.ts` から `config.aiTools` のスナップショットを注入するための DI。
 * Agent 起動時・再接続時に `connectToServer()` が更新する（診断専用・spawn ゼロ・配布判断に非関与）。
 * 未注入時は「設定なし」として扱う（fail-safe）。
 */
let aiToolsSnapshot: Record<string, unknown> | null = null;

/** `connection.ts` が呼ぶセッター。テストでは呼ばず、直接 fake deps の `hasAiTool` を差し替える */
export function setAiToolsSnapshot(aiTools: Record<string, unknown> | null | undefined): void {
  aiToolsSnapshot = aiTools ?? null;
}

function defaultHasAiTool(name: string): boolean {
  return Boolean(aiToolsSnapshot && Object.prototype.hasOwnProperty.call(aiToolsSnapshot, name));
}

/** 本番用の既定 deps */
export const defaultDeps: AgentSkillsDeps = {
  resolveDevinPath: resolveSystemDevin,
  resolveGitPath: resolveSystemGit,
  runGit: execFileGitRunner,
  resolveRuntimeVersion: resolveDevinRuntimeVersion,
  hasAiTool: defaultHasAiTool,
  readJson: readJsonSafe,
  machineCwd: defaultMachineCwd,
  resolveSkillsDir: () => resolveAgentSkillsDirPath({ platform: process.platform, env: process.env, homeDir: os.homedir() }),
  resolveLegacySkillsDir: () => resolveLegacyDevinSkillsDirPath({ platform: process.platform, env: process.env, homeDir: os.homedir() }),
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
  return { provider: 'agent-skills', kind: 'standard', runtimeVersion: null, installed: [], updated: [], present: [], failed: [], notAllowed: [] };
}

// -----------------------------------------------------------------------------
// marker 走査・削除の共通ヘルパ（新配布先/legacy 共通。predicate だけ差し替える）
// -----------------------------------------------------------------------------

/** `skillsDir` 直下を走査し、`isOwned` が真の skill 名 → marker を返す */
async function scanOwnedSkills(
  deps: AgentSkillsDeps,
  skillsDir: string,
  isOwned: (data: unknown) => data is SkillMarker,
): Promise<Map<string, SkillMarker>> {
  const names = await deps.listDirNames(skillsDir);
  const owned = new Map<string, SkillMarker>();
  for (const name of names) {
    const data = await deps.readJson(join(skillsDir, name, '.devrelay-capability.json'));
    if (isOwned(data)) owned.set(name, data);
  }
  return owned;
}

/** `names` を 1 件ずつ削除し、成功したものだけ `removedIds` に積む（失敗は failed へ） */
async function performRemovals(
  deps: AgentSkillsDeps,
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

/** 新配布先に書き込んだ marker を読み直し、`isOwnedAgentSkillsMarker()` が真であることを確認する */
async function verifyWrittenMarker(deps: AgentSkillsDeps, skillsDir: string, skillName: string): Promise<boolean> {
  try {
    const data = await deps.readJson(join(skillsDir, skillName, '.devrelay-capability.json'));
    return isOwnedAgentSkillsMarker(data);
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------
// §5-4: legacy（P3-A）からの移行
// -----------------------------------------------------------------------------

interface MigrateLegacyInput {
  /** 今回のサイクルで desired だった skill 名一覧（`plan.desired` 由来。cleanup-only なら空配列） */
  desiredSkillNames: string[];
  /** 今回のサイクルで新配布先への install/update/present/refresh-marker が成功した skill 名 */
  installedThisCycle: Set<string>;
  /** 今回のサイクルで新配布先の marker 再読込検証ができた skill 名 */
  markerVerifiedThisCycle: Set<string>;
  /** `canPerformRemoval(indexOutcome)`（索引取得が last-known-good を維持できているか） */
  canRemove: boolean;
}

/**
 * legacy dir（P3-A が `%APPDATA%\devin\skills` 等に作った managed 状態）をスキャンし、
 * `decideLegacyMigration()` が `remove-legacy` を返した skill だけ削除する。
 * - desired にある skill: 新配布先への install/update が成功し marker 再検証も通った場合のみ削除
 * - desired に無い skill（config から外れた/cleanup-only）: `canRemove` が真であれば削除
 * marker が無い/他者 marker/読めないディレクトリには一切触らない。
 */
async function migrateLegacyDevinSkills(
  deps: AgentSkillsDeps,
  result: CapabilityResult,
  removedIds: string[],
  input: MigrateLegacyInput,
): Promise<void> {
  const legacyDirResult = deps.resolveLegacySkillsDir();
  if (!legacyDirResult.ok) return;
  const legacyDir = legacyDirResult.dir;

  let legacyNames: string[];
  try {
    legacyNames = await deps.listDirNames(legacyDir);
  } catch {
    return;
  }
  if (legacyNames.length === 0) return;

  const desiredSet = new Set(input.desiredSkillNames);

  for (const name of legacyNames) {
    const data = await deps.readJson(join(legacyDir, name, '.devrelay-capability.json'));
    if (!isOwnedLegacyDevinMarker(data)) continue;

    const isDesiredThisCycle = desiredSet.has(name);
    const decision = decideLegacyMigration({
      hasLegacyOwnedDir: true,
      canRemove: input.canRemove,
      newInstallSucceeded: isDesiredThisCycle ? input.installedThisCycle.has(name) : true,
      newMarkerVerified: isDesiredThisCycle ? input.markerVerifiedThisCycle.has(name) : true,
    });
    if (decision !== 'remove-legacy') continue;

    const marker = data as SkillMarker;
    const displayId = marker.pluginId ? `${marker.pluginId}/${name}` : name;
    try {
      await deps.removeManagedDir(join(legacyDir, name));
      removedIds.push(`legacy:${displayId}`);
    } catch (err) {
      result.failed.push({ id: `legacy:${displayId}`, reason: (err as Error)?.message || 'remove-failed' });
    }
  }
}

// -----------------------------------------------------------------------------
// §5-6: ランタイム診断（配布判断には非関与。表示専用）
// -----------------------------------------------------------------------------

/**
 * サイクル P3-B §5-6・承認ノート#2: Devin は実機検出（`--version`）、Codex は
 * `config.aiTools.codex` の設定有無で診断文字列を組み立てる（判定根拠が異なるため語彙も変える）。
 * `ctx.items.length === 0` のときは呼ばない（無駄な spawn をしない）。
 */
async function buildDiagnostics(deps: AgentSkillsDeps): Promise<string> {
  const devinPath = deps.resolveDevinPath();
  const devinVersion = devinPath ? await deps.resolveRuntimeVersion(devinPath) : null;
  const codexConfigured = deps.hasAiTool('codex');
  return buildRuntimeDiagnostics([
    { label: 'Devin', detected: Boolean(devinPath), basis: 'runtime-detection', version: devinVersion },
    { label: 'Codex', detected: codexConfigured, basis: 'config-presence' },
  ]);
}

// -----------------------------------------------------------------------------
// marketplace リポジトリの clone/fetch（P3-A §3-1）
// -----------------------------------------------------------------------------

/**
 * marketplace リポジトリを `<cloneParentDir>/<dirName>` に shallow clone し、無ければ作成・
 * 既にあれば fetch + reset --hard + clean -fdx でリセットする。失敗したら `ok:false`
 * （呼び出し側は既存 managed skill を last-known-good として保持し、撤去しない）。
 * 存在確認は `deps.listDirNames()` のみで行う（fake deps でも spawn ゼロで検証できるようにするため）。
 */
async function ensureMarketplaceClone(
  deps: AgentSkillsDeps,
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
  deps: AgentSkillsDeps,
  sourceSkillDir: string,
  entry: DesiredSkillEntry,
  indexCommit: string | null,
  providerConfig: CapabilityClaudeProviderConfig,
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
 * - `ctx.items.length === 0`: cleanup-only 経路（承認ノート#6）。git CLI を呼ばず filesystem 操作
 *   だけで新配布先 + legacy 両方の managed skill を撤去する。
 * - それ以外: `providers.claude` 索引宣言確認 → git 検出 → marketplace clone/fetch → manifest 解析 →
 *   1 plugin ずつ desired skill 一覧を構築 → 1 skill ずつ install/update/present を判定・実行 →
 *   非desired な managed skill を撤去 → legacy 移行判定（承認ノート#8: clone/fetch/manifest 解析が
 *   失敗した場合はここまで到達せず、既存 skill も legacy も last-known-good のまま保持される）。
 */
export async function reconcileMachineWithDeps(ctx: CapabilityCtx, deps: AgentSkillsDeps): Promise<CapabilityResult> {
  const result = emptyResult();
  const removedIds: string[] = [];

  const skillsDirResult = deps.resolveSkillsDir();
  if (!skillsDirResult.ok) {
    for (const id of resolveFailureIds(ctx.items.map(i => i.id), 'agent-skills:standard')) {
      result.failed.push({ id, reason: `skills-dir-${skillsDirResult.reason}` });
    }
    return result;
  }
  const skillsDir = skillsDirResult.dir;

  if (ctx.items.length === 0) {
    // 承認ノート#6: cleanup-only 経路。診断は行わない（無駄な spawn をしない）
    await deps.cleanupResidue(skillsDir);
    const ownedMarkers = await scanOwnedSkills(deps, skillsDir, isOwnedAgentSkillsMarker);
    await performRemovals(deps, skillsDir, Array.from(ownedMarkers.keys()), result, removedIds);

    await migrateLegacyDevinSkills(deps, result, removedIds, {
      desiredSkillNames: [],
      installedThisCycle: new Set(),
      markerVerifiedThisCycle: new Set(),
      canRemove: canPerformRemoval('skipped-empty-items'),
    });

    if (removedIds.length > 0) result.removed = removedIds;
    return result;
  }

  // §5-6: 診断（配布判断には非関与）
  result.runtimeVersion = await buildDiagnostics(deps);

  const providerConfig: CapabilityClaudeProviderConfig | undefined = ctx.config.providers.claude;
  if (!providerConfig) {
    for (const id of resolveFailureIds(ctx.items.map(i => i.id), 'agent-skills:standard')) {
      result.failed.push({ id, reason: 'missing-marketplace-config' });
    }
    return result;
  }

  // §5-9(c): item id の二重サフィックス防御（web 側の正規化が効いていない古い DB 値対策）
  const strippedItems = ctx.items.map(i => ({ ...i, id: stripMarketplaceSuffix(i.id, providerConfig.marketplaceName) }));

  const gitPath = deps.resolveGitPath();
  if (!gitPath) {
    for (const id of resolveFailureIds(strippedItems.map(i => i.id), 'agent-skills:standard')) {
      result.failed.push({ id, reason: 'git-not-found' });
    }
    return result;
  }

  const urlResult = resolveGitCloneUrl(providerConfig.marketplaceSource);
  if (!urlResult.ok) {
    for (const id of resolveFailureIds(strippedItems.map(i => i.id), 'agent-skills:standard')) {
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
    // 承認ノート#8: desired state 未確定 → 撤去しない（新配布先・legacy とも last-known-good のまま）
    for (const id of resolveFailureIds(strippedItems.map(i => i.id), 'agent-skills:standard')) {
      result.failed.push({ id, reason: 'clone-failed' });
    }
    return result;
  }
  const { cloneDir, commit: indexCommit } = cloneOutcome;

  const manifest = parseMarketplaceManifest(await deps.readJson(join(cloneDir, '.claude-plugin', 'marketplace.json')));
  if (!manifest) {
    // 承認ノート#8: manifest 解析失敗 → 撤去しない
    for (const id of resolveFailureIds(strippedItems.map(i => i.id), 'agent-skills:standard')) {
      result.failed.push({ id, reason: 'manifest-invalid' });
    }
    return result;
  }

  // 1 plugin ずつ desired plan 構築の入力を集める（plugin.json 読み取り + skills/ 一覧）
  const pluginInputs: DesiredSkillPluginInput[] = [];
  const pluginSkillsRoot = new Map<string, string>();
  for (const item of strippedItems) {
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
  const ownedMarkers = await scanOwnedSkills(deps, skillsDir, isOwnedAgentSkillsMarker);

  // §5-4: legacy 移行ゲートに使う「今回のサイクルで新配布先が確定した skill」の追跡
  const installedThisCycle = new Set<string>();
  const markerVerifiedThisCycle = new Set<string>();

  for (const entry of plan.desired) {
    const marker = ownedMarkers.get(entry.skillName) ?? null;
    const destExists = allDestNames.has(entry.skillName);
    const action = decideSkillActionFast(destExists, marker, indexCommit);

    if (action === 'conflict-unmanaged') {
      // 承認ノート#9: 同名の非管理ディレクトリは上書きも削除もしない
      result.failed.push({ id: entry.resultId, reason: 'unmanaged-conflict' });
      continue;
    }
    if (action === 'present') {
      result.present.push(entry.resultId);
      installedThisCycle.add(entry.skillName);
      markerVerifiedThisCycle.add(entry.skillName); // scanOwnedSkills で既に isOwnedAgentSkillsMarker 検証済み
      continue;
    }

    const sourceSkillDir = join(pluginSkillsRoot.get(entry.pluginId)!, entry.skillName);

    if (action === 'install') {
      const outcome = await installOrUpdateSkill(deps, sourceSkillDir, entry, indexCommit, providerConfig, skillsDir);
      if (outcome.ok) {
        result.installed.push(entry.resultId);
        installedThisCycle.add(entry.skillName);
        if (await verifyWrittenMarker(deps, skillsDir, entry.skillName)) markerVerifiedThisCycle.add(entry.skillName);
      } else {
        result.failed.push({ id: entry.resultId, reason: outcome.reason });
      }
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
      if (outcome.ok) {
        result.updated.push(entry.resultId);
        installedThisCycle.add(entry.skillName);
        if (await verifyWrittenMarker(deps, skillsDir, entry.skillName)) markerVerifiedThisCycle.add(entry.skillName);
      } else {
        result.failed.push({ id: entry.resultId, reason: outcome.reason });
      }
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
      installedThisCycle.add(entry.skillName);
      markerVerifiedThisCycle.add(entry.skillName);
    } catch {
      result.failed.push({ id: entry.resultId, reason: 'marker-refresh-failed' });
    }
  }

  // desired state が確定した（clone/fetch/manifest 解析が成功した）ので撤去を実行してよい
  const indexOutcome: IndexOutcome = 'ok';
  const canRemove = canPerformRemoval(indexOutcome);
  if (canRemove) {
    const desiredNames = plan.desired.map(d => d.skillName);
    const toRemove = decideRemovals(Array.from(ownedMarkers.keys()), desiredNames);
    await performRemovals(deps, skillsDir, toRemove, result, removedIds);
  }

  // §5-4: legacy（P3-A）からの移行。新配布先の成功を確認できた skill だけ legacy を回収する
  await migrateLegacyDevinSkills(deps, result, removedIds, {
    desiredSkillNames: plan.desired.map(d => d.skillName),
    installedThisCycle,
    markerVerifiedThisCycle,
    canRemove,
  });

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
  _deps: AgentSkillsDeps,
): Promise<CapabilityResult> {
  return emptyResult();
}

// -----------------------------------------------------------------------------
// hasManagedState（D4 の cleanup パスが撤去要否を判定するために使う）
// -----------------------------------------------------------------------------

/**
 * このマシンに devrelay 管理下の skill が 1 件でも残っているかを判定する
 * （新配布先 **または** legacy のどちらかに 1 件でもあれば true）。
 * throw / 例外は false 扱い（fail-closed: 判定できないなら破壊的操作をしない）。
 */
export async function hasManagedStateWithDeps(deps: AgentSkillsDeps): Promise<boolean> {
  try {
    const skillsDirResult = deps.resolveSkillsDir();
    if (skillsDirResult.ok) {
      const owned = await scanOwnedSkills(deps, skillsDirResult.dir, isOwnedAgentSkillsMarker);
      if (owned.size > 0) return true;
    }
  } catch {
    // fall through to legacy check
  }
  try {
    const legacyDirResult = deps.resolveLegacySkillsDir();
    if (legacyDirResult.ok) {
      const owned = await scanOwnedSkills(deps, legacyDirResult.dir, isOwnedLegacyDevinMarker);
      if (owned.size > 0) return true;
    }
  } catch {
    // fall through
  }
  return false;
}

/**
 * Agent Skills 標準 adapter 本体（`capability-sync.ts` の `registerCapabilityAdapter()` に登録する）。
 * `hasManagedState` は `CapabilityAdapter` インタフェースへの optional 追加（P3-A D4）を使う。
 */
export const agentSkillsAdapter: CapabilityAdapter & { hasManagedState: () => Promise<boolean> } = {
  provider: 'agent-skills',
  kind: 'standard',
  reconcileMachine: (ctx) => reconcileMachineWithDeps(ctx, defaultDeps),
  reconcileProject: (ctx, projectPath) => reconcileProjectWithDeps(ctx, projectPath, defaultDeps),
  hasManagedState: () => hasManagedStateWithDeps(defaultDeps),
};
