import { useEffect, useState } from 'react';
import { settings, platforms, type LinkedPlatform } from '../lib/api';

export function SettingsPage() {
  const [data, setData] = useState<Record<string, string>>({});
  const [linkedPlatforms, setLinkedPlatforms] = useState<LinkedPlatform[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Form state
  const [openaiKey, setOpenaiKey] = useState('');
  const [linkCode, setLinkCode] = useState('');
  const [linking, setLinking] = useState(false);
  const [unlinking, setUnlinking] = useState<string | null>(null);

  const loadSettings = async () => {
    try {
      const [settingsResult, platformsResult] = await Promise.all([
        settings.get(),
        platforms.list(),
      ]);
      setData(settingsResult);
      setLinkedPlatforms(platformsResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load settings');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSettings();
  }, []);

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
      // Clear the input
      if (key === 'openai_api_key') setOpenaiKey('');
      // Reload settings
      const result = await settings.get();
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save setting');
    } finally {
      setSaving(null);
    }
  };

  const handleDeleteApiKey = async (key: string, displayName: string) => {
    setSaving(key);
    setError('');
    setSuccess('');

    try {
      await settings.delete(key);
      setSuccess(`${displayName} removed`);
      // Reload settings
      const result = await settings.get();
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove setting');
    } finally {
      setSaving(null);
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

      {/* API Keys Section */}
      <div className="bg-gray-800 rounded-lg p-6">
        <h2 className="text-lg font-semibold text-white mb-4">API Keys</h2>
        <p className="text-gray-400 text-sm mb-6">
          Configure API keys for additional features like natural language commands.
        </p>

        {/* OpenAI API Key */}
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">
              OpenAI API Key
            </label>
            <p className="text-gray-500 text-xs mb-2">
              Used for natural language command parsing. Get your key from{' '}
              <a
                href="https://platform.openai.com/api-keys"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-400 hover:text-blue-300"
              >
                OpenAI Platform
              </a>
            </p>

            {data.openai_api_key ? (
              <div className="flex items-center space-x-4">
                <code className="flex-1 bg-gray-700 px-3 py-2 rounded text-gray-300">
                  {data.openai_api_key}
                </code>
                <button
                  onClick={() => handleDeleteApiKey('openai_api_key', 'OpenAI API Key')}
                  disabled={saving === 'openai_api_key'}
                  className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded disabled:opacity-50"
                >
                  {saving === 'openai_api_key' ? 'Removing...' : 'Remove'}
                </button>
              </div>
            ) : (
              <div className="flex items-center space-x-4">
                <input
                  type="password"
                  value={openaiKey}
                  onChange={(e) => setOpenaiKey(e.target.value)}
                  placeholder="sk-..."
                  className="flex-1 px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <button
                  onClick={() => handleSaveApiKey('openai_api_key', openaiKey, 'OpenAI API Key')}
                  disabled={saving === 'openai_api_key' || !openaiKey}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded disabled:opacity-50"
                >
                  {saving === 'openai_api_key' ? 'Saving...' : 'Save'}
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
          <form onSubmit={handleLinkPlatform} className="flex items-center space-x-4">
            <input
              type="text"
              value={linkCode}
              onChange={(e) => setLinkCode(e.target.value.toUpperCase())}
              placeholder="ABC123"
              maxLength={6}
              className="w-32 px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white text-center text-lg font-mono tracking-widest placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              type="submit"
              disabled={linking || linkCode.length !== 6}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded disabled:opacity-50 disabled:cursor-not-allowed"
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
                  className="flex items-center justify-between bg-gray-700 px-4 py-3 rounded"
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
                    className="px-3 py-1 text-sm bg-red-600/20 hover:bg-red-600/40 text-red-400 rounded disabled:opacity-50"
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
