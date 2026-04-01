import { useEffect, useState, useCallback, useRef } from 'react';
import { teams, machines, projects as projectsApi } from '../lib/api';
import type { TeamInfo, TeamsResponse, Machine } from '../lib/api';

export function TeamPage() {
  const [data, setData] = useState<TeamInfo[]>([]);
  const [allMachines, setAllMachines] = useState<Machine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  /** 新規チーム名 */
  const [newTeamName, setNewTeamName] = useState('');
  /** チーム作成中 */
  const [creating, setCreating] = useState(false);
  /** メンバー追加ダイアログを開いているチームID */
  const [addingTo, setAddingTo] = useState<string | null>(null);
  /** メンバー追加フィルタ */
  const [addFilter, setAddFilter] = useState('');
  /** Ask 中のチーム ID */
  const [askingTeamId, setAskingTeamId] = useState<string | null>(null);
  /** Ask 中のプロジェクト ID セット */
  const [askingProjectIds, setAskingProjectIds] = useState<Set<string>>(new Set());
  /** リネーム中のプロジェクト ID */
  const [renamingProjectId, setRenamingProjectId] = useState<string | null>(null);
  /** リネーム入力値 */
  const [renameValue, setRenameValue] = useState('');
  /** リネーム入力の ref */
  const renameInputRef = useRef<HTMLInputElement>(null);

  /** チーム一覧を取得 */
  const fetchTeams = useCallback(async () => {
    try {
      const result: TeamsResponse = await teams.list();
      setData(result.teams);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load teams');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTeams();
    machines.list().then(setAllMachines).catch(() => {});
  }, [fetchTeams]);

  /** 指定チームに追加可能なプロジェクト一覧（既存メンバーを除外、マシン別グループ） */
  const getAvailableByMachine = (teamMembers: TeamInfo['members']) => {
    const memberIds = new Set(teamMembers.map(m => m.projectId));
    const filter = addFilter.toLowerCase();

    const grouped: Record<string, Array<{ id: string; name: string; machineName: string; machineStatus: string }>> = {};
    for (const m of allMachines) {
      const mName = m.displayName ?? m.name;
      const available = m.projects
        .filter(p => !memberIds.has(p.id))
        .filter(p => !filter || (p.displayName ?? p.name).toLowerCase().includes(filter) || p.name.toLowerCase().includes(filter))
        .map(p => ({ id: p.id, name: p.displayName ?? p.name, machineName: mName, machineStatus: m.status }));
      if (available.length > 0) {
        grouped[mName] = available;
      }
    }
    return grouped;
  };

  /** チーム作成 */
  const handleCreateTeam = async () => {
    const name = newTeamName.trim();
    if (!name || creating) return;
    setCreating(true);
    setError('');
    try {
      await teams.create(name);
      setNewTeamName('');
      await fetchTeams();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create team');
    } finally {
      setCreating(false);
    }
  };

  /** チーム削除 */
  const handleDeleteTeam = async (teamId: string) => {
    setError('');
    try {
      await teams.remove(teamId);
      setData(prev => prev.filter(t => t.id !== teamId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete team');
    }
  };

  /** メンバー追加 */
  const handleAddMember = async (teamId: string, projectId: string) => {
    setError('');
    try {
      await teams.addMember(teamId, projectId);
      await fetchTeams();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add member');
    }
  };

  /** メンバー削除 */
  const handleRemoveMember = async (teamId: string, memberId: string) => {
    setError('');
    try {
      await teams.removeMember(teamId, memberId);
      setData(prev => prev.map(t =>
        t.id === teamId
          ? { ...t, members: t.members.filter(m => m.id !== memberId) }
          : t
      ));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove member');
    }
  };

  /** メンバー名をリネーム開始 */
  const handleStartRename = (projectId: string, currentName: string) => {
    setRenamingProjectId(projectId);
    setRenameValue(currentName);
    setTimeout(() => renameInputRef.current?.focus(), 50);
  };

  /** リネーム確定 */
  const handleConfirmRename = async (projectId: string) => {
    const trimmed = renameValue.trim();
    setRenamingProjectId(null);
    try {
      // 空文字列の場合はリセット（元のディレクトリ名に戻す）
      await projectsApi.updateDisplayName(projectId, trimmed || null);
      await fetchTeams();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to rename');
    }
  };

  /** チーム全メンバーの概要を一括取得 */
  const handleAskDescriptions = async (team: TeamInfo) => {
    const onlineMembers = team.members.filter(m => m.machineStatus === 'online');
    if (onlineMembers.length === 0) return;

    setAskingTeamId(team.id);
    const asking = new Set(onlineMembers.map(m => m.projectId));
    setAskingProjectIds(asking);

    // 並列で全オンラインメンバーに ask
    await Promise.allSettled(
      onlineMembers.map(async (member) => {
        try {
          const { description } = await projectsApi.askDescription(member.projectId);
          // data を直接更新
          setData(prev => prev.map(t => ({
            ...t,
            members: t.members.map(m =>
              m.projectId === member.projectId ? { ...m, description } : m
            ),
          })));
        } catch {
          // 個別エラーは無視（offline 等）
        } finally {
          setAskingProjectIds(prev => {
            const next = new Set(prev);
            next.delete(member.projectId);
            return next;
          });
        }
      })
    );

    setAskingTeamId(null);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-[var(--text-muted)]">Loading...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-[var(--text-primary)]">Team</h1>
        <p className="text-[var(--text-muted)] text-sm mt-1">
          Discord/Telegram: <code className="bg-[var(--bg-tertiary)] px-1.5 py-0.5 rounded text-xs">ask &lt;project&gt;: &lt;question&gt;</code>
        </p>
      </div>

      {/* チーム新規作成 */}
      <div className="flex gap-2">
        <input
          type="text"
          value={newTeamName}
          onChange={e => setNewTeamName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handleCreateTeam(); }}
          placeholder="New team name..."
          className="flex-1 px-3 py-2 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-color)] text-[var(--text-primary)] text-sm placeholder-[var(--text-faint)] focus:outline-none focus:border-[var(--accent-blue)]"
        />
        <button
          onClick={handleCreateTeam}
          disabled={!newTeamName.trim() || creating}
          className="px-4 py-2 rounded-lg bg-[var(--accent-blue)] text-white text-sm font-medium hover:opacity-90 disabled:opacity-50 transition-opacity whitespace-nowrap"
        >
          {creating ? 'Creating...' : 'Create'}
        </button>
      </div>

      {/* エラー表示 */}
      {error && (
        <div className="bg-[var(--bg-danger)] border border-[var(--border-danger)] text-[var(--text-danger)] px-4 py-3 rounded text-sm">
          {error}
        </div>
      )}

      {/* チーム一覧 */}
      {data.length === 0 ? (
        <div className="bg-[var(--bg-secondary)] rounded-lg p-6 text-center">
          <p className="text-[var(--text-muted)]">No teams yet. Create one above.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {data.map(t => (
            <div key={t.id} className="bg-[var(--bg-secondary)] rounded-lg overflow-hidden">
              {/* チームヘッダー */}
              <div className="px-4 py-3 border-b border-[var(--border-color)] flex items-center justify-between">
                <span className="font-medium text-[var(--text-primary)]">{t.name}</span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleAskDescriptions(t)}
                    disabled={askingTeamId === t.id}
                    className="text-xs px-2 py-1 rounded bg-[var(--bg-tertiary)] hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] transition-colors disabled:opacity-50"
                    title="全メンバーにプロジェクト概要を聞く"
                  >
                    {askingTeamId === t.id ? '取得中...' : 'Ask 📋'}
                  </button>
                  <button
                    onClick={() => { setAddingTo(addingTo === t.id ? null : t.id); setAddFilter(''); }}
                    className="text-xs px-2 py-1 rounded bg-[var(--bg-tertiary)] hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] transition-colors"
                  >
                    + Add
                  </button>
                  <button
                    onClick={() => handleDeleteTeam(t.id)}
                    className="text-[var(--text-faint)] hover:text-[var(--text-danger)] transition-colors"
                    title="Delete team"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              </div>

              {/* メンバー追加ダイアログ */}
              {addingTo === t.id && (
                <div className="px-4 py-2 border-b border-[var(--border-color)] bg-[var(--bg-tertiary)]/50">
                  <input
                    type="text"
                    value={addFilter}
                    onChange={e => setAddFilter(e.target.value)}
                    placeholder="Filter projects..."
                    className="w-full px-2 py-1 mb-2 rounded bg-[var(--bg-secondary)] border border-[var(--border-color)] text-[var(--text-primary)] text-xs placeholder-[var(--text-faint)] focus:outline-none focus:border-[var(--accent-blue)]"
                    autoFocus
                  />
                  <div className="max-h-48 overflow-y-auto space-y-2">
                    {(() => {
                      const grouped = getAvailableByMachine(t.members);
                      const machineNames = Object.keys(grouped);
                      if (machineNames.length === 0) {
                        return <span className="text-[var(--text-faint)] text-xs">No projects available</span>;
                      }
                      return machineNames.map(mName => (
                        <div key={mName}>
                          <div className="text-[10px] text-[var(--text-faint)] uppercase tracking-wider mb-1">{mName}</div>
                          <div className="flex flex-wrap gap-1">
                            {grouped[mName].map(p => (
                              <button
                                key={p.id}
                                onClick={() => handleAddMember(t.id, p.id)}
                                className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-[var(--bg-secondary)] hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] transition-colors"
                              >
                                <span className={`w-1.5 h-1.5 rounded-full ${p.machineStatus === 'online' ? 'bg-green-400' : 'bg-gray-400'}`} />
                                {p.name}
                              </button>
                            ))}
                          </div>
                        </div>
                      ));
                    })()}
                  </div>
                </div>
              )}

              {/* メンバーリスト */}
              {t.members.length === 0 ? (
                <div className="px-4 py-3 text-[var(--text-faint)] text-sm">No members</div>
              ) : (
                <div className="divide-y divide-[var(--border-color)]">
                  {t.members.map(member => (
                    <div
                      key={member.id}
                      className="px-4 py-2 group hover:bg-[var(--bg-tertiary)]/30 transition-colors"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className={`w-1.5 h-1.5 rounded-full ${member.machineStatus === 'online' ? 'bg-green-400' : 'bg-gray-400'}`} />
                          {renamingProjectId === member.projectId ? (
                            <input
                              ref={renameInputRef}
                              className="text-[var(--text-secondary)] text-sm bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded px-1 py-0.5 w-40 outline-none focus:border-blue-400"
                              value={renameValue}
                              onChange={e => setRenameValue(e.target.value)}
                              onKeyDown={e => {
                                if (e.key === 'Enter') handleConfirmRename(member.projectId);
                                if (e.key === 'Escape') setRenamingProjectId(null);
                              }}
                              onBlur={() => handleConfirmRename(member.projectId)}
                              placeholder="表示名（空で元の名前に戻す）"
                            />
                          ) : (
                            <span
                              className="text-[var(--text-secondary)] text-sm cursor-pointer hover:text-blue-400 transition-colors"
                              onClick={() => handleStartRename(member.projectId, member.projectName)}
                              title="クリックでリネーム"
                            >
                              {member.projectName}
                            </span>
                          )}
                          <span className="text-[var(--text-faint)] text-xs">({member.machineName})</span>
                          {askingProjectIds.has(member.projectId) && (
                            <span className="text-[var(--text-faint)] text-xs animate-pulse">取得中...</span>
                          )}
                        </div>
                        <button
                          onClick={() => handleRemoveMember(t.id, member.id)}
                          className="text-[var(--text-faint)] hover:text-[var(--text-danger)] opacity-0 group-hover:opacity-100 transition-opacity"
                          title="Remove member"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                      {member.description && (
                        <div className="ml-4 mt-1 text-[var(--text-faint)] text-xs leading-relaxed">
                          {member.description}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
