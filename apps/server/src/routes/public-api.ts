import { FastifyInstance } from 'fastify';
import { prisma } from '../db/client.js';

/**
 * 認証不要のパブリック API エンドポイント
 * インストーラーなど、WebUI 認証セッションを持たないクライアントが使用する
 */
export async function publicApiRoutes(app: FastifyInstance) {

  /**
   * トークンの事前検証 API
   *
   * ワンライナーインストーラーがビルド前にトークンの妥当性を確認するために使用する。
   * トークンに紐づくマシン名が仮名（agent-*）でない場合、インストーラー側で
   * 現在のマシンの hostname/username と比較し、不一致なら中断する。
   *
   * トークン自体が秘密情報のため、トークンを知っている呼び出し元に
   * マシン名を返すのはセキュリティ上問題ない。
   *
   * @body { token: string } - マシントークン
   * @returns {
   *   valid: boolean,            - トークンが有効かどうか
   *   provisional: boolean,      - 仮名（agent-*）かどうか
   *   machineName: string | null - 現在のマシン名（無効なトークンの場合は null）
   * }
   */
  app.post('/api/public/validate-token', async (request, reply) => {
    const { token } = (request.body || {}) as { token?: string };

    // トークン必須チェック
    if (!token || token.trim().length === 0) {
      return reply.status(400).send({ error: 'Token is required' });
    }

    // DB でトークンを検索
    const machine = await prisma.machine.findFirst({
      where: { token: token.trim() },
      select: { name: true },
    });

    // トークンが無効（DB に存在しない）場合
    if (!machine) {
      return {
        valid: false,
        provisional: false,
        machineName: null,
      };
    }

    // 仮名（agent-* で始まる）かどうかを判定
    // agent-* は WebUI でマシン作成時に自動生成される仮名で、
    // Agent 初回接続時に hostname/username で上書きされる
    const isProvisional = machine.name.startsWith('agent-');

    return {
      valid: true,
      provisional: isProvisional,
      machineName: machine.name,
    };
  });
}
