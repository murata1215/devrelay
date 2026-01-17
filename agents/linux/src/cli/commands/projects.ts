import type { AiTool } from '@devbridge/shared';
import { loadConfig } from '../../services/config.js';
import { 
  listProjects, 
  addProject, 
  removeProject, 
  scanProjects 
} from '../../services/projects.js';

interface ProjectsOptions {
  ai?: string;
}

export async function projectsCommand(
  action?: string, 
  path?: string, 
  options?: ProjectsOptions
) {
  const config = await loadConfig();
  
  switch (action) {
    case 'list':
    case undefined:
      await listProjectsAction();
      break;
      
    case 'add':
      if (!path) {
        console.error('❌ Path required. Usage: devbridge projects add <path>');
        process.exit(1);
      }
      await addProjectAction(path, options?.ai as AiTool);
      break;
      
    case 'remove':
    case 'rm':
      if (!path) {
        console.error('❌ Name or path required. Usage: devbridge projects remove <name|path>');
        process.exit(1);
      }
      await removeProjectAction(path);
      break;
      
    case 'scan':
      for (const dir of config.projectsDirs) {
        await scanProjectsAction(dir);
      }
      break;
      
    default:
      console.error(`❌ Unknown action: ${action}`);
      console.log('Available actions: list, add, remove, scan');
      process.exit(1);
  }
}

async function listProjectsAction() {
  const projects = await listProjects();
  
  if (projects.length === 0) {
    console.log('📁 No projects registered.');
    console.log('');
    console.log('Add a project:');
    console.log('  devbridge projects add /path/to/project');
    console.log('');
    console.log('Or scan for projects:');
    console.log('  devbridge projects scan');
    return;
  }
  
  console.log('📁 Registered Projects:\n');
  
  projects.forEach((p, i) => {
    console.log(`${i + 1}. ${p.name}`);
    console.log(`   Path: ${p.path}`);
    console.log(`   AI:   ${p.defaultAi}`);
    console.log('');
  });
}

async function addProjectAction(projectPath: string, ai?: AiTool) {
  try {
    const project = await addProject(projectPath, undefined, ai || 'claude');
    console.log(`✅ Added project: ${project.name}`);
    console.log(`   Path: ${project.path}`);
    console.log(`   AI:   ${project.defaultAi}`);
  } catch (err: any) {
    console.error(`❌ Failed to add project: ${err.message}`);
    process.exit(1);
  }
}

async function removeProjectAction(nameOrPath: string) {
  try {
    await removeProject(nameOrPath);
    console.log(`✅ Removed project: ${nameOrPath}`);
  } catch (err: any) {
    console.error(`❌ Failed to remove project: ${err.message}`);
    process.exit(1);
  }
}

async function scanProjectsAction(baseDir: string) {
  console.log(`🔍 Scanning for projects in ${baseDir}...\n`);
  
  const found = await scanProjects(baseDir, 2);
  
  if (found.length === 0) {
    console.log('No new projects found.');
    return;
  }
  
  console.log(`Found ${found.length} project(s):\n`);
  
  found.forEach((p, i) => {
    console.log(`${i + 1}. ${p.name}`);
    console.log(`   ${p.path}`);
  });
  
  console.log('');
  console.log('To add a project, run:');
  console.log('  devbridge projects add <path>');
}
