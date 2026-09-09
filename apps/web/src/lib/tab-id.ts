/**
 * スレッド管理 サイクル3（WebUI）: ブラウザタブごとの tabId を sessionStorage で管理する。
 *
 * 元は `hooks/useWebSocket.ts` に private 関数として存在していたが、
 * `POST /api/threads` / `POST /api/sessions/:id/switch`（`chatId = web:${userId}:${tabId}` の
 * 解決に tabId が必要）からも同じ tabId を参照する必要があるため共通化した。
 * 挙動は元の実装から変更していない（キー名 `devrelay-tab-id` も同一）。
 */
export function getTabId(): string {
  let tabId = sessionStorage.getItem('devrelay-tab-id');
  if (!tabId) {
    tabId = crypto.randomUUID();
    sessionStorage.setItem('devrelay-tab-id', tabId);
  }
  return tabId;
}
