/**
 * WebUI の共通 HTTP ヘルパー（`api.ts` の `request()`）が組み立てるリクエストヘッダの
 * 純粋関数（外部 import ゼロ）。
 *
 * 2026-11-08 に見つかったバグの修正: 旧実装は body の有無に関わらず常に
 * `Content-Type: application/json` を付けていた。body が無い POST（例:
 * `POST /teams/:teamId/subscribe`）では「JSON を送る」と宣言しながら本文が空、という
 * 不正な HTTP リクエストになり、Fastify の既定 JSON パーサが認証フックより前の
 * ボディパース段階で `FST_ERR_CTP_EMPTY_JSON_BODY`（400）として弾いていた
 * （ハンドラは一度も実行されない）。同じ条件の呼び出しが `api.ts` に 5 箇所あり、
 * いずれも以前から 400 で動いていなかった（`push/fcm/test`・`teams/invites/:id/decline`・
 * `teams/:teamId/subscribe`・`org/leave`・`sites/:host/health-check`）。
 *
 * 本関数では `hasBody` を明示的に受け取り、body があるときだけ `Content-Type` を付ける。
 */

export interface BuildRequestHeadersParams {
  /** `localStorage` 等から取得したセッショントークン。無ければ Authorization を付けない */
  token: string | null;
  /** 送信する body があるか（無いのに Content-Type を付けると Fastify が 400 で弾く） */
  hasBody: boolean;
}

/**
 * `fetch()` に渡すリクエストヘッダを組み立てる。
 * `hasBody` と `token` の有無は互いに独立して判定する（一方が他方に影響しない）。
 */
export function buildRequestHeaders(params: BuildRequestHeadersParams): Record<string, string> {
  const headers: Record<string, string> = {};
  if (params.hasBody) {
    headers['Content-Type'] = 'application/json';
  }
  if (params.token) {
    headers['Authorization'] = `Bearer ${params.token}`;
  }
  return headers;
}
