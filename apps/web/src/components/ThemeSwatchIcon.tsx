import { useEffect, useId, useRef, useState } from 'react';
import { useTheme } from '../contexts/ThemeContext';
import { useLanguage } from '../contexts/LanguageContext';
import { getTheme, themesByGroup } from '../lib/theme-rules';

/**
 * テーマ選択ボタン（2026-11-21）。丸い色見本を斜めに 2 分割し、今のテーマの背景色とアクセント色を見せる。
 * 押すと色見本パネルが開き、グループ（定番 / パステル / ビビッド / 濃い色）ごとに並んだ 30 色から選べる。
 * 選ぶとその場で切り替わり、パネルは開いたまま（続けて試せる）。外側クリック・Esc で閉じる。
 * Layout（PC・モバイル）と LiteHeader で共用する。
 */
export function ThemeSwatchButton({ size = 20, className = '' }: { size?: number; className?: string }) {
  const { theme, setTheme } = useTheme();
  const { t, language } = useLanguage();
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState(0);
  const first = useRef(true);
  const wrapRef = useRef<HTMLDivElement>(null);
  const clipId = `theme-swatch-${useId().replace(/:/g, '')}`;

  // テーマが変わるたびに半回転ずつ足す（累積させて常に同じ向きに回す）
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setTurns((n) => n + 1);
  }, [theme]);

  // パネル外クリック・Esc で閉じる
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const cur = getTheme(theme);
  const title = `${t('theme.label')}: ${cur.name[language]}（${t('theme.clickPick')}）`;

  return (
    <div ref={wrapRef} className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={title}
        aria-label={title}
        aria-haspopup="dialog"
        aria-expanded={open}
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

      {open && (
        <div
          role="dialog"
          aria-label={t('theme.pickTitle')}
          className="absolute right-0 top-full mt-2 z-50 w-[22rem] max-w-[calc(100vw-1rem)] max-h-[70vh] overflow-y-auto rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] shadow-xl p-3"
        >
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-semibold text-[var(--text-primary)]">{t('theme.pickTitle')}</span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label={t('common.close')}
              className="w-6 h-6 flex items-center justify-center rounded text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            >
              ✕
            </button>
          </div>
          {themesByGroup().map(({ group, themes }) => (
            <div key={group.id} className="mb-3 last:mb-0">
              <div className="text-xs text-[var(--text-muted)] mb-1.5">{group.name[language]}</div>
              <div className="grid grid-cols-3 gap-1.5">
                {themes.map((th) => {
                  const selected = th.id === cur.id;
                  return (
                    <button
                      key={th.id}
                      type="button"
                      onClick={() => setTheme(th.id)}
                      title={th.name[language]}
                      aria-pressed={selected}
                      className={`relative flex items-center gap-1.5 h-9 px-2 rounded-md border text-left text-xs transition-transform hover:scale-[1.04] ${
                        selected ? 'border-[var(--accent-blue)] ring-2 ring-[var(--accent-blue)]' : 'border-black/10'
                      }`}
                      style={{ backgroundColor: th.swatchBg, color: th.swatchText }}
                    >
                      <span className="shrink-0 w-3.5 h-3.5 rounded-full" style={{ backgroundColor: th.swatchAccent }} aria-hidden="true" />
                      <span className="truncate">{th.name[language]}</span>
                      {selected && (
                        <span className="absolute -top-1.5 -right-1.5 w-4 h-4 flex items-center justify-center rounded-full bg-[var(--accent-blue)] text-white text-[10px] leading-none" aria-hidden="true">
                          ✓
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
