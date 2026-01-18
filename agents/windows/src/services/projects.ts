import fs from 'fs/promises';
import path from 'path';
import type { Project, AiTool } from '@devrelay/shared';
import type { AgentConfig, ProjectConfig } from './config.js';
import { loadProjectsConfig, saveProjectsConfig } from './config.js';

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

export async function scanProjects(baseDir: string, maxDepth: number = 1): Promise<ProjectConfig[]> {
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
        if (entry.name === 'node_modules') continue;

        const fullPath = path.join(dir, entry.name);

        // Check if this looks like a project
        const isProject = await looksLikeProject(fullPath);

        if (isProject && !existingPaths.has(fullPath)) {
          found.push({
            name: entry.name,
            path: fullPath,
            defaultAi: 'claude',
          });
        } else if (depth < maxDepth) {
          await scan(fullPath, depth + 1);
        }
      }
    } catch (err) {
      // Ignore permission errors
    }
  }

  await scan(baseDir, 0);
  return found;
}

async function looksLikeProject(dir: string): Promise<boolean> {
  // Recognize as project if CLAUDE.md exists
  try {
    await fs.access(path.join(dir, 'CLAUDE.md'));
    return true;
  } catch {
    return false;
  }
}

export async function listProjects(): Promise<ProjectConfig[]> {
  return loadProjectsConfig();
}

/**
 * Scan specified directory and auto-register projects with CLAUDE.md
 */
export async function autoDiscoverProjects(baseDir: string, maxDepth: number = 5): Promise<number> {
  console.log(`Scanning for projects with CLAUDE.md in ${baseDir}...`);

  const discovered = await scanProjects(baseDir, maxDepth);

  if (discovered.length === 0) {
    console.log('   No new projects found');
    return 0;
  }

  // Get existing project list
  const existing = await loadProjectsConfig();

  // Add new projects
  let added = 0;
  for (const project of discovered) {
    // Duplicate check
    const isDuplicate = existing.some(p => p.path === project.path || p.name === project.name);
    if (!isDuplicate) {
      existing.push(project);
      console.log(`   Added: ${project.name} (${project.path})`);
      added++;
    }
  }

  if (added > 0) {
    await saveProjectsConfig(existing);
  }

  console.log(`   Found ${added} new project(s)`);
  return added;
}
