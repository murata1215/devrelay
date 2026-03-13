/**
 * プッシュ通知の許可バナー
 *
 * 未許可の場合にバナーを表示し、ユーザーに通知を有効化するよう促す
 * 許可済み or 拒否済みの場合は非表示
 */
import { useState, useEffect, useCallback } from 'react';
import { getToken } from '../lib/api';

/** 通知バナーの非表示フラグ（ユーザーが「あとで」を押した場合） */
const DISMISS_KEY = 'devrelay-push-dismissed';
/** 通知購読済みフラグ */
const SUBSCRIBED_KEY = 'devrelay-push-subscribed';

export function NotificationBanner() {
  const [visible, setVisible] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // ブラウザが通知をサポートしているか
    if (!('Notification' in window) || !('serviceWorker' in navigator)) return;
    // 既に許可 or 拒否済み → 非表示
    if (Notification.permission !== 'default') return;
    // ユーザーが「あとで」を押していたら非表示（24時間後にリセット）
    const dismissed = localStorage.getItem(DISMISS_KEY);
    if (dismissed && Date.now() - parseInt(dismissed) < 24 * 60 * 60 * 1000) return;
    // 既に購読済みなら非表示
    if (localStorage.getItem(SUBSCRIBED_KEY)) return;

    setVisible(true);
  }, []);

  /** 通知を有効化 */
  const enableNotifications = useCallback(async () => {
    setLoading(true);
    try {
      // 通知許可をリクエスト
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setVisible(false);
        return;
      }

      // VAPID 公開鍵を取得
      const token = getToken();
      const vapidRes = await fetch('/api/push/vapid-key', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!vapidRes.ok) throw new Error('Failed to get VAPID key');
      const { publicKey } = await vapidRes.json();

      // Service Worker の準備を待つ
      const reg = await navigator.serviceWorker.ready;

      // プッシュ購読を作成
      const subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey).buffer as ArrayBuffer,
      });

      // サーバーに登録
      const subJson = subscription.toJSON();
      await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          subscription: {
            endpoint: subJson.endpoint,
            keys: subJson.keys,
          },
          browser: detectBrowser(),
        }),
      });

      localStorage.setItem(SUBSCRIBED_KEY, 'true');
      setVisible(false);
    } catch (err) {
      console.error('Push subscription failed:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  /** あとで */
  const dismiss = useCallback(() => {
    localStorage.setItem(DISMISS_KEY, Date.now().toString());
    setVisible(false);
  }, []);

  if (!visible) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 max-w-sm rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-4 shadow-lg">
      <p className="text-sm text-[var(--color-text)] mb-3">
        AI の処理完了時に通知を受け取れます。ブラウザを閉じていても届きます。
      </p>
      <div className="flex gap-2 justify-end">
        <button
          onClick={dismiss}
          className="px-3 py-1.5 text-xs rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
        >
          あとで
        </button>
        <button
          onClick={enableNotifications}
          disabled={loading}
          className="px-3 py-1.5 text-xs rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? '設定中...' : '通知を有効にする'}
        </button>
      </div>
    </div>
  );
}

/** Base64 URL 文字列を Uint8Array に変換（VAPID キー用） */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from(rawData, (char) => char.charCodeAt(0));
}

/** ブラウザ名を簡易検出 */
function detectBrowser(): string {
  const ua = navigator.userAgent;
  if (ua.includes('Firefox')) return 'Firefox';
  if (ua.includes('Edg')) return 'Edge';
  if (ua.includes('Chrome')) return 'Chrome';
  if (ua.includes('Safari')) return 'Safari';
  return 'Unknown';
}
