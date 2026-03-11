/**
 * エージェントドキュメント CRUD API
 *
 * マシンごとのドキュメント管理（一覧・アップロード・ダウンロード・削除）。
 * WebUI ユーザートークン認証 + マシン所有権チェック。
 * アップロード時に embedding を fire-and-forget で生成し、Agent にも WS で同期する。
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../db/client.js';
import { authenticate } from './auth.js';
import { processAgentDocumentEmbedding } from '../services/embedding-service.js';
import { sendToAgent } from '../services/agent-manager.js';

/** エージェントドキュメント API ルートを登録 */
export function registerAgentDocumentApiRoutes(app: FastifyInstance) {
  // Fastify の register でスコープを作り、addHook で認証を一括適用
  app.register(async (scoped) => {
    scoped.addHook('preHandler', authenticate);

    /**
     * ドキュメント一覧（メタデータのみ、content は含まない）
     * @route GET /api/machines/:machineId/documents
     */
    scoped.get('/api/machines/:machineId/documents', async (request, reply) => {
      // @ts-ignore
      const userId = request.user.id;
      const { machineId } = request.params as { machineId: string };

      const machine = await prisma.machine.findFirst({
        where: { id: machineId, userId, deletedAt: null },
      });
      if (!machine) return reply.status(404).send({ error: 'Machine not found' });

      const documents = await prisma.agentDocument.findMany({
        where: { machineId },
        select: {
          id: true,
          filename: true,
          mimeType: true,
          size: true,
          embeddingStatus: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: { createdAt: 'desc' },
      });

      return { documents };
    });

    /**
     * ドキュメントアップロード（base64 files 配列）
     * アップロード後に embedding を fire-and-forget で生成し、Agent にも WS で同期
     * @route POST /api/machines/:machineId/documents
     */
    scoped.post('/api/machines/:machineId/documents', { bodyLimit: 50 * 1024 * 1024 }, async (request, reply) => {
      // @ts-ignore
      const userId = request.user.id;
      const { machineId } = request.params as { machineId: string };
      const { files } = request.body as { files: Array<{ filename: string; content: string; mimeType: string; size: number }> };

      const machine = await prisma.machine.findFirst({
        where: { id: machineId, userId, deletedAt: null },
      });
      if (!machine) return reply.status(404).send({ error: 'Machine not found' });

      if (!files || !Array.isArray(files) || files.length === 0) {
        return reply.status(400).send({ error: 'No files provided' });
      }

      console.log(`📁 Doc upload: machineId=${machineId}, files=${files.length}`);

      const created: Array<{ id: string; filename: string; size: number }> = [];

      for (const file of files) {
        const content = Buffer.from(file.content, 'base64');
        const doc = await prisma.agentDocument.create({
          data: {
            machineId,
            filename: file.filename,
            mimeType: file.mimeType,
            size: file.size || content.length,
            content,
          },
        });
        created.push({ id: doc.id, filename: doc.filename, size: doc.size });

        // embedding を非同期生成（fire-and-forget）
        processAgentDocumentEmbedding(doc.id).catch(() => {});

        // Agent にファイルを WS で同期（オンライン時のみ）
        sendToAgent(machineId, {
          type: 'server:doc:sync',
          payload: {
            filename: file.filename,
            content: file.content,  // base64 のまま送信
            mimeType: file.mimeType,
          },
        });
      }

      return { documents: created };
    });

    /**
     * ドキュメントダウンロード（バイナリ）
     * ?token= クエリパラメータ認証にも対応（img タグ / ブラウザ直接開き用）
     * @route GET /api/machines/:machineId/documents/:docId/download
     */
    scoped.get('/api/machines/:machineId/documents/:docId/download', async (request, reply) => {
      // @ts-ignore
      const userId = request.user?.id || (request as any).userId;
      const { machineId, docId } = request.params as { machineId: string; docId: string };

      const doc = await prisma.agentDocument.findUnique({
        where: { id: docId },
        include: { machine: { select: { userId: true } } },
      });

      if (!doc || doc.machineId !== machineId || doc.machine.userId !== userId) {
        return reply.status(404).send({ error: 'Document not found' });
      }

      return reply
        .header('Content-Type', doc.mimeType)
        .header('Content-Disposition', `inline; filename="${doc.filename}"`)
        .header('Cache-Control', 'private, max-age=86400')
        .send(doc.content);
    });

    /**
     * ドキュメント削除
     * @route DELETE /api/machines/:machineId/documents/:docId
     */
    scoped.delete('/api/machines/:machineId/documents/:docId', async (request, reply) => {
      // @ts-ignore
      const userId = request.user.id;
      const { machineId, docId } = request.params as { machineId: string; docId: string };

      const doc = await prisma.agentDocument.findUnique({
        where: { id: docId },
        include: { machine: { select: { userId: true } } },
      });

      if (!doc || doc.machineId !== machineId || doc.machine.userId !== userId) {
        return reply.status(404).send({ error: 'Document not found' });
      }

      const filename = doc.filename;
      await prisma.agentDocument.delete({ where: { id: docId } });

      // Agent にファイル削除を通知（オンライン時のみ）
      sendToAgent(machineId, {
        type: 'server:doc:delete',
        payload: { filename },
      });

      console.log(`📁 Doc deleted: machineId=${machineId}, filename=${filename}`);

      return { success: true };
    });
  });
}
