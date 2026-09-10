import { useLanguage } from '../../contexts/LanguageContext';
import type { ProjectSelectorOption } from './lite-shell-rules';

/**
 * Lite シェル L2: 入力欄 + プロジェクトセレクタの骨組み。
 *
 * L2 では送信機能を実装しない（L4 で追加）。テキストエリアと送信ボタンは常に disabled。
 * プロジェクトセレクタのみ有効で、選択状態は `LitePage` が保持する（このコンポーネントは状態を持たない）。
 */
export interface LiteComposerProps {
  options: readonly ProjectSelectorOption[];
  selectedProjectId: string | null;
  onProjectChange: (projectId: string) => void;
  projectsLoading: boolean;
  projectsLoadFailed: boolean;
}

export function LiteComposer({ options, selectedProjectId, onProjectChange, projectsLoading, projectsLoadFailed }: LiteComposerProps) {
  const { t } = useLanguage();

  return (
    <div className="shrink-0 border-t border-[var(--border-color)] bg-[var(--bg-secondary)] p-2 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <label className="text-xs text-[var(--text-muted)] shrink-0">{t('lite.projectLabel')}</label>
        <select
          value={selectedProjectId ?? ''}
          onChange={(e) => onProjectChange(e.target.value)}
          disabled={projectsLoading || projectsLoadFailed}
          className="flex-1 text-xs bg-[var(--bg-primary)] border border-[var(--border-color)] rounded px-2 py-1 text-[var(--text-primary)] disabled:opacity-50"
        >
          <option value="" disabled>{t('lite.projectPlaceholder')}</option>
          {options.map((opt) => (
            <option key={opt.projectId} value={opt.projectId}>
              {opt.label}{opt.machineLabel ? ` — ${opt.machineLabel}` : ''}{opt.online ? '' : ` (${t('lite.offline')})`}
            </option>
          ))}
        </select>
      </div>
      {projectsLoadFailed && (
        <div className="text-[10px] text-[var(--text-faint)]">{t('lite.projectLoadFailed')}</div>
      )}
      <div className="flex items-center gap-2">
        <textarea
          disabled
          rows={2}
          placeholder={t('lite.composerPlaceholder')}
          className="flex-1 text-sm bg-[var(--bg-primary)] border border-[var(--border-color)] rounded px-2 py-1 text-[var(--text-primary)] resize-none disabled:opacity-50"
        />
        <button
          disabled
          className="text-sm px-3 py-1 rounded bg-[var(--bg-hover)] text-[var(--text-muted)] disabled:opacity-50 shrink-0"
        >
          {t('chat.send')}
        </button>
      </div>
    </div>
  );
}
