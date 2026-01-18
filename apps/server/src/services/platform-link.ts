import { prisma } from '../db/client.js';

// 紛らわしい文字を除外した文字セット (0, O, I, 1 を除外)
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
const CODE_EXPIRY_MINUTES = 5;

/**
 * 6桁のリンクコードを生成
 */
function generateCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_CHARS.charAt(Math.floor(Math.random() * CODE_CHARS.length));
  }
  return code;
}

/**
 * プラットフォームユーザー用のリンクコードを作成
 */
export async function createLinkCode(
  platform: string,
  platformUserId: string,
  platformName?: string,
  chatId?: string
): Promise<string> {
  // 既存の未使用コードを削除（同一プラットフォームユーザー）
  await prisma.platformLinkCode.deleteMany({
    where: {
      platform,
      platformUserId,
    },
  });

  // 新しいコードを生成（衝突回避のため最大3回リトライ）
  let code = generateCode();
  for (let i = 0; i < 3; i++) {
    const existing = await prisma.platformLinkCode.findUnique({
      where: { code },
    });
    if (!existing) break;
    code = generateCode();
  }

  // 有効期限を設定（5分後）
  const expiresAt = new Date();
  expiresAt.setMinutes(expiresAt.getMinutes() + CODE_EXPIRY_MINUTES);

  await prisma.platformLinkCode.create({
    data: {
      code,
      platform,
      platformUserId,
      platformName,
      chatId,
      expiresAt,
    },
  });

  return code;
}

/**
 * コードを検証してアカウントをリンク
 */
export async function validateAndConsumeLinkCode(
  code: string,
  userId: string
): Promise<{ success: boolean; error?: string; platform?: string; platformName?: string }> {
  // コードを検索
  const linkCode = await prisma.platformLinkCode.findUnique({
    where: { code: code.toUpperCase() },
  });

  if (!linkCode) {
    return { success: false, error: 'Invalid code' };
  }

  // 有効期限チェック
  if (new Date() > linkCode.expiresAt) {
    // 期限切れコードを削除
    await prisma.platformLinkCode.delete({ where: { id: linkCode.id } });
    return { success: false, error: 'Code expired' };
  }

  // 既存のリンクをチェック
  const existingLink = await prisma.platformLink.findUnique({
    where: {
      platform_platformUserId: {
        platform: linkCode.platform,
        platformUserId: linkCode.platformUserId,
      },
    },
  });

  if (existingLink) {
    if (existingLink.userId === userId) {
      // 既に同じユーザーにリンク済み
      await prisma.platformLinkCode.delete({ where: { id: linkCode.id } });
      return { success: false, error: 'Already linked to your account' };
    }

    // 別のユーザーにリンク済み → マージ処理
    await mergePlatformUser(existingLink.userId, userId);
  }

  // リンクを作成または更新
  await prisma.platformLink.upsert({
    where: {
      platform_platformUserId: {
        platform: linkCode.platform,
        platformUserId: linkCode.platformUserId,
      },
    },
    update: {
      userId,
      platformName: linkCode.platformName,
      chatId: linkCode.chatId,
      linkedAt: new Date(),
    },
    create: {
      userId,
      platform: linkCode.platform,
      platformUserId: linkCode.platformUserId,
      platformName: linkCode.platformName,
      chatId: linkCode.chatId,
      linkedAt: new Date(),
    },
  });

  // 使用済みコードを削除
  await prisma.platformLinkCode.delete({ where: { id: linkCode.id } });

  return {
    success: true,
    platform: linkCode.platform,
    platformName: linkCode.platformName || undefined,
  };
}

/**
 * プラットフォーム自動作成ユーザーのデータを WebUI ユーザーにマージ
 */
async function mergePlatformUser(fromUserId: string, toUserId: string): Promise<void> {
  // マシンを移行（名前が重複する場合はスキップまたはリネーム）
  const fromMachines = await prisma.machine.findMany({
    where: { userId: fromUserId },
  });

  for (const machine of fromMachines) {
    // 既存のマシン名をチェック
    const existingMachine = await prisma.machine.findUnique({
      where: {
        userId_name: { userId: toUserId, name: machine.name },
      },
    });

    if (existingMachine) {
      // 同じ名前のマシンが既にある場合、サフィックスを追加
      let newName = `${machine.name} (merged)`;
      let counter = 1;
      while (
        await prisma.machine.findUnique({
          where: { userId_name: { userId: toUserId, name: newName } },
        })
      ) {
        counter++;
        newName = `${machine.name} (merged ${counter})`;
      }
      await prisma.machine.update({
        where: { id: machine.id },
        data: { userId: toUserId, name: newName },
      });
    } else {
      await prisma.machine.update({
        where: { id: machine.id },
        data: { userId: toUserId },
      });
    }
  }

  // セッションを移行
  await prisma.session.updateMany({
    where: { userId: fromUserId },
    data: { userId: toUserId },
  });

  // その他のプラットフォームリンクを移行
  const otherLinks = await prisma.platformLink.findMany({
    where: { userId: fromUserId },
  });

  for (const link of otherLinks) {
    // 既に toUser にリンクがある場合はスキップ
    const existingToLink = await prisma.platformLink.findUnique({
      where: {
        platform_platformUserId: {
          platform: link.platform,
          platformUserId: link.platformUserId,
        },
      },
    });

    if (!existingToLink || existingToLink.userId === fromUserId) {
      await prisma.platformLink.update({
        where: { id: link.id },
        data: { userId: toUserId },
      });
    }
  }

  // 設定を移行（重複キーがなければ）
  const fromSettings = await prisma.userSettings.findMany({
    where: { userId: fromUserId },
  });

  for (const setting of fromSettings) {
    const existingSetting = await prisma.userSettings.findUnique({
      where: {
        userId_key: {
          userId: toUserId,
          key: setting.key,
        },
      },
    });

    if (!existingSetting) {
      await prisma.userSettings.update({
        where: { id: setting.id },
        data: { userId: toUserId },
      });
    }
  }

  // 元ユーザーを削除（カスケードで残りのデータも削除される）
  try {
    await prisma.user.delete({ where: { id: fromUserId } });
  } catch {
    // 既に削除されている場合は無視
  }
}

/**
 * プラットフォームリンクを解除
 */
export async function unlinkPlatform(userId: string, platform: string): Promise<boolean> {
  const link = await prisma.platformLink.findFirst({
    where: { userId, platform },
  });

  if (!link) {
    return false;
  }

  await prisma.platformLink.delete({ where: { id: link.id } });
  return true;
}

/**
 * ユーザーの連携済みプラットフォーム一覧を取得
 */
export async function getLinkedPlatforms(userId: string) {
  const links = await prisma.platformLink.findMany({
    where: { userId },
    select: {
      platform: true,
      platformUserId: true,
      platformName: true,
      linkedAt: true,
      createdAt: true,
    },
  });

  return links.map((link) => ({
    platform: link.platform,
    platformUserId: link.platformUserId,
    platformName: link.platformName,
    linkedAt: link.linkedAt || link.createdAt,
  }));
}

/**
 * 期限切れコードをクリーンアップ
 */
export async function cleanupExpiredCodes(): Promise<number> {
  const result = await prisma.platformLinkCode.deleteMany({
    where: {
      expiresAt: { lt: new Date() },
    },
  });
  return result.count;
}
