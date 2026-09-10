import { Link } from 'react-router-dom';
import { useLanguage } from '../../contexts/LanguageContext';
import { useTheme } from '../../contexts/ThemeContext';

/**
 * Lite シェル L2: 最小ヘッダー。
 *
 * F5（`useOrganization()` は `OrganizationProvider` の外で throw する）対策のため、
 * `Layout` / `useOrganization()` は絶対に使わない（`components/lite/lite-shell-rules.ts` の
 * `FORBIDDEN_LITE_BINDINGS` / `FORBIDDEN_LITE_MODULES` で静的に検出する）。
 * `useTheme()` / `useLanguage()` は `App` 直下（`App.tsx`）にあるため `/lite` から使用可。
 *
 * B2（`/` への自動リダイレクト・localStorage によるモード永続化）は L2 で撤回された。
 * URL のみを状態とする方針のため、「従来 UI に戻る」は単なる `<Link to="/chat">` であり、
 * モードの書き込みは一切行わない。
 */
export function LiteHeader() {
  const { t } = useLanguage();
  const { theme, toggleTheme } = useTheme();

  return (
    <header className="h-12 shrink-0 flex items-center justify-between px-3 border-b border-[var(--border-color)] bg-[var(--bg-secondary)]">
      <span className="text-sm font-semibold text-[var(--text-primary)]">{t('lite.title')}</span>
      <div className="flex items-center gap-2">
        <button
          onClick={toggleTheme}
          title={theme === 'dark' ? t('nav.lightMode') : t('nav.darkMode')}
          className="text-[var(--text-muted)] hover:text-[var(--text-primary)] p-1"
        >
          {theme === 'dark' ? (
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v2.25m6.364.386-1.591 1.591M21 12h-2.25m-.386 6.364-1.591-1.591M12 18.75V21m-4.773-4.227-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0Z" />
            </svg>
          ) : (
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M21.752 15.002A9.72 9.72 0 0 1 18 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 0 0 3 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 0 0 9.002-5.998Z" />
            </svg>
          )}
        </button>
        <Link
          to="/chat"
          className="text-xs px-2 py-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
        >
          {t('lite.backToClassic')}
        </Link>
      </div>
    </header>
  );
}
