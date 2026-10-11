import { useEffect, useState } from 'react';
import { useLanguage } from '../../contexts/LanguageContext';
import { useOrganization } from '../../contexts/OrganizationContext';
import { clearance as clearanceApi, type ClearanceMember } from '../../lib/api';
import {
  canEditClearance,
  canViewClearance,
  isClearanceDirty,
  toClearanceDraft,
  validateClearanceDraft,
  type ClearanceDraft,
} from '../../lib/clearance-rules';
import { CompartmentChips } from './CompartmentChips';

/**
 * 高辻ナレッジ サイクル3（WebUI）: 設定＞組織タブ「ナレッジ権限」節（指示書 §4）。
 * `admin` は編集可、`manager` は閲覧のみ、`member`／組織なしには節自体を出さない。
 */
export function ClearanceAdminSection() {
  const { t } = useLanguage();
  const { organization } = useOrganization();
  const role = organization?.role ?? null;

  const [members, setMembers] = useState<ClearanceMember[]>([]);
  const [compartmentSuggestions, setCompartmentSuggestions] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<Record<string, ClearanceDraft>>({});
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; isError: boolean } | null>(null);

  const canView = canViewClearance(role);
  const canEdit = canEditClearance(role);

  useEffect(() => {
    if (!canView) return;
    clearanceApi
      .listOrg()
      .then((res) => {
        setMembers(res.members);
        setDrafts(
          Object.fromEntries(
            res.members.map((m) => [m.userId, toClearanceDraft({ readLevel: m.readLevel, writeLevel: m.writeLevel, compartments: m.compartments })])
          )
        );
      })
      .catch(() => setMsg({ text: t('clearance.loadFailed'), isError: true }));
    clearanceApi
      .compartments()
      .then((res) => setCompartmentSuggestions(res.compartments))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canView]);

  if (!canView) return null;

  const handleSave = async (userId: string) => {
    const draft = drafts[userId];
    const validated = validateClearanceDraft(draft);
    if (!validated.ok) {
      setMsg({ text: t('clearance.saveFailed'), isError: true });
      return;
    }
    setBusyUserId(userId);
    setMsg(null);
    try {
      const res = await clearanceApi.setMember(userId, validated.value);
      setMembers((prev) => prev.map((m) => (m.userId === userId ? { ...m, ...res } : m)));
      setDrafts((prev) => ({ ...prev, [userId]: toClearanceDraft(res) }));
      setMsg({ text: t('clearance.saved'), isError: false });
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : t('clearance.saveFailed'), isError: true });
    } finally {
      setBusyUserId(null);
    }
  };

  const levelOptions = Array.from({ length: 11 }, (_, i) => i);

  const row = (m: ClearanceMember) => {
    const draft = drafts[m.userId] ?? toClearanceDraft({ readLevel: m.readLevel, writeLevel: m.writeLevel, compartments: m.compartments });
    const dirty = isClearanceDirty({ readLevel: m.readLevel, writeLevel: m.writeLevel, compartments: m.compartments }, draft);
    const setDraft = (patch: Partial<ClearanceDraft>) => setDrafts((prev) => ({ ...prev, [m.userId]: { ...draft, ...patch } }));
    return { m, draft, dirty, setDraft };
  };

  return (
    <div>
      <h3 className="text-base font-semibold text-[var(--text-primary)] mb-1">{t('clearance.sectionTitle')}</h3>
      <p className="text-xs text-[var(--text-faint)] mb-3">{t('clearance.sectionDesc')}</p>
      <p className="text-xs text-[var(--text-muted)] mb-3">{t('clearance.legend')}</p>
      {!canEdit && <p className="text-xs text-amber-500 mb-3">{t('clearance.managerReadOnlyHint')}</p>}

      {members.length === 0 ? (
        <p className="text-sm text-[var(--text-muted)]">{t('clearance.empty')}</p>
      ) : (
        <>
          {/* デスクトップ: 表 */}
          <div className="hidden md:block bg-[var(--bg-base)]/40 rounded-lg overflow-hidden">
            <table className="min-w-full divide-y divide-[var(--border-color)] text-sm">
              <thead>
                <tr>
                  <th className="px-3 py-2 text-left text-xs font-medium text-[var(--text-muted)]">{t('clearance.colMember')}</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-[var(--text-muted)]">{t('clearance.colRole')}</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-[var(--text-muted)]">{t('clearance.colReadLevel')}</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-[var(--text-muted)]">{t('clearance.colWriteLevel')}</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-[var(--text-muted)]">{t('clearance.colCompartments')}</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border-color)]">
                {members.map((m) => {
                  const { draft, dirty, setDraft } = row(m);
                  return (
                    <tr key={m.userId}>
                      <td className="px-3 py-2 text-[var(--text-primary)]">{m.name ?? m.email ?? m.userId}</td>
                      <td className="px-3 py-2 text-[var(--text-muted)]">{m.role}</td>
                      <td className="px-3 py-2">
                        <select
                          value={draft.readLevel}
                          disabled={!canEdit}
                          onChange={(e) => setDraft({ readLevel: e.target.value })}
                          className="rounded border border-[var(--border-color)] bg-[var(--bg-base)] px-2 py-1 text-xs"
                        >
                          {levelOptions.map((n) => (
                            <option key={n} value={n}>
                              {n}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-3 py-2">
                        <select
                          value={draft.writeLevel}
                          disabled={!canEdit}
                          onChange={(e) => setDraft({ writeLevel: e.target.value })}
                          className="rounded border border-[var(--border-color)] bg-[var(--bg-base)] px-2 py-1 text-xs"
                        >
                          {levelOptions.map((n) => (
                            <option key={n} value={n}>
                              {n}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-3 py-2">
                        <CompartmentChips
                          values={draft.compartmentsInput ? draft.compartmentsInput.split(',').map((s) => s.trim()).filter(Boolean) : []}
                          editable
                          disabled={!canEdit}
                          suggestions={compartmentSuggestions}
                          onChange={(next) => setDraft({ compartmentsInput: next.join(', ') })}
                        />
                      </td>
                      <td className="px-3 py-2 text-right">
                        {canEdit && (
                          <button
                            onClick={() => handleSave(m.userId)}
                            disabled={!dirty || busyUserId === m.userId}
                            className="px-3 py-1 bg-[var(--accent-blue)] text-white rounded text-xs font-medium disabled:opacity-50"
                          >
                            {t('clearance.save')}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* モバイル: カード */}
          <div className="md:hidden space-y-3">
            {members.map((m) => {
              const { draft, dirty, setDraft } = row(m);
              return (
                <div key={m.userId} className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-base)]/40 p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[var(--text-primary)] font-medium">{m.name ?? m.email ?? m.userId}</span>
                    <span className="text-xs text-[var(--text-muted)]">{m.role}</span>
                  </div>
                  <div className="flex gap-2">
                    <label className="flex-1 text-xs text-[var(--text-secondary)]">
                      {t('clearance.colReadLevel')}
                      <select
                        value={draft.readLevel}
                        disabled={!canEdit}
                        onChange={(e) => setDraft({ readLevel: e.target.value })}
                        className="mt-1 block w-full rounded border border-[var(--border-color)] bg-[var(--bg-base)] px-2 py-1 text-xs"
                      >
                        {levelOptions.map((n) => (
                          <option key={n} value={n}>
                            {n}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="flex-1 text-xs text-[var(--text-secondary)]">
                      {t('clearance.colWriteLevel')}
                      <select
                        value={draft.writeLevel}
                        disabled={!canEdit}
                        onChange={(e) => setDraft({ writeLevel: e.target.value })}
                        className="mt-1 block w-full rounded border border-[var(--border-color)] bg-[var(--bg-base)] px-2 py-1 text-xs"
                      >
                        {levelOptions.map((n) => (
                          <option key={n} value={n}>
                            {n}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <CompartmentChips
                    values={draft.compartmentsInput ? draft.compartmentsInput.split(',').map((s) => s.trim()).filter(Boolean) : []}
                    editable
                    disabled={!canEdit}
                    suggestions={compartmentSuggestions}
                    onChange={(next) => setDraft({ compartmentsInput: next.join(', ') })}
                  />
                  {canEdit && (
                    <button
                      onClick={() => handleSave(m.userId)}
                      disabled={!dirty || busyUserId === m.userId}
                      className="w-full px-3 py-1.5 bg-[var(--accent-blue)] text-white rounded text-xs font-medium disabled:opacity-50"
                    >
                      {t('clearance.save')}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      {msg && <p className={`mt-3 text-xs ${msg.isError ? 'text-[var(--text-danger)]' : 'text-[var(--text-success)]'}`}>{msg.text}</p>}
    </div>
  );
}
