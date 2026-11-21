import { useEffect, useId, useRef, useState } from 'react';
import { useTheme } from '../contexts/ThemeContext';
import { useLanguage } from '../contexts/LanguageContext';
import { getTheme, nextTheme } from '../lib/theme-rules';

/**
 * テーマ切替ボタン（2026-11-21）。丸い色見本を斜めに 2 分割し、今のテーマの背景色とアクセント色を見せる。
 * 押すたびに次のテーマへ巡回し、見本が 180° 回転して新しい色に変わる。
 * Layout（PC・モバイル）と LiteHeader で共用する。
 */
export function ThemeSwatchButton({ size = 20, className = '' }: { size?: number; className?: string }) {
  const { theme, toggleTheme } = useTheme();
  const { t, language } = useLanguage();
  const [turns, setTurns] = useState(0);
  const first = useRef(true);
  const clipId = `theme-swatch-${useId().replace(/:/g, '')}`;

  // テーマが変わるたびに半回転ずつ足す（累積させて常に同じ向きに回す）
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setTurns((n) => n + 1);
  }, [theme]);

  const cur = getTheme(theme);
  const next = getTheme(nextTheme(theme));
  const title = `${t('theme.label')}: ${cur.name[language]}（${t('theme.clickNext')}: ${next.name[language]}）`;

  return (
    <button
      type="button"
      onClick={toggleTheme}
      title={title}
      aria-label={title}
      className={`group p-1.5 rounded-md hover:bg-[var(--bg-tertiary)] transition-colors ${className}`}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        className="block transition-transform duration-300 ease-out group-hover:scale-110"
        style={{ transform: `rotate(${turns * 180}deg)` }}
        aria-hidden="true"
      >
        <defs>
          <clipPath id={clipId}>
            <circle cx="12" cy="12" r="8.5" />
          </clipPath>
        </defs>
        <g clipPath={`url(#${clipId})`}>
          <rect x="0" y="0" width="24" height="24" fill={cur.swatchBg} style={{ transition: 'fill 300ms' }} />
          <path d="M24 0 L24 24 L0 24 Z" fill={cur.swatchAccent} style={{ transition: 'fill 300ms' }} />
        </g>
        {/* 外周の細い輪（どの背景でも見本の縁が分かるよう currentColor） */}
        <circle cx="12" cy="12" r="10.25" fill="none" stroke="currentColor" strokeWidth="1.25" className="text-[var(--text-muted)] group-hover:text-[var(--text-primary)]" />
      </svg>
    </button>
  );
}
