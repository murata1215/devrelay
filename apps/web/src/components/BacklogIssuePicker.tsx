import { useCallback, useEffect, useRef, useState } from 'react';
import {
  backlog as backlogApi,
  isBacklogIssueKey,
  type BacklogConfig,
  type BacklogIssueBrief,
  type BacklogIssueSummary,
} from '../lib/api';

/**
 * Backlog 連携（2026-11-21）: チャット入力欄の上の「🏷 案件」欄の横に出す部品。
 * - BacklogPickButton: 押すと課題一覧のポップアップを開き、選んだ課題キーを案件に入れる
 * - BacklogIssueBadge: 案件が課題キーのとき、件名と状態（Backlog の色）を表示。状態をクリックすると変更できる
 */

// 設定は画面全体で 1 回だけ取る（設定画面で保存したら invalidateBacklogConfig() で取り直す）
let configPromise: Promise<BacklogConfig> | null = null;
const listeners = new Set<() => void>();
export function invalidateBacklogConfig() {
  configPromise = null;
  listeners.forEach((l) => l());
}

export function useBacklogConfig(): BacklogConfig | null {
  const [config, setConfig] = useState<BacklogConfig | null>(null);
  const [ver, setVer] = useState(0);
  useEffect(() => {
    const l = () => setVer((v) => v + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  useEffect(() => {
    let alive = true;
    if (!configPromise) configPromise = backlogApi.getConfig().catch(() => ({ enabled: false }));
    configPromise.then((c) => alive && setConfig(c));
    return () => {
      alive = false;
    };
  }, [ver]);
  return config;
}

/** 背景色に対して読みやすい文字色 */
function textOn(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return '#fff';
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#222' : '#fff';
}

export function StatusPill({ name, color, onClick, title }: { name: string; color: string; onClick?: () => void; title?: string }) {
  return (
    <span
      onClick={onClick}
      title={title}
      className={`inline-block px-2 py-0.5 rounded-full text-xs whitespace-nowrap ${onClick ? 'cursor-pointer hover:opacity-80' : ''}`}
      style={{ backgroundColor: color, color: textOn(color) }}
    >
      {name}
    </span>
  );
}

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: '未対応・着手中' },
  { value: '未対応', label: '未対応' },
  { value: 'open', label: '完了以外' },
  { value: 'all', label: 'すべて' },
];

function IssuePickerDialog({ config, onPick, onClose }: { config: BacklogConfig; onPick: (key: string) => void; onClose: () => void }) {
  const [status, setStatus] = useState('');
  const [everyone, setEveryone] = useState(false);
  const [project, setProject] = useState('');
  const [keyword, setKeyword] = useState('');
  const [issues, setIssues] = useState<BacklogIssueSummary[] | null>(null);
  const [err, setErr] = useState('');
  const [warn, setWarn] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const reqRef = useRef(0);

  const load = useCallback(async (kw: string) => {
    const req = ++reqRef.current;
    setLoading(true);
    setErr('');
    setWarn([]);
    // project は「接続ID:プロジェクトキー」（別スペースに同じキーがあっても区別するため）
    const [conn, projectKey] = project ? project.split(':') : [undefined, undefined];
    try {
      const r = await backlogApi.listIssues({ status: status || undefined, everyone, conn, project: projectKey, keyword: kw || undefined });
      if (req === reqRef.current) {
        setIssues(r.issues);
        setWarn(r.errors ?? []);
      }
    } catch (e) {
      if (req === reqRef.current) {
        setIssues([]);
        setErr(e instanceof Error ? e.message : '取得に失敗しました');
      }
    } finally {
      if (req === reqRef.current) setLoading(false);
    }
  }, [status, everyone, project]);

  // 絞り込み（キーワード以外）が変わったら取り直す。キーワードは Enter / 検索ボタンで
  const keywordRef = useRef(keyword);
  keywordRef.current = keyword;
  useEffect(() => {
    void load(keywordRef.current);
  }, [load]);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const connections = (config.connections ?? []).filter((c) => c.projects.length > 0);
  const multiSpace = connections.length > 1;
  const projects = connections.flatMap((c) =>
    c.projects.map((p) => ({ value: `${c.id}:${p.projectKey}`, label: multiSpace ? `${c.space} / ${p.name}` : p.name })),
  );
  const selectCls = 'px-2 py-1 rounded border border-[var(--border-color)] bg-[var(--input-bg)] text-[var(--text-primary)] text-sm';

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-16 px-2" onMouseDown={onClose}>
      <div
        className="w-full max-w-3xl max-h-[75vh] flex flex-col rounded-lg shadow-xl bg-[var(--bg-secondary)] border border-[var(--border-color)]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--border-color)]">
          <span className="font-semibold text-[var(--text-primary)]">Backlog の課題を選ぶ</span>
          <button onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--text-primary)] px-2" aria-label="閉じる">✕</button>
        </div>
        <div className="flex flex-wrap items-center gap-2 px-4 py-2 border-b border-[var(--border-color)] text-sm">
          <select value={status} onChange={(e) => setStatus(e.target.value)} className={selectCls}>
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          {projects.length > 1 && (
            <select value={project} onChange={(e) => setProject(e.target.value)} className={selectCls}>
              <option value="">全プロジェクト</option>
              {projects.map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
          )}
          <label className="flex items-center gap-1 text-[var(--text-secondary)] whitespace-nowrap">
            <input type="checkbox" checked={everyone} onChange={(e) => setEveryone(e.target.checked)} />
            全員分（担当者で絞らない）
          </label>
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void load(keyword);
              }
            }}
            placeholder="キーワード"
            className={`${selectCls} w-40`}
          />
          <button onClick={() => void load(keyword)} className="px-3 py-1 rounded bg-blue-600 text-white hover:bg-blue-700">検索</button>
        </div>
        <div className="overflow-y-auto flex-1">
          {!loading && warn.map((w) => (
            <div key={w} className="px-4 py-1 text-xs text-[var(--text-danger)]">⚠ 取得できなかったスペース: {w}</div>
          ))}
          {loading &&<div className="px-4 py-6 text-center text-[var(--text-muted)] text-sm">読み込み中…</div>}
          {!loading && err && <div className="px-4 py-6 text-center text-[var(--text-danger)] text-sm">{err}</div>}
          {!loading && !err && issues && issues.length === 0 && (
            <div className="px-4 py-6 text-center text-[var(--text-muted)] text-sm">該当する課題はありません</div>
          )}
          {!loading && !err && issues && issues.length > 0 && (
            <table className="w-full text-sm">
              <tbody>
                {issues.map((i) => (
                  <tr
                    key={i.issueKey}
                    onClick={() => onPick(i.issueKey)}
                    className="cursor-pointer border-b border-[var(--border-color)] hover:bg-[var(--bg-hover)]"
                  >
                    <td className="px-3 py-2 whitespace-nowrap font-mono text-xs text-[var(--text-secondary)]">{i.issueKey}</td>
                    <td className="px-1 py-2"><StatusPill name={i.status.name} color={i.status.color} /></td>
                    <td className="px-2 py-2 text-[var(--text-primary)]">
                      {i.summary}
                      {multiSpace && <span className="ml-2 text-xs text-[var(--text-faint)]">{i.space}</span>}
                    </td>
                    <td className="px-2 py-2 whitespace-nowrap text-xs text-[var(--text-muted)]">{i.assignee ?? '担当なし'}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-xs text-[var(--text-muted)]">{i.dueDate ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

/** 案件欄の右の「Backlog」ボタン。Backlog 連携が未設定の人には出さない */
export function BacklogPickButton({ onPick, disabled }: { onPick: (issueKey: string) => void; disabled?: boolean }) {
  const config = useBacklogConfig();
  const [open, setOpen] = useState(false);
  if (!config?.enabled || !config.configured) return null;
  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(true)}
        title="Backlog の課題を選んで案件にする"
        className="px-2 py-1 rounded border border-[var(--border-color)] text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-50 whitespace-nowrap"
      >
        Backlog▼
      </button>
      {open && (
        <IssuePickerDialog
          config={config}
          onClose={() => setOpen(false)}
          onPick={(k) => {
            setOpen(false);
            onPick(k);
          }}
        />
      )}
    </>
  );
}

/** 案件が課題キーのとき、件名と状態を表示する（状態クリックで変更） */
export function BacklogIssueBadge({ caseName }: { caseName: string | null }) {
  const config = useBacklogConfig();
  const [issue, setIssue] = useState<BacklogIssueBrief | null>(null);
  const [err, setErr] = useState('');
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const reqRef = useRef(0);
  const active = !!config?.enabled && !!config.configured && isBacklogIssueKey(caseName);

  const load = useCallback(async () => {
    if (!active || !caseName) return;
    const req = ++reqRef.current;
    try {
      const r = await backlogApi.getIssue(caseName);
      if (req === reqRef.current) {
        setIssue(r);
        setErr('');
      }
    } catch (e) {
      if (req === reqRef.current) {
        setIssue(null);
        setErr(e instanceof Error ? e.message : '取得できません');
      }
    }
  }, [active, caseName]);

  useEffect(() => {
    setIssue(null);
    setErr('');
    setMenu(false);
    void load();
  }, [load]);

  // AI が状態を変えたら反映されるよう、画面に戻ったときと 1 分ごと（表示中のみ）に取り直す
  useEffect(() => {
    if (!active) return;
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 60_000);
    return () => {
      window.removeEventListener('focus', onFocus);
      clearInterval(t);
    };
  }, [active, load]);

  if (!active) return null;
  if (err) return <span className="text-xs text-[var(--text-danger)] truncate max-w-xs" title={err}>⚠ {err}</span>;
  if (!issue) return <span className="text-xs text-[var(--text-muted)]">読み込み中…</span>;

  const change = async (statusId: number) => {
    setMenu(false);
    if (statusId === issue.status.id) return;
    setBusy(true);
    try {
      await backlogApi.setStatus(issue.issueKey, statusId);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : '変更できませんでした');
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="relative flex items-center gap-2 min-w-0">
      <a
        href={issue.url}
        target="_blank"
        rel="noreferrer"
        className="truncate max-w-[24rem] text-[var(--text-primary)] hover:underline"
        title={`${issue.summary}（Backlog で開く）`}
      >
        {issue.summary}
      </a>
      <StatusPill
        name={busy ? '変更中…' : issue.status.name}
        color={issue.status.color}
        onClick={busy ? undefined : () => setMenu((m) => !m)}
        title="クリックで状態を変更"
      />
      {menu && (
        <>
          <span className="fixed inset-0 z-40" onClick={() => setMenu(false)} />
          <span className="absolute bottom-full right-0 mb-1 z-50 flex flex-col gap-1 p-2 rounded shadow-lg bg-[var(--bg-secondary)] border border-[var(--border-color)]">
            {issue.statuses.map((s) => (
              <button
                key={s.id}
                onClick={() => void change(s.id)}
                className={`flex items-center gap-2 px-2 py-1 rounded text-left text-sm hover:bg-[var(--bg-hover)] ${s.id === issue.status.id ? 'font-semibold' : ''}`}
              >
                <span className="inline-block w-3 h-3 rounded-full" style={{ backgroundColor: s.color }} />
                <span className="text-[var(--text-primary)] whitespace-nowrap">{s.name}</span>
              </button>
            ))}
          </span>
        </>
      )}
    </span>
  );
}
