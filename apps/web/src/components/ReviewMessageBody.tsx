import { MarkdownBody } from './MarkdownBody';

const REVIEW_PREFIX = '[review] ';
const DETAIL_MARKER = '<!-- devrelay:detail -->';

/** レビュー再考の保存メッセージだけを折りたたむ。AI 回答の detail 契約には作用しない。 */
export function ReviewMessageBody({ text }: { text: string }) {
  if (!text.startsWith(REVIEW_PREFIX)) return <MarkdownBody text={text} />;
  const markerAt = text.indexOf(DETAIL_MARKER);
  if (markerAt < 0) return <MarkdownBody text={text} />;
  const heading = text.slice(0, markerAt).trim();
  const detail = text.slice(markerAt + DETAIL_MARKER.length).trim();
  return (
    <>
      <MarkdownBody text={heading} />
      {detail && (
        <details className="mt-2 rounded border border-[var(--border-color)] px-3 py-2">
          <summary className="cursor-pointer text-xs text-[var(--text-muted)]">レビュー全文を表示</summary>
          <div className="mt-2">
            <MarkdownBody text={detail} />
          </div>
        </details>
      )}
    </>
  );
}
