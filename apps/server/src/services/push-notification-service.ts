/**
 * Web Push 通知サービス
 *
 * VAPID キーによるプッシュ通知送信
 * 購読情報は UserSettings に JSON で保存
 */

import webpush from 'web-push';
import { prisma } from '../db/client.js';
import { getUserSetting, setUserSetting, SettingKeys } from './user-settings.js';

/** プッシュ購読情報 */
interface PushSubscriptionRecord {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  /** ブラウザ識別（Chrome, Firefox 等） */
  browser?: string;
}

/** VAPID 初期化済みフラグ */
let vapidInitialized = false;

/**
 * VAPID キーを初期化
 * サーバー起動時に呼び出す
 */
export function initVapid(): boolean {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;

  if (!publicKey || !privateKey) {
    console.log('⚠️ VAPID keys not configured, push notifications disabled');
    return false;
  }

  webpush.setVapidDetails(
    'mailto:noreply@devrelay.io',
    publicKey,
    privateKey
  );
  vapidInitialized = true;
  console.log('🔔 Web Push initialized');
  return true;
}

/**
 * VAPID 公開鍵を取得
 */
export function getVapidPublicKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY || null;
}

/**
 * ユーザーの購読一覧を取得
 */
async function getSubscriptions(userId: string): Promise<PushSubscriptionRecord[]> {
  const raw = await getUserSetting(userId, SettingKeys.PUSH_SUBSCRIPTIONS);
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

/**
 * ユーザーの購読一覧を保存
 */
async function saveSubscriptions(userId: string, subs: PushSubscriptionRecord[]): Promise<void> {
  await setUserSetting(userId, SettingKeys.PUSH_SUBSCRIPTIONS, JSON.stringify(subs));
}

/**
 * プッシュ購読を登録
 */
export async function savePushSubscription(
  userId: string,
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  browser?: string
): Promise<void> {
  const subs = await getSubscriptions(userId);

  // 同じ endpoint が既にあれば更新
  const idx = subs.findIndex(s => s.endpoint === subscription.endpoint);
  const record: PushSubscriptionRecord = { ...subscription, browser };

  if (idx >= 0) {
    subs[idx] = record;
  } else {
    subs.push(record);
  }

  await saveSubscriptions(userId, subs);
  console.log(`🔔 Push subscription saved for user ${userId} (${browser || 'unknown'}, total: ${subs.length})`);
}

/**
 * プッシュ購読を解除
 */
export async function removePushSubscription(userId: string, endpoint: string): Promise<void> {
  const subs = await getSubscriptions(userId);
  const filtered = subs.filter(s => s.endpoint !== endpoint);
  await saveSubscriptions(userId, filtered);
  console.log(`🔔 Push subscription removed for user ${userId} (remaining: ${filtered.length})`);
}

/**
 * ユーザーにプッシュ通知を送信
 * 全ての登録済み購読に送信し、期限切れは自動削除
 */
export async function sendPushNotification(
  userId: string,
  title: string,
  body: string,
  data?: Record<string, unknown>
): Promise<void> {
  if (!vapidInitialized) return;

  const subs = await getSubscriptions(userId);
  if (subs.length === 0) return;

  const payload = JSON.stringify({ title, body, tag: `devrelay-${Date.now()}`, data });
  const expiredEndpoints: string[] = [];

  await Promise.allSettled(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys },
          payload,
          { TTL: 3600 }
        );
      } catch (err: any) {
        // 410 Gone: 購読期限切れ → 自動削除
        if (err.statusCode === 410 || err.statusCode === 404) {
          expiredEndpoints.push(sub.endpoint);
          console.log(`🔔 Push subscription expired (${err.statusCode}), removing: ${sub.endpoint.slice(0, 50)}...`);
        } else {
          console.error(`🔔 Push notification failed:`, err.statusCode || err.message);
        }
      }
    })
  );

  // 期限切れ購読を一括削除
  if (expiredEndpoints.length > 0) {
    const remaining = subs.filter(s => !expiredEndpoints.includes(s.endpoint));
    await saveSubscriptions(userId, remaining);
  }
}

/**
 * セッション完了時のプッシュ通知送信
 * session テーブルから userId を取得して通知
 */
export async function sendPushNotificationForSession(
  sessionId: string,
  message: string
): Promise<void> {
  if (!vapidInitialized) return;

  try {
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      include: { project: true },
    });
    if (!session) return;

    const projectName = session.project?.name || 'Unknown';
    // 通知本文は先頭 100 文字に切り詰め
    const body = message.length > 100 ? message.slice(0, 100) + '...' : message;

    await sendPushNotification(
      session.userId,
      `✅ ${projectName}`,
      body,
      { sessionId, projectId: session.projectId }
    );
  } catch (err: any) {
    console.error('🔔 Push notification for session failed:', err.message);
  }
}
