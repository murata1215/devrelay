import { useEffect, useState } from 'react';
import {
  backlog as backlogApi,
  type BacklogConfig,
  type BacklogConnection,
  type BacklogPhaseMap,
  type BacklogProjectSetting,
  type BacklogStatus,
} from '../lib/api';
import { invalidateBacklogConfig } from './BacklogIssuePicker';

/**
 * Backlog 連携（2026-11-21）: 設定画面の「Backlog 連携」欄。
 * 1 人で複数の Backlog スペース（会社・お客様ごと）を使えるよう、「接続」を何件でも登録できる。
 * 接続 = スペース URL + 個人の API キー（暗号化保存・画面には出さない）+ 使うプロジェクト + 段階と状態の対応。
 */

const PHASES: { key: keyof BacklogPhaseMap; label: string; hint: string }[] = [
  { key: 'start', label: '着手', hint: '課題を抱える（例: 処理中）' },
  { key: 'test', label: 'テスト', hint: 'テストに入る（例: 結合テスト）' },
  { key: 'done', label: '完了報告', hint: 'コミット後（例: リリース待ち・処理済み）' },
];

const inputCls =
  'flex-1 px-3 py-2 bg-[var(--input-bg)] border border-[var(--border-color)] rounded text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-blue)]';
const btnCls = 'px-4 py-2 bg-[var(--accent-blue)] hover:bg-[var(--accent-blue-hover)] text-white rounded disabled:opacity-50';
const subBtnCls =
  'px-3 py-1 rounded border border-[var(--border-color)] text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-50';

/** 接続 1 件のカード（キーの差し替え・プロジェクトの選択・段階の対応・削除） */
function ConnectionCard({ conn, onChanged }: { conn: BacklogConnection; onChanged: () => Promise<void> }) {
  const [apiKey, setApiKey] = useState('');
  const [available, setAvailable] = useState<{ projectId: number; projectKey: string; name: string }[] | null>(null);
  const [me, setMe] = useState('');
  const [selected, setSelected] = useState<BacklogProjectSetting[]>(conn.projects);
  const [statuses, setStatuses] = useState<Record<string, BacklogStatus[]>>({});
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    setSelected(conn.projects);
  }, [conn.projects]);

  // 選択済みプロジェクトの状態一覧（対応のプルダウン用）
  useEffect(() => {
    for (const p of selected) {
      if (statuses[p.projectKey]) continue;
      backlogApi
        .getStatuses(conn.id, p.projectKey)
        .then((r) => setStatuses((s) => ({ ...s, [p.projectKey]: r.statuses })))
        .catch(() => {});
    }
  }, [selected, statuses, conn.id]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setErr('');
    setMsg('');
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : '失敗しました');
    } finally {
      setBusy('');
    }
  };

  const replaceKey = () =>
    run('key', async () => {
      await backlogApi.updateConnection(conn.id, { apiKey: apiKey.trim() });
      setApiKey('');
      await onChanged();
      setMsg('API キーを差し替えました');
    });

  const remove = () => {
    if (!window.confirm(`接続「${conn.space}」を削除しますか？（このスペースの課題は使えなくなります）`)) return;
    void run('del', async () => {
      await backlogApi.deleteConnection(conn.id);
      await onChanged();
    });
  };

  const loadProjects = () =>
    run('load', async () => {
      const r = await backlogApi.listProjects(conn.id);
      setAvailable(r.projects);
      setMe(r.me);
    });

  const toggleProject = async (p: { projectId: number; projectKey: string; name: string }, on: boolean) => {
    if (!on) {
      setSelected((s) => s.filter((x) => x.projectKey !== p.projectKey));
      return;
    }
    await run(`p:${p.projectKey}`, async () => {
      const r = await backlogApi.getStatuses(conn.id, p.projectKey);
      setStatuses((s) => ({ ...s, [p.projectKey]: r.statuses }));
      setSelected((s) => [...s.filter((x) => x.projectKey !== p.projectKey), { ...p, map: r.guessed }]);
    });
  };

  const setPhase = (projectKey: string, phase: keyof BacklogPhaseMap, value: number | null) => {
    setSelected((s) => s.map((p) => (p.projectKey === projectKey ? { ...p, map: { ...p.map, [phase]: value } } : p)));
  };

  const saveProjects = () =>
    run('projects', async () => {
      await backlogApi.updateConnection(conn.id, { projects: selected });
      await onChanged();
      setMsg('プロジェクトの設定を保存しました');
    });

  const list = available ?? selected.map((p) => ({ projectId: p.projectId, projectKey: p.projectKey, name: p.name }));

  return (
    <div className="rounded-lg border border-[var(--border-color)] p-4 space-y-3">
      <div className="flex items-center gap-2">
        <span className="font-mono text-sm text-[var(--text-primary)] flex-1 break-all">{conn.space}</span>
        <span className="text-xs text-[var(--text-muted)]">{conn.hasKey ? 'API キー登録済み' : 'API キー未登録'}</span>
        <button onClick={remove} disabled={!!busy} className="px-3 py-1 rounded bg-red-600 hover:bg-red-700 text-white text-sm disabled:opacity-50">
          削除
        </button>
      </div>

      <div className="flex flex-col sm:flex-row gap-2">
        <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="API キーを差し替える場合に入力" className={inputCls} />
        <button onClick={replaceKey} disabled={!!busy || !apiKey.trim()} className={subBtnCls}>
          {busy === 'key' ? '保存中…' : 'キーを差し替え'}
        </button>
      </div>

      <div>
        <div className="flex items-center gap-3 mb-2">
          <span className="text-sm font-medium text-[var(--text-secondary)]">使うプロジェクト</span>
          <button onClick={loadProjects} disabled={!conn.hasKey || !!busy} className={subBtnCls}>
            {busy === 'load' ? '読み込み中…' : 'プロジェクトを読み込む'}
          </button>
          {me && <span className="text-xs text-[var(--text-muted)]">（{me} さんのキーで見えるプロジェクト）</span>}
        </div>

        {list.length === 0 && <p className="text-xs text-[var(--text-muted)]">「プロジェクトを読み込む」を押すと、キーで見えるプロジェクトが出ます。</p>}

        <div className="space-y-2">
          {list.map((p) => {
            const sel = selected.find((x) => x.projectKey === p.projectKey);
            const sts = statuses[p.projectKey] ?? [];
            return (
              <div key={p.projectKey} className="rounded border border-[var(--border-color)] px-3 py-2">
                <label className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
                  <input
                    type="checkbox"
                    checked={!!sel}
                    disabled={busy === `p:${p.projectKey}`}
                    onChange={(e) => void toggleProject(p, e.target.checked)}
                  />
                  <span>{p.name}</span>
                  <span className="text-xs text-[var(--text-muted)] font-mono">{p.projectKey}</span>
                </label>
                {sel && (
                  <div className="mt-2 ml-6 grid grid-cols-1 sm:grid-cols-3 gap-2">
                    {PHASES.map((ph) => (
                      <label key={ph.key} className="text-xs text-[var(--text-secondary)]" title={ph.hint}>
                        <span className="block mb-1">{ph.label}</span>
                        <select
                          value={sel.map[ph.key] ?? ''}
                          onChange={(e) => setPhase(p.projectKey, ph.key, e.target.value ? Number(e.target.value) : null)}
                          className="w-full px-2 py-1 rounded border border-[var(--border-color)] bg-[var(--input-bg)] text-[var(--text-primary)] text-sm"
                        >
                          <option value="">なし（この段階は飛ばす）</option>
                          {sts.map((s) => (
                            <option key={s.id} value={s.id}>{s.name}</option>
                          ))}
                        </select>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {(list.length > 0 || conn.projects.length > 0) && (
          <div className="mt-3">
            <button onClick={saveProjects} disabled={!!busy} className={btnCls}>
              {busy === 'projects' ? '保存中…' : 'プロジェクトの設定を保存'}
            </button>
          </div>
        )}
      </div>

      {msg && <p className="text-sm text-green-600">{msg}</p>}
      {err && <p className="text-sm text-[var(--text-danger)]">{err}</p>}
    </div>
  );
}

export function BacklogSettingsSection() {
  const [config, setConfig] = useState<BacklogConfig | null>(null);
  const [adding, setAdding] = useState(false);
  const [space, setSpace] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const reload = async () => {
    const c = await backlogApi.getConfig().catch(() => ({ enabled: false }) as BacklogConfig);
    setConfig(c);
    invalidateBacklogConfig();
  };
  useEffect(() => {
    void reload();
  }, []);

  if (!config?.enabled) return null;
  const connections = config.connections ?? [];
  const showForm = adding || connections.length === 0;

  const startAdd = () => {
    // 組織既定のスペースはまだ接続に無いときだけ初期値にする
    const def = config.defaultSpace && !connections.some((c) => c.space === config.defaultSpace) ? config.defaultSpace : '';
    setSpace(def);
    setApiKey('');
    setErr('');
    setAdding(true);
  };

  const add = async () => {
    setBusy(true);
    setErr('');
    try {
      await backlogApi.addConnection(space.trim() || config.defaultSpace || '', apiKey.trim());
      setAdding(false);
      setSpace('');
      setApiKey('');
      await reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : '追加できませんでした');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mb-10 pb-6 border-b border-[var(--border-color)]">
      <h2 className="text-lg font-semibold text-[var(--text-primary)] mb-2">Backlog 連携</h2>
      <p className="text-[var(--text-muted)] text-sm mb-4">
        自分の Backlog API キーで、チャットの「案件」欄から課題を選んだり、AI に課題の確認・状態の変更を頼めるようになります。
        スペース（会社・お客様ごと）が複数あれば、接続を追加してください。AI が触れるのは、チェックを付けたプロジェクトだけです
        （Backlog の更新履歴にはあなたの名前が残ります）。
      </p>

      <div className="space-y-4">
        {connections.map((c) => (
          <ConnectionCard key={c.id} conn={c} onChanged={reload} />
        ))}

        {showForm ? (
          <div className="rounded-lg border border-dashed border-[var(--border-color)] p-4 space-y-3">
            <div className="text-sm font-medium text-[var(--text-secondary)]">接続を追加</div>
            <div>
              <label className="block text-xs text-[var(--text-secondary)] mb-1">スペース URL</label>
              <input
                value={space}
                onChange={(e) => setSpace(e.target.value)}
                placeholder={config.defaultSpace ? `${config.defaultSpace}（組織の既定）` : 'xxx.backlog.jp'}
                className={`${inputCls} w-full`}
              />
            </div>
            <div>
              <label className="block text-xs text-[var(--text-secondary)] mb-1">API キー</label>
              <p className="text-[var(--text-faint)] text-xs mb-1">Backlog の「個人設定 → API」で発行したキーを入れてください。暗号化して保存します。</p>
              <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="API キー" className={`${inputCls} w-full`} />
            </div>
            <div className="flex gap-2">
              <button onClick={() => void add()} disabled={busy || !apiKey.trim() || !(space.trim() || config.defaultSpace)} className={btnCls}>
                {busy ? '追加中…' : '追加'}
              </button>
              {connections.length > 0 && (
                <button onClick={() => setAdding(false)} disabled={busy} className={subBtnCls}>
                  やめる
                </button>
              )}
            </div>
            {err && <p className="text-sm text-[var(--text-danger)]">{err}</p>}
          </div>
        ) : (
          <button onClick={startAdd} className={subBtnCls}>
            ＋ 接続を追加
          </button>
        )}
      </div>
    </div>
  );
}
