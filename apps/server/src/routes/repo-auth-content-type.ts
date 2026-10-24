/**
 * インストーラのサーバー配布PAT取得が IIS 経由で 415 になる不具合の修正サイクル。
 *
 * `POST /api/agent/repo-auth` のプラグインスコープ限定で content-type parser を
 * 「何でも受けてボディを捨てる」1 本に置き換えるためのヘルパー。
 *
 * 背景: IIS(ARR) 等のリバースプロキシは、Content-Type ヘッダ無しの POST にもボディ framing
 * ヘッダ（`Content-Length`/`Transfer-Encoding`）を付けて転送することがある。Fastify は
 * 「Content-Type 未指定だがボディはある」場合に `contentTypeParser.run('')` へ入り、一致する
 * パーサーが無いと `FST_ERR_CTP_INVALID_MEDIA_TYPE`（415）を返す
 * （`node_modules/fastify/lib/handleRequest.js` 参照）。このルートは `request.body` を一切
 * 読まないため、どんな Content-Type・ボディでも読み捨てて 415/400 を起こさないようにする。
 *
 * **スコープ限定である根拠**: 呼び出し元の `agentRepoAuthRoutes` は `fastify-plugin` で
 * ラップしていない素の async function を `app.register()` している。Fastify はこのような
 * プラグインを登録する際、親の ContentTypeParser を複製した専用インスタンスを子に持たせる
 * （`node_modules/fastify/lib/pluginOverride.js` の `buildContentTypeParser`）。したがって
 * ここで `removeAllContentTypeParsers()` を呼んでも、このプラグインスコープの外（他ルート・
 * ルートの `app`）には一切影響しない。
 *
 * Fastify 本体への直接依存を避け、必要なメソッドだけを構造的に要求する型にしてある
 * （テストから `dist/` 経由で単体 import しやすくするため。他の純粋関数モジュールと同じ流儀）。
 */

/** `applyRepoAuthContentTypeParser` が要求する最小限のインターフェース（Fastify インスタンスの一部） */
export interface RepoAuthParserTarget {
  removeAllContentTypeParsers(): void;
  addContentTypeParser(
    contentType: string,
    opts: { parseAs: 'string' | 'buffer' },
    parser: (
      request: unknown,
      payload: unknown,
      done: (error: Error | null, body?: unknown) => void
    ) => void
  ): void;
}

/**
 * 指定された Fastify インスタンス（プラグインスコープ）の content-type parser を、
 * 「どんな Content-Type でも受理しボディを読み捨てる」1 本に置き換える。
 *
 * `/api/agent/repo-auth` のハンドラは `request.body` を参照しないため、ボディの内容を
 * 捨てても機能に影響しない。
 */
export function applyRepoAuthContentTypeParser(app: RepoAuthParserTarget): void {
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'string' }, (_request, _payload, done) => {
    done(null, undefined);
  });
}
