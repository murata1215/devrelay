import { tokenizeAnswerMarkdown, type AnswerInlineSegment } from '../../lib/knowledge-answer-rules';

/**
 * 高辻ナレッジ サイクル4: ナレッジ回答本文の最小安全レンダラ（D11）。
 *
 * `tokenizeAnswerMarkdown`（外部 import ゼロの純関数）が返すトークンを React 要素に変換するだけで、
 * `dangerouslySetInnerHTML` は一切使わない（生 HTML はテキストとしてそのまま表示される＝実行されない）。
 * カード/ビューア（`KnowledgeResultCard.tsx` / `KnowledgeThreadViewer.tsx`）は本サイクルでも
 * プレーン表示のまま変更しない — markdown 装飾を描画するのはこのファイルと
 * `KnowledgeAnswerPanel.tsx` の回答パネルに限定する。
 */
export interface AnswerMarkdownProps {
  text: string;
  /** [n] クリック時のコールバック（カードへのスクロール or ビューア遷移は呼び出し側に委ねる）。 */
  onCitationClick: (rank: number) => void;
}

function InlineSegments({
  segments,
  onCitationClick,
}: {
  segments: AnswerInlineSegment[];
  onCitationClick: (rank: number) => void;
}) {
  return (
    <>
      {segments.map((segment, index) => {
        switch (segment.kind) {
          case 'bold':
            return <strong key={index}>{segment.text}</strong>;
          case 'code':
            return (
              <code key={index} className="rounded bg-[var(--bg-tertiary)] px-1 py-0.5 text-[0.85em]">
                {segment.text}
              </code>
            );
          case 'citation':
            return (
              <button
                key={index}
                type="button"
                onClick={() => onCitationClick(segment.rank)}
                className="mx-0.5 rounded bg-[var(--accent-blue)]/20 px-1 text-[0.85em] font-medium text-[var(--text-link)] hover:underline"
              >
                [{segment.rank}]
              </button>
            );
          case 'text':
          default:
            return <span key={index}>{segment.text}</span>;
        }
      })}
    </>
  );
}

export function AnswerMarkdown({ text, onCitationClick }: AnswerMarkdownProps) {
  const blocks = tokenizeAnswerMarkdown(text);

  return (
    <div className="space-y-1 text-sm text-[var(--text-primary)]">
      {blocks.map((block, index) => {
        if (block.kind === 'blank') {
          return <div key={index} className="h-2" aria-hidden="true" />;
        }
        if (block.kind === 'heading') {
          return (
            <p key={index} className="mt-2 font-semibold text-[var(--text-primary)]">
              <InlineSegments segments={block.segments} onCitationClick={onCitationClick} />
            </p>
          );
        }
        if (block.kind === 'bullet') {
          return (
            <p key={index} className="ml-4 whitespace-pre-wrap break-words before:mr-1.5 before:content-['•']">
              <InlineSegments segments={block.segments} onCitationClick={onCitationClick} />
            </p>
          );
        }
        return (
          <p key={index} className="whitespace-pre-wrap break-words">
            <InlineSegments segments={block.segments} onCitationClick={onCitationClick} />
          </p>
        );
      })}
    </div>
  );
}
