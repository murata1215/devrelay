import { useEffect, useState, useCallback } from 'react';
import { org as orgApi } from '../lib/api';
import type {
  OrgSupervisedMember,
  OrgMemberSession,
  OrgSessionMessagesResponse,
} from '../lib/api';
import { useOrganization } from '../contexts/OrganizationContext';
import { useLanguage } from '../contexts/LanguageContext';

/** ISO 文字列を「YYYY/MM/DD」に変換（日付グループ用） */
function dateKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
}

/** ISO 文字列を「HH:MM」に変換 */
function timeLabel(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const PAGE_LIMIT = 30;

/**
 * メンバー活動ページ（統制 v3 #270）。
 * admin/manager が配下メンバーの開発セッションを一覧・AI 要約・会話全文で確認する。
 * ユーザー一覧 → セッション要約タイムライン → クリックで会話全文表示。過去検索・期間絞り込み対応。
 */
export function MemberActivityPage() {
  const { t } = useLanguage();
  const { organization } = useOrganization();
  const canSupervise = organization?.role === 'admin' || organization?.role === 'manager';

  const [members, setMembers] = useState<OrgSupervisedMember[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<string>('');

  const [sessions, setSessions] = useState<OrgMemberSession[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 検索・期間フィルタ（入力中の値と適用済みの値を分ける）
  const [qInput, setQInput] = useState('');
  const [fromInput, setFromInput] = useState('');
  const [toInput, setToInput] = useState('');
  const [appliedFilters, setAppliedFilters] = useState<{ q: string; from: string; to: string }>({ q: '', from: '', to: '' });

  // 要約生成中のセッション ID 集合
  const [summarizing, setSummarizing] = useState<Set<string>>(new Set());
  const [summarizeError, setSummarizeError] = useState<string | null>(null);

  // 会話全文モーダル
  const [detail, setDetail] = useState<OrgSessionMessagesResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // 監督対象メンバー一覧を取得
  useEffect(() => {
    if (!canSupervise) return;
    orgApi
      .myMembers()
      .then(({ members }) => {
        setMembers(members);
        if (members.length > 0) setSelectedUserId((prev) => prev || members[0].userId);
      })
      .catch(() => setMembers([]));
  }, [canSupervise]);

  // セッション一覧を取得
  const loadSessions = useCallback(async () => {
    if (!selectedUserId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await orgApi.memberSessions(selectedUserId, {
        offset: page * PAGE_LIMIT,
        limit: PAGE_LIMIT,
        q: appliedFilters.q || undefined,
        from: appliedFilters.from ? new Date(appliedFilters.from).toISOString() : undefined,
        to: appliedFilters.to ? new Date(appliedFilters.to).toISOString() : undefined,
      });
      setSessions(res.sessions);
      setTotal(res.total);
    } catch (e: any) {
      setError(e?.message || '読み込みに失敗しました');
      setSessions([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [selectedUserId, page, appliedFilters]);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  // ユーザー切り替え時はページ・フィルタをリセット
  const handleSelectUser = (userId: string) => {
    setSelectedUserId(userId);
    setPage(0);
    setDetail(null);
  };

  // フィルタ適用
  const applyFilters = () => {
    setAppliedFilters({ q: qInput.trim(), from: fromInput, to: toInput });
    setPage(0);
  };

  const clearFilters = () => {
    setQInput('');
    setFromInput('');
    setToInput('');
    setAppliedFilters({ q: '', from: '', to: '' });
    setPage(0);
  };

  // 未要約セッションを一括要約（最大10件/回）
  const handleSummarize = async (sessionIds: string[]) => {
    if (!selectedUserId || sessionIds.length === 0) return;
    setSummarizeError(null);
    const batch = sessionIds.slice(0, 10);
    setSummarizing((prev) => {
      const next = new Set(prev);
      batch.forEach((id) => next.add(id));
      return next;
    });
    try {
      const { results } = await orgApi.summarizeSessions(selectedUserId, batch);
      // 結果を state に反映
      const summaryMap = new Map(results.map((r) => [r.sessionId, r.summary]));
      setSessions((prev) =>
        prev.map((s) =>
          summaryMap.has(s.id)
            ? { ...s, summary: summaryMap.get(s.id) ?? s.summary, summarizedAt: new Date().toISOString() }
            : s,
        ),
      );
    } catch (e: any) {
      setSummarizeError(e?.message || '要約の生成に失敗しました');
    } finally {
      setSummarizing((prev) => {
        const next = new Set(prev);
        batch.forEach((id) => next.delete(id));
        return next;
      });
    }
  };

  // 会話全文を開く
  const openDetail = async (sessionId: string) => {
    setDetailLoading(true);
    setDetail(null);
    try {
      const res = await orgApi.sessionMessages(sessionId);
      setDetail(res);
    } catch (e: any) {
      setSummarizeError(e?.message || '会話の取得に失敗しました');
    } finally {
      setDetailLoading(false);
    }
  };

  if (!canSupervise) {
    return (
      <div className="text-[var(--text-secondary)]">
        このページは組織の管理者・マネージャーのみ利用できます。
      </div>
    );
  }

  const unsummarizedIds = sessions.filter((s) => !s.summary).map((s) => s.id);
  const totalPages = Math.ceil(total / PAGE_LIMIT);

  // 日付でグループ化
  const groups: { date: string; items: OrgMemberSession[] }[] = [];
  for (const s of sessions) {
    const key = dateKey(s.startedAt);
    const last = groups[groups.length - 1];
    if (last && last.date === key) last.items.push(s);
    else groups.push({ date: key, items: [s] });
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <h1 className="text-2xl font-bold text-[var(--text-primary)]">{t('activity.title')}</h1>
        {/* ユーザー選択 */}
        <select
          value={selectedUserId}
          onChange={(e) => handleSelectUser(e.target.value)}
          className="px-3 py-2 rounded-md bg-[var(--bg-secondary)] border border-[var(--border-color)] text-[var(--text-primary)] text-sm"
        >
          {members.length === 0 && <option value="">（対象メンバーなし）</option>}
          {members.map((m) => (
            <option key={m.userId} value={m.userId}>
              {m.name || m.email || m.userId}
            </option>
          ))}
        </select>
      </div>

      {/* 外部 AI 送信の明示 */}
      <div className="mb-4 text-xs text-[var(--text-muted)] bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-md px-3 py-2">
        ℹ️ 「要約を生成」を押すと、対象の会話内容が Settings で設定した AI プロバイダー（OpenAI / Anthropic / Gemini）へ送信されます。
        生成された要約はキャッシュされ、次回以降は再送信されません。
      </div>

      {/* 検索・期間フィルタ */}
      <div className="mb-4 flex items-end gap-2 flex-wrap">
        <div>
          <label className="block text-xs text-[var(--text-muted)] mb-1">キーワード検索（会話全文）</label>
          <input
            type="text"
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && applyFilters()}
            placeholder="例: 決済 API"
            className="px-3 py-2 rounded-md bg-[var(--bg-secondary)] border border-[var(--border-color)] text-[var(--text-primary)] text-sm w-48"
          />
        </div>
        <div>
          <label className="block text-xs text-[var(--text-muted)] mb-1">開始日（以降）</label>
          <input
            type="date"
            value={fromInput}
            onChange={(e) => setFromInput(e.target.value)}
            className="px-3 py-2 rounded-md bg-[var(--bg-secondary)] border border-[var(--border-color)] text-[var(--text-primary)] text-sm"
          />
        </div>
        <div>
          <label className="block text-xs text-[var(--text-muted)] mb-1">終了日（以前）</label>
          <input
            type="date"
            value={toInput}
            onChange={(e) => setToInput(e.target.value)}
            className="px-3 py-2 rounded-md bg-[var(--bg-secondary)] border border-[var(--border-color)] text-[var(--text-primary)] text-sm"
          />
        </div>
        <button
          onClick={applyFilters}
          className="px-4 py-2 rounded-md bg-[var(--accent)] text-white text-sm font-medium hover:opacity-90"
        >
          検索
        </button>
        <button
          onClick={clearFilters}
          className="px-3 py-2 rounded-md text-[var(--text-secondary)] text-sm hover:text-[var(--text-primary)]"
        >
          クリア
        </button>
        {unsummarizedIds.length > 0 && (
          <button
            onClick={() => handleSummarize(unsummarizedIds)}
            disabled={unsummarizedIds.some((id) => summarizing.has(id))}
            className="ml-auto px-4 py-2 rounded-md bg-[var(--bg-tertiary)] border border-[var(--border-color)] text-[var(--text-primary)] text-sm font-medium hover:bg-[var(--bg-base)] disabled:opacity-50"
            title="このページの未要約セッションをまとめて要約（最大10件）"
          >
            ✨ このページを要約（{Math.min(unsummarizedIds.length, 10)}件）
          </button>
        )}
      </div>

      {summarizeError && (
        <div className="mb-3 text-sm text-red-500 bg-red-500/10 border border-red-500/30 rounded-md px-3 py-2">
          {summarizeError}
        </div>
      )}
      {error && (
        <div className="mb-3 text-sm text-red-500 bg-red-500/10 border border-red-500/30 rounded-md px-3 py-2">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-[var(--text-muted)]">読み込み中...</div>
      ) : sessions.length === 0 ? (
        <div className="text-[var(--text-muted)]">セッションがありません。</div>
      ) : (
        <div className="space-y-6">
          {groups.map((g) => (
            <div key={g.date}>
              <div className="text-sm font-semibold text-[var(--text-secondary)] mb-2 sticky top-0 bg-[var(--bg-base)] py-1">
                {g.date}
              </div>
              <div className="space-y-2">
                {g.items.map((s) => (
                  <div
                    key={s.id}
                    className="bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg p-3"
                  >
                    <div className="flex items-center gap-2 text-xs text-[var(--text-muted)] mb-1 flex-wrap">
                      <span className="font-mono">{timeLabel(s.startedAt)}</span>
                      <span className="px-2 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
                        {s.projectName}
                      </span>
                      <span>{s.machineName}</span>
                      <span>{s.aiTool}</span>
                      <span>💬 {s.messageCount}</span>
                    </div>

                    {s.summary ? (
                      <div className="text-sm text-[var(--text-primary)] whitespace-pre-wrap">{s.summary}</div>
                    ) : (
                      <div className="text-sm text-[var(--text-secondary)]">
                        <span className="text-[var(--text-muted)] italic">{s.preview || '（メッセージなし）'}</span>
                      </div>
                    )}

                    <div className="flex items-center gap-3 mt-2">
                      {!s.summary && (
                        <button
                          onClick={() => handleSummarize([s.id])}
                          disabled={summarizing.has(s.id)}
                          className="text-xs px-2 py-1 rounded bg-[var(--bg-tertiary)] border border-[var(--border-color)] text-[var(--text-primary)] hover:bg-[var(--bg-base)] disabled:opacity-50"
                        >
                          {summarizing.has(s.id) ? '要約中...' : '✨ 要約を生成'}
                        </button>
                      )}
                      <button
                        onClick={() => openDetail(s.id)}
                        className="text-xs text-[var(--accent)] hover:underline"
                      >
                        会話を表示 →
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ページング */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3 mt-6">
          <button
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
            className="px-3 py-1.5 rounded-md bg-[var(--bg-secondary)] border border-[var(--border-color)] text-[var(--text-primary)] text-sm disabled:opacity-40"
          >
            ← 前へ
          </button>
          <span className="text-sm text-[var(--text-muted)]">
            {page + 1} / {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1}
            className="px-3 py-1.5 rounded-md bg-[var(--bg-secondary)] border border-[var(--border-color)] text-[var(--text-primary)] text-sm disabled:opacity-40"
          >
            次へ →
          </button>
        </div>
      )}

      {/* 会話全文モーダル */}
      {(detail || detailLoading) && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
          onClick={() => {
            setDetail(null);
            setDetailLoading(false);
          }}
        >
          <div
            className="bg-[var(--bg-base)] border border-[var(--border-color)] rounded-lg max-w-3xl w-full max-h-[85vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-color)]">
              <div className="text-sm text-[var(--text-secondary)]">
                {detail ? `${detail.session.projectName} — ${detail.session.machineName}` : '読み込み中...'}
              </div>
              <button
                onClick={() => {
                  setDetail(null);
                  setDetailLoading(false);
                }}
                className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              >
                ✕
              </button>
            </div>
            <div className="overflow-y-auto p-4 space-y-3">
              {detailLoading && <div className="text-[var(--text-muted)]">読み込み中...</div>}
              {detail?.session.summary && (
                <div className="text-sm bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded p-3 text-[var(--text-primary)]">
                  <span className="text-xs text-[var(--text-muted)] block mb-1">AI 要約</span>
                  {detail.session.summary}
                </div>
              )}
              {detail?.messages.map((m) => (
                <div
                  key={m.id}
                  className={`text-sm rounded p-2 ${
                    m.role === 'user'
                      ? 'bg-[var(--accent)]/10 border border-[var(--accent)]/30'
                      : m.role === 'system'
                        ? 'bg-[var(--bg-tertiary)] text-[var(--text-muted)]'
                        : 'bg-[var(--bg-secondary)] border border-[var(--border-color)]'
                  }`}
                >
                  <div className="text-xs text-[var(--text-muted)] mb-1">
                    {m.role === 'user' ? 'ユーザー' : m.role === 'ai' ? 'AI' : m.role} · {timeLabel(m.createdAt)}
                  </div>
                  <div className="whitespace-pre-wrap break-words text-[var(--text-primary)]">{m.content}</div>
                </div>
              ))}
              {detail && detail.messages.length === 0 && (
                <div className="text-[var(--text-muted)]">メッセージがありません。</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
