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
調べ物は search_project_context を使う。submit/approve は破壊的操作なので必ず確認を取る。`;

/**
 * Fastify に MCP エンドポイントを登録する
 */
export async function mcpRoutes(app: FastifyInstance) {
  // OAuth 2.1 エンドポイント（well-known + register + authorize + token）
  await app.register(oauthRoutes);

  // POST /mcp — Streamable HTTP メインエンドポイント
  app.post('/mcp', async (request: FastifyRequest, reply: FastifyReply) => {
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
