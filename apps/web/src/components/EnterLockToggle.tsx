import { useLanguage } from '../contexts/LanguageContext';

/**
 * Enter 送信ロックのトグル（2026-11-21）。送信ボタンの左に置く。
 * Enter キー形（⏎）のアイコンで、ロック中は錠前バッジが付きアクセント色になる。
 */
export function EnterLockToggle({ locked, onToggle, compact = false }: { locked: boolean; onToggle: () => void; compact?: boolean }) {
  const { t } = useLanguage();
  const title = locked ? t('chat.enterLockOn') : t('chat.enterLockOff');
  const box = compact ? 'w-8 h-8' : 'w-10 h-10';

  return (
    <button
      type="button"
      onClick={onToggle}
      title={title}
      aria-label={title}
      aria-pressed={locked}
      className={`relative shrink-0 ${box} flex items-center justify-center rounded-lg border transition-colors ${
        locked
          ? 'border-[var(--accent-blue)] text-[var(--accent-blue)] bg-[var(--bg-tertiary)]'
          : 'border-[var(--border-color)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]'
      }`}
    >
      {/* ⏎（Enter キー） */}
      <svg className={compact ? 'w-4 h-4' : 'w-5 h-5'} fill="none" viewBox="0 0 24 24" strokeWidth="1.8" stroke="currentColor" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M19 5v7a3 3 0 0 1-3 3H6" />
        <path strokeLinecap="round" strokeLinejoin="round" d="m9 11-4 4 4 4" />
      </svg>
      {locked && (
        /* 錠前バッジ */
        <span className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-[var(--accent-blue)] text-white flex items-center justify-center shadow">
          <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5Zm-3 8V7a3 3 0 1 1 6 0v3H9Z" />
          </svg>
        </span>
      )}
    </button>
  );
}
