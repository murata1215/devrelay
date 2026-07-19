import fs from 'fs/promises';
import path from 'path';
import type { Project, AiTool } from '@devrelay/shared';
import type { AgentConfig, ProjectConfig } from './config.js';
import { loadProjectsConfig, saveProjectsConfig } from './config.js';

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

export async function loadProjects(config: AgentConfig): Promise<Project[]> {
  const projectConfigs = await loadProjectsConfig();
  
  const projects: Project[] = projectConfigs.map((p) => ({
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
        const isProject = await looksLikeProject(fullPath);

        if (isProject) {
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
  const baseIsProject = await looksLikeProject(baseDir);
  if (baseIsProject && !existingPaths.has(baseDir)) {
    found.push({
      name: path.basename(baseDir) || baseDir,
      path: baseDir,
      defaultAi,
    });
  }

  await scan(baseDir, 0);
  return found;
}

/** プロジェクト検出マーカーの種別 */
type ProjectMarker = 'claude' | 'flutter' | 'android' | 'xcode';

/**
 * ディレクトリがプロジェクトかどうかを検出し、マーカー種別を返す。
 * 検出できなければ null を返す。
 *
 * 生の `flutter create` / `gradle init` で作られた（CLAUDE.md 無しの）プロジェクトも
 * 認識できるよう、pubspec.yaml / settings.gradle(.kts) をマーカーに含める（#255）。
 */
async function detectProjectMarker(dir: string): Promise<ProjectMarker | null> {
  // CLAUDE.md が存在すればプロジェクトとして認識（最優先）
  try {
    await fs.access(path.join(dir, 'CLAUDE.md'));
    return 'claude';
  } catch {}

  // ディレクトリエントリを 1 回だけ読んで各マーカーを判定
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return null;
  }

  // .xcodeproj ディレクトリ（iOS/macOS 開発）
  if (entries.some(e => e.endsWith('.xcodeproj'))) return 'xcode';
  // pubspec.yaml（Flutter/Dart）
  if (entries.includes('pubspec.yaml')) return 'flutter';
  // settings.gradle / settings.gradle.kts（Android/Gradle）
  if (entries.includes('settings.gradle') || entries.includes('settings.gradle.kts')) return 'android';

  return null;
}

async function looksLikeProject(dir: string): Promise<boolean> {
  return (await detectProjectMarker(dir)) !== null;
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

  const marker = await detectProjectMarker(dir);
  // ここに来る時点で CLAUDE.md は無いため marker は flutter/android/xcode のいずれか（保険で claude 扱い）
  const effectiveMarker: ProjectMarker = marker && marker !== 'claude' ? marker : 'claude';
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
    // 重複チェック
    const isDuplicate = existing.some(p => p.path === project.path || p.name === project.name);
    if (!isDuplicate) {
      existing.push(project);
      console.log(`   ✅ Added: ${project.name} (${project.path})`);
      added++;

      // CLAUDE.md 自動配置: マーカー検出（pubspec.yaml 等）で登録されたが
      // CLAUDE.md が無いプロジェクトに最小限の CLAUDE.md を書き込む（#255・非致命的）
      await ensureAutoClaudeMd(project.path, project.name);
    }
  }

  if (added > 0) {
    await saveProjectsConfig(existing);
  }

  console.log(`   Found ${added} new project(s)`);
  return added;
}
