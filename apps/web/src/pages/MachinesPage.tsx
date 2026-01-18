import { useEffect, useState } from 'react';
import { machines } from '../lib/api';
import type { Machine, MachineCreateResponse } from '../lib/api';

export function MachinesPage() {
  const [data, setData] = useState<Machine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // 新規マシン登録
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newMachineName, setNewMachineName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  // トークン表示モーダル
  const [showTokenModal, setShowTokenModal] = useState(false);
  const [newMachine, setNewMachine] = useState<MachineCreateResponse | null>(null);
  const [tokenCopied, setTokenCopied] = useState(false);

  // 削除確認モーダル
  const [deleteTarget, setDeleteTarget] = useState<Machine | null>(null);
  const [deleting, setDeleting] = useState(false);

  const loadMachines = async (isPolling = false) => {
    try {
      const result = await machines.list();
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

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMachineName.trim()) return;

    setCreating(true);
    setCreateError('');

    try {
      const result = await machines.create(newMachineName.trim());
      setNewMachine(result);
      setShowCreateModal(false);
      setShowTokenModal(true);
      setNewMachineName('');
      loadMachines();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create machine');
    } finally {
      setCreating(false);
    }
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

  const copyToken = async () => {
    if (!newMachine) return;
    try {
      await navigator.clipboard.writeText(newMachine.token);
      setTokenCopied(true);
      setTimeout(() => setTokenCopied(false), 2000);
    } catch {
      // Fallback for older browsers
      const textArea = document.createElement('textarea');
      textArea.value = newMachine.token;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
      setTokenCopied(true);
      setTimeout(() => setTokenCopied(false), 2000);
    }
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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">Machines</h1>
        <button
          onClick={() => setShowCreateModal(true)}
          className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-medium transition-colors"
        >
          + Add Machine
        </button>
      </div>

      {data.length === 0 ? (
        <div className="bg-gray-800 rounded-lg p-6 text-center">
          <p className="text-gray-400">No machines registered yet.</p>
          <p className="text-gray-500 text-sm mt-2">
            Click "Add Machine" to generate a token, then run{' '}
            <code className="bg-gray-700 px-2 py-1 rounded">devrelay setup</code> on your machine.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {data.map((machine) => (
            <div key={machine.id} className="bg-gray-800 rounded-lg p-6 relative group">
              <button
                onClick={() => setDeleteTarget(machine)}
                className="absolute top-4 right-4 text-gray-500 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
                title="Delete machine"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </button>

              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold text-white">{machine.name}</h3>
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

              <div className="text-gray-400 text-sm mb-4">
                {machine.projectCount} project{machine.projectCount !== 1 ? 's' : ''}
              </div>

              {machine.projects.length > 0 && (
                <div className="space-y-2">
                  <div className="text-gray-500 text-xs uppercase tracking-wider">Projects</div>
                  {machine.projects.slice(0, 5).map((project) => (
                    <div
                      key={project.id}
                      className="text-sm text-gray-300 truncate"
                      title={project.path}
                    >
                      {project.name}
                    </div>
                  ))}
                  {machine.projects.length > 5 && (
                    <div className="text-gray-500 text-xs">
                      +{machine.projects.length - 5} more
                    </div>
                  )}
                </div>
              )}

              {machine.lastSeenAt && (
                <div className="text-gray-500 text-xs mt-4">
                  Last seen: {new Date(machine.lastSeenAt).toLocaleString()}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* 新規マシン作成モーダル */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-lg p-6 w-full max-w-md mx-4">
            <h2 className="text-xl font-bold text-white mb-4">Add New Machine</h2>
            <form onSubmit={handleCreate}>
              <div className="mb-4">
                <label className="block text-gray-400 text-sm mb-2">Machine Name</label>
                <input
                  type="text"
                  value={newMachineName}
                  onChange={(e) => setNewMachineName(e.target.value)}
                  placeholder="e.g., ubuntu-dev, macbook-pro"
                  className="w-full bg-gray-700 text-white px-4 py-2 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
                  autoFocus
                />
              </div>
              {createError && (
                <div className="mb-4 text-red-400 text-sm">{createError}</div>
              )}
              <div className="flex justify-end space-x-3">
                <button
                  type="button"
                  onClick={() => {
                    setShowCreateModal(false);
                    setNewMachineName('');
                    setCreateError('');
                  }}
                  className="px-4 py-2 text-gray-400 hover:text-white transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creating || !newMachineName.trim()}
                  className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white px-4 py-2 rounded-lg font-medium transition-colors"
                >
                  {creating ? 'Creating...' : 'Create'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* トークン表示モーダル */}
      {showTokenModal && newMachine && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-lg p-6 w-full max-w-lg mx-4">
            <h2 className="text-xl font-bold text-white mb-4">Machine Created!</h2>
            <div className="bg-yellow-500/20 border border-yellow-500 text-yellow-400 px-4 py-3 rounded mb-4">
              <strong>Important:</strong> Copy this token now. It will not be shown again!
            </div>
            <div className="mb-4">
              <label className="block text-gray-400 text-sm mb-2">Machine Name</label>
              <div className="text-white">{newMachine.name}</div>
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
            <div className="bg-gray-700/50 rounded-lg p-4 mb-4">
              <div className="text-gray-400 text-sm mb-2">Next steps:</div>
              <ol className="text-gray-300 text-sm list-decimal list-inside space-y-1">
                <li>Copy the token above</li>
                <li>Run <code className="bg-gray-600 px-1 rounded">devrelay setup</code> on your machine</li>
                <li>Paste the token when prompted</li>
              </ol>
            </div>
            <div className="flex justify-end">
              <button
                onClick={() => {
                  setShowTokenModal(false);
                  setNewMachine(null);
                  setTokenCopied(false);
                }}
                className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-medium transition-colors"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 削除確認モーダル */}
      {deleteTarget && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-lg p-6 w-full max-w-md mx-4">
            <h2 className="text-xl font-bold text-white mb-4">Delete Machine?</h2>
            <p className="text-gray-400 mb-4">
              Are you sure you want to delete <strong className="text-white">{deleteTarget.name}</strong>?
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
