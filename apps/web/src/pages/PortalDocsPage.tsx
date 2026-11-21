import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useLanguage } from '../contexts/LanguageContext';
import { portal as portalApi } from '../lib/api';
import {
  formatPortalFileSize,
  normalizePortalDocs,
  portalDocFileHref,
  portalDocsPagePath,
  type PortalDocCategory,
} from '../lib/portal-rules';
import { PortalHeader, usePortalConfig } from './PortalPage';

/**
 * ポータルの資料ページ（/portal/docs?c=<分類>、ログイン不要）— サイクル P1。
 * `DEVRELAY_PORTAL_DIR` 配下の PDF を分類（直下フォルダ）ごとに一覧し、新しいタブで開く。
 * `c` が無い・見つからないときは全分類を並べる。
 */
export function PortalDocsPage() {
  const { t } = useLanguage();
  const config = usePortalConfig();
  const [params] = useSearchParams();
  const [cats, setCats] = useState<PortalDocCategory[] | null>(null);
  const [error, setError] = useState(false);
  const selected = params.get('c');

  useEffect(() => {
    let alive = true;
    portalApi
      .docs()
      .then((r) => alive && setCats(normalizePortalDocs(r)))
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
    };
  }, []);

  const list = cats ?? [];
  const current = selected ? list.filter((c) => c.name === selected) : [];
  const shown = current.length > 0 ? current : list;

  return (
    <div className="min-h-screen bg-[var(--bg-base)] text-[var(--text-primary)]">
      <PortalHeader title={config.title} back />
      <div className="max-w-5xl mx-auto px-3 sm:px-5 py-6 grid gap-6 md:grid-cols-[200px_minmax(0,1fr)]">
        <nav className="flex md:flex-col gap-1 flex-wrap text-sm">
          <Link
            to={portalDocsPagePath(null)}
            className={`px-3 py-1.5 rounded-md hover:bg-[var(--bg-hover)] ${current.length === 0 ? 'bg-[var(--bg-secondary)] font-semibold' : ''}`}
          >
            {t('portal.docsAll')}
          </Link>
          {list.map((c) => (
            <Link
              key={c.name}
              to={portalDocsPagePath(c.name)}
              className={`px-3 py-1.5 rounded-md hover:bg-[var(--bg-hover)] ${current[0]?.name === c.name ? 'bg-[var(--bg-secondary)] font-semibold' : ''}`}
            >
              {c.name} <span className="text-xs text-[var(--text-muted)]">({c.docs.length})</span>
            </Link>
          ))}
        </nav>

        <main className="space-y-8 min-w-0">
          {error && <p className="text-sm text-red-400">{t('portal.loadError')}</p>}
          {cats && shown.length === 0 && <p className="text-sm text-[var(--text-muted)]">{t('portal.docsEmpty')}</p>}
          {shown.map((c) => (
            <section key={c.name}>
              <h1 className="mb-3 text-xl font-bold tracking-tight">{c.name}</h1>
              <ul className="grid gap-3 sm:grid-cols-2">
                {c.docs.map((d) => (
                  <li key={d.path}>
                    <a
                      href={portalDocFileHref(d.path, import.meta.env.BASE_URL)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="group flex gap-3 rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] p-4 hover:border-[var(--accent-blue)] hover:bg-[var(--bg-hover)] transition-colors"
                    >
                      <span className="shrink-0 inline-flex items-center justify-center w-9 h-11 rounded-md bg-red-500/15 text-red-400 text-[11px] font-bold">
                        PDF
                      </span>
                      <span className="min-w-0">
                        <span className="block font-semibold break-words group-hover:text-[var(--text-link)]">{d.title}</span>
                        <span className="mt-1 block text-xs text-[var(--text-muted)]">
                          {[d.updatedAt.slice(0, 10), formatPortalFileSize(d.size)].filter(Boolean).join(' ・ ')}
                        </span>
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </main>
      </div>
    </div>
  );
}
