import { useEffect, useState } from 'react';
import { useLanguage } from '../../contexts/LanguageContext';
import { clearance as clearanceApi, type ClassificationValue, type ThreadClassification } from '../../lib/api';
import {
  buildClassificationPatch,
  isClassificationDirty,
  toClassificationDraft,
  type ClassificationDraft,
  CLEARANCE_LEVEL_MIN,
  CLEARANCE_LEVEL_MAX,
} from '../../lib/clearance-rules';

/**
 * 高辻ナレッジ サイクル3（WebUI）: 案件 / スレッドの機密度エディタ（指示書 §3.4 / §5）。
 * 対象（project | thread）ごとに自前で GET/PUT する。
 *
 * 権限エラーはサーバーが 403 ではなく 400 で返し、かつ `lib/api.ts` の `request()` が
 * ステータスを捨てるため、本コンポーネントは**常にサーバーの文言をそのまま表示**し、
 * ステータスコードで分岐しない（プラン §1 のズレ吸収方針）。
 */
export type ClassificationTarget = { kind: 'project'; projectId: string } | { kind: 'thread'; sessionId: string };

export interface ClassificationEditorProps {
  target: ClassificationTarget;
  canEdit: boolean;
  /** 案件既定値（継承時の表示に使う）。thread 対象のときだけ意味がある（effectiveLevel から引ける）。 */
  onSaved?: (after: ClassificationValue | ThreadClassification) => void;
}

export function ClassificationEditor({ target, canEdit, onSaved }: ClassificationEditorProps) {
  const { t } = useLanguage();
  const [loaded, setLoaded] = useState<ClassificationValue | ThreadClassification | null>(null);
  const [draft, setDraft] = useState<ClassificationDraft>({ level: '', compartment: '' });
  const [compartmentSuggestions, setCompartmentSuggestions] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; isError: boolean } | null>(null);

  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const data =
          target.kind === 'project'
            ? await clearanceApi.getProjectClassification(target.projectId)
            : await clearanceApi.getThreadClassification(target.sessionId);
        if (dead) return;
        setLoaded(data);
        setDraft(toClassificationDraft(data));
      } catch (e) {
        if (!dead) setMsg({ text: e instanceof Error ? e.message : String(e), isError: true });
      }
    })();
    // 案件名候補（組織なしは 404 になるので無視して候補なしに留める）
    (async () => {
      try {
        const res = await clearanceApi.compartments();
        if (!dead) setCompartmentSuggestions(res.compartments);
      } catch {
        // 組織なし等。候補なしのまま自由入力を許す。
      }
    })();
    return () => {
      dead = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.kind, target.kind === 'project' ? target.projectId : target.sessionId]);

  if (!loaded) {
    return msg ? <p className="text-xs text-[var(--text-danger)]">{msg.text}</p> : null;
  }

  const dirty = isClassificationDirty(loaded, draft);
  const effectiveLevel = 'effectiveLevel' in loaded ? loaded.effectiveLevel : loaded.level ?? 0;

  const handleSave = async () => {
    const result = buildClassificationPatch(loaded, draft);
    if (!result.ok) {
      setMsg({ text: t('classification.saveFailed'), isError: true });
      return;
    }
    if (Object.keys(result.patch).length === 0) return;
    setBusy(true);
    setMsg(null);
    try {
      const res =
        target.kind === 'project'
          ? await clearanceApi.setProjectClassification(target.projectId, result.patch)
          : await clearanceApi.setThreadClassification(target.sessionId, result.patch);
      setLoaded(res.after);
      setDraft(toClassificationDraft(res.after));
      setMsg({ text: t('classification.saved'), isError: false });
      onSaved?.(res.after);
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : t('classification.saveFailed'), isError: true });
    } finally {
      setBusy(false);
    }
  };

  const levelOptions = Array.from({ length: CLEARANCE_LEVEL_MAX - CLEARANCE_LEVEL_MIN + 1 }, (_, i) => i);
  const listId = `classification-compartment-suggestions-${target.kind}`;

  return (
    <div className="space-y-2 rounded border border-[var(--border-color)] bg-[var(--bg-base)]/40 p-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
          {t('classification.levelLabel')}
          <select
            value={draft.level}
            disabled={!canEdit || busy}
            onChange={(e) => setDraft((d) => ({ ...d, level: e.target.value }))}
            className="rounded border border-[var(--border-color)] bg-[var(--bg-base)] px-2 py-1 text-sm text-[var(--text-primary)]"
          >
            <option value="">{t('classification.levelInheritOption').replace('{n}', String(effectiveLevel))}</option>
            {levelOptions.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-1 flex-col gap-1 text-xs text-[var(--text-secondary)]">
          {t('classification.compartmentLabel')}
          <input
            list={compartmentSuggestions.length > 0 ? listId : undefined}
            value={draft.compartment}
            disabled={!canEdit || busy}
            onChange={(e) => setDraft((d) => ({ ...d, compartment: e.target.value }))}
            placeholder={t('classification.compartmentPlaceholder')}
            className="rounded border border-[var(--border-color)] bg-[var(--bg-base)] px-2 py-1 text-sm text-[var(--text-primary)]"
          />
          {compartmentSuggestions.length > 0 && (
            <datalist id={listId}>
              {compartmentSuggestions.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          )}
        </label>
        {canEdit && (
          <button
            type="button"
            onClick={handleSave}
            disabled={busy || !dirty}
            className="px-3 py-1.5 bg-[var(--accent-blue)] text-white rounded text-sm font-medium disabled:opacity-50"
          >
            {t('classification.save')}
          </button>
        )}
      </div>
      {!canEdit && <p className="text-xs text-[var(--text-faint)]">{t('classification.readOnlyHint')}</p>}
      {msg && (
        <p className={`text-xs ${msg.isError ? 'text-[var(--text-danger)]' : 'text-[var(--text-success)]'}`}>{msg.text}</p>
      )}
    </div>
  );
}
