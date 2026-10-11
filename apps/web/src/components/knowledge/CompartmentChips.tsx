import { useId, useState, type KeyboardEvent } from 'react';
import { useLanguage } from '../../contexts/LanguageContext';
import {
  COMPARTMENT_WILDCARD,
  applyWildcardExclusivity,
  normalizeCompartmentList,
  parseCompartmentInput,
} from '../../lib/clearance-rules';

/**
 * 高辻ナレッジ サイクル3（WebUI）: 案件名（compartment）チップ。
 * 表示専用（`editable` 省略/false）と編集可能（`editable: true`）の 2 用途を持つ。
 */
interface DisplayProps {
  values: string[];
  editable?: false;
}

interface EditableProps {
  values: string[];
  editable: true;
  onChange: (next: string[]) => void;
  disabled?: boolean;
  /** `<datalist>` の候補（`GET /api/org/compartments` の結果）。 */
  suggestions?: string[];
}

export type CompartmentChipsProps = DisplayProps | EditableProps;

export function CompartmentChips(props: CompartmentChipsProps) {
  const { t } = useLanguage();
  const reactId = useId();
  const [draft, setDraft] = useState('');
  const normalized = normalizeCompartmentList(props.values);
  const hasWildcard = normalized.includes(COMPARTMENT_WILDCARD);

  if (!props.editable) {
    if (normalized.length === 0) return null;
    return (
      <span className="inline-flex flex-wrap gap-1">
        {normalized.map((c) => (
          <span
            key={c}
            className="inline-flex items-center rounded bg-[var(--bg-tertiary)] px-1.5 py-0.5 text-xs text-[var(--text-secondary)]"
          >
            {c === COMPARTMENT_WILDCARD ? t('clearance.wildcardLabel') : c}
          </span>
        ))}
      </span>
    );
  }

  const { onChange, disabled = false, suggestions = [] } = props;

  const commitDraft = () => {
    const parsed = parseCompartmentInput(draft);
    if (parsed.length > 0) {
      onChange(normalizeCompartmentList([...props.values, ...parsed]));
    }
    setDraft('');
  };

  const removeChip = (chip: string) => {
    onChange(props.values.filter((v) => v !== chip));
  };

  const toggleWildcard = (on: boolean) => {
    onChange(applyWildcardExclusivity(props.values, on));
  };

  const listId = `compartment-suggestions-${reactId}`;

  return (
    <div className="space-y-2">
      <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
        <input
          type="checkbox"
          checked={hasWildcard}
          disabled={disabled}
          onChange={(e) => toggleWildcard(e.target.checked)}
        />
        {t('clearance.wildcardLabel')}
      </label>
      <div className="flex flex-wrap items-center gap-1">
        {normalized
          .filter((c) => c !== COMPARTMENT_WILDCARD)
          .map((c) => (
            <span
              key={c}
              className="inline-flex items-center gap-1 rounded bg-[var(--bg-tertiary)] px-1.5 py-0.5 text-xs text-[var(--text-secondary)]"
            >
              {c}
              {!disabled && !hasWildcard && (
                <button
                  type="button"
                  onClick={() => removeChip(c)}
                  className="text-[var(--text-danger)] hover:opacity-80"
                  aria-label={`remove ${c}`}
                >
                  ×
                </button>
              )}
            </span>
          ))}
        {!disabled && !hasWildcard && (
          <input
            list={suggestions.length > 0 ? listId : undefined}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitDraft();
              }
            }}
            onBlur={commitDraft}
            placeholder={t('clearance.addCompartmentPlaceholder')}
            className="min-w-[8rem] flex-1 bg-transparent text-xs text-[var(--text-primary)] outline-none placeholder:text-[var(--text-faint)]"
          />
        )}
        {suggestions.length > 0 && (
          <datalist id={listId}>
            {suggestions.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        )}
      </div>
    </div>
  );
}
