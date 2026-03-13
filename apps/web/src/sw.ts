/// <reference lib="webworker" />
import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching';

declare let self: ServiceWorkerGlobalScope;

// Workbox プリキャッシュ（ビルド時に自動注入される）
cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

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
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        tag: data.tag || 'devrelay-default',
        data: data.data,
      })
    );
  } catch {
    // JSON パース失敗時はテキストとして表示
    event.waitUntil(
      self.registration.showNotification('DevRelay', {
        body: event.data.text(),
        icon: '/icons/icon-192.png',
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
      return self.clients.openWindow('/chat');
    })
  );
});
