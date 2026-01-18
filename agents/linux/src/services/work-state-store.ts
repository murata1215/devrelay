import { readFile, writeFile, mkdir, rename } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import type { WorkState } from '@devrelay/shared';

const DEVRELAY_DIR = '.devrelay';
const WORK_STATE_FILE = 'work_state.json';
const WORK_STATES_DIR = 'work-states';

function getWorkStatePath(projectPath: string): string {
  return join(projectPath, DEVRELAY_DIR, WORK_STATE_FILE);
}

function getWorkStatesDir(projectPath: string): string {
  return join(projectPath, DEVRELAY_DIR, WORK_STATES_DIR);
}

function generateArchiveFilename(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  return `work_state_${year}${month}${day}_${hours}${minutes}${seconds}.json`;
}

/**
 * Save work state to project directory
 */
export async function saveWorkState(
  projectPath: string,
  workState: WorkState
): Promise<void> {
  const dirPath = join(projectPath, DEVRELAY_DIR);
  const filePath = getWorkStatePath(projectPath);

  try {
    // Ensure directory exists
    if (!existsSync(dirPath)) {
      await mkdir(dirPath, { recursive: true });
    }

    await writeFile(filePath, JSON.stringify(workState, null, 2), 'utf-8');
    console.log(`💾 Work state saved to ${filePath}`);
  } catch (err) {
    console.error(`❌ Could not save work state:`, (err as Error).message);
    throw err;
  }
}

/**
 * Load work state from project directory (if exists)
 * Returns null if no work state file exists
 */
export async function loadWorkState(projectPath: string): Promise<WorkState | null> {
  const filePath = getWorkStatePath(projectPath);

  try {
    if (!existsSync(filePath)) {
      return null;
    }

    const content = await readFile(filePath, 'utf-8');
    const workState: WorkState = JSON.parse(content);

    console.log(`📂 Loaded work state: ${workState.summary}`);
    return workState;
  } catch (err) {
    console.warn(`⚠️ Could not load work state:`, (err as Error).message);
    return null;
  }
}

/**
 * Archive work state file (move to work-states/ with timestamp)
 * Called after work state is loaded and used
 */
export async function archiveWorkState(projectPath: string): Promise<void> {
  const filePath = getWorkStatePath(projectPath);
  const archiveDir = getWorkStatesDir(projectPath);

  try {
    if (!existsSync(filePath)) {
      return;
    }

    // Ensure archive directory exists
    if (!existsSync(archiveDir)) {
      await mkdir(archiveDir, { recursive: true });
    }

    const archiveFilename = generateArchiveFilename();
    const archivePath = join(archiveDir, archiveFilename);

    await rename(filePath, archivePath);
    console.log(`📦 Work state archived to ${archivePath}`);
  } catch (err) {
    console.error(`❌ Could not archive work state:`, (err as Error).message);
  }
}

/**
 * Check if there is a pending work state for a project
 */
export async function hasPendingWorkState(projectPath: string): Promise<boolean> {
  const filePath = getWorkStatePath(projectPath);
  return existsSync(filePath);
}

/**
 * Format work state for including in prompt to Claude
 */
export function formatWorkStateForPrompt(workState: WorkState): string {
  const todoListStr = workState.todoList
    .map(t => {
      const statusIcon = t.status === 'completed' ? '✅' : t.status === 'in_progress' ? '🔄' : '⬜';
      return `  ${statusIcon} ${t.task}`;
    })
    .join('\n');

  const filesStr = workState.context.filesModified.length > 0
    ? `\n変更済みファイル:\n${workState.context.filesModified.map(f => `  - ${f}`).join('\n')}`
    : '';

  const restartStr = workState.restartInfo
    ? `\n再起動理由: ${workState.restartInfo.reason}`
    : '';

  return `
【前回の作業状態を継続】
作業概要: ${workState.summary}
作成日時: ${workState.createdAt}
${restartStr}

TODO リスト:
${todoListStr}
${filesStr}

前回の最後のメッセージ:
${workState.context.lastMessage}

---
上記の作業を継続してください。まず現在の状態を確認し、次に行うべきタスクを実行してください。
`.trim();
}
