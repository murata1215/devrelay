import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import {
  summarizeUsage,
  totalUsage,
  formatUsageUsd,
  usageChangeRatio,
  usageAxisKey,
  usageRowsToCsv,
  shiftMonthKey,
  type UsageAxis,
  type UsageThreadRow,
} from '@devrelay/shared';
import { usage as usageApi, type UsageResponse } from '../lib/api';
import { withBase } from '../lib/base';

/**
 * Usage（コスト集計）画面。
 * グループ（人のタグ）→ 利用者 → プロジェクト → 案件（スレッドのタグ）→ スレッド の軸で、
 * JST 暦月ごとのコストを集計する。金額は会話履歴のコスト列と同じ計算。
 */

const NONE_GROUP = 'タグなし';
const NONE_CASE = '案件なし';
/** フィルタで「未設定」を表す値（実在のラベルと衝突しない） */
const NONE_FILTER = '\u0000none';

const AXIS_LABELS: Record<UsageAxis, string> = {
  group: 'グループ',
  user: '利用者',
  project: 'プロジェクト',
  case: '案件',
};
const AXES: UsageAxis[] = ['group', 'user', 'project', 'case'];

type SortKey = 'group' | 'user' | 'project' | 'case' | 'thread' | 'cost' | 'turns' | 'lastAt';

function formatMonth(key: string): string {
  const [y, m] = key.split('-');
  return `${y}年${Number(m)}月`;
}

function formatRatio(r: number | null): string {
  if (r === null) return '—';
  const sign = r > 0 ? '+' : '';
  return `${sign}${r.toFixed(0)}%`;
}

function noneLabel(axis: UsageAxis): string {
  return axis === 'case' ? NONE_CASE : NONE_GROUP;
}

/** グループ名・案件名のその場編集（候補つき入力。Enter / フォーカスを外すと保存） */
function LabelEditor({
  value,
  listId,
  placeholder,
  editable,
  onSave,
}: {
  value: string | null;
  listId: string;
  placeholder: string;
  editable: boolean;
  onSave: (next: string | null) => Promise<void>;
}) {
  const [text, setText] = useState(value ?? '');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => setText(value ?? ''), [value]);

  if (!editable) {
    return value ? (
      <span className="text-[var(--text-primary)]">{value}</span>
    ) : (
      <span className="text-[var(--text-faint)]">{placeholder}</span>
    );
  }

  const commit = async () => {
    const next = text.trim() || null;
    if (next === (value ?? null)) return;
    setSaving(true);
    setErr('');
    try {
      await onSave(next);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '保存に失敗しました');
      setText(value ?? '');
    } finally {
      setSaving(false);
    }
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
    if (e.key === 'Escape') {
      setText(value ?? '');
      (e.target as HTMLInputElement).blur();
    }
  };

  return (
    <span className="inline-flex flex-col">
      <input
        value={text}
        list={listId}
        placeholder={placeholder}
        disabled={saving}
        maxLength={40}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={onKey}
        title={err || 'Enter またはフォーカスを外すと保存（空欄で未設定に戻す）'}
        className={`w-28 px-1.5 py-0.5 text-sm rounded border bg-transparent text-[var(--text-primary)] placeholder:text-[var(--text-faint)] ${
          err ? 'border-red-500' : 'border-transparent hover:border-[var(--border-color)] focus:border-[var(--border-color)]'
        }`}
      />
      {err && <span className="text-xs text-[var(--text-danger)]">{err}</span>}
    </span>
  );
}

export function UsagePage() {
  const [month, setMonth] = useState<string | undefined>(undefined);
  const [data, setData] = useState<UsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [axis, setAxis] = useState<UsageAxis>('group');
  const [filters, setFilters] = useState<Record<UsageAxis, string>>({ group: '', user: '', project: '', case: '' });
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'cost', desc: true });
  const [showMembers, setShowMembers] = useState(false);
  const [signageMsg, setSignageMsg] = useState('');

  const load = async (m?: string, quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const r = await usageApi.get(m);
      setData(r);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : '読み込みに失敗しました');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(month);
  }, [month]);

  const rows = data?.rows ?? [];
  const prevRows = data?.prevRows ?? [];

  // フィルタ適用後の明細
  const filtered = useMemo(() => {
    return rows.filter((r) =>
      AXES.every((a) => {
        const f = filters[a];
        if (!f) return true;
        const { key } = usageAxisKey(r, a);
        return f === NONE_FILTER ? key === null : key === f;
      }),
    );
  }, [rows, filters]);

  const prevFiltered = useMemo(() => {
    return prevRows.filter((r) =>
      AXES.every((a) => {
        const f = filters[a];
        if (!f) return true;
        const { key } = usageAxisKey(r, a);
        return f === NONE_FILTER ? key === null : key === f;
      }),
    );
  }, [prevRows, filters]);

  const total = useMemo(() => totalUsage(filtered), [filtered]);
  const prevTotal = useMemo(() => totalUsage(prevFiltered), [prevFiltered]);
  const buckets = useMemo(() => summarizeUsage(filtered, axis), [filtered, axis]);
  const prevBucketMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const b of summarizeUsage(prevFiltered, axis)) m.set(b.key ?? NONE_FILTER, b.costUsd);
    return m;
  }, [prevFiltered, axis]);
  const maxBucket = Math.max(0.0001, ...buckets.map((b) => b.costUsd));

  // フィルタの選択肢（当月の明細に出てくる値）
  const filterOptions = useMemo(() => {
    const out = {} as Record<UsageAxis, { key: string; label: string }[]>;
    for (const a of AXES) {
      out[a] = summarizeUsage(rows, a).map((b) => ({ key: b.key ?? NONE_FILTER, label: b.label ?? noneLabel(a) }));
    }
    return out;
  }, [rows]);

  const sorted = useMemo(() => {
    const val = (r: UsageThreadRow): string | number => {
      switch (sort.key) {
        case 'group': return r.group ?? '￿';
        case 'user': return r.userName;
        case 'project': return r.projectName;
        case 'case': return r.caseName ?? '￿';
        case 'thread': return r.threadTitle;
        case 'cost': return r.costUsd;
        case 'turns': return r.turns;
        case 'lastAt': return r.lastAt;
      }
    };
    return [...filtered].sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      const c = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb), 'ja');
      return sort.desc ? -c : c;
    });
  }, [filtered, sort]);

  const canEditGroup = (userId: string) => !!data && (data.isAdmin || userId === data.myUserId);
  const canEditCase = (row: UsageThreadRow) => !!data && (data.isAdmin || row.userId === data.myUserId);

  const saveGroup = async (userId: string, group: string | null) => {
    await usageApi.setGroup(userId, group);
    // その人の全行（当月・前月・メンバー一覧）を即時反映し、裏で再取得する
    setData((d) =>
      d && {
        ...d,
        rows: d.rows.map((r) => (r.userId === userId ? { ...r, group } : r)),
        prevRows: d.prevRows.map((r) => (r.userId === userId ? { ...r, group } : r)),
        members: d.members.map((m) => (m.userId === userId ? { ...m, group } : m)),
      },
    );
    void load(month, true);
  };

  const saveCase = async (sessionId: string, caseName: string | null) => {
    await usageApi.setCase(sessionId, caseName);
    setData((d) =>
      d && {
        ...d,
        rows: d.rows.map((r) => (r.sessionId === sessionId ? { ...r, caseName } : r)),
        prevRows: d.prevRows.map((r) => (r.sessionId === sessionId ? { ...r, caseName } : r)),
      },
    );
    void load(month, true);
  };

  const downloadCsv = () => {
    if (!data) return;
    const csv = usageRowsToCsv(sorted, { noneGroup: NONE_GROUP, noneCase: NONE_CASE });
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `usage_${data.month}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const signageUrl = data?.signageToken
    ? `${window.location.origin}${withBase(`/signage/usage?token=${encodeURIComponent(data.signageToken)}`)}`
    : null;

  const issueSignage = async () => {
    if (data?.signageToken && !window.confirm('URL を再発行すると、今の URL は使えなくなります。よろしいですか？')) return;
    try {
      const r = await usageApi.issueSignageToken();
      setData((d) => d && { ...d, signageToken: r.signageToken });
      setSignageMsg('URL を発行しました');
    } catch (e) {
      setSignageMsg(e instanceof Error ? e.message : '発行に失敗しました');
    }
  };
  const stopSignage = async () => {
    if (!window.confirm('サイネージを停止しますか？（今の URL は表示できなくなります）')) return;
    try {
      await usageApi.stopSignage();
      setData((d) => d && { ...d, signageToken: null });
      setSignageMsg('停止しました');
    } catch (e) {
      setSignageMsg(e instanceof Error ? e.message : '停止に失敗しました');
    }
  };
  const copySignage = async () => {
    if (!signageUrl) return;
    try {
      await navigator.clipboard.writeText(signageUrl);
      setSignageMsg('コピーしました');
    } catch {
      setSignageMsg('コピーできませんでした。URL を手で選択してコピーしてください');
    }
  };

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: key === 'cost' || key === 'turns' || key === 'lastAt' }));

  const sortMark = (key: SortKey) => (sort.key === key ? (sort.desc ? ' ▼' : ' ▲') : '');

  const anyFilter = AXES.some((a) => filters[a]);
  const isCurrent = !!data && data.month === data.currentMonth;
  const ratio = usageChangeRatio(total.costUsd, prevTotal.costUsd);

  if (loading && !data) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-[var(--text-primary)] mb-6">Usage</h1>
        <div className="text-[var(--text-muted)]">読み込み中...</div>
      </div>
    );
  }
  if (error && !data) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-[var(--text-primary)] mb-6">Usage</h1>
        <div className="text-[var(--text-danger)]">{error}</div>
      </div>
    );
  }
  if (!data) return null;

  const thCls = 'text-left text-[var(--text-muted)] text-xs font-medium px-3 py-2 cursor-pointer select-none whitespace-nowrap';
  const selectCls = 'px-2 py-1 bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded text-[var(--text-primary)] text-sm max-w-[11rem]';

  return (
    <div className="p-6 space-y-6">
      <datalist id="usage-group-options">
        {data.groupOptions.map((g) => <option key={g} value={g} />)}
      </datalist>
      <datalist id="usage-case-options">
        {data.caseOptions.map((c) => <option key={c} value={c} />)}
      </datalist>

      {/* 見出し + 月の切替 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[var(--text-primary)]">Usage</h1>
          <p className="text-xs text-[var(--text-muted)] mt-1">
            日本時間の暦月で集計（金額は会話履歴のコスト列と同じ計算。「~」付きの推定値を含む）
            {!data.inOrganization && ' ・組織に未所属のため自分の分だけを表示'}
          </p>
          <p className="text-xs text-[var(--text-muted)]">
            Devin のフルシート利用者は、定額に含まれる分も含めた使用量の金額です（Devin の請求画面のオンデマンドコストとは一致しません）
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setMonth(shiftMonthKey(data.month, -1))}
            className="px-2 py-1 rounded border border-[var(--border-color)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
            title="前の月"
          >
            ◀
          </button>
          <span className="text-lg font-semibold text-[var(--text-primary)] min-w-[7rem] text-center">{formatMonth(data.month)}</span>
          <button
            onClick={() => setMonth(shiftMonthKey(data.month, 1))}
            disabled={isCurrent}
            className="px-2 py-1 rounded border border-[var(--border-color)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-30"
            title="次の月"
          >
            ▶
          </button>
          <button
            onClick={() => setMonth(data.currentMonth)}
            disabled={isCurrent}
            className={`px-3 py-1 rounded text-sm ${isCurrent ? 'bg-[var(--bg-base)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'}`}
          >
            当月
          </button>
          <button
            onClick={() => setMonth(shiftMonthKey(data.currentMonth, -1))}
            disabled={data.month === shiftMonthKey(data.currentMonth, -1)}
            className={`px-3 py-1 rounded text-sm ${data.month === shiftMonthKey(data.currentMonth, -1) ? 'bg-[var(--bg-base)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'}`}
          >
            前月
          </button>
        </div>
      </div>

      {/* 合計 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-[var(--bg-secondary)] rounded-lg p-4">
          <div className="text-xs text-[var(--text-muted)]">{formatMonth(data.month)}{anyFilter && '（絞り込み中）'}</div>
          <div className="text-3xl font-bold text-[var(--text-primary)] mt-1">{formatUsageUsd(total.costUsd)}</div>
        </div>
        <div className="bg-[var(--bg-secondary)] rounded-lg p-4">
          <div className="text-xs text-[var(--text-muted)]">{formatMonth(data.prevMonth)}</div>
          <div className="text-3xl font-bold text-[var(--text-secondary)] mt-1">{formatUsageUsd(prevTotal.costUsd)}</div>
        </div>
        <div className="bg-[var(--bg-secondary)] rounded-lg p-4">
          <div className="text-xs text-[var(--text-muted)]">前月比</div>
          <div className="text-3xl font-bold text-[var(--text-primary)] mt-1">{formatRatio(ratio)}</div>
        </div>
        <div className="bg-[var(--bg-secondary)] rounded-lg p-4">
          <div className="text-xs text-[var(--text-muted)]">ターン / スレッド</div>
          <div className="text-3xl font-bold text-[var(--text-primary)] mt-1">
            {total.turns.toLocaleString()} <span className="text-lg text-[var(--text-muted)]">/ {total.threads}</span>
          </div>
          {total.unknownTurns > 0 && (
            <div className="text-xs text-[var(--text-muted)] mt-1" title="金額が「-」のターン（単価不明のモデル・古いデータ・中断したターン等）。0 円として集計しています">
              金額不明 {total.unknownTurns} 件
            </div>
          )}
        </div>
      </div>

      {/* 切り口ごとの小計 */}
      <div className="bg-[var(--bg-secondary)] rounded-lg p-4">
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <span className="text-sm text-[var(--text-muted)] mr-1">集計の切り口:</span>
          {AXES.map((a) => (
            <button
              key={a}
              onClick={() => setAxis(a)}
              className={`px-3 py-1 rounded text-sm ${
                axis === a ? 'bg-[var(--bg-base)] text-[var(--text-primary)] font-semibold' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'
              }`}
            >
              {AXIS_LABELS[a]}
            </button>
          ))}
        </div>
        {buckets.length === 0 ? (
          <div className="text-[var(--text-muted)] text-sm py-4 text-center">この月の利用はありません</div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-[var(--border-color)]">
                <th className="text-left text-[var(--text-muted)] text-xs font-medium px-3 py-2">{AXIS_LABELS[axis]}</th>
                <th className="text-right text-[var(--text-muted)] text-xs font-medium px-3 py-2 w-28">金額</th>
                <th className="text-left text-[var(--text-muted)] text-xs font-medium px-3 py-2 w-[30%] hidden md:table-cell"></th>
                <th className="text-right text-[var(--text-muted)] text-xs font-medium px-3 py-2 w-28">前月</th>
                <th className="text-right text-[var(--text-muted)] text-xs font-medium px-3 py-2 w-20">前月比</th>
                <th className="text-right text-[var(--text-muted)] text-xs font-medium px-3 py-2 w-24">ターン</th>
                <th className="text-right text-[var(--text-muted)] text-xs font-medium px-3 py-2 w-20 hidden md:table-cell">スレッド</th>
              </tr>
            </thead>
            <tbody>
              {buckets.map((b) => {
                const k = b.key ?? NONE_FILTER;
                const prev = prevBucketMap.get(k) ?? 0;
                return (
                  <tr
                    key={k}
                    onClick={() => setFilters((f) => ({ ...f, [axis]: f[axis] === k ? '' : k }))}
                    className={`border-b border-[var(--border-color)]/50 cursor-pointer hover:bg-[var(--bg-tertiary)]/30 ${filters[axis] === k ? 'bg-[var(--bg-tertiary)]/40' : ''}`}
                    title="クリックでこの値に絞り込み（もう一度で解除）"
                  >
                    <td className="px-3 py-2 text-sm">
                      {b.label ? <span className="text-[var(--text-primary)]">{b.label}</span> : <span className="text-[var(--text-muted)] italic">{noneLabel(axis)}</span>}
                    </td>
                    <td className="px-3 py-2 text-sm text-right font-semibold text-[var(--text-primary)] tabular-nums">{formatUsageUsd(b.costUsd)}</td>
                    <td className="px-3 py-2 hidden md:table-cell">
                      <div className="h-3 bg-[var(--bg-tertiary)]/40 rounded">
                        <div className="h-3 rounded bg-sky-500" style={{ width: `${Math.max(1, (b.costUsd / maxBucket) * 100)}%` }} />
                      </div>
                    </td>
                    <td className="px-3 py-2 text-sm text-right text-[var(--text-secondary)] tabular-nums">{formatUsageUsd(prev)}</td>
                    <td className="px-3 py-2 text-sm text-right text-[var(--text-secondary)] tabular-nums">{formatRatio(usageChangeRatio(b.costUsd, prev))}</td>
                    <td className="px-3 py-2 text-sm text-right text-[var(--text-secondary)] tabular-nums">
                      {b.turns}
                      {b.unknownTurns > 0 && <span className="text-xs text-[var(--text-muted)]" title="金額不明のターン数"> (不明{b.unknownTurns})</span>}
                    </td>
                    <td className="px-3 py-2 text-sm text-right text-[var(--text-secondary)] tabular-nums hidden md:table-cell">{b.threads}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* 明細（1 行 1 スレッド） */}
      <div className="bg-[var(--bg-secondary)] rounded-lg p-4">
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <h2 className="text-lg font-semibold text-[var(--text-primary)] mr-2">明細</h2>
          {AXES.map((a) => (
            <select
              key={a}
              value={filters[a]}
              onChange={(e) => setFilters((f) => ({ ...f, [a]: e.target.value }))}
              className={selectCls}
              title={`${AXIS_LABELS[a]}で絞り込み`}
            >
              <option value="">{AXIS_LABELS[a]}: すべて</option>
              {filterOptions[a].map((o) => (
                <option key={o.key} value={o.key}>{o.label}</option>
              ))}
            </select>
          ))}
          {anyFilter && (
            <button
              onClick={() => setFilters({ group: '', user: '', project: '', case: '' })}
              className="px-2 py-1 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            >
              絞り込み解除
            </button>
          )}
          <div className="flex-1" />
          <span className="text-xs text-[var(--text-muted)]">{sorted.length} 件</span>
          <button
            onClick={downloadCsv}
            className="px-3 py-1 rounded border border-[var(--border-color)] text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
          >
            CSV 出力
          </button>
        </div>
        <p className="text-xs text-[var(--text-muted)] mb-2">
          グループは本人と管理者、案件はスレッドの持ち主と管理者が、その場で入力して変更できます（一度使った名前は候補に出ます）。
        </p>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-[var(--border-color)]">
                <th className={thCls} onClick={() => toggleSort('group')}>グループ{sortMark('group')}</th>
                <th className={thCls} onClick={() => toggleSort('user')}>利用者{sortMark('user')}</th>
                <th className={thCls} onClick={() => toggleSort('project')}>プロジェクト{sortMark('project')}</th>
                <th className={thCls} onClick={() => toggleSort('case')}>案件{sortMark('case')}</th>
                <th className={thCls} onClick={() => toggleSort('thread')}>スレッド{sortMark('thread')}</th>
                <th className={`${thCls} text-right`} onClick={() => toggleSort('cost')}>金額{sortMark('cost')}</th>
                <th className={`${thCls} text-right`} onClick={() => toggleSort('turns')}>ターン{sortMark('turns')}</th>
                <th className={`${thCls} text-right hidden lg:table-cell`} onClick={() => toggleSort('lastAt')}>最終応答{sortMark('lastAt')}</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr key={r.sessionId} className="border-b border-[var(--border-color)]/50 hover:bg-[var(--bg-tertiary)]/20">
                  <td className="px-3 py-1.5 text-sm">
                    <LabelEditor
                      value={r.group}
                      listId="usage-group-options"
                      placeholder={NONE_GROUP}
                      editable={canEditGroup(r.userId)}
                      onSave={(g) => saveGroup(r.userId, g)}
                    />
                  </td>
                  <td className="px-3 py-1.5 text-sm text-[var(--text-primary)] whitespace-nowrap">{r.userName}</td>
                  <td className="px-3 py-1.5 text-sm text-[var(--text-secondary)] whitespace-nowrap">{r.projectName}</td>
                  <td className="px-3 py-1.5 text-sm">
                    <LabelEditor
                      value={r.caseName}
                      listId="usage-case-options"
                      placeholder={NONE_CASE}
                      editable={canEditCase(r)}
                      onSave={(c) => saveCase(r.sessionId, c)}
                    />
                  </td>
                  <td className="px-3 py-1.5 text-sm text-[var(--text-secondary)] max-w-[22rem] truncate" title={r.threadTitle}>{r.threadTitle}</td>
                  <td className="px-3 py-1.5 text-sm text-right font-semibold text-[var(--text-primary)] tabular-nums whitespace-nowrap">{formatUsageUsd(r.costUsd)}</td>
                  <td className="px-3 py-1.5 text-sm text-right text-[var(--text-secondary)] tabular-nums whitespace-nowrap">
                    {r.turns}
                    {r.unknownTurns > 0 && <span className="text-xs text-[var(--text-muted)]" title="金額不明のターン数"> (不明{r.unknownTurns})</span>}
                  </td>
                  <td className="px-3 py-1.5 text-xs text-right text-[var(--text-muted)] whitespace-nowrap hidden lg:table-cell">
                    {new Date(r.lastAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* メンバーのグループ設定（利用実績が無い人も設定できる） */}
      {data.inOrganization && (
        <div className="bg-[var(--bg-secondary)] rounded-lg p-4">
          <button onClick={() => setShowMembers((v) => !v)} className="text-sm font-semibold text-[var(--text-primary)]">
            {showMembers ? '▼' : '▶'} メンバーのグループ設定（{data.members.length} 人）
          </button>
          {showMembers && (
            <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-1">
              {data.members.map((m) => (
                <div key={m.userId} className="flex items-center justify-between gap-2 py-1 border-b border-[var(--border-color)]/40">
                  <span className="text-sm text-[var(--text-primary)] truncate">{m.userName}</span>
                  <LabelEditor
                    value={m.group}
                    listId="usage-group-options"
                    placeholder={NONE_GROUP}
                    editable={canEditGroup(m.userId)}
                    onSave={(g) => saveGroup(m.userId, g)}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* サイネージ（管理者のみ） */}
      {data.isAdmin && (
        <div className="bg-[var(--bg-secondary)] rounded-lg p-4 space-y-2">
          <h2 className="text-lg font-semibold text-[var(--text-primary)]">サイネージ表示（ログイン不要の URL）</h2>
          <p className="text-xs text-[var(--text-muted)]">
            URL を知っている人は誰でもログインなしで見られます（表示するのはグループ・案件または利用者名・金額だけ）。
            URL の末尾に <code>&amp;by=user</code> を付けるとカードの中が利用者別になります。
          </p>
          {signageUrl ? (
            <div className="flex flex-wrap items-center gap-2">
              <input readOnly value={signageUrl} onFocus={(e) => e.target.select()} className="flex-1 min-w-[20rem] px-2 py-1 text-sm rounded border border-[var(--border-color)] bg-[var(--bg-base)] text-[var(--text-primary)]" />
              <button onClick={copySignage} className="px-3 py-1 rounded border border-[var(--border-color)] text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]">コピー</button>
              <a href={signageUrl} target="_blank" rel="noreferrer" className="px-3 py-1 rounded border border-[var(--border-color)] text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]">開く</a>
              <button onClick={issueSignage} className="px-3 py-1 rounded border border-[var(--border-color)] text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]">再発行</button>
              <button onClick={stopSignage} className="px-3 py-1 rounded border border-red-500/50 text-sm text-[var(--text-danger)] hover:bg-red-500/10">停止</button>
            </div>
          ) : (
            <button onClick={issueSignage} className="px-3 py-1 rounded bg-sky-600 text-white text-sm hover:bg-sky-500">URL を発行する</button>
          )}
          {signageMsg && <div className="text-xs text-[var(--text-muted)]">{signageMsg}</div>}
        </div>
      )}
    </div>
  );
}
