/**
 * Cross-Project Task Manager
 *
 * プロジェクト間でタスクをやり取りするための管理サービス
 */

import { PrismaClient } from '@prisma/client';
import type {
  TaskCreatePayload,
  TaskCompletePayload,
  TaskFailPayload,
  TaskStartPayload,
  TaskCommentPayload,
  TaskAssignedPayload,
  TaskCompletedNotifyPayload,
  TaskListPayload,
  CrossProjectTask,
  TaskStatus,
  TaskPriority,
  FileAttachment,
} from '@devrelay/shared';

const prisma = new PrismaClient();

// =============================================================================
// Task CRUD Operations
// =============================================================================

/**
 * タスク作成
 */
export async function createTask(
  payload: TaskCreatePayload
): Promise<{ task: CrossProjectTask; receiverMachineId?: string }> {
  const { machineId, senderProjectPath, receiverProjectPath, receiverMachineName, name, description, priority, parentTaskId, attachments } = payload;

  // 送信元プロジェクトを取得
  const senderProject = await prisma.project.findFirst({
    where: {
      path: senderProjectPath,
      machine: { id: machineId },
    },
    include: { machine: true },
  });

  if (!senderProject) {
    throw new Error(`Sender project not found: ${senderProjectPath}`);
  }

  // 受信先プロジェクトを検索（指定されている場合）
  let receiverProject = null;
  if (receiverProjectPath) {
    const whereClause: Record<string, unknown> = { path: receiverProjectPath };
    if (receiverMachineName) {
      whereClause.machine = { name: receiverMachineName };
    }
    receiverProject = await prisma.project.findFirst({
      where: whereClause,
      include: { machine: true },
    });
  } else if (receiverMachineName) {
    // マシン名のみ指定された場合、そのマシンの最初のプロジェクトを使用
    const machine = await prisma.machine.findFirst({
      where: { name: receiverMachineName, userId: senderProject.machine.userId },
      include: { projects: true },
    });
    if (machine && machine.projects.length > 0) {
      receiverProject = { ...machine.projects[0], machine };
    }
  }

  // タスク作成
  const task = await prisma.crossProjectTask.create({
    data: {
      senderProjectId: senderProject.id,
      receiverProjectId: receiverProject?.id,
      name,
      description,
      priority: priority || 'normal',
      parentTaskId,
      status: receiverProject ? 'assigned' : 'pending',
      assignedAt: receiverProject ? new Date() : null,
    },
  });

  // 添付ファイルがあれば保存
  if (attachments && attachments.length > 0) {
    await prisma.taskAttachment.createMany({
      data: attachments.map(att => ({
        taskId: task.id,
        filename: att.filename,
        mimeType: att.mimeType,
        size: att.size,
        content: att.content,
        uploadedBy: senderProject.id,
      })),
    });
  }

  // アクティビティログ
  await prisma.taskActivityLog.create({
    data: {
      taskId: task.id,
      projectId: senderProject.id,
      action: 'created',
      details: JSON.stringify({ name, priority }),
    },
  });

  if (receiverProject) {
    await prisma.taskActivityLog.create({
      data: {
        taskId: task.id,
        projectId: senderProject.id,
        action: 'assigned',
        details: JSON.stringify({ receiverProjectId: receiverProject.id }),
      },
    });
  }

  const result: CrossProjectTask = {
    id: task.id,
    senderProjectId: task.senderProjectId,
    senderProjectName: senderProject.name,
    senderMachineName: senderProject.machine.name,
    receiverProjectId: task.receiverProjectId || undefined,
    receiverProjectName: receiverProject?.name,
    receiverMachineName: receiverProject?.machine?.name,
    name: task.name,
    description: task.description,
    status: task.status as TaskStatus,
    priority: task.priority as TaskPriority,
    createdAt: task.createdAt.toISOString(),
    assignedAt: task.assignedAt?.toISOString(),
    parentTaskId: task.parentTaskId || undefined,
  };

  return {
    task: result,
    receiverMachineId: receiverProject?.machine?.id,
  };
}

/**
 * タスク開始
 */
export async function startTask(payload: TaskStartPayload): Promise<CrossProjectTask | null> {
  const { taskId, projectPath } = payload;

  const project = await prisma.project.findFirst({
    where: { path: projectPath },
  });

  if (!project) {
    throw new Error(`Project not found: ${projectPath}`);
  }

  const task = await prisma.crossProjectTask.update({
    where: { id: taskId },
    data: {
      status: 'in_progress',
      startedAt: new Date(),
      executorProjectId: project.id,
    },
    include: {
      senderProject: { include: { machine: true } },
      receiverProject: { include: { machine: true } },
    },
  });

  await prisma.taskActivityLog.create({
    data: {
      taskId: task.id,
      projectId: project.id,
      action: 'started',
    },
  });

  return formatTask(task);
}

/**
 * タスク完了
 */
export async function completeTask(
  payload: TaskCompletePayload
): Promise<{ task: CrossProjectTask; senderMachineId: string }> {
  const { taskId, projectPath, resultNotes, resultFiles } = payload;

  const project = await prisma.project.findFirst({
    where: { path: projectPath },
    include: { machine: true },
  });

  if (!project) {
    throw new Error(`Project not found: ${projectPath}`);
  }

  // 結果ファイルがあれば添付
  let resultFileUrl: string | undefined;
  if (resultFiles && resultFiles.length > 0) {
    await prisma.taskAttachment.createMany({
      data: resultFiles.map(att => ({
        taskId,
        filename: att.filename,
        mimeType: att.mimeType,
        size: att.size,
        content: att.content,
        uploadedBy: project.id,
      })),
    });
    resultFileUrl = `attachments/${taskId}`;
  }

  const task = await prisma.crossProjectTask.update({
    where: { id: taskId },
    data: {
      status: 'completed',
      completedAt: new Date(),
      resultNotes,
      resultFileUrl,
      executorProjectId: project.id,
    },
    include: {
      senderProject: { include: { machine: true } },
      receiverProject: { include: { machine: true } },
      executorProject: { include: { machine: true } },
    },
  });

  await prisma.taskActivityLog.create({
    data: {
      taskId: task.id,
      projectId: project.id,
      action: 'completed',
      details: JSON.stringify({ resultNotes }),
    },
  });

  return {
    task: formatTask(task),
    senderMachineId: task.senderProject.machine.id,
  };
}

/**
 * タスク失敗
 */
export async function failTask(
  payload: TaskFailPayload
): Promise<{ task: CrossProjectTask; senderMachineId: string }> {
  const { taskId, projectPath, error } = payload;

  const project = await prisma.project.findFirst({
    where: { path: projectPath },
    include: { machine: true },
  });

  if (!project) {
    throw new Error(`Project not found: ${projectPath}`);
  }

  const task = await prisma.crossProjectTask.update({
    where: { id: taskId },
    data: {
      status: 'failed',
      completedAt: new Date(),
      resultNotes: error,
      executorProjectId: project.id,
    },
    include: {
      senderProject: { include: { machine: true } },
      receiverProject: { include: { machine: true } },
      executorProject: { include: { machine: true } },
    },
  });

  await prisma.taskActivityLog.create({
    data: {
      taskId: task.id,
      projectId: project.id,
      action: 'failed',
      details: JSON.stringify({ error }),
    },
  });

  return {
    task: formatTask(task),
    senderMachineId: task.senderProject.machine.id,
  };
}

/**
 * コメント追加
 */
export async function addComment(payload: TaskCommentPayload): Promise<void> {
  const { taskId, projectPath, content } = payload;

  const project = await prisma.project.findFirst({
    where: { path: projectPath },
  });

  if (!project) {
    throw new Error(`Project not found: ${projectPath}`);
  }

  await prisma.taskComment.create({
    data: {
      taskId,
      projectId: project.id,
      content,
    },
  });

  await prisma.taskActivityLog.create({
    data: {
      taskId,
      projectId: project.id,
      action: 'commented',
      details: JSON.stringify({ contentLength: content.length }),
    },
  });
}

// =============================================================================
// Task Queries
// =============================================================================

/**
 * プロジェクトの受信タスク一覧（ペンディング・割り当て済み）
 */
export async function getIncomingTasks(projectPath: string): Promise<TaskListPayload> {
  const project = await prisma.project.findFirst({
    where: { path: projectPath },
  });

  if (!project) {
    return { projectPath, tasks: [] };
  }

  const tasks = await prisma.crossProjectTask.findMany({
    where: {
      receiverProjectId: project.id,
      status: { in: ['pending', 'assigned', 'in_progress'] },
    },
    include: {
      senderProject: { include: { machine: true } },
    },
    orderBy: [
      { priority: 'desc' },
      { createdAt: 'asc' },
    ],
  });

  return {
    projectPath,
    tasks: tasks.map(task => ({
      id: task.id,
      name: task.name,
      description: task.description,
      status: task.status as TaskStatus,
      priority: task.priority as TaskPriority,
      senderProjectName: task.senderProject.name,
      senderMachineName: task.senderProject.machine.name,
      createdAt: task.createdAt.toISOString(),
    })),
  };
}

/**
 * タスク詳細取得
 */
export async function getTask(taskId: string): Promise<CrossProjectTask | null> {
  const task = await prisma.crossProjectTask.findUnique({
    where: { id: taskId },
    include: {
      senderProject: { include: { machine: true } },
      receiverProject: { include: { machine: true } },
      executorProject: { include: { machine: true } },
    },
  });

  if (!task) return null;

  return formatTask(task);
}

/**
 * タスク一覧取得（フィルタリング対応）
 */
export async function getTasks(filters: {
  userId?: string;
  projectId?: string;
  status?: TaskStatus;
  limit?: number;
  offset?: number;
}): Promise<{ tasks: CrossProjectTask[]; total: number }> {
  const { userId, projectId, status, limit = 50, offset = 0 } = filters;

  const where: Record<string, unknown> = {};

  if (projectId) {
    where.OR = [
      { senderProjectId: projectId },
      { receiverProjectId: projectId },
      { executorProjectId: projectId },
    ];
  }

  if (userId) {
    where.senderProject = { machine: { userId } };
  }

  if (status) {
    where.status = status;
  }

  const [tasks, total] = await Promise.all([
    prisma.crossProjectTask.findMany({
      where,
      include: {
        senderProject: { include: { machine: true } },
        receiverProject: { include: { machine: true } },
        executorProject: { include: { machine: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    }),
    prisma.crossProjectTask.count({ where }),
  ]);

  return {
    tasks: tasks.map(formatTask),
    total,
  };
}

/**
 * タスクのコメント一覧
 */
export async function getTaskComments(taskId: string) {
  return prisma.taskComment.findMany({
    where: { taskId },
    include: { project: true },
    orderBy: { createdAt: 'asc' },
  });
}

/**
 * タスクの添付ファイル一覧
 */
export async function getTaskAttachments(taskId: string) {
  return prisma.taskAttachment.findMany({
    where: { taskId },
    orderBy: { createdAt: 'asc' },
  });
}

/**
 * タスクのアクティビティログ
 */
export async function getTaskActivityLogs(taskId: string) {
  return prisma.taskActivityLog.findMany({
    where: { taskId },
    include: { project: true },
    orderBy: { createdAt: 'asc' },
  });
}

// =============================================================================
// Helper Functions
// =============================================================================

interface TaskWithRelations {
  id: string;
  senderProjectId: string;
  receiverProjectId: string | null;
  executorProjectId: string | null;
  name: string;
  description: string;
  status: string;
  priority: string;
  createdAt: Date;
  assignedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  resultNotes: string | null;
  resultFileUrl: string | null;
  parentTaskId: string | null;
  metadata: string | null;
  senderProject: { name: string; machine: { name: string } };
  receiverProject?: { name: string; machine: { name: string } } | null;
  executorProject?: { name: string; machine: { name: string } } | null;
}

function formatTask(task: TaskWithRelations): CrossProjectTask {
  return {
    id: task.id,
    senderProjectId: task.senderProjectId,
    senderProjectName: task.senderProject.name,
    senderMachineName: task.senderProject.machine.name,
    receiverProjectId: task.receiverProjectId || undefined,
    receiverProjectName: task.receiverProject?.name,
    receiverMachineName: task.receiverProject?.machine?.name,
    executorProjectId: task.executorProjectId || undefined,
    name: task.name,
    description: task.description,
    status: task.status as TaskStatus,
    priority: task.priority as TaskPriority,
    createdAt: task.createdAt.toISOString(),
    assignedAt: task.assignedAt?.toISOString(),
    startedAt: task.startedAt?.toISOString(),
    completedAt: task.completedAt?.toISOString(),
    resultNotes: task.resultNotes || undefined,
    resultFileUrl: task.resultFileUrl || undefined,
    parentTaskId: task.parentTaskId || undefined,
    metadata: task.metadata || undefined,
  };
}

/**
 * TaskAssignedPayload を作成
 */
export function buildTaskAssignedPayload(
  task: CrossProjectTask,
  receiverProjectPath: string,
  attachments?: FileAttachment[]
): TaskAssignedPayload {
  return {
    taskId: task.id,
    projectPath: receiverProjectPath,
    name: task.name,
    description: task.description,
    priority: task.priority,
    senderProjectName: task.senderProjectName || 'unknown',
    senderMachineName: task.senderMachineName || 'unknown',
    parentTaskId: task.parentTaskId,
    attachments,
  };
}

/**
 * TaskCompletedNotifyPayload を作成
 */
export function buildTaskCompletedNotifyPayload(
  task: CrossProjectTask,
  senderProjectPath: string,
  resultFiles?: FileAttachment[]
): TaskCompletedNotifyPayload {
  return {
    taskId: task.id,
    projectPath: senderProjectPath,
    name: task.name,
    status: task.status === 'failed' ? 'failed' : 'completed',
    resultNotes: task.resultNotes,
    resultFiles,
    error: task.status === 'failed' ? task.resultNotes : undefined,
    executorProjectName: task.senderProjectName || 'unknown', // Use sender as executor if not set
    executorMachineName: task.senderMachineName || 'unknown',
  };
}
