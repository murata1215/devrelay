import { useState } from 'react';
import { useLanguage } from '../../contexts/LanguageContext';
import type { KnowledgeSearchResultItem } from '../../lib/api';
import { buildHighlightSegments, ownerLabel } from '../../lib/knowledge-search-rules';
import { LevelBadge } from './LevelBadge';
import { CompartmentChips } from './CompartmentChips';
import { ClassificationEditor } from './ClassificationEditor';
import type { ClassificationValue, ThreadClassification } from '../../lib/api';

/**
 * 高辻ナレッジ サイクル3（WebUI）: 検索結果 1 件のカード（指示書 §3.1 の 4）。
 * fetch は一切しない（純粋な表示＋クリックイベントの委譲）。本文はプレーン表示（`whitespace-pre-wrap`）、
 * markdown は描画しない（ChatPage の `renderMarkdown` は触らない方針）。
 */
export interface KnowledgeResultCardProps {
  result: KnowledgeSearchResultItem;
  query: string;
  isOpen: boolean;
  canEditClassification: boolean;
  onOpen: (sessionId: string, aiMessageId: string, occurredAt: string) => void;
  onClassificationSaved: (sessionId: string, after: ClassificationValue | ThreadClassification) => void;
}

export function KnowledgeResultCard({
  result,
  query,
  isOpen,
  canEditClassification,
  onOpen,
  onClassificationSaved,
}: KnowledgeResultCardProps) {
  const { t } = useLanguage();
  const [editing, setEditing] = useState(false);
  const owner = ownerLabel(result);
  const segments = buildHighlightSegments(result.snippet, query);

  return (
    <div
      className={`rounded-lg border p-3 ${
        isOpen ? 'border-[var(--accent-blue)] bg-[var(--bg-tertiary)]/30' : 'border-[var(--border-color)] bg-[var(--bg-secondary)]'
      }`}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)]">
        <span className="text-[var(--text-faint)]">#{result.rank}</span>
        <LevelBadge level={result.level} compact />
        {result.compartment && <CompartmentChips values={[result.compartment]} />}
        {result.matchedBy.map((m) => (
          <span key={m} className="rounded bg-[var(--bg-tertiary)] px-1.5 py-0.5 text-[10px] text-[var(--text-secondary)]">
            {t(m === 'keyword' ? 'knowledge.matchedBy.keyword' : 'knowledge.matchedBy.vector')}
          </span>
        ))}
        <span>{result.projectName}</span>
        <span>{result.aiTool}</span>
        <span>{new Date(result.occurredAt).toLocaleString()}</span>
        <span className="ml-auto">
          {owner.isOwn ? t('knowledge.own') : t('knowledge.ownerBy').replace('{name}', owner.text)}
        </span>
      </div>

      {result.threadTitle && (
        <p className="mt-1 text-sm font-medium text-[var(--text-primary)]">{result.threadTitle}</p>
      )}

      <p className="mt-1 whitespace-pre-wrap break-words text-sm text-[var(--text-secondary)]">
        {segments.map((s, i) =>
          s.match ? (
            <mark key={i} className="rounded bg-[var(--accent-blue)]/25 px-0.5 text-[var(--text-primary)]">
              {s.text}
            </mark>
          ) : (
            <span key={i}>{s.text}</span>
          )
        )}
      </p>

      <div className="mt-2 flex items-center justify-between text-xs">
        <span className="text-[var(--text-faint)]">
          {t('knowledge.chunkOf').replace('{i}', String(result.chunkIndex + 1)).replace('{n}', String(result.chunkCount))}
        </span>
        <div className="flex items-center gap-3">
          {canEditClassification && (
            <button
              type="button"
              onClick={() => setEditing((v) => !v)}
              className="text-[var(--text-link)] hover:underline"
            >
              {t('classification.title')}
            </button>
          )}
          <button
            type="button"
            onClick={() => onOpen(result.sessionId, result.aiMessageId, result.occurredAt)}
            className="text-[var(--text-link)] hover:underline"
          >
            {t('knowledge.openThread')}
          </button>
        </div>
      </div>

      {editing && (
        <div className="mt-2">
          <ClassificationEditor
            target={{ kind: 'thread', sessionId: result.sessionId }}
            canEdit={canEditClassification}
            onSaved={(after) => onClassificationSaved(result.sessionId, after)}
          />
        </div>
      )}
    </div>
  );
}
