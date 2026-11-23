/**
 * サイクルSB-1b: サーバーが伝えた「このセッションは Sandbox 対象（`Project.sandboxEnabled`）か」を
 * `sessionId` を鍵にして保持する専用レジストリ。
 *
 * `terminalMode`/`crossAskScope` は `SendPromptOptions` に乗せて渡す方式だが、`connection.ts` の
 * `retryOptions`（`:2269-2305` 付近。`--resume` 失敗時の再送オプション）は手で詰め直す実装で、
 * 既に `terminalMode`/`crossAskScope` を取りこぼす既存バグがある（本サイクルでは直さない）。
 * `sandboxEnabled` をこれ以上同じ経路に積むと同じ穴に落ちるため、`SendPromptOptions` には
 * 乗せず、`sessionId` 単位の Map に外出しする。retry は同じ `sessionId` で `sendPromptToAi()` を
 * 呼ぶため、この Map からは取りこぼれない。
 */

const serverSandboxEnabledBySession = new Map<string, true>();

/** サーバーから届いた `sandboxEnabled` を反映する。`false`/未指定なら登録を消す（既定へ戻す）。 */
export function setServerSandboxEnabled(sessionId: string, enabled: boolean | undefined): void {
  if (enabled) {
    serverSandboxEnabledBySession.set(sessionId, true);
  } else {
    serverSandboxEnabledBySession.delete(sessionId);
  }
}

/** このセッションがサーバーから Sandbox 対象と伝えられているか（未登録なら false）。 */
export function getServerSandboxEnabled(sessionId: string): boolean {
  return serverSandboxEnabledBySession.has(sessionId);
}

/** セッション破棄時に登録を消す（`sessionInfoMap.delete(sessionId)` と対で呼ぶこと）。 */
export function clearServerSandboxEnabled(sessionId: string): void {
  serverSandboxEnabledBySession.delete(sessionId);
}
