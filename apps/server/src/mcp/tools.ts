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
import { checkCommandPermission } from '../services/org-control.js';
import { buildApprovalExecPrompt } from './approval-prompt.js';
import { resolvePermissionPolicy } from '../services/permission-policy.js';
import { fenceHumanText, neutralizeHumanInputTag, validateHumanTextLength } from '../services/human-text-fence.js';
import {
  ATTACHMENT_MAX_FILE_SIZE,
  ATTACHMENT_MAX_TOTAL_SIZE,
  ATTACHMENT_MAX_COUNT,
  ALLOWED_ATTACHMENT_MIME_TYPES,
  validateAttachments,
} from '../services/attachment-validation.js';
import { processMessageFilesEmbedding } from '../services/embedding-service.js';
import { evaluateApproveGuard, decideClaimResult, buildClaimReleaseWhere, buildTurnId } from '../services/submission-guard.js';
import { normalizeStopReason, isStopReasonTruncated, applyStopReasonMark } from '../services/stop-reason.js';
import { truncateOnLineBoundary, CONVERSATION_MAX_CONTENT_LENGTH, BUILD_STATUS_TAIL_LENGTH } from '../services/content-truncate.js';
import { tChat, DEFAULT_CHAT_LANGUAGE } from '@devrelay/shared';

/**
 * #334: 人間入力テキストの長さ上限（string.length = UTF-16 コードユニット数基準）。
 * 超過時は切り詰めず明示エラーで拒否する（静かなフォールバック禁止、#325）。
 */
const SUBMIT_INSTRUCTION_MAX_LENGTH = 20000;
const APPROVAL_NOTE_MAX_LENGTH = 2000;

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
        where: { deletedAt: null, machine: { userId, deletedAt: null } },
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
    'Search a project\'s recent build summaries and conversation history. Use this when the user asks about the current state of a project, what was recently implemented, or to look up context before submitting an instruction. Use get_conversation_history for full conversation browsing.',
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

      // メッセージ検索（user + ai メッセージから query にマッチするものを検索）
      const messages = await prisma.message.findMany({
        where: {
          session: { projectId, userId },
          role: { in: ['user', 'ai'] },
          content: { contains: query, mode: 'insensitive' },
        },
        select: {
          id: true, role: true, content: true, sessionId: true, createdAt: true,
          files: { select: { id: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 10,
      });

      const results = [
        ...builds.map(b => ({
          source: 'build' as const,
          ref: b.id,
          summary: b.summary.slice(0, 200),
          date: b.createdAt.toISOString(),
        })),
        ...messages.map(m => ({
          source: 'conversation' as const,
          ref: m.id,
          role: m.role,
          sessionId: m.sessionId,
          summary: m.content.slice(0, 200),
          date: m.createdAt.toISOString(),
          hasAttachments: m.files.length > 0,
        })),
      ];

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ results }, null, 2) }],
      };
    }
  );

  /**
   * get_conversation_history — プロジェクトの会話履歴を時系列で取得（#272）
   */
  server.tool(
    'get_conversation_history',
    'Get conversation messages for a project in chronological order. Use this to browse full conversation history, or to dive deeper into results from search_project_context. Supports pagination via before/after timestamps. Each message body is truncated to 2000 characters; by default the BEGINNING is kept. Set tail: true to keep the END instead — required for reading exec completion reports, where the commit hash and push result appear at the very end of the message. Truncation always lands on a line boundary. When a body was truncated, truncated is true and truncatedSide names the side that was REMOVED ("tail" = the end was dropped, "head" = the beginning was dropped). truncatedSide is absent when truncated is false.',
    {
      projectId: z.string().describe('The project ID'),
      limit: z.number().optional().describe('Number of messages to return (default 50, max 200)'),
      before: z.string().optional().describe('Return messages before this ISO timestamp (for backward pagination)'),
      after: z.string().optional().describe('Return messages after this ISO timestamp (for forward pagination)'),
      order: z.enum(['asc', 'desc']).optional().describe('Sort order by timestamp (default "asc")'),
      tail: z.boolean().optional().describe('Keep the END of each message body instead of the beginning when it exceeds the 2000-character limit (default false). Use true to read exec completion reports, where the commit hash and push result are at the end.'),
    },
    async ({ projectId, limit: rawLimit, before, after, order: rawOrder, tail: rawTail }) => {
      const limit = Math.min(Math.max(rawLimit ?? 50, 1), 200);
      const order = rawOrder ?? 'asc';
      const keepSide = rawTail === true ? 'tail' : 'head';

      // createdAt フィルタ構築
      const createdAtFilter: Record<string, Date> = {};
      if (before) createdAtFilter.lt = new Date(before);
      if (after) createdAtFilter.gt = new Date(after);

      const messages = await prisma.message.findMany({
        where: {
          session: { projectId, userId },
          ...(Object.keys(createdAtFilter).length > 0 ? { createdAt: createdAtFilter } : {}),
        },
        select: {
          id: true,
          role: true,
          content: true,
          createdAt: true,
          sessionId: true,
          files: {
            select: { id: true, filename: true, mimeType: true, size: true, direction: true },
          },
        },
        orderBy: { createdAt: order },
        take: limit,
      });

      const result = {
        messages: messages.map(m => {
          const t = truncateOnLineBoundary(m.content, CONVERSATION_MAX_CONTENT_LENGTH, keepSide);
          return {
            id: m.id,
            role: m.role,
            content: t.content,
            truncated: t.truncated,
            ...(t.truncatedSide ? { truncatedSide: t.truncatedSide } : {}),
            timestamp: m.createdAt.toISOString(),
            sessionId: m.sessionId,
            attachments: m.files.map(f => ({
              id: f.id,
              filename: f.filename,
              mimeType: f.mimeType,
              size: f.size,
              direction: f.direction,
            })),
          };
        }),
        count: messages.length,
        hasMore: messages.length === limit,
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  /**
   * get_attachment — 添付ファイル（画像等）を取得（#273）
   * 画像は MCP ImageContent（base64）で返却、テキストは TextContent で返却
   */
  server.tool(
    'get_attachment',
    'Get an attachment file (image, text, etc.) by its ID. Use the attachment IDs from get_conversation_history results. Images are returned as base64-encoded image content blocks.',
    {
      attachmentId: z.string().describe('The attachment ID from get_conversation_history attachments'),
    },
    async ({ attachmentId }) => {
      const file = await prisma.messageFile.findUnique({
        where: { id: attachmentId },
        include: {
          message: {
            select: { session: { select: { userId: true } } },
          },
        },
      });

      if (!file || file.message.session.userId !== userId) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Attachment not found' }) }],
          isError: true,
        };
      }

      /** 取得可能な最大ファイルサイズ（5MB） */
      const MAX_FILE_SIZE = 5 * 1024 * 1024;

      const meta = {
        id: file.id,
        filename: file.filename,
        mimeType: file.mimeType,
        size: file.size,
        direction: file.direction,
      };

      // サイズ上限チェック
      if (file.size > MAX_FILE_SIZE) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            ...meta,
            error: `File too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Maximum is ${MAX_FILE_SIZE / 1024 / 1024}MB.`,
          }) }],
        };
      }

      // 画像: MCP ImageContent で返却
      if (file.mimeType.startsWith('image/')) {
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify(meta) },
            { type: 'image' as const, data: Buffer.from(file.content).toString('base64'), mimeType: file.mimeType },
          ],
        };
      }

      // テキスト: 文字列として返却
      if (file.mimeType.startsWith('text/')) {
        const textContent = Buffer.from(file.content).toString('utf-8');
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify(meta) },
            { type: 'text' as const, text: textContent },
          ],
        };
      }

      // その他: base64 を JSON テキストとして返却
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({
            ...meta,
            data: Buffer.from(file.content).toString('base64'),
            encoding: 'base64',
          }) },
        ],
      };
    }
  );

  /**
   * get_plan — 投入済み指示のプランを取得
   *
   * submissionId (= sessionId) に紐づく DB の Message からプランを取得。
   * requestLatestPlanFile（machineId スコープ）は使わない — 別プロジェクトの
   * ゴーストプランを返す致命的なスコープバグがあった (#246 実機テストで発見)。
   * #375: requestLatestPlanFile 自体は projectPath スコープ化されたが、get_plan は
   * submissionId 単位の厳密性を保つため引き続き DB 経由のままとする。
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
    'Check the progress and result of an approved implementation. Call this after approve_implementation to monitor the build. Poll periodically until done is true. summary is a short AI-generated description (max 200 chars) and does NOT contain the commit hash or push result. To confirm completion details, read tail — the last 1500 characters of the latest AI message, cut on a line boundary, which is where the commit hash and push result appear. tail is absent when no AI output exists yet.',
    { submissionId: z.string().describe('The submission ID') },
    async ({ submissionId }) => {
      // exec メッセージの最新タイムスタンプを取得（approve_implementation が保存する）
      // exec 以前の BuildLog / AI メッセージ（plan フェーズ）を除外するための基準点
      const execMessage = await prisma.message.findFirst({
        where: { sessionId: submissionId, role: 'user', content: 'exec' },
        orderBy: { createdAt: 'desc' },
      });
      const execTimestamp = execMessage?.createdAt;

      // #380: BuildLog 分岐でも tail を返すため、latestMsg の取得を BuildLog 検索より前に移動。
      // 参照するのは content のみなので select で絞る（旧コードは全カラム＋usageData を無駄に取得していた）。
      const latestMsg = await prisma.message.findFirst({
        where: {
          sessionId: submissionId,
          role: 'ai',
          ...(execTimestamp ? { createdAt: { gt: execTimestamp } } : {}),
        },
        select: { content: true },
        orderBy: { createdAt: 'desc' },
      });
      const tail = latestMsg?.content
        ? truncateOnLineBoundary(latestMsg.content, BUILD_STATUS_TAIL_LENGTH, 'tail').content
        : undefined;

      // submissionId = sessionId として BuildLog を検索（exec 以降に限定）
      const buildLog = await prisma.buildLog.findFirst({
        where: {
          sessionId: submissionId,
          ...(execTimestamp ? { createdAt: { gt: execTimestamp } } : {}),
        },
        orderBy: { createdAt: 'desc' },
      });

      if (buildLog) {
        // #377: stopReason は BuildLog に実値があるのでそのまま使う（未指定は 'success' 正規化）
        const sr = normalizeStopReason(buildLog.stopReason ?? undefined);
        const truncated = isStopReasonTruncated(sr);
        const mark = truncated ? tChat(DEFAULT_CHAT_LANGUAGE, 'buildStatus.truncatedMark', { stopReason: sr }) : '';
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            phase: 'done',
            buildId: buildLog.id,
            summary: applyStopReasonMark(buildLog.summary || 'Build completed', mark),
            done: true,
            truncated,
            stopReason: sr,
            ...(tail !== undefined ? { tail } : {}),
          }) }],
        };
      }

      // BuildLog がまだない → 進行中かチェック
      // MCP 用の chatId で進捗を検索
      const mcpChatId = `mcp:${userId}:${submissionId}`;
      const progress = getActiveProgressForChatId(mcpChatId);

      if (progress) {
        // 進行中: DB の最新メッセージがあればそちらを優先（progress tracker より正確）
        const summary = latestMsg
          ? latestMsg.content.slice(0, 500)
          : progress.output.slice(0, 500);
        const progressTail = latestMsg?.content
          ? tail
          : truncateOnLineBoundary(progress.output, BUILD_STATUS_TAIL_LENGTH, 'tail').content;
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            phase: 'exec',
            progressSummary: summary,
            elapsedSeconds: progress.elapsed,
            done: false,
            ...(progressTail !== undefined ? { tail: progressTail } : {}),
          }) }],
        };
      }

      // 進行中トラッカーがない + exec 後の AI メッセージがある → exec 完了
      // #377: この分岐は BuildLog が存在しない場合のフォールバック（isExec フラグ欠落や
      // BuildLog 作成失敗など）であり、Message には stopReason を保存していないため実際の
      // 打ち切り有無を判定できない。打ち切りのある exec は agent-manager.ts 側のゲート緩和により
      // 必ず上の BuildLog 分岐で拾われるようになったため、ここに到達するのは通常 stopReason='success'
      // 相当のケースのみ（既知の限界として明示的にハードコードする。devlog に記載）。
      if (latestMsg) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            phase: 'done',
            summary: latestMsg.content.slice(0, 500),
            done: true,
            truncated: false,
            stopReason: 'success',
            ...(tail !== undefined ? { tail } : {}),
          }) }],
        };
      }

      // exec メッセージがあるのに結果がない → exec 進行中（queued）
      if (execTimestamp) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            phase: 'exec',
            message: 'Execution is in progress. Please wait and try again.',
            done: false,
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
      instruction: z.string().describe(`The coding instruction in Markdown format (max ${SUBMIT_INSTRUCTION_MAX_LENGTH} characters)`),
      council: z.boolean().optional().describe('Opt-in to council mode (default false). NOTE: the council engine is not implemented yet; the flag is recorded only and has no effect on execution.'),
      attachments: z.array(z.object({
        filename: z.string().describe('File name (basename only; path separators are stripped)'),
        mimeType: z.string().describe(`MIME type. Allowed: ${ALLOWED_ATTACHMENT_MIME_TYPES.join(', ')}`),
        content: z.string().describe('Base64-encoded file content'),
      })).optional().describe(
        `Optional file attachments (max ${ATTACHMENT_MAX_COUNT} files, ${ATTACHMENT_MAX_FILE_SIZE / 1024 / 1024}MB each, ` +
        `${ATTACHMENT_MAX_TOTAL_SIZE / 1024 / 1024}MB total). Files are written to <projectPath>/.devrelay-files/ on the ` +
        'agent machine and their absolute paths are prepended to the prompt. Oversized requests are rejected by the ' +
        'server before this tool runs (HTTP 413), not as a tool error.'
      ),
    },
    async ({ projectId, instruction, council, attachments }) => {
      // エンタープライズ統制ゲート（#268）: マネージャー未割当の member はコマンド発行不可
      const permission = await checkCommandPermission(userId);
      if (!permission.allowed) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: permission.reason }) }], isError: true };
      }

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

      // #334: 長さ検証は createSession（セッション作成という状態変更）より前に行う。
      // ここで拒否すれば「セッションだけ作られてMessageが無い」等の中途半端な状態は一切発生しない。
      const trimmedInstruction = instruction.trim();
      const lengthCheck = validateHumanTextLength(trimmedInstruction, SUBMIT_INSTRUCTION_MAX_LENGTH);
      if (!lengthCheck.ok) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'instruction is too long',
            kind: 'submitInstruction',
            rawLength: lengthCheck.rawLength,
            limit: lengthCheck.limit,
          }) }],
          isError: true,
        };
      }

      // 添付ファイル検証も createSession より前に行う（#334 と同じ規約: 状態変更の前に全ての拒否判定を終える）。
      // #添付対応: MIME はマジックバイトで実体検証し、ファイル名は basename 化・制御文字除去でサニタイズする
      // （file-handler.ts がファイル名をディスク書き込み先とプロンプト平文の両方に使うため）。
      const validatedAttachments = validateAttachments(attachments ?? []);
      if (!validatedAttachments.ok) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'attachment validation failed',
            kind: 'submitInstruction',
            reason: validatedAttachments.reason,
            limits: {
              maxCount: ATTACHMENT_MAX_COUNT,
              maxFileSize: ATTACHMENT_MAX_FILE_SIZE,
              maxTotalSize: ATTACHMENT_MAX_TOTAL_SIZE,
              allowedMimeTypes: ALLOWED_ATTACHMENT_MIME_TYPES,
            },
            ...(validatedAttachments.detail ? { detail: validatedAttachments.detail } : {}),
            ...(validatedAttachments.failures.length > 0 ? { failures: validatedAttachments.failures } : {}),
          }) }],
          isError: true,
        };
      }

      // aiTool はプロジェクトの defaultAi を使用
      const aiTool = project.defaultAi || 'claude';

      // セッション作成
      const sessionId = await createSession(userId, project.machineId, project.id, aiTool);

      // core#336: plan ターンの correlation ID。agent に prompt を dispatch する前に Session へ
      // 永続化する（turnId 生成 → planTurnId 保存 → 送信 の順）。これにより完了報告が遅延しても
      // Session.planTurnId との一致判定で正しいターンにのみ対応付けられる。
      const planTurnId = buildTurnId(Date.now(), Math.random().toString(36).slice(2, 9));
      await prisma.session.update({ where: { id: sessionId }, data: { planTurnId } });

      // #331: council opt-in の記録のみ（council 実行エンジンは未実装。既定は false のため
      // 未指定時はこの更新自体を行わず、DB の @default(false) のまま = 従来と完全同形）
      if (council === true) {
        await prisma.session.update({ where: { id: sessionId }, data: { councilMode: true } });
      }

      // MCP 用の chatId で参加者登録（進捗トラッキング用）
      // 注意: mcp: prefix の chatId は実際の WebSocket を持たないため、
      // ツール承認リクエストは sendWebRawMessage で送れず fallback broadcast になる
      const mcpChatId = `mcp:${userId}:${sessionId}`;
      addParticipant(sessionId, 'web', mcpChatId);
      console.log(`⏱️ [MCP] session created: sessionId=${sessionId.substring(0, 12)}, participant chatId=${mcpChatId.substring(0, 25)}`);

      // Agent にセッション開始を通知（core#336: agentScopeId = submissionId で状態をスコープ分離する）
      await startAgentSession(project.machineId, sessionId, project.name, project.path, aiTool as any, sessionId);

      // 進捗トラッキング開始
      await startProgressTracking(sessionId);

      // #334: 監査メタ情報（raw text 自体は content にそのまま保存されるため、meta には含めない）
      // #添付対応: 添付があるときだけ既存キーの末尾に attachments を追加する（無添付時は現行と1バイトも変わらない）。
      const { count: submitNeutralizedCount } = neutralizeHumanInputTag(trimmedInstruction);
      const submitHumanTextMeta = JSON.stringify({
        kind: 'submitInstruction',
        origin: 'human',
        rawLength: lengthCheck.rawLength,
        limit: SUBMIT_INSTRUCTION_MAX_LENGTH,
        fenced: true,
        neutralized: submitNeutralizedCount,
        rawRef: 'message.content',
        ...(validatedAttachments.files.length > 0 ? {
          attachments: {
            count: validatedAttachments.files.length,
            totalBytes: validatedAttachments.totalBytes,
            mimeTypes: validatedAttachments.files.map(f => f.mimeType),
            sanitizedFilenames: validatedAttachments.sanitizedFilenameCount,
          },
        } : {}),
      });

      // メッセージを DB に保存（content は fence 前の raw text を無切り詰めで保存する）
      // #添付対応: WebUI 受け口（command-handler.ts）と同一の形でネストした MessageFile を作成する（経路を二重化しない）。
      const userMessage = await prisma.message.create({
        data: {
          sessionId,
          role: 'user',
          content: trimmedInstruction,
          platform: 'web',
          humanTextMeta: submitHumanTextMeta,
          files: validatedAttachments.files.length > 0 ? {
            create: validatedAttachments.files.map(f => ({
              filename: f.filename,
              mimeType: f.mimeType,
              size: f.size,
              content: Buffer.from(f.content, 'base64'),
              direction: 'input',
            })),
          } : undefined,
        },
      });
      if (validatedAttachments.files.length > 0) {
        processMessageFilesEmbedding(userMessage.id).catch(err =>
          console.error('[Embedding] fire-and-forget error:', err.message));
      }

      // Agent にプロンプト送信（forceNewSession: 前回セッションの JSONL 注入・resume をスキップ）
      // #334: プロンプトへの連結は human-text fence（provenance 境界）で囲んだ文字列を使う
      // #添付対応: files（第5引数）は Agent 側まで配線済み（.devrelay-files/ に書き出しプロンプトへ絶対パスを前置）。
      await sendPromptToAgent(
        project.machineId,
        sessionId,
        fenceHumanText('submitInstruction', trimmedInstruction),
        userId,
        validatedAttachments.files.length > 0 ? validatedAttachments.files : undefined,
        undefined,
        project.path,
        aiTool as any,
        true,  // forceNewSession: MCP submit は常に新規セッション
        undefined, // model: 未指定（UserSettings から補完）
        undefined, // language: 未指定（UserSettings から補完）
        resolvePermissionPolicy('mcp'),  // #332: MCP plan は allowlist 外のツールを聞かずに deny する
        { agentScopeId: sessionId, turnId: planTurnId },  // core#336: 会話セッション境界 + 完了報告の対応付け
      );

      // 監査ログ
      console.log(`📋 [MCP] AUDIT submit: userId=${userId}, projectId=${projectId}, council=${council === true}, rawLength=${lengthCheck.rawLength}, attachments=${validatedAttachments.files.length}, instruction=${trimmedInstruction.slice(0, 100)}...`);

      // #331: council 未指定時はキー自体を返さない（従来と完全同形）。
      // 指定時は「静かなフォールバック禁止」(#325) に従い、エンジン未実装であることを明示する。
      const councilInfo = council === true
        ? { requested: true, status: 'accepted_not_implemented' as const, message: 'Council engine is not implemented yet; running in normal single-AI mode.' }
        : undefined;

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          submissionId: sessionId,
          projectId,
          status: 'planning',
          message: 'Instruction submitted. Use get_plan to check the plan status.',
          ...(councilInfo ? { council: councilInfo } : {}),
          ...(validatedAttachments.files.length > 0 ? {
            attachments: {
              count: validatedAttachments.files.length,
              totalBytes: validatedAttachments.totalBytes,
              files: validatedAttachments.files.map(f => ({ filename: f.filename, mimeType: f.mimeType, size: f.size })),
            },
          } : {}),
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
      note: z.string().optional().describe(`Optional note from the human at approval time (e.g. "go with plan B", max ${APPROVAL_NOTE_MAX_LENGTH} characters). Appended to the exec prompt sent to the AI, and recorded for audit.`),
    },
    async ({ projectId, submissionId, note }) => {
      // エンタープライズ統制ゲート（#268）: マネージャー未割当の member はコマンド発行不可
      const permission = await checkCommandPermission(userId);
      if (!permission.allowed) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: permission.reason }) }], isError: true };
      }

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

      // #334: 長さ検証は Message 作成・Session.approvalNote 保存・execConversation（build開始）の
      // いずれよりも前に行う。ここで拒否すれば「exec メッセージだけ作られて approvalNote が無い」等の
      // 中途半端な状態は一切発生しない。
      const trimmedNote = note?.trim();
      if (trimmedNote) {
        const lengthCheck = validateHumanTextLength(trimmedNote, APPROVAL_NOTE_MAX_LENGTH);
        if (!lengthCheck.ok) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({
              error: 'note is too long',
              kind: 'approvalNote',
              rawLength: lengthCheck.rawLength,
              limit: lengthCheck.limit,
            }) }],
            isError: true,
          };
        }
      }

      // core#336: approve の所有検証。submissionId が本当にこの projectId / userId の Session かを
      // ここで確認しないと、他プロジェクト・他ユーザーの submissionId を渡されても exec してしまう
      // （#336 調査で発見した既存の穴、旧実装には Session の存在・所有チェックが一切無かった）。
      // 満たさない場合は exec を送らず明確なエラーを返し、拒否理由はサーバーログに残す。
      const session = await prisma.session.findUnique({ where: { id: submissionId } });
      const planMessage = session
        ? await prisma.message.findFirst({ where: { sessionId: submissionId, role: 'ai' } })
        : null;
      const guard = evaluateApproveGuard({
        session,
        requestedProjectId: projectId,
        requestedUserId: userId,
        hasPlanMessage: !!planMessage,
      });
      if (!guard.ok) {
        console.warn(`⚠️ [MCP] approve rejected: ${guard.code} (submissionId=${submissionId}, userId=${userId})`);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: guard.message }) }], isError: true };
      }
      // guard.ok === true が保証されたので session / session.planAiSessionId は non-null
      // （TypeScript の絞り込みが evaluateApproveGuard() の戻り値までは追跡できないため、
      // ここで明示的にアサートする。evaluateApproveGuard() が既に両方の非 null を検証済み）
      const nonNullSession = session!;

      // core#336: 二重 approve の競合防止。read → update ではなく atomic に claim する。
      // 同一 submission に approve が並行到着しても、この updateMany の count === 1 になるのは
      // 1 要求だけ（DB のロー単位 UPDATE が直列化するため）。exec 完了後の再 approve も
      // approvedAt が非 null のままなのでここで同じ経路で拒否される。
      const claimedAt = new Date();
      const claim = await prisma.session.updateMany({
        where: { id: submissionId, approvedAt: null },
        data: { approvedAt: claimedAt },
      });
      if (!decideClaimResult(claim.count).claimed) {
        console.warn(`⚠️ [MCP] approve rejected: already approved (submissionId=${submissionId})`);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'This submission has already been approved.' }) }], isError: true };
      }

      // #334: 監査メタ情報。raw text 自体は Session.approvalNote に無切り詰めで保存されるため
      // meta には含めない（rawRef で参照先を明記する）
      const approvalHumanTextMeta = trimmedNote
        ? JSON.stringify({
            kind: 'approvalNote',
            origin: 'human',
            rawLength: trimmedNote.length,
            limit: APPROVAL_NOTE_MAX_LENGTH,
            fenced: true,
            neutralized: neutralizeHumanInputTag(trimmedNote).count,
            rawRef: 'session.approvalNote',
          })
        : undefined;

      // exec メッセージを保存（content は 'exec' の完全一致固定。get_build_status がこの値を
      // exec 開始時刻のアンカーとして使うため、note を混ぜてはいけない（#331 調査で判明した既存の罠）
      await prisma.message.create({
        data: {
          sessionId: submissionId,
          role: 'user',
          content: 'exec',
          platform: 'web',
          ...(approvalHumanTextMeta ? { humanTextMeta: approvalHumanTextMeta } : {}),
        },
      });

      // #331: note があれば Session に記録（監査用。BuildLog が作られない失敗時にも残る）
      if (trimmedNote) {
        await prisma.session.update({ where: { id: submissionId }, data: { approvalNote: trimmedNote } });
      }

      // Plan → Exec 遷移（note は exec プロンプト自体に追記して Agent/AI に届ける。
      // #334: buildApprovalExecPrompt 内部で human-text fence により囲まれる）。
      // core#336: agentScopeId で状態をスコープ分離し、resumeSessionId で plan ターンの
      // AI セッションを明示 resume する（Agent 側の共有ファイルは一切参照させない）。
      try {
        await execConversation(
          project.machineId,
          submissionId,
          project.path,
          userId,
          buildApprovalExecPrompt(note),
          undefined,
          undefined,
          undefined,
          { agentScopeId: submissionId, resumeSessionId: nonNullSession.planAiSessionId! },
        );
      } catch (err) {
        // core#336: claim 解放は自要求が取得した claim に限る。claim 時に設定した approvedAt
        // （claimedAt）との一致を条件に atomic に解放し、他要求が更新した状態を巻き戻さない。
        await prisma.session.updateMany({
          where: buildClaimReleaseWhere(submissionId, claimedAt),
          data: { approvedAt: null },
        });
        console.error(`❌ [MCP] approve exec failed, claim released: submissionId=${submissionId}`, (err as Error).message);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Failed to start execution. Please try again.' }) }], isError: true };
      }

      // 監査ログ
      console.log(`📋 [MCP] AUDIT approve: userId=${userId}, projectId=${projectId}, submissionId=${submissionId}, rawLength=${trimmedNote?.length ?? 0}, note=${trimmedNote ? trimmedNote.slice(0, 100) : '(none)'}`);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          phase: 'queued',
          message: 'Implementation approved and started. Use get_build_status to monitor progress.',
          noteApplied: !!trimmedNote,
        }) }],
      };
    }
  );
}
