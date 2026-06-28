/**
 * DevRelay MCP ツール定義
 *
 * 既存の API/関数への薄いアダプタとして 6 ツールを定義。
 * 各ツールは既存の Prisma クエリや agent-manager 関数を呼び出すだけ。
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { prisma } from '../db/client.js';
import {
  getConnectedAgents,
  sendPromptToAgent,
  execConversation,
  isAgentOutdated,
  startSession as startAgentSession,
} from '../services/agent-manager.js';
import {
  createSession,
  startProgressTracking,
  addParticipant,
  getActiveProgressForChatId,
} from '../services/session-manager.js';

/**
 * MCP サーバーにツールを登録する
 *
 * @param server McpServer インスタンス
 * @param userId 認証済みユーザー ID
 */
export function registerMcpTools(server: McpServer, userId: string) {

  // ============================================================
  // 参照系ツール（readOnlyHint: true）
  // ============================================================

  /**
   * list_projects — ユーザーのプロジェクト一覧を取得
   */
  server.tool(
    'list_projects',
    'List all projects the user has access to. Use this when the user wants to know which projects are available or when the target project for an instruction is unclear.',
    {},
    async () => {
      const projects = await prisma.project.findMany({
        where: { machine: { userId, deletedAt: null } },
        include: {
          machine: { select: { id: true, name: true, displayName: true, lastSeenAt: true } },
        },
        orderBy: { name: 'asc' },
      });

      const connectedAgents = getConnectedAgents();
      const result = projects.map(p => ({
        id: p.id,
        name: p.displayName || p.name,
        path: p.path,
        machine: (p as any).machine.displayName || (p as any).machine.name,
        machineId: p.machineId,
        online: connectedAgents.has(p.machineId),
        aiTool: p.defaultAi,
      }));

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ projects: result }, null, 2) }],
      };
    }
  );

  /**
   * search_project_context — プロジェクトのビルド履歴と会話を検索
   */
  server.tool(
    'search_project_context',
    'Search a project\'s recent build summaries and conversation history. Use this when the user asks about the current state of a project, what was recently implemented, or to look up context before submitting an instruction.',
    { projectId: z.string().describe('The project ID to search'), query: z.string().describe('Search query (keyword or description of what to find)') },
    async ({ projectId, query }) => {
      // ビルドログ検索（最新10件の summary を返す）
      const builds = await prisma.buildLog.findMany({
        where: {
          session: { projectId, userId },
        },
        select: { id: true, summary: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 10,
      });

      // メッセージ検索（AI 応答から query にマッチするものを検索）
      const messages = await prisma.message.findMany({
        where: {
          session: { projectId, userId },
          role: 'ai',
          content: { contains: query, mode: 'insensitive' },
        },
        select: { id: true, content: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 5,
      });

      const results = [
        ...builds.map(b => ({
          source: 'build',
          ref: b.id,
          summary: b.summary.slice(0, 200),
          date: b.createdAt.toISOString(),
        })),
        ...messages.map(m => ({
          source: 'conversation',
          ref: m.id,
          summary: m.content.slice(0, 200),
          date: m.createdAt.toISOString(),
        })),
      ];

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ results }, null, 2) }],
      };
    }
  );

  /**
   * get_plan — 投入済み指示のプランを取得
   *
   * submissionId (= sessionId) に紐づく DB の Message からプランを取得。
   * requestLatestPlanFile（machineId スコープ）は使わない — 別プロジェクトの
   * ゴーストプランを返す致命的なスコープバグがあった (#246 実機テストで発見)。
   */
  server.tool(
    'get_plan',
    'Get the plan for a submitted instruction. Call this after submit_instruction to retrieve the AI-generated implementation plan. If status is "planning", wait a moment and call again.',
    { submissionId: z.string().describe('The submission ID returned by submit_instruction') },
    async ({ submissionId }) => {
      // submissionId の存在チェック
      const session = await prisma.session.findUnique({
        where: { id: submissionId },
        select: { id: true, userId: true },
      });

      if (!session || session.userId !== userId) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ status: 'not_found', error: 'Submission not found' }) }] };
      }

      // submissionId に紐づく最新の AI メッセージを取得
      const latestMessage = await prisma.message.findFirst({
        where: { sessionId: submissionId, role: 'ai' },
        orderBy: { createdAt: 'desc' },
      });

      if (latestMessage) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            status: 'ready',
            summary: latestMessage.content.slice(0, 500),
            planMarkdown: latestMessage.content,
            executable: true,
          }) }],
        };
      }

      // AI メッセージがまだない → プラン生成中
      return { content: [{ type: 'text' as const, text: JSON.stringify({ status: 'planning', message: 'Plan is being generated. Please wait and try again.' }) }] };
    }
  );

  /**
   * get_build_status — Exec の進捗・結果を取得
   */
  server.tool(
    'get_build_status',
    'Check the progress and result of an approved implementation. Call this after approve_implementation to monitor the build. Poll periodically until done is true.',
    { submissionId: z.string().describe('The submission ID') },
    async ({ submissionId }) => {
      // submissionId = sessionId として最新の BuildLog を検索
      const buildLog = await prisma.buildLog.findFirst({
        where: { sessionId: submissionId },
        orderBy: { createdAt: 'desc' },
      });

      if (buildLog) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            phase: 'done',
            buildId: buildLog.id,
            summary: buildLog.summary || 'Build completed',
            done: true,
          }) }],
        };
      }

      // BuildLog がまだない → 進行中かチェック
      // MCP 用の chatId で進捗を検索
      const mcpChatId = `mcp:${userId}:${submissionId}`;
      const progress = getActiveProgressForChatId(mcpChatId);

      // DB から最新 AI メッセージも取得（progress tracker が古い履歴を返す問題の対策）
      const latestMsg = await prisma.message.findFirst({
        where: { sessionId: submissionId, role: 'ai' },
        orderBy: { createdAt: 'desc' },
      });

      if (progress) {
        // 進行中: DB の最新メッセージがあればそちらを優先（progress tracker より正確）
        const summary = latestMsg
          ? latestMsg.content.slice(0, 500)
          : progress.output.slice(0, 500);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            phase: 'exec',
            progressSummary: summary,
            elapsedSeconds: progress.elapsed,
            done: false,
          }) }],
        };
      }

      // 進行中トラッカーがない場合
      if (latestMsg) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            phase: 'done',
            summary: latestMsg.content.slice(0, 500),
            done: true,
          }) }],
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          phase: 'queued',
          message: 'Build is queued or in progress. Please wait and try again.',
          done: false,
        }) }],
      };
    }
  );

  // ============================================================
  // 書き込み系ツール（readOnlyHint なし → ホストが確認）
  // ============================================================

  /**
   * submit_instruction — 指示を投入して Plan フェーズを開始
   */
  server.tool(
    'submit_instruction',
    'Submit a coding instruction to a project. This starts the Plan phase where the AI analyzes the instruction and creates an implementation plan. IMPORTANT: Always confirm with the user before calling this tool. Returns a submissionId to use with get_plan and approve_implementation.',
    {
      projectId: z.string().describe('The target project ID'),
      instruction: z.string().describe('The coding instruction in Markdown format'),
    },
    async ({ projectId, instruction }) => {
      // プロジェクト + マシン検索
      const project = await prisma.project.findFirst({
        where: { id: projectId, machine: { userId, deletedAt: null } },
        include: { machine: true },
      });

      if (!project) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Project not found' }) }], isError: true };
      }

      if (!getConnectedAgents().has(project.machineId)) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Agent is offline' }) }], isError: true };
      }

      if (isAgentOutdated(project.machineId)) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Agent needs update. Send "u" command first.' }) }], isError: true };
      }

      // aiTool はプロジェクトの defaultAi を使用
      const aiTool = project.defaultAi || 'claude';

      // セッション作成
      const sessionId = await createSession(userId, project.machineId, project.id, aiTool);

      // MCP 用の chatId で参加者登録（進捗トラッキング用）
      // 注意: mcp: prefix の chatId は実際の WebSocket を持たないため、
      // ツール承認リクエストは sendWebRawMessage で送れず fallback broadcast になる
      const mcpChatId = `mcp:${userId}:${sessionId}`;
      addParticipant(sessionId, 'web', mcpChatId);
      console.log(`⏱️ [MCP] session created: sessionId=${sessionId.substring(0, 12)}, participant chatId=${mcpChatId.substring(0, 25)}`);

      // Agent にセッション開始を通知
      await startAgentSession(project.machineId, sessionId, project.name, project.path, aiTool as any);

      // 進捗トラッキング開始
      await startProgressTracking(sessionId);

      // メッセージを DB に保存
      await prisma.message.create({
        data: {
          sessionId,
          role: 'user',
          content: instruction,
          platform: 'web',
        },
      });

      // Agent にプロンプト送信（forceNewSession: 前回セッションの JSONL 注入・resume をスキップ）
      await sendPromptToAgent(
        project.machineId,
        sessionId,
        instruction,
        userId,
        undefined,
        undefined,
        project.path,
        aiTool as any,
        true,  // forceNewSession: MCP submit は常に新規セッション
      );

      // 監査ログ
      console.log(`📋 [MCP] AUDIT submit: userId=${userId}, projectId=${projectId}, instruction=${instruction.slice(0, 100)}...`);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          submissionId: sessionId,
          projectId,
          status: 'planning',
          message: 'Instruction submitted. Use get_plan to check the plan status.',
        }) }],
      };
    }
  );

  /**
   * approve_implementation — プランを承認して Exec フェーズを開始
   */
  server.tool(
    'approve_implementation',
    'Approve the implementation plan and start execution. IMPORTANT: Always confirm with the user before calling this. The AI agent will begin making code changes.',
    {
      projectId: z.string().describe('The project ID'),
      submissionId: z.string().describe('The submission ID from submit_instruction'),
    },
    async ({ projectId, submissionId }) => {
      // プロジェクト検索
      const project = await prisma.project.findFirst({
        where: { id: projectId, machine: { userId, deletedAt: null } },
        include: { machine: true },
      });

      if (!project) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Project not found' }) }], isError: true };
      }

      if (!getConnectedAgents().has(project.machineId)) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Agent is offline' }) }], isError: true };
      }

      // exec メッセージを保存
      await prisma.message.create({
        data: {
          sessionId: submissionId,
          role: 'user',
          content: 'exec',
          platform: 'web',
        },
      });

      // Plan → Exec 遷移
      await execConversation(
        project.machineId,
        submissionId,
        project.path,
        userId,
        'プランに従って実装を開始してください。',
      );

      // 監査ログ
      console.log(`📋 [MCP] AUDIT approve: userId=${userId}, projectId=${projectId}, submissionId=${submissionId}`);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          phase: 'queued',
          message: 'Implementation approved and started. Use get_build_status to monitor progress.',
        }) }],
      };
    }
  );
}
