/**
 * FCM（Firebase Cloud Messaging）プッシュ通知サービス
 *
 * Firebase Admin SDK を使用してモバイルアプリ（iOS/Android）にプッシュ通知を送信
 * FIREBASE_SERVICE_ACCOUNT_PATH 環境変数が未設定の場合は無効化（エラーにしない）
 */

import { getUserSetting, setUserSetting, SettingKeys } from './user-settings.js';
import { prisma } from '../db/client.js';

/** FCM トークンレコード */
interface FcmTokenRecord {
  token: string;
  /** プラットフォーム識別（ios / android） */
  platform: 'ios' | 'android';
  /** 登録日時（ISO 文字列） */
  registeredAt: string;
}

/** Firebase Admin のメッセージング型（動的 import のため any） */
let messaging: any = null;

/** FCM 初期化済みフラグ */
let fcmInitialized = false;

/**
 * Firebase Admin SDK を初期化
 * FIREBASE_SERVICE_ACCOUNT_PATH が未設定の場合はスキップ（FCM 無効化）
 */
export async function initFcm(): Promise<boolean> {
  const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;

  if (!serviceAccountPath) {
    console.log('⚠️ FIREBASE_SERVICE_ACCOUNT_PATH not configured, FCM push notifications disabled');
    return false;
  }

  try {
    // 動的 import で firebase-admin をロード（パッケージ未インストール時もエラーにしない）
    const admin = await import('firebase-admin');
    const fs = await import('fs');

    if (!fs.existsSync(serviceAccountPath)) {
      console.log(`⚠️ Firebase service account file not found: ${serviceAccountPath}, FCM disabled`);
      return false;
    }

    const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf-8'));

    // 既に初期化済みの場合はスキップ
    if (admin.default.apps?.length === 0 || !admin.default.apps) {
      admin.default.initializeApp({
        credential: admin.default.credential.cert(serviceAccount),
      });
    }

    messaging = admin.default.messaging();
    fcmInitialized = true;
    console.log('🔔 FCM (Firebase Cloud Messaging) initialized');
    return true;
  } catch (err: any) {
    console.error('⚠️ FCM initialization failed:', err.message);
    return false;
  }
}

/**
 * FCM が利用可能かどうか
 */
export function isFcmEnabled(): boolean {
  return fcmInitialized;
}

/**
 * ユーザーの FCM トークン一覧を取得
 */
async function getFcmTokens(userId: string): Promise<FcmTokenRecord[]> {
  const raw = await getUserSetting(userId, SettingKeys.FCM_TOKENS);
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

/**
 * ユーザーの FCM トークン一覧を保存
 */
async function saveFcmTokens(userId: string, tokens: FcmTokenRecord[]): Promise<void> {
  await setUserSetting(userId, SettingKeys.FCM_TOKENS, JSON.stringify(tokens));
}

/**
 * FCM トークンを登録
 * 同じトークンが既にあれば更新、なければ追加
 */
export async function saveFcmToken(
  userId: string,
  fcmToken: string,
  platform: 'ios' | 'android'
): Promise<void> {
  const tokens = await getFcmTokens(userId);

  // 同じトークンが既にあれば更新
  const idx = tokens.findIndex(t => t.token === fcmToken);
  const record: FcmTokenRecord = {
    token: fcmToken,
    platform,
    registeredAt: new Date().toISOString(),
  };

  if (idx >= 0) {
    tokens[idx] = record;
  } else {
    tokens.push(record);
  }

  await saveFcmTokens(userId, tokens);
  console.log(`🔔 FCM token saved for user ${userId} (${platform}, total: ${tokens.length})`);
}

/**
 * FCM トークンを削除
 */
export async function removeFcmToken(userId: string, fcmToken: string): Promise<void> {
  const tokens = await getFcmTokens(userId);
  const filtered = tokens.filter(t => t.token !== fcmToken);
  await saveFcmTokens(userId, filtered);
  console.log(`🔔 FCM token removed for user ${userId} (remaining: ${filtered.length})`);
}

/**
 * ユーザーに FCM プッシュ通知を送信
 * 全登録済みトークンに送信し、無効なトークンは自動削除
 */
export async function sendFcmNotification(
  userId: string,
  title: string,
  body: string,
  data?: Record<string, string>
): Promise<void> {
  if (!fcmInitialized || !messaging) return;

  const tokens = await getFcmTokens(userId);
  if (tokens.length === 0) return;

  const invalidTokens: string[] = [];

  await Promise.allSettled(
    tokens.map(async (record) => {
      try {
        await messaging.send({
          token: record.token,
          notification: {
            title,
            body: body.length > 200 ? body.slice(0, 200) + '...' : body,
          },
          data: data || {},
          // iOS 固有設定
          apns: {
            payload: {
              aps: {
                sound: 'default',
                badge: 1,
              },
            },
          },
          // Android 固有設定
          android: {
            priority: 'high' as const,
            notification: {
              sound: 'default',
              channelId: 'devrelay_default',
            },
          },
        });
      } catch (err: any) {
        // 無効なトークン（アプリ削除、トークン期限切れ等）→ 自動削除
        if (
          err.code === 'messaging/registration-token-not-registered' ||
          err.code === 'messaging/invalid-registration-token' ||
          err.code === 'messaging/invalid-argument'
        ) {
          invalidTokens.push(record.token);
          console.log(`🔔 FCM token expired/invalid (${err.code}), removing: ${record.token.slice(0, 20)}...`);
        } else {
          console.error(`🔔 FCM notification failed:`, err.code || err.message);
        }
      }
    })
  );

  // 無効なトークンを一括削除
  if (invalidTokens.length > 0) {
    const remaining = tokens.filter(t => !invalidTokens.includes(t.token));
    await saveFcmTokens(userId, remaining);
  }
}

/**
 * セッション完了時の FCM プッシュ通知送信
 * session テーブルから userId を取得して通知
 */
export async function sendFcmNotificationForSession(
  sessionId: string,
  message: string
): Promise<void> {
  if (!fcmInitialized) return;

  try {
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      include: { project: true },
    });
    if (!session) return;

    const projectName = session.project?.name || 'Unknown';
    const body = message.length > 100 ? message.slice(0, 100) + '...' : message;

    await sendFcmNotification(
      session.userId,
      `✅ ${projectName}`,
      body,
      { sessionId, projectId: session.projectId }
    );
  } catch (err: any) {
    console.error('🔔 FCM notification for session failed:', err.message);
  }
}

/**
 * ツール承認待ちの FCM プッシュ通知送信
 */
export async function sendFcmNotificationForToolApproval(
  userId: string,
  toolName: string,
  projectName: string,
  sessionId: string,
  projectId: string
): Promise<void> {
  if (!fcmInitialized) return;

  try {
    await sendFcmNotification(
      userId,
      `🔐 ${projectName}`,
      `ツール承認待ち: ${toolName}`,
      { sessionId, projectId, type: 'tool_approval' }
    );
  } catch (err: any) {
    console.error('🔔 FCM notification for tool approval failed:', err.message);
  }
}
