/**
 * 通知サービス
 *
 * モバイルアプリの通知一覧・バッジ管理用
 * FCM プッシュ通知と同タイミングで DB に通知レコードを作成
 */

import { truncateSafe, stripLoneSurrogates } from '@devrelay/shared';
import { prisma } from '../db/client.js';

/** 通知タイプ */
type NotificationType = 'response' | 'approval' | 'error';

/**
 * 通知レコードを作成する（fire-and-forget で呼ぶこと）
 *
 * @param userId 通知の宛先ユーザー ID
 * @param type 通知タイプ（response / approval / error）
 * @param projectId 対象プロジェクト ID
 * @param projectName プロジェクト名（非正規化、表示用）
 * @param title 通知タイトル
 * @param body 通知本文（200文字に切り詰め）
 */
export async function createNotification(
  userId: string,
  type: NotificationType,
  projectId: string,
  projectName: string,
  title: string,
  body: string
): Promise<void> {
  try {
    // 絵文字（サロゲートペア）を途中で切ると不正な UTF-16 になり Prisma が JSON を拒否する
    // （#297: `unexpected end of hex escape` で通知が作れていなかった）
    await prisma.notification.create({
      data: {
        userId,
        type,
        projectId,
        projectName,
        title: stripLoneSurrogates(title),
        body: truncateSafe(body, 200),
      },
    });
  } catch (err: any) {
    console.error('🔔 Failed to create notification:', err.message);
  }
}

/**
 * ユーザーの通知一覧を取得（カーソルベースページネーション、新しい順）
 *
 * @param userId ユーザー ID
 * @param limit 取得件数（最大100）
 * @param before カーソル（この通知 ID より古い通知を取得）
 */
export async function getNotifications(
  userId: string,
  limit: number = 50,
  before?: string
): Promise<{ notifications: any[]; hasMore: boolean }> {
  const take = Math.min(Math.max(limit, 1), 100);

  const where: any = { userId };
  if (before) {
    // カーソルの通知の createdAt を取得して、それより古い通知を取得
    const cursor = await prisma.notification.findUnique({ where: { id: before }, select: { createdAt: true } });
    if (cursor) {
      where.createdAt = { lt: cursor.createdAt };
    }
  }

  const notifications = await prisma.notification.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: take + 1, // hasMore 判定用に +1
  });

  const hasMore = notifications.length > take;
  const result = hasMore ? notifications.slice(0, take) : notifications;

  return {
    notifications: result.map(n => ({
      id: n.id,
      type: n.type,
      projectId: n.projectId,
      projectName: n.projectName,
      title: n.title,
      body: n.body,
      isRead: n.isRead,
      createdAt: n.createdAt.toISOString(),
    })),
    hasMore,
  };
}

/**
 * ユーザーの全未読通知を既読にする
 *
 * @returns 既読にした通知の件数
 */
export async function markAllAsRead(userId: string): Promise<number> {
  const result = await prisma.notification.updateMany({
    where: { userId, isRead: false },
    data: { isRead: true },
  });
  return result.count;
}

/**
 * ユーザーの未読通知数を取得
 */
export async function getUnreadCount(userId: string): Promise<number> {
  return prisma.notification.count({
    where: { userId, isRead: false },
  });
}
