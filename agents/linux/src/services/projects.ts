import fs from 'fs/promises';
import path from 'path';
import type { Project, AiTool } from '@devrelay/shared';
import type { AgentConfig, ProjectConfig } from './config.js';
import { loadProjectsConfig, saveProjectsConfig, loadConfig } from './config.js';

/**
 * スキャン時にスキップする vendor / ビルド生成物ディレクトリ（#257）。
 * これらの配下には pubspec.yaml 等のマーカーが含まれることがあり、過剰検出の原因になる。
 * （`.` 始まり = .dart_tool / .gradle 等は別途スキップ済み）
 */
const VENDOR_DIRS = new Set([
  'node_modules', 'Pods', 'build', 'DerivedData',
]);

/**
 * Flutter SDK のチェックアウト（`flutter` リポジトリ本体）かどうかを判定する（#257）。
 * SDK は examples/ benchmarks/ packages/ 配下に大量の pubspec.yaml を含むため、
 * プロジェクトとして登録も再帰探索もしない。`bin/flutter` と `packages/flutter` の
 * 両方が存在するディレクトリを SDK とみなす。
 */
async function isFlutterSdkCheckout(dir: string): Promise<boolean> {
  try {
    await fs.access(path.join(dir, 'bin', 'flutter'));
    await fs.access(path.join(dir, 'packages', 'flutter'));
    return true;
  } catch {
    return false;
  }
}

/**
 * プロジェクトディレクトリがディスク上から削除されたかを判定する（幽霊エントリ対策）。
 * `rm -rf` 等で消えたプロジェクトが `projects.yaml` に残り続け、DB 側の #322 照合スイープ
 * （Agent が送ってこなくなった名前をソフトデリート）が永久に発動しない問題への対処。
 * 外付け/ネットワークドライブの一時的な未マウントで大量ソフトデリートが起きないよう、
 * 「親ディレクトリは存在するのに対象ディレクトリだけ無い」場合のみ「削除された」と判定する
 * （親も無い＝未マウントの疑いがあるため、安全側に倒して一覧に残す）。
 */
async function isDeletedFromDisk(projectPath: string): Promise<boolean> {
  try {
    await fs.stat(projectPath);
    return false; // 存在する
  } catch (err: any) {
    if (err.code !== 'ENOENT') {
      return false; // EACCES 等の不明なエラーは安全側に倒して残す
    }
  }
  try {
    await fs.stat(path.dirname(projectPath));
    return true; // 親は存在するのに対象だけ無い → 削除されたと判断
  } catch {
    return false; // 親も無い → 未マウントの疑い、残す
  }
}

/**
 * Server へ送信するプロジェクト一覧を組み立てる。
 * `projectOwnerFilter`（既定 true）が有効な場合、CLAUDE.md 等のマーカーファイルが
 * Agent 実行ユーザーの所有でないプロジェクトを一覧から除外する（#322）。
 * `projectExistenceFilter`（既定 true）が有効な場合、ディスク上から削除されたプロジェクトを
 * 一覧から除外する（幽霊エントリ対策）。
 * `projects.yaml` 自体は書き換えないため、設定を戻す/ディレクトリを復元すれば即座に復活する。
 */
export async function loadProjects(config: AgentConfig): Promise<Project[]> {
  const projectConfigs = await loadProjectsConfig();
  const ownerFilterEnabled = config.projectOwnerFilter !== false;
  const existenceFilterEnabled = config.projectExistenceFilter !== false;

  const filtered: ProjectConfig[] = [];
  let excludedByOwner = 0;
  let excludedByExistence = 0;
  for (const p of projectConfigs) {
    if (existenceFilterEnabled && (await isDeletedFromDisk(p.path))) {
      excludedByExistence++;
      continue;
    }
    if (ownerFilterEnabled) {
      const marker = await detectProjectMarker(p.path);
      if (marker && !(await isOwnedBySelf(marker.file))) {
        excludedByOwner++;
        continue;
      }
    }
    filtered.push(p);
  }

  if (excludedByOwner > 0) {
    console.log(`🔒 Owner filter: excluded ${excludedByOwner} project(s) not owned by ${await selfUserLabel()}`);
  }
  if (excludedByExistence > 0) {
    console.log(`🧹 Existence filter: excluded ${excludedByExistence} project(s) whose directory no longer exists`);
  }

  const projects: Project[] = filtered.map((p) => ({
    name: p.name,
    path: p.path,
    defaultAi: p.defaultAi,
  }));

  return projects;
}

export async function addProject(projectPath: string, name?: string, defaultAi: AiTool = 'claude'): Promise<ProjectConfig> {
  const absolutePath = path.resolve(projectPath);
  
  // Verify path exists
  try {
    const stat = await fs.stat(absolutePath);
    if (!stat.isDirectory()) {
      throw new Error(`${absolutePath} is not a directory`);
    }
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      throw new Error(`Directory not found: ${absolutePath}`);
    }
    throw err;
  }

  // Get project name from directory name if not provided
  const projectName = name || path.basename(absolutePath);

  // Load existing projects
  const projects = await loadProjectsConfig();

  // Check for duplicates
  const existing = projects.find((p) => p.name === projectName || p.path === absolutePath);
  if (existing) {
    throw new Error(`Project already exists: ${existing.name}`);
  }

  // Add new project
  const newProject: ProjectConfig = {
    name: projectName,
    path: absolutePath,
    defaultAi,
  };

  projects.push(newProject);
  await saveProjectsConfig(projects);

  return newProject;
}

export async function removeProject(nameOrPath: string): Promise<void> {
  const projects = await loadProjectsConfig();
  
  const index = projects.findIndex(
    (p) => p.name === nameOrPath || p.path === nameOrPath
  );

  if (index === -1) {
    throw new Error(`Project not found: ${nameOrPath}`);
  }

  projects.splice(index, 1);
  await saveProjectsConfig(projects);
}

export async function scanProjects(baseDir: string, maxDepth: number = 1, defaultAi: AiTool = 'claude'): Promise<ProjectConfig[]> {
  const found: ProjectConfig[] = [];
  const existing = await loadProjectsConfig();
  const existingPaths = new Set(existing.map((p) => p.path));

  // 所有者フィルタ設定を読み込む（既定 true、#322）。無効化していれば従来どおり全ユーザー分を検出する。
  const agentConfig = await loadConfig();
  const ownerFilterEnabled = agentConfig.projectOwnerFilter !== false;
  let excludedByOwner = 0;

  async function scan(dir: string, depth: number) {
    if (depth > maxDepth) return;

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.')) continue;
        // vendor / ビルド生成物ディレクトリはスキップ（node_modules / Pods / build / DerivedData 等、#257）
        if (VENDOR_DIRS.has(entry.name)) continue;

        const fullPath = path.join(dir, entry.name);

        // Flutter SDK チェックアウトは examples/benchmarks 配下に大量の pubspec.yaml を含むため、
        // 登録も再帰もせず丸ごとスキップする（過剰検出防止、#257）
        if (await isFlutterSdkCheckout(fullPath)) continue;

        // Check if this looks like a project
        const detected = await detectProjectMarker(fullPath);

        if (detected) {
          // 所有者フィルタ: マーカーファイルが自分の所有でなければ登録も再帰もしない（#322）。
          // Flutter SDK チェックアウトと同様、プロジェクト境界とみなして探索を打ち切る。
          if (ownerFilterEnabled && !(await isOwnedBySelf(detected.file))) {
            excludedByOwner++;
            continue;
          }
          // プロジェクト検出: 未登録なら追加。いずれの場合も内部へは再帰しない（#257）
          // 登録済みプロジェクトの内部へ再帰すると SDK / サブモジュール / ネイティブ層（android・ios・macos）を
          // 過剰検出してしまうため、プロジェクト境界で探索を止める
          if (!existingPaths.has(fullPath)) {
            found.push({
              name: entry.name,
              path: fullPath,
              defaultAi,
            });
          }
        } else if (depth < maxDepth) {
          await scan(fullPath, depth + 1);
        }
      }
    } catch (err) {
      // Ignore permission errors
    }
  }

  // baseDir 自体も CLAUDE.md チェック（ホームディレクトリ直下に CLAUDE.md がある場合に対応）
  const baseDetected = await detectProjectMarker(baseDir);
  if (baseDetected) {
    if (!ownerFilterEnabled || (await isOwnedBySelf(baseDetected.file))) {
      if (!existingPaths.has(baseDir)) {
        found.push({
          name: path.basename(baseDir) || baseDir,
          path: baseDir,
          defaultAi,
        });
      }
    } else {
      excludedByOwner++;
    }
  }

  await scan(baseDir, 0);

  if (excludedByOwner > 0) {
    console.log(`🔒 Owner filter: excluded ${excludedByOwner} project(s) not owned by ${await selfUserLabel()} while scanning ${baseDir}`);
  }

  return found;
}

/** プロジェクト検出マーカーの種別 */
type ProjectMarker = 'claude' | 'flutter' | 'android' | 'xcode';

/** 検出結果: マーカー種別 + 実際に見つかったマーカーファイル/ディレクトリの絶対パス（所有者判定用、#322） */
interface DetectedMarker {
  marker: ProjectMarker;
  file: string;
}

/**
 * ディレクトリがプロジェクトかどうかを検出し、マーカー種別とマーカーファイルのパスを返す。
 * 検出できなければ null を返す。
 *
 * 生の `flutter create` / `gradle init` で作られた（CLAUDE.md 無しの）プロジェクトも
 * 認識できるよう、pubspec.yaml / settings.gradle(.kts) をマーカーに含める（#255）。
 */
async function detectProjectMarker(dir: string): Promise<DetectedMarker | null> {
  // CLAUDE.md が存在すればプロジェクトとして認識（最優先）
  const claudeMdPath = path.join(dir, 'CLAUDE.md');
  try {
    await fs.access(claudeMdPath);
    return { marker: 'claude', file: claudeMdPath };
  } catch {}

  // ディレクトリエントリを 1 回だけ読んで各マーカーを判定
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return null;
  }

  // .xcodeproj ディレクトリ（iOS/macOS 開発）
  const xcodeproj = entries.find(e => e.endsWith('.xcodeproj'));
  if (xcodeproj) return { marker: 'xcode', file: path.join(dir, xcodeproj) };
  // pubspec.yaml（Flutter/Dart）
  if (entries.includes('pubspec.yaml')) return { marker: 'flutter', file: path.join(dir, 'pubspec.yaml') };
  // settings.gradle / settings.gradle.kts（Android/Gradle）
  if (entries.includes('settings.gradle')) return { marker: 'android', file: path.join(dir, 'settings.gradle') };
  if (entries.includes('settings.gradle.kts')) return { marker: 'android', file: path.join(dir, 'settings.gradle.kts') };

  return null;
}

/**
 * マーカーファイル/ディレクトリの所有者が Agent 実行ユーザー自身かどうかを判定する（#322）。
 * `/opt` 等に複数ユーザーのプロジェクトが同居する環境で、他ユーザー所有のプロジェクトを
 * 誤って検出・登録しないためのフィルタ（可視性のためのフィルタであり、OS のアクセス制御の代替ではない）。
 *
 * - Windows（`process.getuid` が存在しない）: 常に true（従来動作を維持、判定対象外）
 * - root（uid=0）で実行中の Agent: 常に true（全ユーザーのプロジェクトを面倒見る運用を壊さない）
 * - stat 失敗（権限不足等で判定不能）: 常に true（安全側＝除外しない）
 */
async function isOwnedBySelf(markerFile: string): Promise<boolean> {
  const getuid = (process as any).getuid;
  if (typeof getuid !== 'function') return true; // Windows 等
  const selfUid = getuid.call(process);
  if (selfUid === 0) return true; // root 実行は常に許可

  try {
    const stat = await fs.stat(markerFile);
    return stat.uid === selfUid;
  } catch {
    return true; // 判定不能なら除外しない
  }
}

/** ログ表示用の「自ユーザー」ラベル（例: devrelay(uid=1001)）。Windows 等では 'self' を返す */
async function selfUserLabel(): Promise<string> {
  const getuid = (process as any).getuid;
  if (typeof getuid !== 'function') return 'self';
  try {
    const os = await import('os');
    return `${os.userInfo().username}(uid=${getuid.call(process)})`;
  } catch {
    return `uid=${getuid.call(process)}`;
  }
}

/**
 * マーカー種別ごとの最小限 CLAUDE.md を生成する。
 */
function generateAutoClaudeMd(name: string, marker: ProjectMarker): string {
  const kindLabel: Record<ProjectMarker, string> = {
    claude: '一般',
    flutter: 'Flutter/Dart',
    android: 'Android (Gradle)',
    xcode: 'iOS/macOS (Xcode)',
  };
  return `# ${name}

> ${kindLabel[marker]} プロジェクト（DevRelay が自動生成した CLAUDE.md）

このファイルは DevRelay がプロジェクトを認識するために自動作成されました。
プロジェクトの概要・技術スタック・開発ルールをここに追記してください。

## ルール参照
- \`rules/devrelay.md\` - DevRelay 共通ルール（\`ag\` / \`agreement\` コマンドで生成）
`;
}

/**
 * マーカー検出（pubspec.yaml 等）で新規登録されたプロジェクトに CLAUDE.md が無い場合、
 * 最小限の CLAUDE.md を書き込む。DevRelay の「プロジェクトには CLAUDE.md 必須」ポリシーを維持する。
 * 書き込み失敗（権限等）は warn ログのみで登録は継続する（非致命的）。
 */
async function ensureAutoClaudeMd(dir: string, name: string): Promise<void> {
  const claudeMdPath = path.join(dir, 'CLAUDE.md');
  try {
    await fs.access(claudeMdPath);
    return; // 既に存在するなら何もしない（既存プロジェクトを上書きしない）
  } catch {}

  const detected = await detectProjectMarker(dir);
  // ここに来る時点で CLAUDE.md は無いため marker は flutter/android/xcode のいずれか（保険で claude 扱い）
  const effectiveMarker: ProjectMarker = detected && detected.marker !== 'claude' ? detected.marker : 'claude';
  try {
    await fs.writeFile(claudeMdPath, generateAutoClaudeMd(name, effectiveMarker), 'utf-8');
    console.log(`   📝 Auto-created CLAUDE.md for ${name} (${effectiveMarker})`);
  } catch (err) {
    console.warn(`   ⚠️ Failed to auto-create CLAUDE.md for ${name}: ${(err as Error).message}`);
  }
}

export async function listProjects(): Promise<ProjectConfig[]> {
  return loadProjectsConfig();
}

/**
 * 既存プロジェクトと名前が衝突しないユニークなプロジェクト名を生成する（#284）。
 * trunk/branch 構成など同名フォルダ（例: d:\iap\lafit と d:\iap_trunk\lafit）を
 * 両方登録できるようにするため、まず親フォルダ名を付与（"lafit (iap_trunk)"）し、
 * それでも衝突する場合は連番（"lafit-2", "lafit-3"...）を付ける。
 */
function makeUniqueProjectName(desiredName: string, projectPath: string, existing: ProjectConfig[]): string {
  const taken = new Set(existing.map(p => p.name));
  if (!taken.has(desiredName)) return desiredName;
  // 親フォルダ名を付与して区別
  const parent = path.basename(path.dirname(projectPath));
  const withParent = `${desiredName} (${parent})`;
  if (parent && !taken.has(withParent)) return withParent;
  // それでも衝突するなら連番
  let n = 2;
  while (taken.has(`${desiredName}-${n}`)) n++;
  return `${desiredName}-${n}`;
}

/**
 * 指定ディレクトリをスキャンして CLAUDE.md があるプロジェクトを自動登録
 *
 * @param defaultAi 新規登録するプロジェクトの既定 AI ツール。config.yaml の
 *   `aiTools.default`（Devin 専用マシンなら 'devin' 等）を渡すことで、claude 未ログインの
 *   マシンでも自動検出プロジェクトが正しい AI で起動する。省略時は従来通り 'claude'。
 */
export async function autoDiscoverProjects(baseDir: string, maxDepth: number = 5, defaultAi: AiTool = 'claude'): Promise<number> {
  console.log(`🔍 Scanning for projects with CLAUDE.md in ${baseDir}... (defaultAi=${defaultAi})`);

  const discovered = await scanProjects(baseDir, maxDepth, defaultAi);

  if (discovered.length === 0) {
    console.log('   No new projects found');
    return 0;
  }

  // 既存のプロジェクト一覧を取得
  const existing = await loadProjectsConfig();

  // 新規プロジェクトを追加
  let added = 0;
  for (const project of discovered) {
    // path 重複は同一プロジェクトの二重登録なのでスキップ
    if (existing.some(p => p.path === project.path)) continue;
    // name のみ重複する場合は自動リネームして登録（#284: 同名フォルダ対策）
    const uniqueName = makeUniqueProjectName(project.name, project.path, existing);
    const entry: ProjectConfig = { ...project, name: uniqueName };
    existing.push(entry);
    const renamedNote = uniqueName !== project.name ? ` [renamed: name conflict with "${project.name}"]` : '';
    console.log(`   ✅ Added: ${entry.name} (${entry.path})${renamedNote}`);
    added++;

    // CLAUDE.md 自動配置: マーカー検出（pubspec.yaml 等）で登録されたが
    // CLAUDE.md が無いプロジェクトに最小限の CLAUDE.md を書き込む（#255・非致命的）
    await ensureAutoClaudeMd(entry.path, entry.name);
  }

  if (added > 0) {
    await saveProjectsConfig(existing);
  }

  console.log(`   Found ${added} new project(s)`);
  return added;
}
