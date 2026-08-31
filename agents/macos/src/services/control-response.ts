/**
 * #343: SDK の `Query.request()` が resolve する control_response の「封筒」から中身を取り出す。
 *
 * `Query.request()` は `{ subtype, request_id, response }` という封筒を resolve する
 * （SDK 自身も内部で `(await this.request(x)).response` と1段剥がして使っている、`sdk.mjs` 実測）。
 * `claude-login.ts` はこれを見落として封筒をそのまま `response.manualUrl` として読んでいたため、
 * `claude_authenticate`/`claude_oauth_callback` の呼び出しが常に `undefined` を読み `unsupportedAgent`
 * に落ちるバグがあった（#341 リリース直後、実チャットで即座に発覚）。
 *
 * 将来 SDK が中身を直接返すようになっても壊れないよう、封筒形・中身直返し形の両方を受け付ける。
 * 外部 import ゼロの純関数（#337 progress-timeout.ts / #339 claude-login-code.ts と同じ流儀）で
 * `claude-login.ts`（SDK 依存）から切り離してテストできるようにする。
 *
 * @param raw `Query.request()` の resolve 値（型不明の生の戻り値）
 * @returns `raw.response` がオブジェクトならそれ、そうでなくオブジェクトなら `raw` 自身、
 *          それ以外（null/undefined/文字列/数値等）は空オブジェクト。例外は投げない。
 */
export function unwrapControlResponse(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if (obj.response && typeof obj.response === 'object') {
      return obj.response as Record<string, unknown>;
    }
    return obj;
  }
  return {};
}
