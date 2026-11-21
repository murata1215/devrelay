import { Link } from 'react-router-dom';
import { useLanguage } from '../../contexts/LanguageContext';
import { ThemeSwatchButton } from '../ThemeSwatchIcon';

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
 *
 * L3: `connected`（WS 接続状態）は optional prop。未指定時は L2 と完全に同一の見た目
 * （インジケータ非表示）になる。
 */
export interface LiteHeaderProps {
  connected?: boolean;
}

export function LiteHeader({ connected }: LiteHeaderProps = {}) {
  const { t } = useLanguage();

  return (
    <header className="h-12 shrink-0 flex items-center justify-between px-3 border-b border-[var(--border-color)] bg-[var(--bg-secondary)]">
      <span className="text-sm font-semibold text-[var(--text-primary)]">{t('lite.title')}</span>
      <div className="flex items-center gap-2">
        {connected !== undefined && (
          <span className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
            <span
              className={`w-2 h-2 rounded-full ${connected ? 'bg-[var(--text-success)]' : 'bg-[var(--text-danger)]'}`}
            />
            {connected ? t('lite.connected') : t('lite.disconnected')}
          </span>
        )}
        <ThemeSwatchButton size={16} className="!p-1" />
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
