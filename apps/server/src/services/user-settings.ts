/**
 * ユーザー設定サービス
 *
 * 汎用的なKey-Value形式でユーザー設定を管理
 * 暗号化が必要な設定（APIキーなど）は encrypted フラグで管理
 */

import { prisma } from '../db/client.js';
import crypto from 'crypto';
import type { AiProvider, ModelSelectableAiTool, Language } from '@devrelay/shared';
import { isLanguage, DEFAULT_CHAT_LANGUAGE } from '@devrelay/shared';
import { resolveOrgAiContext, decideEffectiveModel, isOrgProviderControlEnabled } from './org-ai-defaults.js';

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
  /** Terminal Mode の画面解析・応答要約に使用する AI プロバイダー（'openai' | 'anthropic' | 'gemini' | 'none'） */
  TERMINAL_AI_PROVIDER: 'terminal_ai_provider',
  /** 会話モード（Voice Assist）に使用する AI プロバイダー（'openai' | 'anthropic' | 'gemini' | 'none'） */
  VOICE_ASSIST_PROVIDER: 'voice_assist_provider',
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
  /** Claude SDK モデル — Plan モード用（例: 'sonnet', 'opus', 'haiku'） */
  CLAUDE_MODEL_PLAN: 'claude_model_plan',
  /** Claude SDK モデル — Exec モード用（例: 'sonnet', 'opus', 'haiku'） */
  CLAUDE_MODEL_EXEC: 'claude_model_exec',
  /** Codex CLI モデル — Plan モード用（例: 'gpt-5.6-terra'）。#309 */
  CODEX_MODEL_PLAN: 'codex_model_plan',
  /** Codex CLI モデル — Exec モード用。#309 */
  CODEX_MODEL_EXEC: 'codex_model_exec',
  /** Gemini CLI モデル — Plan モード用（例: 'gemini-3.1-pro-preview'）。#309 */
  GEMINI_MODEL_PLAN: 'gemini_model_plan',
  /** Gemini CLI モデル — Exec モード用。#309 */
  GEMINI_MODEL_EXEC: 'gemini_model_exec',
  /** Devin CLI モデル — Plan モード用（fuzzy 名可、例: 'opus'）。#309 */
  DEVIN_MODEL_PLAN: 'devin_model_plan',
  /** Devin CLI モデル — Exec モード用。#309 */
  DEVIN_MODEL_EXEC: 'devin_model_exec',
  /** 組織活動の会話要約に使用する AI プロバイダー（'openai' | 'anthropic' | 'gemini' | 'none'）。統制 v3 #270 */
  ORG_SUMMARY_PROVIDER: 'org_summary_provider',
  /** Agent 自動更新のグローバル kill switch（#296）。'false' のときだけ無効（未設定＝有効） */
  AUTO_UPDATE_ENABLED: 'auto_update_enabled',
  /** ログイン後に manager.devrelay.io へ自動遷移するかどうか（'true'|'false'、未設定＝無効） */
  MANAGER_REDIRECT: 'managerRedirect',
  /** Backlog 連携（2026-11-21）: 個人の Backlog API キー（暗号化） */
  BACKLOG_API_KEY: 'backlog_api_key',
  /** Backlog 連携: スペースのホスト名（例: 'xxx.backlog.jp'。未設定なら DEVRELAY_BACKLOG_SPACE） */
  BACKLOG_SPACE: 'backlog_space',
  /** Backlog 連携: 使ってよいプロジェクトと段階→状態の対応（JSON。services/backlog.ts の BacklogProjectsSetting） */
  BACKLOG_PROJECTS: 'backlog_projects',
  /**
   * Backlog 連携（複数接続）: 接続の一覧（スペース・API キー・使うプロジェクト・段階の対応）の JSON。全体を暗号化。
   * これがあれば上の 3 キー（旧形式・1 人 1 件）は読まない。保存時に旧形式のキーは消す。
   */
  BACKLOG_CONNECTIONS: 'backlog_connections',
  /**
   * Backlog 連携: 最後に分かった課題の状態（課題キー → 状態名・色・件名・確認日時の JSON、最大 300 件）。
   * DevRelay が Backlog とやり取りしたついでに更新し、スレッド一覧はこれを表示するだけ（一覧で Backlog に問い合わせない）
   */
  BACKLOG_STATUS_CACHE: 'backlog_status_cache',
  /** 応答の書式サイクル（2026-11-23）: Discord/Telegram へ付ける公開共有リンクの保存期間（日数、文字列）。
   *  未設定なら `DEVRELAY_SHARE_TTL_DAYS`（既定 30 日）が使われる。 */
  RESPONSE_SHARE_TTL_DAYS: 'response_share_ttl_days',
  /** AI 回答契約サイクル（2026-11-23 第3版）: AI 応答を人間向けに要約する機能に使う AI プロバイダー
   *  （'openai' | 'anthropic' | 'gemini' | 'none'）。未設定時は `BUILD_SUMMARY_PROVIDER` を流用する
   *  （`getApiKeyForOrgSummary` と同じフォールバック方式）。 */
  REPLY_SUMMARY_PROVIDER: 'reply_summary_provider',
} as const;

export type SettingKey = typeof SettingKeys[keyof typeof SettingKeys];

// 暗号化が必要なキーのリスト（API キー・トークン系は全て暗号化）
const ENCRYPTED_KEYS: SettingKey[] = [
  SettingKeys.OPENAI_API_KEY,
  SettingKeys.ANTHROPIC_API_KEY,
  SettingKeys.GEMINI_API_KEY,
  SettingKeys.DISCORD_BOT_TOKEN,
  SettingKeys.TELEGRAM_BOT_TOKEN,
  SettingKeys.BACKLOG_API_KEY,
  SettingKeys.BACKLOG_CONNECTIONS,
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

/** aiTool + mode(plan/exec) → SettingKey の単一情報源マッピング（#309） */
const MODEL_SETTING_KEY_MAP: Record<ModelSelectableAiTool, { plan: SettingKey; exec: SettingKey }> = {
  claude: { plan: SettingKeys.CLAUDE_MODEL_PLAN, exec: SettingKeys.CLAUDE_MODEL_EXEC },
  codex: { plan: SettingKeys.CODEX_MODEL_PLAN, exec: SettingKeys.CODEX_MODEL_EXEC },
  gemini: { plan: SettingKeys.GEMINI_MODEL_PLAN, exec: SettingKeys.GEMINI_MODEL_EXEC },
  devin: { plan: SettingKeys.DEVIN_MODEL_PLAN, exec: SettingKeys.DEVIN_MODEL_EXEC },
};

/**
 * AI ツール + モード（plan/exec）からモデル設定用の SettingKey を取得
 * `l` コマンド・agent-manager の model 解決が共通で使う単一情報源（#304/#306 と同種の分散防止）
 */
export function modelSettingKey(aiTool: ModelSelectableAiTool, mode: 'plan' | 'exec'): SettingKey {
  return MODEL_SETTING_KEY_MAP[aiTool][mode];
}

/**
 * AI ツール + モード（plan/exec）に対応するモデル設定値を解決する
 * 未設定の場合は undefined（呼び出し側で CLI/SDK のデフォルトに委ねる）
 *
 * #372: 組織 AI デフォルト（`Organization.aiModelDefaults`）とメンバーの
 * `canOverrideAiSettings` を考慮した実効値を返す（単一情報源、判定は
 * `decideEffectiveModel()` に集約。`agent-manager.ts` 側は無変更で対応済み）。
 */
export async function resolveModelForTool(
  userId: string,
  aiTool: ModelSelectableAiTool,
  mode: 'plan' | 'exec',
): Promise<string | undefined> {
  const key = modelSettingKey(aiTool, mode);
  const userValue = (await getUserSetting(userId, key)) || undefined;
  const { orgDefaults, canOverride } = await resolveOrgAiContext(userId);
  const { value } = decideEffectiveModel({ userValue, orgDefault: orgDefaults[key], canOverride });
  return value;
}

/**
 * AI プロバイダー設定キー（`*_provider`）の実効値を解決する（組織プロバイダー強制サイクル）。
 * `resolveModelForTool` と同じ形：個人設定・組織既定・上書き許可フラグから単一の実効値を返す。
 *
 * `DEVRELAY_ORG_PROVIDER_DEFAULTS` キルスイッチ（既定で有効）が無効（'0'）のときは
 * 組織既定を一切考慮せず、個人設定の生値のみを返す（source は常に 'user'。モデル強制には
 * このキルスイッチは影響しない＝`resolveModelForTool` は無改造）。
 *
 * `decideEffectiveModel` の戻り値 `string | undefined` は `null` に正規化する
 * （呼び出し元7関数の既存の `as AiProvider | null` 分岐と型を一致させるため）。
 */
export async function resolveProviderSetting(
  userId: string,
  key: SettingKey,
): Promise<{ value: string | null; source: import('./org-ai-defaults.js').EffectiveModelSource }> {
  const userValue = (await getUserSetting(userId, key)) || undefined;
  if (!isOrgProviderControlEnabled(process.env.DEVRELAY_ORG_PROVIDER_DEFAULTS)) {
    return { value: userValue ?? null, source: 'user' };
  }
  const { orgDefaults, canOverride } = await resolveOrgAiContext(userId);
  const { value, source } = decideEffectiveModel({ userValue, orgDefault: orgDefaults[key], canOverride });
  return { value: value ?? null, source };
}

/**
 * 組織既定のプロバイダーが選ばれているが、本人（または環境変数）に該当する API キーが
 * 無く機能が停止したときの警告ログ（`source === 'org'` のときだけ呼ぶ）。
 * 鍵の材料は出さない。Discord/Telegram 等では画面表示が無いため、原因追跡の唯一の手段。
 */
function warnOrgProviderKeyMissing(userId: string, key: string, provider: AiProvider): void {
  console.warn(
    `⚠️ 組織既定の AI プロバイダー（${key}=${provider}）が有効ですが、ユーザー ${userId} の API キーが見つからないため機能が停止します`,
  );
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
  const { value, source } = await resolveProviderSetting(userId, SettingKeys.BUILD_SUMMARY_PROVIDER);
  const provider = (value || 'none') as AiProvider;
  if (provider === 'none') return null;

  const apiKey = await getApiKeyForProvider(userId, provider);
  if (!apiKey) {
    if (source === 'org') warnOrgProviderKeyMissing(userId, SettingKeys.BUILD_SUMMARY_PROVIDER, provider);
    return null;
  }

  return { provider, apiKey };
}

/**
 * 組織活動の会話要約（統制 v3 #270）用の AI プロバイダーと API キーを取得
 *
 * ORG_SUMMARY_PROVIDER 設定を優先し、未設定（none 含む）の場合は
 * BUILD_SUMMARY_PROVIDER にフォールバックする（BuildLog 要約利用者は追加設定なしで使える）。
 *
 * @returns { provider, apiKey } のペア。使用不可の場合は null
 */
export async function getApiKeyForOrgSummary(userId: string): Promise<{ provider: AiProvider; apiKey: string } | null> {
  // まず ORG_SUMMARY_PROVIDER を確認
  const { value, source } = await resolveProviderSetting(userId, SettingKeys.ORG_SUMMARY_PROVIDER);
  const orgProvider = (value || 'none') as AiProvider;
  if (orgProvider !== 'none') {
    const apiKey = await getApiKeyForProvider(userId, orgProvider);
    if (apiKey) return { provider: orgProvider, apiKey };
    if (source === 'org') warnOrgProviderKeyMissing(userId, SettingKeys.ORG_SUMMARY_PROVIDER, orgProvider);
    return null;
  }
  // フォールバック: BuildLog 要約の設定を流用
  return getApiKeyForBuildSummary(userId);
}

/**
 * AI 回答契約サイクル（2026-11-23 第3版）: AI 応答を人間向けに要約する機能用の
 * AI プロバイダーと API キーを取得。
 *
 * REPLY_SUMMARY_PROVIDER 設定を優先し、未設定（none 含む）の場合は
 * BUILD_SUMMARY_PROVIDER にフォールバックする（`getApiKeyForOrgSummary` と同じ方式。
 * Build Summary を既に設定済みの人は追加設定なしで使える）。
 *
 * @returns { provider, apiKey } のペア。使用不可の場合は null
 */
export async function getApiKeyForReplySummary(userId: string): Promise<{ provider: AiProvider; apiKey: string } | null> {
  const { value, source } = await resolveProviderSetting(userId, SettingKeys.REPLY_SUMMARY_PROVIDER);
  const summaryProvider = (value || 'none') as AiProvider;
  if (summaryProvider !== 'none') {
    const apiKey = await getApiKeyForProvider(userId, summaryProvider);
    if (apiKey) return { provider: summaryProvider, apiKey };
    if (source === 'org') warnOrgProviderKeyMissing(userId, SettingKeys.REPLY_SUMMARY_PROVIDER, summaryProvider);
    return null;
  }
  // フォールバック: Build Summary の設定を流用
  return getApiKeyForBuildSummary(userId);
}

/**
 * Dev Report（開発レポート生成）用の AI プロバイダーと API キーを取得
 * DEV_REPORT_PROVIDER 設定に基づいてプロバイダーを選択
 *
 * @returns { provider, apiKey } のペア。使用不可の場合は null
 */
export async function getApiKeyForDevReport(userId: string): Promise<{ provider: AiProvider; apiKey: string } | null> {
  const { value, source } = await resolveProviderSetting(userId, SettingKeys.DEV_REPORT_PROVIDER);
  const provider = (value || 'none') as AiProvider;
  if (provider === 'none') return null;

  const apiKey = await getApiKeyForProvider(userId, provider);
  if (!apiKey) {
    if (source === 'org') warnOrgProviderKeyMissing(userId, SettingKeys.DEV_REPORT_PROVIDER, provider);
    return null;
  }

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
  const { value, source } = await resolveProviderSetting(userId, SettingKeys.CHAT_AI_PROVIDER);
  const provider = value as AiProvider | null;

  // CHAT_AI_PROVIDER が明示設定されている場合（組織既定で強制されている場合を含む）
  if (provider && provider !== 'none') {
    const apiKey = await getApiKeyForProvider(userId, provider);
    if (apiKey) return { provider, apiKey };
    if (source === 'org') warnOrgProviderKeyMissing(userId, SettingKeys.CHAT_AI_PROVIDER, provider);
    return null;
  }

  // 後方互換: CHAT_AI_PROVIDER 未設定 → 従来通り OpenAI キーがあれば使用
  if (!provider) {
    const openaiKey = await getApiKeyForProvider(userId, 'openai');
    if (openaiKey) return { provider: 'openai', apiKey: openaiKey };
  }

  return null;
}

/**
 * Terminal AI（端末モードの画面解析・応答要約）用の AI プロバイダーと API キーを取得
 * TERMINAL_AI_PROVIDER 設定に基づいてプロバイダーを選択
 * 未設定の場合は Anthropic → OpenAI の順でフォールバック
 *
 * @returns { provider, apiKey } のペア。使用不可の場合は null
 */
export async function getApiKeyForTerminalAi(userId: string): Promise<{ provider: AiProvider; apiKey: string } | null> {
  const { value, source } = await resolveProviderSetting(userId, SettingKeys.TERMINAL_AI_PROVIDER);
  const provider = value as AiProvider | null;

  // TERMINAL_AI_PROVIDER が明示設定されている場合（組織既定で強制されている場合を含む）
  if (provider && provider !== 'none') {
    const apiKey = await getApiKeyForProvider(userId, provider);
    if (apiKey) return { provider, apiKey };
    if (source === 'org') warnOrgProviderKeyMissing(userId, SettingKeys.TERMINAL_AI_PROVIDER, provider);
    return null;
  }

  // 後方互換: 未設定 → Anthropic キーがあれば使用、なければ OpenAI
  if (!provider) {
    const anthropicKey = await getApiKeyForProvider(userId, 'anthropic');
    if (anthropicKey) return { provider: 'anthropic', apiKey: anthropicKey };
    const openaiKey = await getApiKeyForProvider(userId, 'openai');
    if (openaiKey) return { provider: 'openai', apiKey: openaiKey };
  }

  return null;
}

/**
 * userId から表示言語を解決する（高辻ナレッジ サイクル4）。
 *
 * `resolveSessionLanguage` の本体（Session → userId の解決部分を除いたもの）を単一情報源として
 * 切り出したもの。userId を直接持つハンドラ（`routes/knowledge-api.ts` の `POST /api/knowledge/answer`
 * 等）はこちらを使う。解決に失敗した場合（設定なし等）は DEFAULT_CHAT_LANGUAGE にフォールバックする。
 */
export async function resolveUserLanguage(userId: string): Promise<Language> {
  try {
    const stored = await getUserSetting(userId, SettingKeys.LANGUAGE);
    return isLanguage(stored) ? stored : DEFAULT_CHAT_LANGUAGE;
  } catch (err) {
    console.error(`⚠️ resolveUserLanguage failed for user ${userId}:`, err);
    return DEFAULT_CHAT_LANGUAGE;
  }
}

/**
 * sessionId のみから表示言語を解決する（#319）
 *
 * agent-manager.ts の一部ハンドラは payload に sessionId しか持たないため、
 * Session → userId → UserSettings.language の解決ロジックを単一情報源として集約する。
 * #304/#306/#309 と同種の「分散した同期漏れバグ」の再発防止。
 * 解決に失敗した場合（Session/userId/設定なし）は DEFAULT_CHAT_LANGUAGE にフォールバックする。
 * 高辻ナレッジ サイクル4: userId → 言語の解決部分自体は `resolveUserLanguage` に委譲する
 * （挙動は不変。単一情報源化）。
 */
export async function resolveSessionLanguage(sessionId: string): Promise<Language> {
  try {
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      select: { userId: true },
    });
    if (!session) return DEFAULT_CHAT_LANGUAGE;

    return await resolveUserLanguage(session.userId);
  } catch (err) {
    console.error(`⚠️ resolveSessionLanguage failed for session ${sessionId}:`, err);
    return DEFAULT_CHAT_LANGUAGE;
  }
}

/**
 * Voice Assist（音声会話モード）用の AI プロバイダーと API キーを取得
 * VOICE_ASSIST_PROVIDER 設定に基づいてプロバイダーを選択
 * 未設定の場合は OpenAI → Anthropic の順でフォールバック
 */
export async function getApiKeyForVoiceAssist(userId: string): Promise<{ provider: AiProvider; apiKey: string } | null> {
  const { value, source } = await resolveProviderSetting(userId, SettingKeys.VOICE_ASSIST_PROVIDER);
  const provider = value as AiProvider | null;

  if (provider && provider !== 'none') {
    const apiKey = await getApiKeyForProvider(userId, provider);
    if (apiKey) return { provider, apiKey };
    if (source === 'org') warnOrgProviderKeyMissing(userId, SettingKeys.VOICE_ASSIST_PROVIDER, provider);
    return null;
  }

  if (!provider) {
    const openaiKey = await getApiKeyForProvider(userId, 'openai');
    if (openaiKey) return { provider: 'openai', apiKey: openaiKey };
    const anthropicKey = await getApiKeyForProvider(userId, 'anthropic');
    if (anthropicKey) return { provider: 'anthropic', apiKey: anthropicKey };
  }

  return null;
}
