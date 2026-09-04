/**
 * DevRelay Remote MCP サーバー
 *
 * DevRelay の既存機能（Plan/Exec/BuildLog/Conversations）を
 * MCP ツールとして公開する薄いファサード。
 * Claude モバイル（音声）等をフロントエンドとして利用可能にする。
 *
 * トランスポート: Streamable HTTP（/mcp エンドポイント）
 * 認証: v1 は Bearer トークン（既存 AuthSession）
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerMcpTools } from './tools.js';
import { authenticateMcp } from './auth.js';
import { oauthRoutes } from './oauth.js';

/** MCP サーバーの instructions（ツールの正しい使い方をホスト LLM に伝える） */
const SERVER_INSTRUCTIONS = `DevRelay はAIコーディングの投入・承認を行うシステムです。手順:
1) 投入先が曖昧なら list_projects で確認。
2) 指示が固まるまではツールを呼ばず会話で詰める（勝手に submit しない）。
3) ユーザーが「実行/送って」と言ったら submit_instruction。返る submissionId を保持。
4) get_plan でプランを取得し、要約して読み上げ、実装の可否を聞く。
5) ユーザーが「実装して」と言ったら approve_implementation。
6) get_build_status で進捗・完了を確認。
調べ物は search_project_context を使う。会話履歴の閲覧は get_conversation_history で期間指定して取得できる。添付ファイル（画像等）は get_conversation_history で attachments を確認し、get_attachment で取得できる。submit/approve は破壊的操作なので必ず確認を取る。
submit_instruction には画像等の添付ファイル（attachments）を渡せるが、上限を超えるリクエストは submit_instruction 自体が呼ばれる前に HTTP エラーで拒否されるため、ツールの isError ではなく HTTP レベルのエラーとして現れる点に注意。`;

/**
 * /mcp のリクエストボディ上限（16 MiB）。
 * 添付の生バイト合計上限 10MB → base64 で約 13.34MB、加えて JSON エスケープ・
 * ファイル名・instruction（最大 20,000 文字）・JSON-RPC の封筒分の余裕を見て 16 MiB。
 * Fastify のグローバル既定（1 MiB）ではこの用途に届かないため /mcp にのみ明示指定する。
 */
const MCP_BODY_LIMIT_BYTES = 16 * 1024 * 1024;

/**
 * Fastify に MCP エンドポイントを登録する
 */
export async function mcpRoutes(app: FastifyInstance) {
  // OAuth 2.1 エンドポイント（well-known + register + authorize + token）
  await app.register(oauthRoutes);

  // POST /mcp — Streamable HTTP メインエンドポイント
  // bodyLimit: 添付ファイル（画像等）を含むリクエストのため Fastify 既定の 1 MiB から引き上げる。
  app.post('/mcp', { bodyLimit: MCP_BODY_LIMIT_BYTES }, async (request: FastifyRequest, reply: FastifyReply) => {
    // 認証
    const userId = await authenticateMcp(request);
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    // MCP サーバーインスタンスを作成（リクエストごと。ステートレス設計）
    const mcpServer = new McpServer({
      name: 'devrelay',
      version: '1.0.0',
    }, {
      instructions: SERVER_INSTRUCTIONS,
    });

    // ツールを登録（userId をクロージャで渡す）
    registerMcpTools(mcpServer, userId);

    // Streamable HTTP トランスポート
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,  // ステートレス（セッション管理なし）
    });

    // MCP サーバーに接続
    await mcpServer.connect(transport);

    // Fastify のリクエスト/レスポンスを Node.js の IncomingMessage/ServerResponse に変換
    await transport.handleRequest(request.raw, reply.raw, request.body);

    // reply.raw に直接書き込んだので Fastify に「もう送った」と伝える
    reply.hijack();
  });

  // GET /mcp — SSE 用（Claude モバイルが SSE fallback する場合）
  app.get('/mcp', async (request: FastifyRequest, reply: FastifyReply) => {
    return reply.status(405).send({ error: 'Use POST for Streamable HTTP transport' });
  });

  // DELETE /mcp — セッション終了用（ステートレスなので no-op）
  app.delete('/mcp', async (request: FastifyRequest, reply: FastifyReply) => {
    return reply.status(200).send({ ok: true });
  });
}
