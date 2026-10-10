/// <reference lib="webworker" />
import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching';

declare let self: ServiceWorkerGlobalScope;

/**
 * サブパス配信（`vite.config.ts` の `base`）に追従させるための前置パス。
 * Service Worker 内では `import.meta.env.BASE_URL` も Vite が埋め込むが、
 * SW の実際の管理範囲は登録スコープそのものなので、スコープを基準に
 * 絶対 URL を組み立てる（スコープは必ず末尾 `/` を持つ）。
 */
const scopeUrl = (path: string): string =>
  new URL(path.replace(/^\/+/, ''), self.registration.scope).href;

// Workbox プリキャッシュ（ビルド時に自動注入される）
cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

/**
 * 新バージョンの即時有効化
 * vite-plugin-pwa の registerType: 'autoUpdate' が SKIP_WAITING メッセージを送信し、
 * このハンドラで skipWaiting() を呼ぶことで、全タブを閉じなくても新しいコードが即座に反映される
 */
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

/**
 * プッシュ通知受信ハンドラ
 * サーバーから送信された通知を表示
 */
self.addEventListener('push', (event) => {
  if (!event.data) return;

  try {
    const data = event.data.json();
    event.waitUntil(
      self.registration.showNotification(data.title || 'DevRelay', {
        body: data.body || '',
        icon: scopeUrl('/icons/icon-192.png'),
        badge: scopeUrl('/icons/icon-192.png'),
        tag: data.tag || 'devrelay-default',
        data: data.data,
      })
    );
  } catch {
    // JSON パース失敗時はテキストとして表示
    event.waitUntil(
      self.registration.showNotification('DevRelay', {
        body: event.data.text(),
        icon: scopeUrl('/icons/icon-192.png'),
      })
    );
  }
});

/**
 * 通知クリックハンドラ
 * クリックでチャット画面を開く/フォーカスする
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // 既に開いているウィンドウがあればフォーカス
      for (const client of clientList) {
        if (client.url.includes('/chat') && 'focus' in client) {
          return client.focus();
        }
      }
      // なければ新規ウィンドウで開く
      return self.clients.openWindow(scopeUrl('/chat'));
    })
  );
});
