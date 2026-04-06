/**
 * ユーザー設定サービス
 *
 * 汎用的なKey-Value形式でユーザー設定を管理
 * 暗号化が必要な設定（APIキーなど）は encrypted フラグで管理
 */

import { prisma } from '../db/client.js';
import crypto from 'crypto';
import type { AiProvider } from '@devrelay/shared';

// 設定キーの定義
export const SettingKeys = {
  OPENAI_API_KEY: 'openai_api_key',
  ANTHROPIC_API_KEY: 'anthropic_api_key',
  GEMINI_API_KEY: 'gemini_api_key',
  DISCORD_BOT_TOKEN: 'discord_bot_token',
  TELEGRAM_BOT_TOKEN: 'telegram_bot_token',
  NATURAL_LANGUAGE_ENABLED: 'natural_language_enabled',
  /** BuildLog 要約に使用する AI プロバイダー（'openai' | 'anthropic' | 'gemini' | 'none'） */
  BUILD_SUMMARY_PROVIDER: 'build_summary_provider',
  /** 自然言語コマンドパースに使用する AI プロバイダー（'openai' | 'anthropic' | 'gemini' | 'none'） */
  CHAT_AI_PROVIDER: 'chat_ai_provider',
  /** Dev Report 生成に使用する AI プロバイダー（'openai' | 'anthropic' | 'gemini' | 'none'） */
  DEV_REPORT_PROVIDER: 'dev_report_provider',
  LANGUAGE: 'language',
  THEME: 'theme',
  /** カスタム Agreement テンプレート（ユーザーが編集した場合のみ保存） */
  AGREEMENT_TEMPLATE: 'agreement_template',
  /** プランモード許可ツール（Linux 用、JSON 文字列） */
  ALLOWED_TOOLS_LINUX: 'allowedTools:linux',
  /** プランモード許可ツール（Windows 用、JSON 文字列） */
  ALLOWED_TOOLS_WINDOWS: 'allowedTools:windows',
  /** チャット表示設定（アバター・表示名・色、JSON 文字列） */
  CHAT_DISPLAY: 'chat_display',
  /** ピン止めタブ（projectId 配列、JSON 文字列） */
  PINNED_TABS: 'pinned_tabs',
  /** タブ表示順序（projectId 配列、JSON 文字列） */
  TAB_ORDER: 'tab_order',
  /** タブカスタム名（projectId → 名前のマッピング、JSON 文字列） */
  TAB_NAMES: 'tab_names',
  /** プッシュ通知購読情報（JSON 配列） */
  PUSH_SUBSCRIPTIONS: 'push_subscriptions',
  /** FCM トークン情報（JSON 配列） */
  FCM_TOKENS: 'fcm_tokens',
  /** チャットサーバー定義（ChatServer[] の JSON 文字列） */
  CHAT_SERVERS: 'chat_servers',
  /** アクティブサーバー ID（サーバー未選択時は空文字列） */
  ACTIVE_SERVER: 'active_server',
  /** Exec モード常時許可ツール（ルールパターン配列、JSON 文字列） */
  EXEC_ALLOWED_TOOLS: 'execAllowedTools',
} as const;

export type SettingKey = typeof SettingKeys[keyof typeof SettingKeys];

// 暗号化が必要なキーのリスト（API キー・トークン系は全て暗号化）
const ENCRYPTED_KEYS: SettingKey[] = [
  SettingKeys.OPENAI_API_KEY,
  SettingKeys.ANTHROPIC_API_KEY,
  SettingKeys.GEMINI_API_KEY,
  SettingKeys.DISCORD_BOT_TOKEN,
  SettingKeys.TELEGRAM_BOT_TOKEN,
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
 * ユーザー個別の設定のみを確認（サーバー共通キーは使用しない）
 */
export async function hasOpenAiApiKey(userId: string): Promise<boolean> {
  const key = await getUserSetting(userId, SettingKeys.OPENAI_API_KEY);
  return key !== null && key.length > 0;
}

/**
 * OpenAI API キーを取得
 * ユーザー個別の設定のみを返す（サーバー共通キーは使用しない）
 */
export async function getOpenAiApiKey(userId: string): Promise<string | null> {
  const key = await getUserSetting(userId, SettingKeys.OPENAI_API_KEY);
  if (key !== null && key.length > 0) return key;
  return null;
}

/**
 * 自然言語モードが有効かチェック
 */
export async function isNaturalLanguageEnabled(userId: string): Promise<boolean> {
  // Chat AI 用の API キーがあり、かつ明示的に無効化されていない場合は有効
  const apiKey = await getApiKeyForChatAi(userId);
  if (!apiKey) return false;

  const enabled = await getUserSetting(userId, SettingKeys.NATURAL_LANGUAGE_ENABLED);
  // デフォルトは有効（API キーがあれば）
  return enabled !== 'false';
}

/** プロバイダー名と SettingKey のマッピング */
const PROVIDER_KEY_MAP: Record<string, SettingKey> = {
  openai: SettingKeys.OPENAI_API_KEY,
  anthropic: SettingKeys.ANTHROPIC_API_KEY,
  gemini: SettingKeys.GEMINI_API_KEY,
};

/** プロバイダー名と環境変数名のマッピング（フォールバック用） */
const PROVIDER_ENV_MAP: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
};

/**
 * 指定プロバイダーの API キーを取得
 * ユーザー設定 → 環境変数の順でフォールバック
 *
 * @param userId ユーザーID
 * @param provider AI プロバイダー名
 * @returns API キー。見つからない場合は null
 */
export async function getApiKeyForProvider(userId: string, provider: AiProvider): Promise<string | null> {
  if (provider === 'none') return null;

  const settingKey = PROVIDER_KEY_MAP[provider];
  if (!settingKey) return null;

  // ユーザー個別設定を優先
  const userKey = await getUserSetting(userId, settingKey);
  if (userKey && userKey.length > 0) return userKey;

  // 環境変数にフォールバック
  const envKey = PROVIDER_ENV_MAP[provider];
  const envValue = envKey ? process.env[envKey] : undefined;
  return envValue && envValue.length > 0 ? envValue : null;
}

/**
 * BuildLog 要約用の AI プロバイダーと API キーを取得
 *
 * @returns { provider, apiKey } のペア。使用不可の場合は null
 */
export async function getApiKeyForBuildSummary(userId: string): Promise<{ provider: AiProvider; apiKey: string } | null> {
  const provider = (await getUserSetting(userId, SettingKeys.BUILD_SUMMARY_PROVIDER) || 'none') as AiProvider;
  if (provider === 'none') return null;

  const apiKey = await getApiKeyForProvider(userId, provider);
  if (!apiKey) return null;

  return { provider, apiKey };
}

/**
 * Dev Report（開発レポート生成）用の AI プロバイダーと API キーを取得
 * DEV_REPORT_PROVIDER 設定に基づいてプロバイダーを選択
 *
 * @returns { provider, apiKey } のペア。使用不可の場合は null
 */
export async function getApiKeyForDevReport(userId: string): Promise<{ provider: AiProvider; apiKey: string } | null> {
  const provider = (await getUserSetting(userId, SettingKeys.DEV_REPORT_PROVIDER) || 'none') as AiProvider;
  if (provider === 'none') return null;

  const apiKey = await getApiKeyForProvider(userId, provider);
  if (!apiKey) return null;

  return { provider, apiKey };
}

/**
 * Chat AI（自然言語コマンドパース）用の API キーを取得
 * CHAT_AI_PROVIDER 設定に基づいてプロバイダーを選択
 * 未設定の場合は後方互換のため OpenAI キーにフォールバック
 *
 * @returns { provider, apiKey } のペア。使用不可の場合は null
 */
export async function getApiKeyForChatAi(userId: string): Promise<{ provider: AiProvider; apiKey: string } | null> {
  const provider = await getUserSetting(userId, SettingKeys.CHAT_AI_PROVIDER) as AiProvider | null;

  // CHAT_AI_PROVIDER が明示設定されている場合
  if (provider && provider !== 'none') {
    const apiKey = await getApiKeyForProvider(userId, provider);
    if (apiKey) return { provider, apiKey };
    return null;
  }

  // 後方互換: CHAT_AI_PROVIDER 未設定 → 従来通り OpenAI キーがあれば使用
  if (!provider) {
    const openaiKey = await getApiKeyForProvider(userId, 'openai');
    if (openaiKey) return { provider: 'openai', apiKey: openaiKey };
  }

  return null;
}
