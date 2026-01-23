/**
 * Task Watcher Service
 *
 * Monitors .devrelay-tasks/outgoing/ directory for task files created by Claude Code
 * and sends them to the server via WebSocket.
 */

import { watch, FSWatcher } from 'fs';
import { readFile, unlink, mkdir, readdir, writeFile } from 'fs/promises';
import { join, basename } from 'path';
import { existsSync } from 'fs';
import type {
  TaskFile,
  TaskFileCreate,
  TaskFileComplete,
  TaskFileFail,
  TaskFileStart,
  TaskFileComment,
  TaskAssignedPayload,
  TaskCompletedNotifyPayload,
  TaskListPayload,
  FileAttachment,
} from '@devrelay/shared';

const TASKS_DIR = '.devrelay-tasks';
const OUTGOING_DIR = 'outgoing';
const INCOMING_DIR = 'incoming';

// Watchers per project
const projectWatchers = new Map<string, FSWatcher>();

// Callbacks
let onTaskCreate: ((projectPath: string, task: TaskFileCreate) => Promise<void>) | null = null;
let onTaskComplete: ((projectPath: string, task: TaskFileComplete) => Promise<void>) | null = null;
let onTaskFail: ((projectPath: string, task: TaskFileFail) => Promise<void>) | null = null;
let onTaskStart: ((projectPath: string, task: TaskFileStart) => Promise<void>) | null = null;
let onTaskComment: ((projectPath: string, task: TaskFileComment) => Promise<void>) | null = null;

/**
 * Set callbacks for task events
 */
export function setTaskCallbacks(callbacks: {
  onCreate?: (projectPath: string, task: TaskFileCreate) => Promise<void>;
  onComplete?: (projectPath: string, task: TaskFileComplete) => Promise<void>;
  onFail?: (projectPath: string, task: TaskFileFail) => Promise<void>;
  onStart?: (projectPath: string, task: TaskFileStart) => Promise<void>;
  onComment?: (projectPath: string, task: TaskFileComment) => Promise<void>;
}) {
  onTaskCreate = callbacks.onCreate || null;
  onTaskComplete = callbacks.onComplete || null;
  onTaskFail = callbacks.onFail || null;
  onTaskStart = callbacks.onStart || null;
  onTaskComment = callbacks.onComment || null;
}

/**
 * Start watching a project's outgoing tasks directory
 */
export async function startWatchingProject(projectPath: string): Promise<void> {
  const outgoingDir = join(projectPath, TASKS_DIR, OUTGOING_DIR);

  // Create directories if they don't exist
  await ensureTaskDirectories(projectPath);

  // Skip if already watching
  if (projectWatchers.has(projectPath)) {
    return;
  }

  // Process any existing files first
  await processExistingFiles(projectPath);

  // Start watching
  try {
    const watcher = watch(outgoingDir, async (eventType, filename) => {
      if (eventType === 'rename' && filename && filename.endsWith('.json')) {
        // Small delay to ensure file is fully written
        await new Promise(resolve => setTimeout(resolve, 100));
        await processTaskFile(projectPath, join(outgoingDir, filename));
      }
    });

    projectWatchers.set(projectPath, watcher);
    console.log(`📁 Watching tasks for: ${projectPath}`);
  } catch (err) {
    console.error(`❌ Failed to watch tasks for ${projectPath}:`, err);
  }
}

/**
 * Stop watching a project's tasks directory
 */
export function stopWatchingProject(projectPath: string): void {
  const watcher = projectWatchers.get(projectPath);
  if (watcher) {
    watcher.close();
    projectWatchers.delete(projectPath);
    console.log(`📁 Stopped watching tasks for: ${projectPath}`);
  }
}

/**
 * Stop all watchers
 */
export function stopAllWatchers(): void {
  for (const [projectPath, watcher] of projectWatchers) {
    watcher.close();
    console.log(`📁 Stopped watching tasks for: ${projectPath}`);
  }
  projectWatchers.clear();
}

/**
 * Ensure task directories exist
 */
async function ensureTaskDirectories(projectPath: string): Promise<void> {
  const tasksDir = join(projectPath, TASKS_DIR);
  const outgoingDir = join(tasksDir, OUTGOING_DIR);
  const incomingDir = join(tasksDir, INCOMING_DIR);

  if (!existsSync(tasksDir)) {
    await mkdir(tasksDir, { recursive: true });
  }
  if (!existsSync(outgoingDir)) {
    await mkdir(outgoingDir, { recursive: true });
  }
  if (!existsSync(incomingDir)) {
    await mkdir(incomingDir, { recursive: true });
  }
}

/**
 * Process existing task files in outgoing directory
 */
async function processExistingFiles(projectPath: string): Promise<void> {
  const outgoingDir = join(projectPath, TASKS_DIR, OUTGOING_DIR);

  try {
    const files = await readdir(outgoingDir);
    for (const file of files) {
      if (file.endsWith('.json')) {
        await processTaskFile(projectPath, join(outgoingDir, file));
      }
    }
  } catch (err) {
    // Directory might not exist yet
  }
}

/**
 * Process a single task file
 */
async function processTaskFile(projectPath: string, filePath: string): Promise<void> {
  try {
    // Check if file exists
    if (!existsSync(filePath)) {
      return;
    }

    const content = await readFile(filePath, 'utf-8');
    const taskFile: TaskFile = JSON.parse(content);

    console.log(`📝 Processing task file: ${basename(filePath)} (action: ${taskFile.action})`);

    switch (taskFile.action) {
      case 'create':
        if (onTaskCreate) {
          await onTaskCreate(projectPath, taskFile as TaskFileCreate);
        }
        break;

      case 'complete':
        if (onTaskComplete) {
          await onTaskComplete(projectPath, taskFile as TaskFileComplete);
        }
        break;

      case 'fail':
        if (onTaskFail) {
          await onTaskFail(projectPath, taskFile as TaskFileFail);
        }
        break;

      case 'start':
        if (onTaskStart) {
          await onTaskStart(projectPath, taskFile as TaskFileStart);
        }
        break;

      case 'comment':
        if (onTaskComment) {
          await onTaskComment(projectPath, taskFile as TaskFileComment);
        }
        break;
    }

    // Delete the processed file
    await unlink(filePath);
    console.log(`✅ Processed and deleted: ${basename(filePath)}`);
  } catch (err) {
    console.error(`❌ Error processing task file ${filePath}:`, err);
  }
}

/**
 * Save an incoming task to the project's incoming directory
 */
export async function saveIncomingTask(projectPath: string, payload: TaskAssignedPayload): Promise<void> {
  const incomingDir = join(projectPath, TASKS_DIR, INCOMING_DIR);
  await ensureTaskDirectories(projectPath);

  const filename = `task-${payload.taskId}.json`;
  const filePath = join(incomingDir, filename);

  const taskData = {
    taskId: payload.taskId,
    name: payload.name,
    description: payload.description,
    priority: payload.priority,
    senderProjectName: payload.senderProjectName,
    senderMachineName: payload.senderMachineName,
    parentTaskId: payload.parentTaskId,
    receivedAt: new Date().toISOString(),
  };

  await writeFile(filePath, JSON.stringify(taskData, null, 2), 'utf-8');
  console.log(`📥 Saved incoming task: ${filename}`);

  // If attachments exist, save them
  if (payload.attachments && payload.attachments.length > 0) {
    const attachmentsDir = join(incomingDir, `task-${payload.taskId}-attachments`);
    await mkdir(attachmentsDir, { recursive: true });

    for (const attachment of payload.attachments) {
      const attachmentPath = join(attachmentsDir, attachment.filename);
      const content = Buffer.from(attachment.content, 'base64');
      await writeFile(attachmentPath, content);
      console.log(`📎 Saved attachment: ${attachment.filename}`);
    }
  }
}

/**
 * Save a task completion notification
 */
export async function saveTaskCompletionNotification(
  projectPath: string,
  payload: TaskCompletedNotifyPayload
): Promise<void> {
  const incomingDir = join(projectPath, TASKS_DIR, INCOMING_DIR);
  await ensureTaskDirectories(projectPath);

  const filename = `result-${payload.taskId}.json`;
  const filePath = join(incomingDir, filename);

  const resultData = {
    taskId: payload.taskId,
    name: payload.name,
    status: payload.status,
    resultNotes: payload.resultNotes,
    error: payload.error,
    executorProjectName: payload.executorProjectName,
    executorMachineName: payload.executorMachineName,
    receivedAt: new Date().toISOString(),
  };

  await writeFile(filePath, JSON.stringify(resultData, null, 2), 'utf-8');
  console.log(`📥 Saved task result: ${filename}`);

  // If result files exist, save them
  if (payload.resultFiles && payload.resultFiles.length > 0) {
    const filesDir = join(incomingDir, `result-${payload.taskId}-files`);
    await mkdir(filesDir, { recursive: true });

    for (const file of payload.resultFiles) {
      const filePath = join(filesDir, file.filename);
      const content = Buffer.from(file.content, 'base64');
      await writeFile(filePath, content);
      console.log(`📎 Saved result file: ${file.filename}`);
    }
  }
}

/**
 * Read file content as base64 FileAttachment
 */
export async function readFileAsAttachment(filePath: string): Promise<FileAttachment | null> {
  try {
    const content = await readFile(filePath);
    const filename = basename(filePath);
    const mimeType = getMimeType(filename);

    return {
      filename,
      content: content.toString('base64'),
      mimeType,
      size: content.length,
    };
  } catch (err) {
    console.error(`❌ Error reading file ${filePath}:`, err);
    return null;
  }
}

/**
 * Get MIME type from filename
 */
function getMimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const mimeTypes: Record<string, string> = {
    'txt': 'text/plain',
    'md': 'text/markdown',
    'json': 'application/json',
    'yaml': 'application/yaml',
    'yml': 'application/yaml',
    'js': 'text/javascript',
    'ts': 'text/typescript',
    'py': 'text/x-python',
    'diff': 'text/x-diff',
    'patch': 'text/x-diff',
    'html': 'text/html',
    'css': 'text/css',
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif',
    'svg': 'image/svg+xml',
    'pdf': 'application/pdf',
    'zip': 'application/zip',
  };

  return mimeTypes[ext] || 'application/octet-stream';
}

/**
 * Get pending incoming tasks for a project (for Claude Code to process)
 */
export async function getPendingIncomingTasks(projectPath: string): Promise<string[]> {
  const incomingDir = join(projectPath, TASKS_DIR, INCOMING_DIR);

  try {
    const files = await readdir(incomingDir);
    // Return task files (not result files)
    return files.filter(f => f.startsWith('task-') && f.endsWith('.json'));
  } catch (err) {
    return [];
  }
}
