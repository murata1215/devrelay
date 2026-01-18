/**
 * ユーザー設定サービス
 *
 * 汎用的なKey-Value形式でユーザー設定を管理
 * 暗号化が必要な設定（APIキーなど）は encrypted フラグで管理
 */

import { prisma } from '../db/client.js';
import crypto from 'crypto';

// 設定キーの定義
export const SettingKeys = {
  OPENAI_API_KEY: 'openai_api_key',
  NATURAL_LANGUAGE_ENABLED: 'natural_language_enabled',
  LANGUAGE: 'language',
  THEME: 'theme',
} as const;

export type SettingKey = typeof SettingKeys[keyof typeof SettingKeys];

// 暗号化が必要なキーのリスト
const ENCRYPTED_KEYS: SettingKey[] = [
  SettingKeys.OPENAI_API_KEY,
];

// 暗号化キー（環境変数から取得、なければデフォルト）
const ENCRYPTION_KEY = process.env.SETTINGS_ENCRYPTION_KEY || 'devrelay-default-key-change-me!';

/**
 * 値を暗号化
 */
export function encrypt(text: string): string {
  const key = crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

/**
 * 値を復号化
 */
export function decrypt(encryptedText: string): string {
  const key = crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32);
  const [ivHex, encrypted] = encryptedText.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

/**
 * ユーザー設定を取得
 */
export async function getUserSetting(userId: string, key: SettingKey): Promise<string | null> {
  const setting = await prisma.userSettings.findUnique({
    where: {
      userId_key: { userId, key },
    },
  });

  if (!setting) {
    return null;
  }

  // 暗号化されている場合は復号化
  if (setting.encrypted) {
    try {
      return decrypt(setting.value);
    } catch (error) {
      console.error(`Failed to decrypt setting ${key}:`, error);
      return null;
    }
  }

  return setting.value;
}

/**
 * ユーザー設定を保存
 */
export async function setUserSetting(userId: string, key: SettingKey, value: string): Promise<void> {
  const shouldEncrypt = ENCRYPTED_KEYS.includes(key);
  const storedValue = shouldEncrypt ? encrypt(value) : value;

  await prisma.userSettings.upsert({
    where: {
      userId_key: { userId, key },
    },
    update: {
      value: storedValue,
      encrypted: shouldEncrypt,
      updatedAt: new Date(),
    },
    create: {
      userId,
      key,
      value: storedValue,
      encrypted: shouldEncrypt,
    },
  });
}

/**
 * ユーザー設定を削除
 */
export async function deleteUserSetting(userId: string, key: SettingKey): Promise<void> {
  await prisma.userSettings.deleteMany({
    where: { userId, key },
  });
}

/**
 * ユーザーの全設定を取得
 */
export async function getAllUserSettings(userId: string): Promise<Record<string, string>> {
  const settings = await prisma.userSettings.findMany({
    where: { userId },
  });

  const result: Record<string, string> = {};
  for (const setting of settings) {
    if (setting.encrypted) {
      try {
        result[setting.key] = decrypt(setting.value);
      } catch {
        // 復号化に失敗した場合はスキップ
      }
    } else {
      result[setting.key] = setting.value;
    }
  }

  return result;
}

/**
 * OpenAI API キーが設定されているかチェック
 * ユーザー設定 → .env のフォールバック
 */
export async function hasOpenAiApiKey(userId: string): Promise<boolean> {
  const key = await getUserSetting(userId, SettingKeys.OPENAI_API_KEY);
  if (key !== null && key.length > 0) return true;

  // .env にグローバルキーがあればそれを使う
  return !!process.env.OPENAI_API_KEY;
}

/**
 * OpenAI API キーを取得
 * ユーザー設定 → .env のフォールバック
 */
export async function getOpenAiApiKey(userId: string): Promise<string | null> {
  const key = await getUserSetting(userId, SettingKeys.OPENAI_API_KEY);
  if (key !== null && key.length > 0) return key;

  // .env にグローバルキーがあればそれを使う
  return process.env.OPENAI_API_KEY || null;
}

/**
 * 自然言語モードが有効かチェック
 */
export async function isNaturalLanguageEnabled(userId: string): Promise<boolean> {
  // OpenAI API キーがあり、かつ明示的に無効化されていない場合は有効
  const hasKey = await hasOpenAiApiKey(userId);
  if (!hasKey) return false;

  const enabled = await getUserSetting(userId, SettingKeys.NATURAL_LANGUAGE_ENABLED);
  // デフォルトは有効（API キーがあれば）
  return enabled !== 'false';
}
