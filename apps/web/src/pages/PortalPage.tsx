import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useLanguage } from '../contexts/LanguageContext';
import { withBase } from '../lib/base';
import { portal as portalApi, type PortalTodo } from '../lib/api';
import {
  DEFAULT_PORTAL_CONFIG,
  PORTAL_FILES_DIR,
  buildKnowledgeSearchPath,
  buildLoginPath,
  filterPortalNews,
  mergeNoticesIntoNews,
  normalizePortalConfig,
  normalizePortalDocs,
  normalizePortalIssues,
  normalizePortalNews,
  portalDocFileHref,
  portalDocsPagePath,
  type PortalConfig,
  type PortalDocCategory,
  type PortalIssue,
  type PortalNewsCategory,
  type PortalNewsItem,
  type PortalNewsTab,
} from '../lib/portal-rules';

/**
 * ポータル（/portal、ログイン不要）— サイクル P1 で Yahoo 風の 3 カラムに作り替え。
 *
 * - 上: ナレッジ検索（→ /knowledge?q=、未ログインはログイン経由）
 * - 左: 使い方（資料ページへ）・方針（DIR 直下の PDF）・リンク（portal.json）・DevRelay の各画面
 * - 中: ニュース（タブ: 最新 / アップデート）。`<DIR>/news/items.json` + portal.json のお知らせ
 * - 右: 課題一覧（自分の TODO = DB、全体課題 = `<DIR>/issues.json`、Backlog = 準備中）
 *
 * 資料・ニュース・課題はサーバーの `/api/portal/*`（`DEVRELAY_PORTAL_DIR`）から、
 * タイトル・お知らせ・リンクは従来どおり配信先の `<base>portal-files/portal.json` から読む。
 */
export function PortalPage() {
  const { user, loading } = useAuth();
  const { t } = useLanguage();
  const navigate = useNavigate();
  const config = usePortalConfig();
  const [docs, setDocs] = useState<PortalDocCategory[]>([]);
  const [news, setNews] = useState<PortalNewsItem[]>([]);
  const [issues, setIssues] = useState<PortalIssue[]>([]);
  const [query, setQuery] = useState('');

  useEffect(() => {
    let alive = true;
    portalApi.docs().then((r) => alive && setDocs(normalizePortalDocs(r))).catch(() => {});
    portalApi.news().then((r) => alive && setNews(normalizePortalNews(r))).catch(() => {});
    portalApi.issues().then((r) => alive && setIssues(normalizePortalIssues(r))).catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const loggedIn = !loading && !!user;
  const to = (path: string) => (loggedIn ? path : buildLoginPath(path));
  const allNews = useMemo(() => mergeNoticesIntoNews(config.notices, news), [config.notices, news]);
  const policyDocs = docs.find((c) => c.root)?.docs ?? [];
  const docCategories = docs.filter((c) => !c.root);

  const onSearch = (e: FormEvent) => {
    e.preventDefault();
    navigate(to(buildKnowledgeSearchPath(query)));
  };

  return (
    <div className="min-h-screen bg-[var(--bg-base)] text-[var(--text-primary)]">
      <PortalHeader title={config.title} />

      <div className="max-w-7xl mx-auto px-3 sm:px-5 py-5 space-y-5">
        {/* ナレッジ検索 */}
        <form
          onSubmit={onSearch}
          className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] px-4 py-4 sm:px-8"
        >
          <label htmlFor="portal-search" className="block mb-2 text-sm font-semibold text-[var(--text-secondary)]">
            🧠 {t('portal.knowledge')}
          </label>
          <div className="flex gap-2">
            <input
              id="portal-search"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('portal.searchPlaceholder')}
              className="min-w-0 flex-1 rounded-lg border border-[var(--border-color)] bg-[var(--bg-base)] px-4 py-2.5 text-base focus:outline-none focus:border-[var(--accent-blue)]"
            />
            <button
              type="submit"
              className="shrink-0 px-5 sm:px-8 py-2.5 rounded-lg bg-[var(--accent-blue)] hover:bg-[var(--accent-blue-hover)] text-white font-semibold"
            >
              {t('portal.search')}
            </button>
          </div>
        </form>

        <div className="grid gap-5 lg:grid-cols-[220px_minmax(0,1fr)_300px]">
          {/* 左: リンク */}
          <aside className="space-y-4 order-2 lg:order-1">
            <SideBox title={`📘 ${t('portal.howTo')}`}>
              {docCategories.length === 0 ? (
                <Empty>{t('portal.docsEmpty')}</Empty>
              ) : (
                docCategories.map((c) => (
                  <SideLink key={c.name} to={portalDocsPagePath(c.name)}>
                    {c.name}
                    <span className="ml-1 text-xs text-[var(--text-muted)]">({c.docs.length})</span>
                  </SideLink>
                ))
              )}
              <SideLink to={to('/machines')}>{t('portal.install')}</SideLink>
            </SideBox>

            {policyDocs.length > 0 && (
              <SideBox title={`📄 ${t('portal.policy')}`}>
                {policyDocs.map((d) => (
                  <SideAnchor key={d.path} href={portalDocFileHref(d.path, import.meta.env.BASE_URL)} pdf>
                    {d.title}
                  </SideAnchor>
                ))}
              </SideBox>
            )}

            {config.links.length > 0 && (
              <SideBox title={`🔗 ${t('portal.links')}`}>
                {config.links.map((l, i) =>
                  l.internal ? (
                    <SideLink key={i} to={to(l.href)} title={l.description}>
                      {l.title}
                    </SideLink>
                  ) : (
                    <SideAnchor key={i} href={l.href} title={l.description}>
                      {l.title}
                    </SideAnchor>
                  ),
                )}
              </SideBox>
            )}

            <SideBox title={`🛠 ${t('portal.devrelay')}`}>
              <SideLink to={to('/chat')}>{t('portal.chatTitle')}</SideLink>
              <SideLink to={to('/knowledge')}>{t('portal.knowledgeTitle')}</SideLink>
              <SideLink to={to('/machines')}>{t('portal.agentsTitle')}</SideLink>
              <SideLink to={to('/usage')}>{t('portal.usage')}</SideLink>
            </SideBox>
          </aside>

          {/* 中: ニュース */}
          <main className="order-1 lg:order-2 min-w-0">
            <NewsBox items={allNews} />
          </main>

          {/* 右: 課題一覧 */}
          <aside className="order-3 space-y-4">
            <h2 className="text-sm font-bold tracking-tight text-[var(--text-secondary)]">📋 {t('portal.tasks')}</h2>
            <SideBox title={t('portal.backlog')}>
              <Empty>{t('portal.comingSoon')}</Empty>
            </SideBox>
            <SideBox title={t('portal.issues')}>
              {issues.length === 0 ? (
                <Empty>{t('portal.issuesEmpty')}</Empty>
              ) : (
                <ul className="space-y-2">
                  {issues.map((it, i) => (
                    <li key={i} className="text-sm leading-5">
                      {it.link ? (
                        <a href={it.link} target="_blank" rel="noopener noreferrer" className="hover:text-[var(--text-link)] hover:underline">
                          {it.title}
                        </a>
                      ) : (
                        <span>{it.title}</span>
                      )}
                      {(it.status || it.owner || it.due) && (
                        <span className="block text-xs text-[var(--text-muted)]">
                          {[it.status, it.owner, it.due].filter(Boolean).join(' ・ ')}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </SideBox>
            <TodoBox loggedIn={loggedIn} />
          </aside>
        </div>
      </div>

      <footer className="border-t border-[var(--border-color)] py-6 text-center text-xs text-[var(--text-faint)]">DevRelay</footer>
    </div>
  );
}

/** portal.json（配信先 `<base>portal-files/portal.json`）を読む。無い・壊れていれば既定値。 */
export function usePortalConfig(): PortalConfig {
  const [config, setConfig] = useState<PortalConfig>(DEFAULT_PORTAL_CONFIG);
  useEffect(() => {
    let alive = true;
    // 置き換えが即反映されるようにキャッシュしない
    fetch(withBase(`${PORTAL_FILES_DIR}portal.json`), { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        // ファイルが無いと IIS の SPA rewrite で index.html が返り json() が失敗する → catch で既定値のまま
        if (alive && json) setConfig(normalizePortalConfig(json, import.meta.env.BASE_URL));
      })
      .catch(() => {
        /* 既定内容のまま */
      });
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    document.title = `${config.title} | Portal`;
    return () => {
      document.title = 'DevRelay';
    };
  }, [config.title]);
  return config;
}

export function PortalHeader({ title, back }: { title: string; back?: boolean }) {
  const { user, loading } = useAuth();
  const { t } = useLanguage();
  const loggedIn = !loading && !!user;
  return (
    <header className="sticky top-0 z-10 backdrop-blur bg-[var(--bg-base)]/85 border-b border-[var(--border-color)]">
      <div className="max-w-7xl mx-auto px-3 sm:px-5 h-14 flex items-center justify-between gap-3">
        <Link to="/portal" className="flex items-center gap-2 font-bold text-lg tracking-tight">
          <span className="inline-flex items-center justify-center w-8 h-8 rounded-md bg-[var(--accent-blue)] text-white text-sm font-bold">
            D
          </span>
          {back ? t('portal.back') : title}
        </Link>
        <div className="flex items-center gap-3 text-sm">
          {loggedIn && (
            <span className="hidden sm:inline text-[var(--text-muted)]">
              {t('portal.signedInAs')} {user?.name || user?.email}
            </span>
          )}
          <Link
            to={loggedIn ? '/' : '/login'}
            className="px-3 py-1.5 rounded-md bg-[var(--accent-blue)] hover:bg-[var(--accent-blue-hover)] text-white font-medium"
          >
            {loggedIn ? t('portal.open') : t('portal.login')}
          </Link>
        </div>
      </div>
    </header>
  );
}

const NEWS_PAGE = 15;

function NewsBox({ items }: { items: PortalNewsItem[] }) {
  const { t } = useLanguage();
  const [tab, setTab] = useState<PortalNewsTab>('latest');
  const [limit, setLimit] = useState(NEWS_PAGE);
  const shown = filterPortalNews(items, tab);
  const tabs: { key: PortalNewsTab; label: string }[] = [
    { key: 'latest', label: t('portal.newsLatest') },
    { key: 'update', label: t('portal.newsUpdate') },
  ];
  return (
    <section className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] overflow-hidden">
      <div className="flex border-b border-[var(--border-color)]">
        {tabs.map((tb) => (
          <button
            key={tb.key}
            type="button"
            onClick={() => {
              setTab(tb.key);
              setLimit(NEWS_PAGE);
            }}
            className={`px-5 py-2.5 text-sm font-semibold border-b-2 -mb-px ${
              tab === tb.key
                ? 'border-[var(--accent-blue)] text-[var(--text-primary)]'
                : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]'
            }`}
          >
            {tb.label}
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <p className="px-5 py-6 text-sm text-[var(--text-muted)]">{t('portal.newsEmpty')}</p>
      ) : (
        <ul className="divide-y divide-[var(--border-color)]">
          {shown.slice(0, limit).map((n) => (
            <li key={n.id} className="px-5 py-3">
              <div className="flex items-baseline gap-2 flex-wrap">
                {n.date !== '0000-00-00' && (
                  <span className="text-xs text-[var(--text-muted)] tabular-nums">{n.date.slice(5).replace('-', '/')}</span>
                )}
                <CategoryBadge category={n.category} />
                {n.link ? (
                  <a href={n.link} target="_blank" rel="noopener noreferrer" className="font-medium hover:text-[var(--text-link)] hover:underline">
                    {n.title}
                  </a>
                ) : (
                  <span className="font-medium">{n.title}</span>
                )}
              </div>
              {n.body && <p className="mt-1 text-sm leading-6 text-[var(--text-secondary)] whitespace-pre-wrap">{n.body}</p>}
            </li>
          ))}
        </ul>
      )}
      {shown.length > limit && (
        <button
          type="button"
          onClick={() => setLimit((l) => l + NEWS_PAGE)}
          className="w-full px-5 py-2.5 text-sm text-[var(--text-link)] hover:bg-[var(--bg-hover)] border-t border-[var(--border-color)]"
        >
          {t('portal.newsMore')}
        </button>
      )}
    </section>
  );
}

function CategoryBadge({ category }: { category: PortalNewsCategory }) {
  const { t } = useLanguage();
  const map: Record<PortalNewsCategory, { label: string; cls: string }> = {
    update: { label: t('portal.catUpdate'), cls: 'bg-emerald-500/15 text-emerald-400' },
    notice: { label: t('portal.catNotice'), cls: 'bg-sky-500/15 text-sky-400' },
    mail: { label: t('portal.catMail'), cls: 'bg-amber-500/15 text-amber-400' },
    other: { label: t('portal.catOther'), cls: 'bg-slate-500/15 text-[var(--text-muted)]' },
  };
  const m = map[category];
  return <span className={`shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded ${m.cls}`}>{m.label}</span>;
}

function TodoBox({ loggedIn }: { loggedIn: boolean }) {
  const { t } = useLanguage();
  const [items, setItems] = useState<PortalTodo[]>([]);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!loggedIn) return;
    let alive = true;
    portalApi
      .listTodos()
      .then((r) => alive && setItems(r.items))
      .catch(() => alive && setError(t('portal.loadError')));
    return () => {
      alive = false;
    };
  }, [loggedIn, t]);

  const sortTodos = (list: PortalTodo[]) =>
    [...list].sort((a, b) => (a.done === b.done ? (a.createdAt < b.createdAt ? 1 : -1) : a.done ? 1 : -1));

  const add = async (e: FormEvent) => {
    e.preventDefault();
    const s = text.trim();
    if (!s || busy) return;
    setBusy(true);
    try {
      const { item } = await portalApi.addTodo(s);
      setItems((prev) => sortTodos([item, ...prev]));
      setText('');
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (todo: PortalTodo) => {
    try {
      const { item } = await portalApi.updateTodo(todo.id, { done: !todo.done });
      setItems((prev) => sortTodos(prev.map((x) => (x.id === item.id ? item : x))));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const remove = async (todo: PortalTodo) => {
    try {
      await portalApi.deleteTodo(todo.id);
      setItems((prev) => prev.filter((x) => x.id !== todo.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <SideBox title={t('portal.myTodo')}>
      {!loggedIn ? (
        <Link to={buildLoginPath('/portal')} className="text-sm text-[var(--text-link)] hover:underline">
          {t('portal.todoLogin')}
        </Link>
      ) : (
        <>
          <form onSubmit={add} className="flex gap-1.5 mb-2">
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={200}
              placeholder={t('portal.todoPlaceholder')}
              className="min-w-0 flex-1 rounded-md border border-[var(--border-color)] bg-[var(--bg-base)] px-2 py-1 text-sm focus:outline-none focus:border-[var(--accent-blue)]"
            />
            <button
              type="submit"
              disabled={busy || !text.trim()}
              className="shrink-0 px-2.5 py-1 rounded-md bg-[var(--accent-blue)] hover:bg-[var(--accent-blue-hover)] disabled:opacity-50 text-white text-xs font-semibold"
            >
              {t('portal.todoAdd')}
            </button>
          </form>
          {error && <p className="mb-2 text-xs text-red-400">{error}</p>}
          {items.length === 0 ? (
            <Empty>{t('portal.todoEmpty')}</Empty>
          ) : (
            <ul className="space-y-1">
              {items.map((todo) => (
                <li key={todo.id} className="group flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={todo.done}
                    onChange={() => toggle(todo)}
                    className="mt-1 shrink-0 accent-[var(--accent-blue)]"
                  />
                  <span className={`flex-1 min-w-0 break-words ${todo.done ? 'line-through text-[var(--text-muted)]' : ''}`}>{todo.text}</span>
                  <button
                    type="button"
                    onClick={() => remove(todo)}
                    title={t('portal.todoDelete')}
                    aria-label={t('portal.todoDelete')}
                    className="shrink-0 text-[var(--text-faint)] hover:text-red-400 opacity-60 group-hover:opacity-100"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </SideBox>
  );
}

export function SideBox({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)]">
      <h3 className="px-4 pt-3 pb-2 text-sm font-bold">{title}</h3>
      <div className="px-4 pb-3 flex flex-col gap-1">{children}</div>
    </section>
  );
}

function SideLink({ to, title, children }: { to: string; title?: string; children: ReactNode }) {
  return (
    <Link to={to} title={title} className="text-sm py-0.5 hover:text-[var(--text-link)] hover:underline">
      {children}
    </Link>
  );
}

export function SideAnchor({ href, title, pdf, children }: { href: string; title?: string; pdf?: boolean; children: ReactNode }) {
  return (
    <a
      href={href}
      title={title}
      target="_blank"
      rel="noopener noreferrer"
      className="text-sm py-0.5 hover:text-[var(--text-link)] hover:underline break-words"
    >
      {pdf && <span className="mr-1 text-[10px] font-bold text-red-400">PDF</span>}
      {children}
      {!pdf && <span className="ml-0.5 text-[var(--text-muted)]">↗</span>}
    </a>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="text-sm text-[var(--text-muted)]">{children}</p>;
}
