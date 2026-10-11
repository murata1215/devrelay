import { levelTone } from '../../lib/knowledge-search-rules';

/**
 * 高辻ナレッジ サイクル3（WebUI）: 機密度（0〜10）バッジ。
 * `levelTone()`（`lib/knowledge-search-rules.ts`）で色を決める: 0=公開（緑系） / 1-3=低（青系） /
 * 4-6=中（黄系） / 7-10=高（赤系）。色だけに意味を持たせず、数字を必ず併記する。
 */
export interface LevelBadgeProps {
  level: number;
  compact?: boolean;
}

const TONE_CLASS: Record<ReturnType<typeof levelTone>, string> = {
  open: 'bg-[var(--bg-tertiary)] text-[var(--text-muted)] border-[var(--border-color)]',
  low: 'bg-[var(--accent-blue)]/15 text-[var(--text-link)] border-[var(--accent-blue)]/40',
  mid: 'bg-amber-500/15 text-amber-500 border-amber-500/40',
  high: 'bg-[var(--bg-danger)] text-[var(--text-danger)] border-[var(--border-danger)]',
};

export function LevelBadge({ level, compact = false }: LevelBadgeProps) {
  const tone = levelTone(level);
  return (
    <span
      className={`inline-flex items-center rounded border font-medium ${TONE_CLASS[tone]} ${
        compact ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-xs'
      }`}
      title={`Level ${level}`}
    >
      L{level}
    </span>
  );
}
