import { tokenizeMarkdown, type MdBlock, type MdInline } from '../lib/markdown-rules';

/**
 * チャット本文（classic / Lite 共通）の Markdown レンダラ。
 *
 * `tokenizeMarkdown`（外部 import ゼロの純関数、`lib/markdown-rules.ts`）が返すトークンを
 * React 要素に変換するだけで、`dangerouslySetInnerHTML` は一切使わない（生 HTML はテキストとして
 * そのまま表示される＝実行されない）。`components/knowledge/AnswerMarkdown.tsx` と同じ構成
 * （純関数トークナイザ + 薄い React レンダラ層）。
 *
 * 斜体は意図的に未対応（`lib/markdown-rules.ts` 冒頭コメント参照）。
 */
export interface MarkdownBodyProps {
  text: string;
}

function InlineNodes({ nodes }: { nodes: MdInline[] }) {
  return (
    <>
      {nodes.map((node, index) => {
        switch (node.kind) {
          case 'code':
            return (
              <code key={index} className="rounded bg-[var(--bg-tertiary)] px-1 py-0.5 text-[0.85em]">
                {node.text}
              </code>
            );
          case 'bold':
            return (
              <strong key={index}>
                <InlineNodes nodes={node.children} />
              </strong>
            );
          case 'strike':
            return (
              <del key={index}>
                <InlineNodes nodes={node.children} />
              </del>
            );
          case 'link':
            return (
              <a
                key={index}
                href={node.href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[var(--text-link)] hover:underline"
              >
                <InlineNodes nodes={node.children} />
              </a>
            );
          case 'text':
          default:
            return <span key={index}>{node.text}</span>;
        }
      })}
    </>
  );
}

const HEADING_CLASS: Record<1 | 2 | 3 | 4 | 5 | 6, string> = {
  1: 'text-xl font-bold',
  2: 'text-lg font-bold',
  3: 'text-base font-semibold',
  4: 'text-sm font-semibold',
  5: 'text-sm font-semibold',
  6: 'text-sm font-semibold',
};

const ALIGN_CLASS: Record<'left' | 'center' | 'right', string> = {
  left: 'text-left',
  center: 'text-center',
  right: 'text-right',
};

function alignClass(align: 'left' | 'center' | 'right' | null): string {
  return ALIGN_CLASS[align ?? 'left'];
}

function renderBlock(block: MdBlock, index: number) {
  switch (block.kind) {
    case 'blank':
      return <div key={index} className="h-3" aria-hidden="true" />;
    case 'code':
      return (
        <pre key={index} className="bg-[var(--bg-base)] rounded p-3 my-2 overflow-x-auto text-sm">
          <code>{block.code}</code>
        </pre>
      );
    case 'heading':
      return (
        <div key={index} className={`mt-2 mb-1 ${HEADING_CLASS[block.level]}`}>
          <InlineNodes nodes={block.inline} />
        </div>
      );
    case 'hr':
      return <hr key={index} className="my-3 border-[var(--border-color)]" />;
    case 'quote':
      return (
        <div
          key={index}
          className="border-l-2 border-[var(--border-color)] pl-3 my-1 text-[var(--text-secondary)] whitespace-pre-wrap break-words"
        >
          <InlineNodes nodes={block.inline} />
        </div>
      );
    case 'list':
      return (
        <div key={index} className="my-1">
          {block.items.map((item, i) => (
            <div
              key={i}
              className="whitespace-pre-wrap break-words"
              style={{ marginLeft: `${item.indent * 1.25}em` }}
            >
              <span className="mr-1.5 text-[var(--text-muted)]">
                {block.ordered ? `${block.start + i}.` : '•'}
              </span>
              <InlineNodes nodes={item.inline} />
            </div>
          ))}
        </div>
      );
    case 'table':
      return (
        <div key={index} className="my-2 overflow-x-auto">
          <table className="min-w-full border-collapse text-sm">
            <thead>
              <tr>
                {block.header.map((cell, i) => (
                  <th
                    key={i}
                    className={`border border-[var(--border-color)] bg-[var(--bg-secondary)] px-2 py-1 font-semibold ${alignClass(block.aligns[i] ?? null)}`}
                  >
                    <InlineNodes nodes={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, ri) => (
                <tr key={ri}>
                  {row.map((cell, ci) => (
                    <td
                      key={ci}
                      className={`border border-[var(--border-color)] px-2 py-1 align-top ${alignClass(block.aligns[ci] ?? null)}`}
                    >
                      <InlineNodes nodes={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'paragraph':
    default:
      return (
        <div key={index} className="whitespace-pre-wrap break-words">
          <InlineNodes nodes={block.inline} />
        </div>
      );
  }
}

export function MarkdownBody({ text }: MarkdownBodyProps) {
  const blocks = tokenizeMarkdown(text);
  return <div>{blocks.map((block, index) => renderBlock(block, index))}</div>;
}
