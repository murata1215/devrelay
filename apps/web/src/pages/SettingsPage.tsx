import { useEffect, useState } from 'react';
import { settings, platforms, services, type LinkedPlatform, type ServiceStatus } from '../lib/api';

/** API キーフィールドの定義 */
interface ApiKeyFieldDef {
  key: string;
  label: string;
  placeholder: string;
  description: string;
  linkUrl: string;
  linkText: string;
}

/** AI プロバイダー選択の定義 */
interface ProviderSelectDef {
  key: string;
  label: string;
  description: string;
}

/** 3社分の API キー定義 */
const API_KEY_FIELDS: ApiKeyFieldDef[] = [
  {
    key: 'openai_api_key',
    label: 'OpenAI API Key',
    placeholder: 'sk-...',
    description: 'GPT-4o-mini for build summary and chat AI.',
    linkUrl: 'https://platform.openai.com/api-keys',
    linkText: 'OpenAI Platform',
  },
  {
    key: 'anthropic_api_key',
    label: 'Anthropic API Key',
    placeholder: 'sk-ant-...',
    description: 'Claude Haiku for build summary and chat AI.',
    linkUrl: 'https://console.anthropic.com/settings/keys',
    linkText: 'Anthropic Console',
  },
  {
    key: 'gemini_api_key',
    label: 'Gemini API Key',
    placeholder: 'AIza...',
    description: 'Gemini 2.0 Flash for build summary and chat AI.',
    linkUrl: 'https://aistudio.google.com/apikey',
    linkText: 'Google AI Studio',
  },
];

/** プロバイダー選択ドロップダウンの選択肢 */
const PROVIDER_OPTIONS = [
  { value: 'none', label: 'None' },
  { value: 'openai', label: 'OpenAI (gpt-4o-mini)' },
  { value: 'anthropic', label: 'Anthropic (Claude Haiku)' },
  { value: 'gemini', label: 'Gemini (2.0 Flash)' },
];

/** プロバイダー選択フィールドの定義 */
const PROVIDER_SELECTS: ProviderSelectDef[] = [
  {
    key: 'build_summary_provider',
    label: 'Build Summary',
    description: 'exec 完了時のビルドログ要約に使用',
  },
  {
    key: 'chat_ai_provider',
    label: 'Chat AI',
    description: '自然言語コマンドパースに使用',
  },
];

export function SettingsPage() {
  const [data, setData] = useState<Record<string, string>>({});
  const [linkedPlatforms, setLinkedPlatforms] = useState<LinkedPlatform[]>([]);
  const [serviceStatus, setServiceStatus] = useState<ServiceStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // API キー入力用のステート（キー名 → 入力値）
  const [keyInputs, setKeyInputs] = useState<Record<string, string>>({});

  // Bot Token 入力
  const [discordToken, setDiscordToken] = useState('');
  const [telegramToken, setTelegramToken] = useState('');
  const [linkCode, setLinkCode] = useState('');
  const [linking, setLinking] = useState(false);
  const [unlinking, setUnlinking] = useState<string | null>(null);

  // Service restart state
  const [restartingServer, setRestartingServer] = useState(false);
  const [restartingAgent, setRestartingAgent] = useState(false);

  const loadSettings = async () => {
    try {
      const [settingsResult, platformsResult, serviceStatusResult] = await Promise.all([
        settings.get(),
        platforms.list(),
        services.status().catch(() => null),
      ]);
      setData(settingsResult);
      setLinkedPlatforms(platformsResult);
      setServiceStatus(serviceStatusResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load settings');
    } finally {
      setLoading(false);
    }
  };

  const handleRestartServer = async () => {
    if (!confirm('Are you sure you want to restart the server? This will temporarily disconnect all agents.')) {
      return;
    }

    setRestartingServer(true);
    setError('');
    setSuccess('');

    try {
      await services.restartServer();
      setSuccess('Server restart initiated. The page will reload shortly...');
      setTimeout(() => {
        window.location.reload();
      }, 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to restart server');
      setRestartingServer(false);
    }
  };

  const handleRestartAgent = async () => {
    if (!confirm('Are you sure you want to restart the agent?')) {
      return;
    }

    setRestartingAgent(true);
    setError('');
    setSuccess('');

    try {
      await services.restartAgent();
      setSuccess('Agent restart initiated');
      setTimeout(async () => {
        try {
          const status = await services.status();
          setServiceStatus(status);
        } catch {}
        setRestartingAgent(false);
      }, 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to restart agent');
      setRestartingAgent(false);
    }
  };

  useEffect(() => {
    loadSettings();
  }, []);

  /** API キー / Bot Token を保存 */
  const handleSaveApiKey = async (key: string, value: string, displayName: string) => {
    if (!value.trim()) {
      setError(`${displayName} cannot be empty`);
      return;
    }

    setSaving(key);
    setError('');
    setSuccess('');

    try {
      await settings.update(key, value);
      setSuccess(`${displayName} saved successfully`);
      // 入力をクリア
      setKeyInputs((prev) => ({ ...prev, [key]: '' }));
      if (key === 'discord_bot_token') setDiscordToken('');
      if (key === 'telegram_bot_token') setTelegramToken('');
      const result = await settings.get();
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save setting');
    } finally {
      setSaving(null);
    }
  };

  /** API キー / Bot Token を削除 */
  const handleDeleteApiKey = async (key: string, displayName: string) => {
    setSaving(key);
    setError('');
    setSuccess('');

    try {
      await settings.delete(key);
      setSuccess(`${displayName} removed`);
      const result = await settings.get();
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove setting');
    } finally {
      setSaving(null);
    }
  };

  /** プロバイダー選択を保存（select 変更時に即座保存） */
  const handleProviderChange = async (key: string, value: string) => {
    setError('');
    setSuccess('');

    try {
      await settings.update(key, value);
      setData((prev) => ({ ...prev, [key]: value }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save provider setting');
    }
  };

  const handleLinkPlatform = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!linkCode.trim()) return;

    setLinking(true);
    setError('');
    setSuccess('');

    try {
      const result = await platforms.link(linkCode.trim().toUpperCase());
      const platformName = result.platformName
        ? ` (${result.platformName})`
        : '';
      setSuccess(`${getPlatformDisplayName(result.platform)}${platformName} linked successfully!`);
      setLinkCode('');
      await loadSettings();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to link platform');
    } finally {
      setLinking(false);
    }
  };

  const handleUnlinkPlatform = async (platform: string) => {
    if (!confirm(`Are you sure you want to unlink ${getPlatformDisplayName(platform)}?`)) {
      return;
    }

    setUnlinking(platform);
    setError('');
    setSuccess('');

    try {
      await platforms.unlink(platform);
      setSuccess(`${getPlatformDisplayName(platform)} unlinked`);
      await loadSettings();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to unlink platform');
    } finally {
      setUnlinking(null);
    }
  };

  const getPlatformDisplayName = (platform: string): string => {
    const names: Record<string, string> = {
      discord: 'Discord',
      telegram: 'Telegram',
      line: 'LINE',
      slack: 'Slack',
    };
    return names[platform] || platform;
  };

  const getPlatformIcon = (platform: string): string => {
    const icons: Record<string, string> = {
      discord: '🎮',
      telegram: '✈️',
      line: '💬',
      slack: '💼',
    };
    return icons[platform] || '🔗';
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-400">Loading...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-white">Settings</h1>

      {error && (
        <div className="bg-red-500/20 border border-red-500 text-red-400 px-4 py-3 rounded">
          {error}
        </div>
      )}

      {success && (
        <div className="bg-green-500/20 border border-green-500 text-green-400 px-4 py-3 rounded">
          {success}
        </div>
      )}

      {/* API Keys Section — 3 社分のキー入力 */}
      <div className="bg-gray-800 rounded-lg p-6">
        <h2 className="text-lg font-semibold text-white mb-4">API Keys</h2>
        <p className="text-gray-400 text-sm mb-6">
          Configure API keys for AI features. Keys are encrypted and stored securely.
        </p>

        <div className="space-y-6">
          {API_KEY_FIELDS.map((field) => (
            <div key={field.key}>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                {field.label}
              </label>
              <p className="text-gray-500 text-xs mb-2">
                {field.description}{' '}
                <a
                  href={field.linkUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-400 hover:text-blue-300"
                >
                  {field.linkText}
                </a>
              </p>

              {data[field.key] ? (
                <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
                  <code className="flex-1 bg-gray-700 px-3 py-2 rounded text-gray-300 text-sm break-all">
                    {data[field.key]}
                  </code>
                  <button
                    onClick={() => handleDeleteApiKey(field.key, field.label)}
                    disabled={saving === field.key}
                    className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded disabled:opacity-50 w-full sm:w-auto"
                  >
                    {saving === field.key ? 'Removing...' : 'Remove'}
                  </button>
                </div>
              ) : (
                <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
                  <input
                    type="password"
                    value={keyInputs[field.key] || ''}
                    onChange={(e) => setKeyInputs((prev) => ({ ...prev, [field.key]: e.target.value }))}
                    placeholder={field.placeholder}
                    className="flex-1 px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <button
                    onClick={() => handleSaveApiKey(field.key, keyInputs[field.key] || '', field.label)}
                    disabled={saving === field.key || !keyInputs[field.key]}
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded disabled:opacity-50 w-full sm:w-auto"
                  >
                    {saving === field.key ? 'Saving...' : 'Save'}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* AI Provider Settings Section — 機能ごとのプロバイダー選択 */}
      <div className="bg-gray-800 rounded-lg p-6">
        <h2 className="text-lg font-semibold text-white mb-4">AI Provider Settings</h2>
        <p className="text-gray-400 text-sm mb-6">
          Select which AI provider to use for each feature. The corresponding API key must be configured above.
        </p>

        <div className="space-y-6">
          {PROVIDER_SELECTS.map((field) => (
            <div key={field.key}>
              <label className="block text-sm font-medium text-gray-300 mb-1">
                {field.label}
              </label>
              <p className="text-gray-500 text-xs mb-2">{field.description}</p>
              <select
                value={data[field.key] || 'none'}
                onChange={(e) => handleProviderChange(field.key, e.target.value)}
                className="w-full sm:w-64 px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {PROVIDER_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
      </div>

      {/* Bot Tokens Section */}
      <div className="bg-gray-800 rounded-lg p-6">
        <h2 className="text-lg font-semibold text-white mb-4">Bot Tokens</h2>
        <p className="text-gray-400 text-sm mb-6">
          Configure bot tokens for Discord and Telegram.
          <span className="text-yellow-400 ml-1">Server restart required after changes.</span>
        </p>

        <div className="space-y-6">
          {/* Discord Bot Token */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">
              Discord Bot Token
            </label>
            <p className="text-gray-500 text-xs mb-2">
              Get from{' '}
              <a
                href="https://discord.com/developers/applications"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-400 hover:text-blue-300"
              >
                Discord Developer Portal
              </a>
            </p>

            {data.discord_bot_token ? (
              <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
                <code className="flex-1 bg-gray-700 px-3 py-2 rounded text-gray-300 text-sm break-all">
                  {data.discord_bot_token}
                </code>
                <button
                  onClick={() => handleDeleteApiKey('discord_bot_token', 'Discord Bot Token')}
                  disabled={saving === 'discord_bot_token'}
                  className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded disabled:opacity-50 w-full sm:w-auto"
                >
                  {saving === 'discord_bot_token' ? 'Removing...' : 'Remove'}
                </button>
              </div>
            ) : (
              <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
                <input
                  type="password"
                  value={discordToken}
                  onChange={(e) => setDiscordToken(e.target.value)}
                  placeholder="Bot token..."
                  className="flex-1 px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <button
                  onClick={() => handleSaveApiKey('discord_bot_token', discordToken, 'Discord Bot Token')}
                  disabled={saving === 'discord_bot_token' || !discordToken}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded disabled:opacity-50 w-full sm:w-auto"
                >
                  {saving === 'discord_bot_token' ? 'Saving...' : 'Save'}
                </button>
              </div>
            )}
          </div>

          {/* Telegram Bot Token */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">
              Telegram Bot Token
            </label>
            <p className="text-gray-500 text-xs mb-2">
              Get from{' '}
              <a
                href="https://t.me/BotFather"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-400 hover:text-blue-300"
              >
                @BotFather
              </a>
              {' '}on Telegram
            </p>

            {data.telegram_bot_token ? (
              <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
                <code className="flex-1 bg-gray-700 px-3 py-2 rounded text-gray-300 text-sm break-all">
                  {data.telegram_bot_token}
                </code>
                <button
                  onClick={() => handleDeleteApiKey('telegram_bot_token', 'Telegram Bot Token')}
                  disabled={saving === 'telegram_bot_token'}
                  className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded disabled:opacity-50 w-full sm:w-auto"
                >
                  {saving === 'telegram_bot_token' ? 'Removing...' : 'Remove'}
                </button>
              </div>
            ) : (
              <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
                <input
                  type="password"
                  value={telegramToken}
                  onChange={(e) => setTelegramToken(e.target.value)}
                  placeholder="123456789:ABC..."
                  className="flex-1 px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <button
                  onClick={() => handleSaveApiKey('telegram_bot_token', telegramToken, 'Telegram Bot Token')}
                  disabled={saving === 'telegram_bot_token' || !telegramToken}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded disabled:opacity-50 w-full sm:w-auto"
                >
                  {saving === 'telegram_bot_token' ? 'Saving...' : 'Save'}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Connected Platforms Section */}
      <div className="bg-gray-800 rounded-lg p-6">
        <h2 className="text-lg font-semibold text-white mb-4">Connected Platforms</h2>
        <p className="text-gray-400 text-sm mb-6">
          Link your Discord or Telegram account to control your machines from those platforms.
        </p>

        {/* Link Code Input */}
        <div className="mb-6">
          <label className="block text-sm font-medium text-gray-300 mb-2">
            Enter Link Code
          </label>
          <p className="text-gray-500 text-xs mb-2">
            Send <code className="bg-gray-700 px-1 rounded">link</code> to the DevRelay bot on Discord or Telegram to get a code.
          </p>
          <form onSubmit={handleLinkPlatform} className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
            <input
              type="text"
              value={linkCode}
              onChange={(e) => setLinkCode(e.target.value.toUpperCase())}
              placeholder="ABC123"
              maxLength={6}
              className="w-full sm:w-32 px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white text-center text-lg font-mono tracking-widest placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              type="submit"
              disabled={linking || linkCode.length !== 6}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded disabled:opacity-50 disabled:cursor-not-allowed w-full sm:w-auto"
            >
              {linking ? 'Linking...' : 'Link'}
            </button>
          </form>
        </div>

        {/* Linked Platforms List */}
        {linkedPlatforms.length > 0 && (
          <div>
            <div className="text-sm font-medium text-gray-300 mb-3">Linked Accounts</div>
            <div className="space-y-2">
              {linkedPlatforms.map((platform) => (
                <div
                  key={platform.platform}
                  className="flex flex-col sm:flex-row sm:items-center sm:justify-between bg-gray-700 px-4 py-3 rounded gap-2"
                >
                  <div className="flex items-center space-x-3">
                    <span className="text-xl">{getPlatformIcon(platform.platform)}</span>
                    <div>
                      <div className="text-white font-medium">
                        {getPlatformDisplayName(platform.platform)}
                        {platform.platformName && (
                          <span className="text-gray-400 font-normal ml-2">
                            {platform.platformName}
                          </span>
                        )}
                      </div>
                      <div className="text-gray-500 text-xs">
                        Linked {new Date(platform.linkedAt).toLocaleDateString()}
                      </div>
                    </div>
                  </div>
                  <button
                    onClick={() => handleUnlinkPlatform(platform.platform)}
                    disabled={unlinking === platform.platform}
                    className="px-3 py-1 text-sm bg-red-600/20 hover:bg-red-600/40 text-red-400 rounded disabled:opacity-50 w-full sm:w-auto"
                  >
                    {unlinking === platform.platform ? 'Unlinking...' : 'Unlink'}
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {linkedPlatforms.length === 0 && (
          <div className="text-gray-500 text-sm border border-dashed border-gray-600 rounded p-4 text-center">
            No platforms linked yet. Send <code className="bg-gray-700 px-1 rounded">link</code> to the bot to get started.
          </div>
        )}
      </div>

      {/* Service Management Section */}
      <div className="bg-gray-800 rounded-lg p-6">
        <h2 className="text-lg font-semibold text-white mb-4">Service Management</h2>
        <p className="text-gray-400 text-sm mb-6">
          Restart DevRelay services. Use with caution.
        </p>

        <div className="space-y-4">
          {/* Server */}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between bg-gray-700 px-4 py-3 rounded gap-2">
            <div className="flex items-center space-x-3">
              <span className="text-xl">🖥️</span>
              <div>
                <div className="text-white font-medium">DevRelay Server</div>
                <div className="text-gray-500 text-xs">
                  Status:{' '}
                  <span className={serviceStatus?.server === 'active' ? 'text-green-400' : 'text-red-400'}>
                    {serviceStatus?.server || 'unknown'}
                  </span>
                </div>
              </div>
            </div>
            <button
              onClick={handleRestartServer}
              disabled={restartingServer}
              className="px-4 py-2 bg-orange-600 hover:bg-orange-700 text-white rounded disabled:opacity-50 disabled:cursor-not-allowed w-full sm:w-auto"
            >
              {restartingServer ? 'Restarting...' : 'Restart'}
            </button>
          </div>

          {/* Agent */}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between bg-gray-700 px-4 py-3 rounded gap-2">
            <div className="flex items-center space-x-3">
              <span className="text-xl">🤖</span>
              <div>
                <div className="text-white font-medium">DevRelay Agent (Local)</div>
                <div className="text-gray-500 text-xs">
                  Status:{' '}
                  <span className={serviceStatus?.agent === 'active' ? 'text-green-400' : 'text-red-400'}>
                    {serviceStatus?.agent || 'unknown'}
                  </span>
                </div>
              </div>
            </div>
            <button
              onClick={handleRestartAgent}
              disabled={restartingAgent}
              className="px-4 py-2 bg-orange-600 hover:bg-orange-700 text-white rounded disabled:opacity-50 disabled:cursor-not-allowed w-full sm:w-auto"
            >
              {restartingAgent ? 'Restarting...' : 'Restart'}
            </button>
          </div>
        </div>

        <p className="text-gray-500 text-xs mt-4">
          Note: Restarting the server will temporarily disconnect all agents. They will automatically reconnect.
        </p>
      </div>

      {/* Preferences Section */}
      <div className="bg-gray-800 rounded-lg p-6">
        <h2 className="text-lg font-semibold text-white mb-4">Preferences</h2>
        <p className="text-gray-400 text-sm">
          More settings coming soon...
        </p>
      </div>
    </div>
  );
}
