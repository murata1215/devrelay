import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useLanguage } from '../contexts/LanguageContext';
import { withBase } from '../lib/base';
import {
  DEFAULT_PORTAL_CONFIG,
  PORTAL_FILES_DIR,
  buildLoginPath,
  normalizePortalConfig,
  type PortalConfig,
} from '../lib/portal-rules';

/**
 * ポータル（/portal、ログイン不要）。
 *
 * 掲載内容（お知らせ・PDF マニュアル・リンク・インストール手順）は配信先の
 * `<base>portal-files/portal.json` から読む（会社固有の資料をリポジトリに入れないため）。
 * ファイルが無い・壊れている場合は既定内容で表示する。
 * 未ログインでカードを押すと `/login?next=<行き先>` に送り、ログイン後に元の行き先へ戻す。
 */
export function PortalPage() {
  const { user, loading } = useAuth();
  const { t } = useLanguage();
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

  const loggedIn = !loading && !!user;
  // ログイン済みならそのまま、未ログインならログイン画面経由（戻り先付き）
  const to = (path: string) => (loggedIn ? path : buildLoginPath(path));

  return (
    <div className="min-h-screen bg-[var(--bg-base)] text-[var(--text-primary)]">
      {/* ヘッダー */}
      <header className="sticky top-0 z-10 backdrop-blur bg-[var(--bg-base)]/80 border-b border-[var(--border-color)]">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2 font-semibold">
            <span className="inline-flex items-center justify-center w-7 h-7 rounded-md bg-[var(--accent-blue)] text-white text-sm font-bold">
              D
            </span>
            {config.title}
          </div>
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

      {/* ヒーロー */}
      <section className="relative overflow-hidden">
        <div
          aria-hidden
          className="absolute inset-0 opacity-40 pointer-events-none"
          style={{
            background:
              'radial-gradient(60% 80% at 15% 0%, rgba(88,101,242,0.45), transparent 60%), radial-gradient(50% 70% at 90% 10%, rgba(16,185,129,0.30), transparent 60%)',
          }}
        />
        <div className="relative max-w-6xl mx-auto px-4 sm:px-6 py-14 sm:py-20">
          <h1 className="text-3xl sm:text-5xl font-bold tracking-tight">{config.title}</h1>
          <p className="mt-4 max-w-2xl text-base sm:text-lg text-[var(--text-secondary)]">{config.subtitle}</p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              to={loggedIn ? '/' : '/login'}
              className="px-5 py-2.5 rounded-lg bg-[var(--accent-blue)] hover:bg-[var(--accent-blue-hover)] text-white font-medium shadow-lg shadow-black/20"
            >
              {loggedIn ? t('portal.open') : t('portal.login')} →
            </Link>
            <a
              href="#manuals"
              className="px-5 py-2.5 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] hover:bg-[var(--bg-hover)] font-medium"
            >
              {t('portal.manuals')}
            </a>
            <a
              href="#install"
              className="px-5 py-2.5 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] hover:bg-[var(--bg-hover)] font-medium"
            >
              {t('portal.install')}
            </a>
          </div>
        </div>
      </section>

      <main className="max-w-6xl mx-auto px-4 sm:px-6 pb-20 space-y-14">
        {/* お知らせ */}
        {config.notices.length > 0 && (
          <section>
            <SectionTitle>{t('portal.notices')}</SectionTitle>
            <ul className="divide-y divide-[var(--border-color)] rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)]">
              {config.notices.map((n, i) => (
                <li key={i} className="px-5 py-3 flex flex-col sm:flex-row sm:gap-6 text-sm">
                  {n.date && <span className="shrink-0 text-[var(--text-muted)] tabular-nums">{n.date}</span>}
                  <span className="whitespace-pre-wrap">{n.text}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* はじめる */}
        <section>
          <SectionTitle>{t('portal.quickLinks')}</SectionTitle>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <FeatureCard
              to={to('/knowledge')}
              icon="🧠"
              title={t('portal.knowledgeTitle')}
              desc={t('portal.knowledgeDesc')}
              badge={loggedIn ? undefined : t('portal.loginRequired')}
              accent="rgba(16,185,129,0.18)"
            />
            <FeatureCard
              to={to('/chat')}
              icon="💬"
              title={t('portal.chatTitle')}
              desc={t('portal.chatDesc')}
              badge={loggedIn ? undefined : t('portal.loginRequired')}
              accent="rgba(88,101,242,0.18)"
            />
            <FeatureCard
              to={to('/machines')}
              icon="🖥️"
              title={t('portal.agentsTitle')}
              desc={t('portal.agentsDesc')}
              badge={loggedIn ? undefined : t('portal.loginRequired')}
              accent="rgba(245,158,11,0.18)"
            />
          </div>
        </section>

        {/* マニュアル */}
        <section id="manuals" className="scroll-mt-20">
          <SectionTitle>{t('portal.manuals')}</SectionTitle>
          {config.manuals.length === 0 ? (
            <p className="text-sm text-[var(--text-muted)]">{t('portal.manualsEmpty')}</p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {config.manuals.map((m, i) => (
                <a
                  key={i}
                  href={m.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group flex gap-4 rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] p-5 hover:border-[var(--accent-blue)] hover:bg-[var(--bg-hover)] transition-colors"
                >
                  <span className="shrink-0 inline-flex items-center justify-center w-10 h-12 rounded-md bg-red-500/15 text-red-400 text-xs font-bold">
                    PDF
                  </span>
                  <span className="min-w-0">
                    <span className="block font-semibold group-hover:text-[var(--text-link)]">{m.title}</span>
                    {m.description && (
                      <span className="mt-1 block text-sm text-[var(--text-muted)]">{m.description}</span>
                    )}
                  </span>
                </a>
              ))}
            </div>
          )}
        </section>

        {/* インストール */}
        <section id="install" className="scroll-mt-20">
          <SectionTitle>{t('portal.install')}</SectionTitle>
          <div className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] p-6">
            <ol className="space-y-3">
              {config.installSteps.map((s, i) => (
                <li key={i} className="flex gap-3">
                  <span className="shrink-0 inline-flex items-center justify-center w-6 h-6 rounded-full bg-[var(--accent-blue)] text-white text-xs font-bold">
                    {i + 1}
                  </span>
                  <span className="text-sm leading-6 whitespace-pre-wrap">{s}</span>
                </li>
              ))}
            </ol>
            <Link
              to={to('/machines')}
              className="mt-6 inline-block px-4 py-2 rounded-lg bg-[var(--accent-blue)] hover:bg-[var(--accent-blue-hover)] text-white text-sm font-medium"
            >
              {t('portal.installCta')} →
            </Link>
          </div>
        </section>

        {/* リンク */}
        {config.links.length > 0 && (
          <section>
            <SectionTitle>{t('portal.links')}</SectionTitle>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {config.links.map((l, i) =>
                l.internal ? (
                  <FeatureCard key={i} to={to(l.href)} icon="🔗" title={l.title} desc={l.description} />
                ) : (
                  <a
                    key={i}
                    href={l.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] p-5 hover:border-[var(--accent-blue)] hover:bg-[var(--bg-hover)] transition-colors"
                  >
                    <span className="block font-semibold">🔗 {l.title} ↗</span>
                    {l.description && <span className="mt-1 block text-sm text-[var(--text-muted)]">{l.description}</span>}
                  </a>
                )
              )}
            </div>
          </section>
        )}
      </main>

      <footer className="border-t border-[var(--border-color)] py-6 text-center text-xs text-[var(--text-faint)]">
        DevRelay
      </footer>
    </div>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 className="mb-4 text-lg font-semibold tracking-tight">{children}</h2>;
}

function FeatureCard({
  to,
  icon,
  title,
  desc,
  badge,
  accent,
}: {
  to: string;
  icon: string;
  title: string;
  desc: string;
  badge?: string;
  accent?: string;
}) {
  return (
    <Link
      to={to}
      className="group relative overflow-hidden rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] p-5 hover:border-[var(--accent-blue)] hover:-translate-y-0.5 hover:shadow-lg hover:shadow-black/20 transition-all"
    >
      {accent && (
        <span
          aria-hidden
          className="absolute -top-10 -right-10 w-32 h-32 rounded-full blur-2xl"
          style={{ background: accent }}
        />
      )}
      <span className="relative flex items-start justify-between gap-2">
        <span className="text-2xl">{icon}</span>
        {badge && (
          <span className="text-[10px] px-2 py-0.5 rounded-full border border-[var(--border-color)] text-[var(--text-muted)]">
            {badge}
          </span>
        )}
      </span>
      <span className="relative mt-3 block font-semibold group-hover:text-[var(--text-link)]">{title} →</span>
      {desc && <span className="relative mt-1 block text-sm text-[var(--text-muted)]">{desc}</span>}
    </Link>
  );
}
