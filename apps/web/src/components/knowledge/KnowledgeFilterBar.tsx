import { useState } from 'react';
import { useLanguage } from '../../contexts/LanguageContext';
import type { KnowledgeKind, KnowledgeMode, KnowledgeScope, KnowledgeUrlState } from '../../lib/knowledge-search-rules';

/**
 * 高辻ナレッジ サイクル3（WebUI）: ナレッジ検索フォーム（指示書 §3.1 の 2）。
 * 完全に controlled。fetch は一切行わない（検索の実行は `onSubmit` 経由で親に委譲する）。
 *
 * `maxLevel` は自由入力の `<input>` ではなく `<select>`（any / 0〜10）にすることで、
 * `maxLevel=''` が `Number('')===0` に化けて静かに level 0 だけへ絞られる罠を
 * UI の構造そのもので塞ぐ（`knowledge-search-rules.ts` の `parseMaxLevel` と対になる設計）。
 */
export interface KnowledgeFilterBarProps {
  state: KnowledgeUrlState;
  qDraft: string;
  projects: Array<{ id: string; name: string }>;
  compartments: string[];
  /** 件数（10/20/30。URL には乗せない＝ページ内だけの表示設定）。 */
  limit: number;
  disabled: boolean;
  onQDraftChange: (v: string) => void;
  onSubmit: () => void;
  onPatch: (patch: Partial<KnowledgeUrlState>) => void;
  onLimitChange: (limit: number) => void;
  onReset: () => void;
}

const MODES: KnowledgeMode[] = ['hybrid', 'keyword', 'vector'];
const SCOPES: KnowledgeScope[] = ['all', 'mine'];
const KINDS: KnowledgeKind[] = ['all', 'instruction', 'question'];
const LEVEL_OPTIONS = Array.from({ length: 11 }, (_, i) => i);

const selectCls =
  'rounded border border-[var(--border-color)] bg-[var(--bg-base)] px-2 py-1 text-sm text-[var(--text-primary)]';

export function KnowledgeFilterBar({
  state,
  qDraft,
  projects,
  compartments,
  limit,
  disabled,
  onQDraftChange,
  onSubmit,
  onPatch,
  onLimitChange,
  onReset,
}: KnowledgeFilterBarProps) {
  const { t } = useLanguage();
  const [filtersOpen, setFiltersOpen] = useState(false);

  return (
    <div className="space-y-2">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
        className="flex gap-2"
      >
        <input
          type="text"
          value={qDraft}
          disabled={disabled}
          onChange={(e) => onQDraftChange(e.target.value)}
          placeholder={t('knowledge.searchPlaceholder')}
          className="flex-1 rounded border border-[var(--border-color)] bg-[var(--bg-base)] px-3 py-2 text-sm text-[var(--text-primary)]"
        />
        <button
          type="submit"
          disabled={disabled}
          className="px-4 py-2 bg-[var(--accent-blue)] text-white rounded text-sm font-medium disabled:opacity-50"
        >
          {t('knowledge.submit')}
        </button>
        <button
          type="button"
          onClick={() => setFiltersOpen((v) => !v)}
          className="px-3 py-2 text-xs border border-[var(--border-color)] rounded text-[var(--text-secondary)]"
        >
          {t('knowledge.filtersToggle')}
        </button>
      </form>

      {filtersOpen && (
        <div className="grid grid-cols-2 gap-3 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-3 md:grid-cols-4">
          <label className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
            {t('knowledge.modeLabel')}
            <select className={selectCls} value={state.mode} onChange={(e) => onPatch({ mode: e.target.value as KnowledgeMode })}>
              {MODES.map((m) => (
                <option key={m} value={m}>
                  {t(`knowledge.mode.${m}` as const)}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
            {t('knowledge.scopeLabel')}
            <select className={selectCls} value={state.scope} onChange={(e) => onPatch({ scope: e.target.value as KnowledgeScope })}>
              {SCOPES.map((s) => (
                <option key={s} value={s}>
                  {t(`knowledge.scope.${s}` as const)}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
            {t('knowledge.kindLabel')}
            <select className={selectCls} value={state.kind} onChange={(e) => onPatch({ kind: e.target.value as KnowledgeKind })}>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(`knowledge.kind.${k}` as const)}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
            {t('knowledge.projectLabel')}
            <select
              className={selectCls}
              value={state.projectId ?? ''}
              onChange={(e) => onPatch({ projectId: e.target.value === '' ? null : e.target.value })}
            >
              <option value="">{t('knowledge.project.all')}</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
            {t('knowledge.compartmentLabel')}
            <select
              className={selectCls}
              value={state.compartment ?? ''}
              onChange={(e) => onPatch({ compartment: e.target.value === '' ? null : e.target.value })}
            >
              <option value="">{t('knowledge.compartment.any')}</option>
              {compartments.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
            {t('knowledge.maxLevelLabel')}
            <select
              className={selectCls}
              value={state.maxLevel === null ? '' : String(state.maxLevel)}
              onChange={(e) => onPatch({ maxLevel: e.target.value === '' ? null : Number(e.target.value) })}
            >
              <option value="">{t('knowledge.maxLevel.any')}</option>
              {LEVEL_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
            {t('knowledge.sinceLabel')}
            <input
              type="date"
              className={selectCls}
              value={state.since ?? ''}
              onChange={(e) => onPatch({ since: e.target.value === '' ? null : e.target.value })}
            />
          </label>

          <label className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
            {t('knowledge.untilLabel')}
            <input
              type="date"
              className={selectCls}
              value={state.until ?? ''}
              onChange={(e) => onPatch({ until: e.target.value === '' ? null : e.target.value })}
            />
          </label>

          <label className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
            {t('knowledge.limitLabel')}
            <select className={selectCls} value={limit} onChange={(e) => onLimitChange(Number(e.target.value))}>
              {[10, 20, 30].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>

          <div className="col-span-2 flex items-end md:col-span-4">
            <button
              type="button"
              onClick={onReset}
              className="px-3 py-1.5 text-xs border border-[var(--border-color)] rounded text-[var(--text-secondary)]"
            >
              {t('knowledge.reset')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
