import { useEffect, useState, useCallback, useRef } from 'react';
import { teams, machines, projects as projectsApi } from '../lib/api';
import type { TeamInfo, TeamsResponse, Machine, OrgCandidate, CrossTeamInboxInvite, CrossTeamOutboxInvite, CrossTeamShare } from '../lib/api';
import { selectInvitableCandidates } from '../lib/cross-team-invite-rules';
import { useLanguage } from '../contexts/LanguageContext';

export function TeamPage() {
  const { t } = useLanguage();
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

  // --- クロスユーザー Team（Phase 1: ask のみ）。DEVRELAY_CROSS_TEAM が OFF の環境では
  // /teams/org-candidates が 404 を返す。その場合は機能自体を非表示にする（UI 側のキルスイッチ対称）。
  const [crossTeamEnabled, setCrossTeamEnabled] = useState(false);
  const [orgCandidates, setOrgCandidates] = useState<OrgCandidate[]>([]);
  const [inbox, setInbox] = useState<CrossTeamInboxInvite[]>([]);
  const [outbox, setOutbox] = useState<CrossTeamOutboxInvite[]>([]);
  /** 自分が公開している（grantee 側の）プロジェクト一覧（「誰に何を公開しているか」の確認用） */
  const [sharedByMe, setSharedByMe] = useState<CrossTeamShare[]>([]);
  /** 招待ダイアログを開いているチームID */
  const [invitingTo, setInvitingTo] = useState<string | null>(null);
  /** 承認ダイアログを開いている招待ID（自分のプロジェクトを選ぶ） */
  const [acceptingInviteId, setAcceptingInviteId] = useState<string | null>(null);
  /** #複数選択対応: 承認ダイアログで選択中のプロジェクト ID（チェックボックス方式、選択ゼロから開始） */
  const [acceptingSelectedIds, setAcceptingSelectedIds] = useState<Set<string>>(new Set());

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

  /** クロスユーザー Team 関連データを取得(機能 OFF なら黒く握り潰して非表示にする) */
  const fetchCrossTeamData = useCallback(async () => {
    try {
      const [candidatesResult, invitesResult, sharedResult] = await Promise.all([
        teams.orgCandidates(),
        teams.listInvites(),
        teams.sharedByMe(),
      ]);
      setOrgCandidates(candidatesResult.candidates);
      setInbox(invitesResult.inbox);
      setOutbox(invitesResult.outbox);
      setSharedByMe(sharedResult.shares);
      setCrossTeamEnabled(true);
    } catch {
      // 404 = DEVRELAY_CROSS_TEAM が OFF。エラー表示はせず機能を非表示にするだけ
      setCrossTeamEnabled(false);
    }
  }, []);

  useEffect(() => {
    fetchTeams();
    fetchCrossTeamData();
    machines.list().then(setAllMachines).catch(() => {});
  }, [fetchTeams, fetchCrossTeamData]);

  /** 招待を送る */
  const handleInvite = async (teamId: string, inviteeUserId: string) => {
    setError('');
    try {
      await teams.invite(teamId, inviteeUserId);
      setInvitingTo(null);
      await fetchCrossTeamData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send invite');
    }
  };

  /** 送信済み招待を取り消す */
  const handleRevokeInvite = async (inviteId: string) => {
    setError('');
    try {
      await teams.revokeInvite(inviteId);
      setOutbox(prev => prev.filter(i => i.id !== inviteId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke invite');
    }
  };

  /** 招待を辞退する */
  const handleDeclineInvite = async (inviteId: string) => {
    setError('');
    try {
      await teams.declineInvite(inviteId);
      setInbox(prev => prev.filter(i => i.id !== inviteId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to decline invite');
    }
  };

  /** 招待を承認し、選択した（複数の）自分のプロジェクトを公開する */
  const handleAcceptInvite = async (inviteId: string, projectIds: string[]) => {
    if (projectIds.length === 0) return;
    setError('');
    try {
      await teams.acceptInvite(inviteId, projectIds);
      setAcceptingInviteId(null);
      setAcceptingSelectedIds(new Set());
      setInbox(prev => prev.filter(i => i.id !== inviteId));
      await Promise.all([fetchTeams(), fetchCrossTeamData()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to accept invite');
    }
  };

  /** 承認ダイアログの開閉（開くときは選択をゼロからリセットする＝誤爆防止） */
  const toggleAcceptingInvite = (inviteId: string) => {
    if (acceptingInviteId === inviteId) {
      setAcceptingInviteId(null);
      setAcceptingSelectedIds(new Set());
    } else {
      setAcceptingInviteId(inviteId);
      setAcceptingSelectedIds(new Set());
    }
  };

  /** 承認ダイアログ内のプロジェクト選択をトグルする */
  const toggleAcceptingProject = (projectId: string) => {
    setAcceptingSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };

  /** クロスユーザー Team の同意を取り消す（Team オーナー視点: 自分の Team から外す） */
  const handleRevokeGrant = async (teamId: string, memberId: string) => {
    setError('');
    try {
      await teams.revokeGrant(memberId);
      setData(prev => prev.map(t =>
        t.id === teamId
          ? { ...t, members: t.members.filter(m => m.id !== memberId) }
          : t
      ));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke grant');
    }
  };

  /**
   * クロスユーザー Team の公開を停止する（grantee 視点: 自分が公開しているプロジェクトを止める）。
   * 2026-11-08: 同一プロジェクトを複数チームへ公開しているケースで「相手は以後このプロジェクトに
   * ask できなくなります」と断言するのは誤り（他チーム経由の grant が生きていれば引き続き ask
   * できる）。対象チームを明示し、他チームにも公開がある場合だけ残存の注記を出す。
   */
  const handleStopSharing = (share: CrossTeamShare) => {
    const otherTeamsCount = sharedByMe.filter(
      s => s.projectId === share.projectId && s.teamMemberId !== share.teamMemberId
    ).length;
    const message = `チーム「${share.teamName}」への「${share.projectName}」の公開を停止しますか？\n`
      + `${share.requesterName} さんはこのチーム経由では ask できなくなります。`
      + (otherTeamsCount > 0 ? '\n（同じプロジェクトを他のチームにも公開しているため、そちらは残ります）' : '');
    if (!window.confirm(message)) {
      return;
    }
    (async () => {
      setError('');
      try {
        await teams.revokeGrant(share.teamMemberId);
        setSharedByMe(prev => prev.filter(s => s.teamMemberId !== share.teamMemberId));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to stop sharing');
      }
    })();
  };

  /**
   * 招待ピッカーに出す組織メンバー候補（承認待ちの宛先は除外、既に公開済みの相手は
   * 「追加依頼」として残す）。2026-11-08: 旧実装は既存クロスメンバーの所有者も除外して
   * おり、サーバー側で解禁した「再招待 = プロジェクト追加」が UI から到達できなかった
   * バグがあった（`cross-team-invite-rules.ts` 参照）。
   */
  const getInvitableCandidates = (team: TeamInfo) => {
    const crossMemberOwnerIds = team.members
      .map(m => m.crossUser ? m.ownerUserId : undefined)
      .filter((id): id is string => !!id);
    const pendingInviteeIds = outbox
      .filter(i => i.teamId === team.id && i.status === 'pending')
      .map(i => i.inviteeUserId);
    return selectInvitableCandidates({ orgCandidates, crossMemberOwnerIds, pendingInviteeIds });
  };

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
        <div className="text-[var(--text-muted)]">{t('common.loading')}</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-[var(--text-primary)]">{t('team.title')}</h1>
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

      {/* クロスユーザー Team（Phase 1: ask のみ）: 受信した招待（DEVRELAY_CROSS_TEAM が OFF なら非表示） */}
      {/* 文言は「チームへの参加」ではなく「自分のプロジェクトへの質問許可を求められている」ことを
          明示する（2026-11-08 実機テストで、旧文言が過剰共有の誤解を招くことが判明したため修正）。 */}
      {crossTeamEnabled && inbox.filter(i => i.status === 'pending').length > 0 && (
        <div className="bg-[var(--bg-secondary)] rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-[var(--border-color)]">
            <span className="font-medium text-[var(--text-primary)]">あなたへの招待</span>
          </div>
          <div className="divide-y divide-[var(--border-color)]">
            {inbox.filter(i => i.status === 'pending').map(invite => (
              <div key={invite.id} className="px-4 py-3">
                <div className="flex items-center justify-between">
                  <div className="text-sm text-[var(--text-secondary)]">
                    <span className="font-medium">{invite.inviterName}</span> さんが、
                    <span className="font-medium">あなたのプロジェクトへの質問（ask）許可</span>を求めています
                    <span className="ml-1 text-[var(--text-faint)] text-xs">（チーム「{invite.teamName}」）</span>
                    <span className="ml-2 text-[var(--text-faint)] text-xs">(ask 権限のみ)</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => toggleAcceptingInvite(invite.id)}
                      className="text-xs px-2 py-1 rounded bg-[var(--accent-blue)] text-white hover:opacity-90 transition-opacity"
                    >
                      承認
                    </button>
                    <button
                      onClick={() => handleDeclineInvite(invite.id)}
                      className="text-xs px-2 py-1 rounded bg-[var(--bg-tertiary)] hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] transition-colors"
                    >
                      辞退
                    </button>
                  </div>
                </div>
                {acceptingInviteId === invite.id && (() => {
                  // #複数選択対応: このチームに既に公開済みの自分のプロジェクトはピッカーから除外する
                  // （再招待で「追加分だけ選ぶ」運用のため、重複候補を見せない）
                  const alreadySharedProjectIds = new Set(
                    sharedByMe.filter(s => s.teamId === invite.teamId).map(s => s.projectId)
                  );
                  const candidates = allMachines.flatMap(m =>
                    m.projects.filter(p => !alreadySharedProjectIds.has(p.id)).map(p => ({ project: p, machine: m }))
                  );
                  return (
                    <div className="mt-2 pt-2 border-t border-[var(--border-color)]">
                      <p className="text-xs text-[var(--text-faint)] mb-2">質問を受け付けるプロジェクトを選んでください（複数選択可）:</p>
                      <div className="flex flex-wrap gap-1 mb-2">
                        {candidates.map(({ project: p, machine: m }) => {
                          const selected = acceptingSelectedIds.has(p.id);
                          return (
                            <button
                              key={p.id}
                              onClick={() => toggleAcceptingProject(p.id)}
                              className={`flex items-center gap-1 text-xs px-2 py-1 rounded border transition-colors ${
                                selected
                                  ? 'bg-[var(--accent-blue)]/20 border-[var(--accent-blue)] text-[var(--text-primary)]'
                                  : 'bg-[var(--bg-tertiary)] border-transparent hover:bg-[var(--bg-hover)] text-[var(--text-secondary)]'
                              }`}
                            >
                              <span className={`w-3 h-3 rounded-sm border flex items-center justify-center text-[8px] ${
                                selected ? 'bg-[var(--accent-blue)] border-[var(--accent-blue)] text-white' : 'border-[var(--text-faint)]'
                              }`}>
                                {selected ? '✓' : ''}
                              </span>
                              <span className={`w-1.5 h-1.5 rounded-full ${m.status === 'online' ? 'bg-green-400' : 'bg-gray-400'}`} />
                              {p.displayName ?? p.name} <span className="text-[var(--text-faint)]">({m.displayName ?? m.name})</span>
                            </button>
                          );
                        })}
                        {candidates.length === 0 && (
                          <span className="text-[var(--text-faint)] text-xs">
                            {allMachines.every(m => m.projects.length === 0)
                              ? '質問を受け付けられるプロジェクトがありません'
                              : 'すべてのプロジェクトを既に公開済みです'}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-amber-500 bg-amber-500/10 border border-amber-500/30 rounded px-2 py-1.5 mb-2">
                        ⚠ 選んだプロジェクトの AI は<span className="font-medium">あなたの契約</span>で実行されます
                        （相手が質問するたびに、あなたの利用枠を消費します）。
                        コードの変更はできません（質問への回答のみ）。あとから「公開中のプロジェクト」一覧で取り消せます。
                      </p>
                      <button
                        onClick={() => handleAcceptInvite(invite.id, [...acceptingSelectedIds])}
                        disabled={acceptingSelectedIds.size === 0}
                        className="text-xs px-3 py-1.5 rounded bg-[var(--accent-blue)] text-white hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
                      >
                        選択した{acceptingSelectedIds.size}件を公開して承認
                      </button>
                    </div>
                  );
                })()}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* クロスユーザー Team: 送信済み招待 */}
      {crossTeamEnabled && outbox.filter(i => i.status === 'pending').length > 0 && (
        <div className="bg-[var(--bg-secondary)] rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-[var(--border-color)]">
            <span className="font-medium text-[var(--text-primary)]">送信済みの招待</span>
          </div>
          <div className="divide-y divide-[var(--border-color)]">
            {outbox.filter(i => i.status === 'pending').map(invite => (
              <div key={invite.id} className="px-4 py-2 flex items-center justify-between">
                <div className="text-sm text-[var(--text-secondary)]">
                  <span className="font-medium">{invite.inviteeName}</span> さんに「{invite.teamName}」へのプロジェクトの公開を依頼中（承認待ち）
                </div>
                <button
                  onClick={() => handleRevokeInvite(invite.id)}
                  className="text-xs px-2 py-1 rounded bg-[var(--bg-tertiary)] hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] transition-colors"
                >
                  取り消す
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* クロスユーザー Team: 自分が公開しているプロジェクト（貸す側視点。公開型の前提条件として追加。
          2026-11-08 実機テストで「自分の何が誰に公開されているか見る手段がない」ことが判明したため新設） */}
      {crossTeamEnabled && sharedByMe.length > 0 && (
        <div className="bg-[var(--bg-secondary)] rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-[var(--border-color)]">
            <span className="font-medium text-[var(--text-primary)]">公開中のプロジェクト</span>
            <span className="ml-2 text-[var(--text-faint)] text-xs">（あなたの契約で質問に応答します）</span>
          </div>
          <div className="divide-y divide-[var(--border-color)]">
            {sharedByMe.map(share => (
              <div key={share.teamMemberId} className="px-4 py-2 flex items-center justify-between">
                <div className="text-sm text-[var(--text-secondary)]">
                  <span className="font-medium">{share.projectName}</span>
                  <span className="text-[var(--text-faint)] text-xs"> ({share.machineName})</span>
                  <span className="ml-2 text-[var(--text-faint)] text-xs">
                    — チーム「{share.teamName}」の <span className="font-medium">{share.requesterName}</span> さんが質問できます
                  </span>
                  <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-green-900/30 text-green-400">ask</span>
                  {share.execAllowed && (
                    <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded bg-red-900/30 text-red-400">exec</span>
                  )}
                </div>
                <button
                  onClick={() => handleStopSharing(share)}
                  className="text-xs px-2 py-1 rounded bg-[var(--bg-tertiary)] hover:bg-[var(--bg-hover)] text-[var(--text-danger)] transition-colors"
                >
                  公開を停止
                </button>
              </div>
            ))}
          </div>
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
                  {crossTeamEnabled && (
                    <button
                      onClick={() => setInvitingTo(invitingTo === t.id ? null : t.id)}
                      className="text-xs px-2 py-1 rounded bg-[var(--bg-tertiary)] hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] transition-colors"
                      title="別ユーザーのプロジェクトを招待する"
                    >
                      + Invite
                    </button>
                  )}
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

              {/* 招待ダイアログ（クロスユーザー Team） */}
              {invitingTo === t.id && (() => {
                const candidates = getInvitableCandidates(t);
                return (
                  <div className="px-4 py-2 border-b border-[var(--border-color)] bg-[var(--bg-tertiary)]/50">
                    <p className="text-xs text-[var(--text-faint)] mb-2">同じ組織のメンバーを招待します（承認されると ask で質問できるようになります。既に公開済みの相手は追加のプロジェクトを依頼できます）:</p>
                    <div className="flex flex-wrap gap-1">
                      {candidates.map(c => (
                        <button
                          key={c.userId}
                          onClick={() => handleInvite(t.id, c.userId)}
                          className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-[var(--bg-secondary)] hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] transition-colors"
                        >
                          {c.name}{c.email ? <span className="text-[var(--text-faint)]"> ({c.email})</span> : null}
                          {c.alreadyContributing && (
                            <span className="text-[var(--text-faint)]">（追加依頼）</span>
                          )}
                        </button>
                      ))}
                      {candidates.length === 0 && (
                        <span className="text-[var(--text-faint)] text-xs">
                          {orgCandidates.length === 0
                            ? '同じ組織に他のメンバーがいません'
                            : '全員に依頼済みです（承認待ち）'}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })()}

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
                          {!member.crossUser && renamingProjectId === member.projectId ? (
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
                          ) : member.crossUser ? (
                            <span className="text-[var(--text-secondary)] text-sm">{member.projectName}</span>
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
                          {member.crossUser && (
                            <>
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-faint)]">
                                外部: {member.ownerName}
                              </span>
                              {member.askAllowed && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-900/30 text-green-400">ask</span>
                              )}
                            </>
                          )}
                          {askingProjectIds.has(member.projectId) && (
                            <span className="text-[var(--text-faint)] text-xs animate-pulse">取得中...</span>
                          )}
                        </div>
                        <button
                          onClick={() => member.crossUser ? handleRevokeGrant(t.id, member.id) : handleRemoveMember(t.id, member.id)}
                          className="text-[var(--text-faint)] hover:text-[var(--text-danger)] opacity-0 group-hover:opacity-100 transition-opacity"
                          title={member.crossUser ? 'クロスユーザーの同意を取り消す' : 'Remove member'}
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
