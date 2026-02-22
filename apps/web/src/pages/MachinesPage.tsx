import { useEffect, useState } from 'react';
import { machines } from '../lib/api';
import type { Machine, MachineCreateResponse } from '../lib/api';

export function MachinesPage() {
  const [data, setData] = useState<Machine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // 新規マシン登録
  const [creating, setCreating] = useState(false);

  // トークン表示モーダル（Agent 作成直後）
  const [showTokenModal, setShowTokenModal] = useState(false);
  const [newMachine, setNewMachine] = useState<MachineCreateResponse | null>(null);
  const [tokenCopied, setTokenCopied] = useState(false);
  const [installCopied, setInstallCopied] = useState(false);

  // OS タブ切り替え（Linux / Windows）
  const [installOs, setInstallOs] = useState<'linux' | 'windows'>('linux');

  // Agent 設定モーダル（既存 Agent の詳細表示）
  const [settingsTarget, setSettingsTarget] = useState<Machine | null>(null);
  const [settingsToken, setSettingsToken] = useState('');
  const [settingsTokenLoading, setSettingsTokenLoading] = useState(false);
  const [settingsTokenCopied, setSettingsTokenCopied] = useState(false);
  const [settingsInstallCopied, setSettingsInstallCopied] = useState(false);
  const [settingsUninstallCopied, setSettingsUninstallCopied] = useState(false);
  const [settingsOs, setSettingsOs] = useState<'linux' | 'windows'>('linux');
  const [mgmtCopiedIndex, setMgmtCopiedIndex] = useState<number | null>(null);

  // ホスト名エイリアス編集
  const [aliasHostname, setAliasHostname] = useState('');
  const [aliasValue, setAliasValue] = useState('');
  const [aliasSaving, setAliasSaving] = useState(false);

  // 削除確認モーダル
  const [deleteTarget, setDeleteTarget] = useState<Machine | null>(null);
  const [deleting, setDeleting] = useState(false);

  const loadMachines = async (isPolling = false) => {
    try {
      const result = await machines.list();
      // 名前順でソート（ポーリングごとに順番が変わるのを防止）
      result.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
      setData(result);
      // Clear error on successful load
      if (error) setError('');
    } catch (err) {
      // Only show error on initial load, not during polling
      if (!isPolling) {
        setError(err instanceof Error ? err.message : 'Failed to load machines');
      }
      // During polling, silently ignore errors (will retry on next interval)
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadMachines(false);

    // Poll for status updates every 5 seconds
    const interval = setInterval(() => {
      loadMachines(true);
    }, 5000);

    return () => clearInterval(interval);
  }, []);

  /** 「+ Add Agent」クリック時: 名前入力なしで即座にトークン生成・表示 */
  const handleAddAgent = async () => {
    setCreating(true);

    try {
      const result = await machines.create();
      setNewMachine(result);
      setShowTokenModal(true);
      loadMachines();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to create agent');
    } finally {
      setCreating(false);
    }
  };

  /** Agent 名クリック時: トークンを取得して設定モーダルを表示 */
  const handleOpenSettings = async (machine: Machine) => {
    setSettingsTarget(machine);
    setSettingsTokenLoading(true);
    setSettingsToken('');

    // ホスト名エイリアスの初期値を設定
    const hostname = machine.name.includes('/') ? machine.name.split('/')[0] : machine.name;
    setAliasHostname(hostname);
    // displayName が設定されていればエイリアス部分を抽出
    const currentAlias = machine.displayName
      ? machine.displayName.split('/')[0]
      : '';
    setAliasValue(currentAlias !== hostname ? currentAlias : '');

    try {
      const result = await machines.getToken(machine.id);
      setSettingsToken(result.token);
    } catch (err) {
      setSettingsToken('(Failed to load token)');
    } finally {
      setSettingsTokenLoading(false);
    }
  };

  /** 設定モーダルを閉じる */
  const closeSettings = () => {
    setSettingsTarget(null);
    setSettingsToken('');
    setSettingsTokenCopied(false);
    setSettingsInstallCopied(false);
    setSettingsUninstallCopied(false);
    setSettingsOs('linux');
    setMgmtCopiedIndex(null);
    setAliasHostname('');
    setAliasValue('');
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;

    setDeleting(true);
    try {
      await machines.delete(deleteTarget.id);
      setDeleteTarget(null);
      loadMachines();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete machine');
    } finally {
      setDeleting(false);
    }
  };

  /** ホスト名エイリアスを保存 */
  const handleSaveAlias = async () => {
    if (!aliasHostname) return;
    setAliasSaving(true);
    try {
      await machines.setHostnameAlias(aliasHostname, aliasValue);
      // 一覧を再読み込みして displayName を反映
      await loadMachines();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to save alias');
    } finally {
      setAliasSaving(false);
    }
  };

  // クリップボードにコピーする汎用関数
  const copyToClipboard = async (text: string, onSuccess: () => void) => {
    try {
      await navigator.clipboard.writeText(text);
      onSuccess();
    } catch {
      const textArea = document.createElement('textarea');
      textArea.value = text;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
      onSuccess();
    }
  };

  const copyToken = () => {
    if (!newMachine) return;
    copyToClipboard(newMachine.token, () => {
      setTokenCopied(true);
      setTimeout(() => setTokenCopied(false), 2000);
    });
  };

  // ワンライナーインストールコマンドを生成（OS 別）
  const getInstallCommand = (token: string, os: 'linux' | 'windows' = 'linux') => {
    if (!token) return '';
    if (os === 'windows') {
      return `$env:DEVRELAY_TOKEN="${token}"; irm https://raw.githubusercontent.com/murata1215/devrelay/main/scripts/install-agent.ps1 | iex`;
    }
    return `curl -fsSL https://raw.githubusercontent.com/murata1215/devrelay/main/scripts/install-agent.sh | bash -s -- --token ${token}`;
  };

  /** アンインストールコマンドを生成（OS 別） */
  const getUninstallCommand = (os: 'linux' | 'windows' = 'linux') => {
    if (os === 'windows') {
      return `Get-CimInstance Win32_Process -Filter "Name='node.exe'" -EA 0 | Where-Object { $_.CommandLine -like '*devrelay*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; Start-Sleep -Seconds 2; Remove-Item "$([Environment]::GetFolderPath('Startup'))\\DevRelay Agent.vbs" -EA 0; Remove-Item "$env:APPDATA\\devrelay" -Recurse -Force`;
    }
    return `sudo systemctl stop devrelay-agent 2>/dev/null; sudo systemctl disable devrelay-agent 2>/dev/null; crontab -l 2>/dev/null | grep -v devrelay | crontab -; pkill -f "devrelay.*index.js"; rm -rf ~/.devrelay`;
  };

  const copyInstallCommand = () => {
    if (!newMachine) return;
    copyToClipboard(getInstallCommand(newMachine.token, installOs), () => {
      setInstallCopied(true);
      setTimeout(() => setInstallCopied(false), 2000);
    });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-400">Loading...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-500/20 border border-red-500 text-red-400 px-4 py-3 rounded">
        {error}
      </div>
    );
  }

  /** OS タブ切り替えボタンの共通コンポーネント */
  const OsTabButtons = ({
    currentOs,
    onSwitch,
  }: {
    currentOs: 'linux' | 'windows';
    onSwitch: (os: 'linux' | 'windows') => void;
  }) => (
    <div className="flex">
      <button
        onClick={() => onSwitch('linux')}
        className={`px-3 py-1 text-xs rounded-l transition-colors ${
          currentOs === 'linux'
            ? 'bg-blue-600 text-white'
            : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
        }`}
      >
        Linux
      </button>
      <button
        onClick={() => onSwitch('windows')}
        className={`px-3 py-1 text-xs rounded-r transition-colors ${
          currentOs === 'windows'
            ? 'bg-blue-600 text-white'
            : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
        }`}
      >
        Windows
      </button>
    </div>
  );

  /** コマンド表示 + コピーボタンの共通コンポーネント */
  const CommandBlock = ({
    command,
    copied,
    onCopy,
  }: {
    command: string;
    copied: boolean;
    onCopy: () => void;
  }) => (
    <div className="flex items-start space-x-2">
      <code className="flex-1 bg-gray-900 text-blue-400 px-4 py-2 rounded-lg text-xs break-all leading-relaxed">
        {command}
      </code>
      <button
        onClick={onCopy}
        className="bg-gray-700 hover:bg-gray-600 text-white px-3 py-2 rounded-lg transition-colors shrink-0"
      >
        {copied ? 'Copied!' : 'Copy'}
      </button>
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <h1 className="text-2xl font-bold text-white">Agents</h1>
        <button
          onClick={handleAddAgent}
          disabled={creating}
          className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white px-4 py-2 rounded-lg font-medium transition-colors w-full sm:w-auto"
        >
          {creating ? 'Creating...' : '+ Add Agent'}
        </button>
      </div>

      {data.length === 0 ? (
        <div className="bg-gray-800 rounded-lg p-6 text-center">
          <p className="text-gray-400">No agents registered yet.</p>
          <p className="text-gray-500 text-sm mt-2">
            Click "Add Agent" to generate a token, then run{' '}
            <code className="bg-gray-700 px-2 py-1 rounded">devrelay setup</code> on your machine.
          </p>
        </div>
      ) : (
        <>
          {/* デスクトップ: テーブル形式 */}
          <div className="hidden md:block bg-gray-800 rounded-lg overflow-hidden">
            <table className="min-w-full divide-y divide-gray-700">
              <thead className="bg-gray-700/50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">
                    Name
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">
                    Status
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">
                    Projects
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">
                    Last Seen
                  </th>
                  <th className="px-6 py-3 w-10"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-700">
                {data.map((machine) => (
                  <tr key={machine.id} className="group hover:bg-gray-700/30 transition-colors">
                    <td className="px-6 py-4 whitespace-nowrap">
                      {/* Agent 名クリックで設定モーダルを開く（displayName があればそちらを表示） */}
                      <button
                        onClick={() => handleOpenSettings(machine)}
                        className="text-white font-medium hover:text-blue-400 transition-colors cursor-pointer"
                        title="Open agent settings"
                      >
                        {machine.displayName ?? machine.name}
                      </button>
                      {/* displayName が設定されている場合、元の名前を小さく表示 */}
                      {machine.displayName && (
                        <div className="text-gray-500 text-xs">{machine.name}</div>
                      )}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span
                        className={`inline-flex items-center px-2 py-1 rounded text-xs font-medium ${
                          machine.status === 'online'
                            ? 'bg-green-500/20 text-green-400'
                            : 'bg-gray-500/20 text-gray-400'
                        }`}
                      >
                        {/* ステータスインジケーター（丸ドット） */}
                        <span
                          className={`w-1.5 h-1.5 rounded-full mr-1.5 ${
                            machine.status === 'online' ? 'bg-green-400' : 'bg-gray-400'
                          }`}
                        />
                        {machine.status}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      {/* プロジェクト一覧をカンマ区切りで表示（最大5件、超過分は +N more） */}
                      <span className="text-gray-300 text-sm">
                        {machine.projects.slice(0, 5).map((p) => p.name).join(', ')}
                        {machine.projects.length > 5 && (
                          <span className="text-gray-500"> +{machine.projects.length - 5} more</span>
                        )}
                        {machine.projects.length === 0 && (
                          <span className="text-gray-500">-</span>
                        )}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-gray-400 text-sm">
                      {machine.lastSeenAt
                        ? new Date(machine.lastSeenAt).toLocaleString()
                        : '-'}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      {/* 削除ボタン（ホバー時に表示） */}
                      <button
                        onClick={() => setDeleteTarget(machine)}
                        className="text-gray-500 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
                        title="Delete agent"
                      >
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* モバイル: カード形式 */}
          <div className="md:hidden space-y-4">
            {data.map((machine) => (
              <div key={machine.id} className="bg-gray-800 rounded-lg p-4 relative group">
                <button
                  onClick={() => setDeleteTarget(machine)}
                  className="absolute top-3 right-3 text-gray-500 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
                  title="Delete agent"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
                <div className="flex items-center justify-between mb-2">
                  {/* モバイルでも Agent 名クリックで設定モーダルを開く（displayName 対応） */}
                  <div>
                    <button
                      onClick={() => handleOpenSettings(machine)}
                      className="text-white font-medium hover:text-blue-400 transition-colors cursor-pointer"
                      title="Open agent settings"
                    >
                      {machine.displayName ?? machine.name}
                    </button>
                    {machine.displayName && (
                      <div className="text-gray-500 text-xs">{machine.name}</div>
                    )}
                  </div>
                  <span
                    className={`px-2 py-1 rounded text-xs font-medium ${
                      machine.status === 'online'
                        ? 'bg-green-500/20 text-green-400'
                        : 'bg-gray-500/20 text-gray-400'
                    }`}
                  >
                    {machine.status}
                  </span>
                </div>
                {/* プロジェクト一覧 */}
                <div className="text-gray-400 text-sm">
                  {machine.projects.slice(0, 5).map((p) => p.name).join(', ')}
                  {machine.projects.length > 5 && (
                    <span className="text-gray-500"> +{machine.projects.length - 5} more</span>
                  )}
                  {machine.projects.length === 0 && '-'}
                </div>
                {machine.lastSeenAt && (
                  <div className="text-gray-500 text-xs mt-2">
                    Last seen: {new Date(machine.lastSeenAt).toLocaleString()}
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      {/* トークン表示モーダル（Agent 作成直後） */}
      {showTokenModal && newMachine && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-lg p-6 w-full max-w-lg mx-4">
            <h2 className="text-xl font-bold text-white mb-4">Agent Created!</h2>
            <div className="bg-blue-500/20 border border-blue-500 text-blue-400 px-4 py-3 rounded mb-4">
              Run the install command below on your machine. The agent name will be set automatically from hostname.
            </div>
            <div className="mb-4">
              <label className="block text-gray-400 text-sm mb-2">Token</label>
              <div className="flex items-center space-x-2">
                <code className="flex-1 bg-gray-900 text-green-400 px-4 py-2 rounded-lg text-sm break-all">
                  {newMachine.token}
                </code>
                <button
                  onClick={copyToken}
                  className="bg-gray-700 hover:bg-gray-600 text-white px-3 py-2 rounded-lg transition-colors shrink-0"
                >
                  {tokenCopied ? 'Copied!' : 'Copy'}
                </button>
              </div>
            </div>
            <div className="mb-4">
              <div className="flex items-center space-x-2 mb-2">
                <label className="block text-gray-400 text-sm">Quick Install</label>
                <OsTabButtons currentOs={installOs} onSwitch={setInstallOs} />
              </div>
              <CommandBlock
                command={getInstallCommand(newMachine.token, installOs)}
                copied={installCopied}
                onCopy={copyInstallCommand}
              />
              <div className="text-gray-500 text-xs mt-2">
                {installOs === 'linux'
                  ? 'Requires: Node.js 20+, git. Proxy support: add --proxy URL'
                  : 'Run in PowerShell. Requires: Node.js 20+, git. Proxy: set $env:DEVRELAY_PROXY'}
              </div>
            </div>
            <div className="flex justify-end">
              <button
                onClick={() => {
                  setShowTokenModal(false);
                  setNewMachine(null);
                  setTokenCopied(false);
                  setInstallCopied(false);
                  setInstallOs('linux');
                }}
                className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-medium transition-colors"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Agent 設定モーダル（既存 Agent の詳細表示） */}
      {settingsTarget && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-lg p-6 w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto">
            <h2 className="text-xl font-bold text-white mb-4">
              Agent Settings: {settingsTarget.displayName ?? settingsTarget.name}
            </h2>
            {settingsTarget.displayName && (
              <p className="text-gray-500 text-xs -mt-3 mb-4">({settingsTarget.name})</p>
            )}

            {/* ホスト名エイリアス編集 */}
            <div className="mb-4">
              <label className="block text-gray-400 text-sm mb-2">
                Hostname Alias
                <span className="text-gray-500 ml-2 text-xs">
                  (applies to all agents with same hostname)
                </span>
              </label>
              <div className="flex items-center space-x-2">
                <input
                  type="text"
                  value={aliasValue}
                  onChange={(e) => setAliasValue(e.target.value)}
                  placeholder={aliasHostname}
                  className="flex-1 bg-gray-900 text-white px-4 py-2 rounded-lg text-sm border border-gray-700 focus:border-blue-500 focus:outline-none"
                />
                <button
                  onClick={handleSaveAlias}
                  disabled={aliasSaving}
                  className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white px-3 py-2 rounded-lg transition-colors shrink-0 text-sm"
                >
                  {aliasSaving ? 'Saving...' : 'Save'}
                </button>
              </div>
              <div className="text-gray-500 text-xs mt-1">
                {aliasValue
                  ? `Display: ${aliasValue}/${settingsTarget.name.includes('/') ? settingsTarget.name.split('/').slice(1).join('/') : ''}`
                  : 'Leave empty to use original hostname'}
              </div>
            </div>

            {/* トークン表示 */}
            <div className="mb-4">
              <label className="block text-gray-400 text-sm mb-2">Token</label>
              {settingsTokenLoading ? (
                <div className="bg-gray-900 px-4 py-2 rounded-lg text-gray-500 text-sm">Loading...</div>
              ) : (
                <div className="flex items-center space-x-2">
                  <code className="flex-1 bg-gray-900 text-green-400 px-4 py-2 rounded-lg text-sm break-all">
                    {settingsToken}
                  </code>
                  <button
                    onClick={() => {
                      copyToClipboard(settingsToken, () => {
                        setSettingsTokenCopied(true);
                        setTimeout(() => setSettingsTokenCopied(false), 2000);
                      });
                    }}
                    className="bg-gray-700 hover:bg-gray-600 text-white px-3 py-2 rounded-lg transition-colors shrink-0"
                  >
                    {settingsTokenCopied ? 'Copied!' : 'Copy'}
                  </button>
                </div>
              )}
            </div>

            {/* インストールコマンド */}
            <div className="mb-4">
              <div className="flex items-center space-x-2 mb-2">
                <label className="block text-gray-400 text-sm">Quick Install</label>
                <OsTabButtons currentOs={settingsOs} onSwitch={setSettingsOs} />
              </div>
              <CommandBlock
                command={getInstallCommand(settingsToken, settingsOs)}
                copied={settingsInstallCopied}
                onCopy={() => {
                  copyToClipboard(getInstallCommand(settingsToken, settingsOs), () => {
                    setSettingsInstallCopied(true);
                    setTimeout(() => setSettingsInstallCopied(false), 2000);
                  });
                }}
              />
              <div className="text-gray-500 text-xs mt-2">
                {settingsOs === 'linux'
                  ? 'Requires: Node.js 20+, git. Proxy support: add --proxy URL'
                  : 'Run in PowerShell. Requires: Node.js 20+, git. Proxy: set $env:DEVRELAY_PROXY'}
              </div>
            </div>

            {/* 管理コマンド（Agent 接続時に環境固有のコマンドを自動取得・保存） */}
            {settingsTarget.managementInfo && settingsTarget.managementInfo.commands.length > 0 ? (
              <div className="mb-4">
                <label className="block text-gray-400 text-sm mb-2">
                  Management Commands
                  <span className="text-gray-500 ml-2 text-xs">
                    ({settingsTarget.managementInfo.os === 'win32' ? 'Windows' : 'Linux'} / {settingsTarget.managementInfo.installType})
                  </span>
                </label>
                <div className="space-y-2">
                  {settingsTarget.managementInfo.commands.map((cmd, i) => (
                    <div key={i} className="flex items-start space-x-2">
                      <span className="text-gray-400 text-xs w-24 shrink-0 pt-2 text-right">{cmd.label}</span>
                      <code className="flex-1 bg-gray-900 text-blue-400 px-3 py-2 rounded text-xs break-all leading-relaxed select-all">
                        {cmd.command}
                      </code>
                      <button
                        onClick={() => {
                          copyToClipboard(cmd.command, () => {
                            setMgmtCopiedIndex(i);
                            setTimeout(() => setMgmtCopiedIndex(null), 2000);
                          });
                        }}
                        className="bg-gray-700 hover:bg-gray-600 text-white px-2 py-2 rounded transition-colors shrink-0 text-xs"
                      >
                        {mgmtCopiedIndex === i ? 'Copied!' : 'Copy'}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="mb-4">
                <label className="block text-gray-400 text-sm mb-2">Management Commands</label>
                <p className="text-gray-500 text-xs">
                  Agent が接続すると管理コマンドが表示されます。
                </p>
              </div>
            )}

            {/* アンインストールコマンド（折りたたみ） */}
            <details className="mb-4">
              <summary className="text-gray-400 text-sm cursor-pointer hover:text-gray-300 transition-colors">
                Uninstall
              </summary>
              <div className="mt-2">
                <CommandBlock
                  command={getUninstallCommand(settingsOs)}
                  copied={settingsUninstallCopied}
                  onCopy={() => {
                    copyToClipboard(getUninstallCommand(settingsOs), () => {
                      setSettingsUninstallCopied(true);
                      setTimeout(() => setSettingsUninstallCopied(false), 2000);
                    });
                  }}
                />
                <div className="text-gray-500 text-xs mt-2">
                  {settingsOs === 'linux'
                    ? 'Stops agent, removes systemd service/crontab, deletes ~/.devrelay'
                    : 'Stops agent, removes auto-start, deletes %APPDATA%\\devrelay'}
                </div>
              </div>
            </details>

            <div className="flex justify-end">
              <button
                onClick={closeSettings}
                className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-medium transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 削除確認モーダル */}
      {deleteTarget && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-lg p-6 w-full max-w-md mx-4">
            <h2 className="text-xl font-bold text-white mb-4">Delete Agent?</h2>
            <p className="text-gray-400 mb-4">
              Are you sure you want to delete <strong className="text-white">{deleteTarget.displayName ?? deleteTarget.name}</strong>?
              This will also delete all associated projects and sessions.
            </p>
            <div className="flex justify-end space-x-3">
              <button
                onClick={() => setDeleteTarget(null)}
                className="px-4 py-2 text-gray-400 hover:text-white transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="bg-red-600 hover:bg-red-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white px-4 py-2 rounded-lg font-medium transition-colors"
              >
                {deleting ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
