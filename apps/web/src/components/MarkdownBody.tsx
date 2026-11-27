import { memo, useEffect, useRef, useState } from 'react';
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

/**
 * 指定した文字列をクリップボードへコピーする。
 *
 * 通常は Clipboard API を使う。HTTP 接続などで API を使えないブラウザでも、
 * 従来方式へフォールバックしてコードブロックをコピーできるようにする。
 *
 * @param text コピーするコード全文
 * @returns コピーに成功したときは true、失敗時は false
 */
async function copyCodeToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Clipboard API が権限・接続方式で使えない場合は、下の互換方式を試す。
  }

  try {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.setAttribute('readonly', '');
    textArea.style.position = 'fixed';
    textArea.style.opacity = '0';
    document.body.appendChild(textArea);
    textArea.select();
    const copied = document.execCommand('copy');
    document.body.removeChild(textArea);
    return copied;
  } catch {
    return false;
  }
}

/**
 * コードフェンスを表示し、右上のボタンで全文をコピーできるようにする。
 * コピー成功時だけチェック印を一時表示し、失敗時に成功したようには見せない。
 *
 * @param code コードフェンスの本文
 * @returns コード表示とコピー操作の React 要素
 */
function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // 画面遷移後にタイマーが state を更新しないよう、破棄時に必ず解除する。
    return () => {
      if (resetTimerRef.current !== null) clearTimeout(resetTimerRef.current);
    };
  }, []);

  /** コードをコピーし、成功が確認できた場合だけ完了表示を出す。 */
  const handleCopy = async () => {
    if (!(await copyCodeToClipboard(code))) return;

    setCopied(true);
    if (resetTimerRef.current !== null) clearTimeout(resetTimerRef.current);
    resetTimerRef.current = setTimeout(() => {
      setCopied(false);
      resetTimerRef.current = null;
    }, 2000);
  };

  return (
    <pre className="relative bg-[var(--bg-base)] rounded p-3 pr-12 my-2 overflow-x-auto text-sm">
      <button
        type="button"
        onClick={handleCopy}
        className="absolute right-2 top-2 rounded p-1.5 text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-blue)]"
        aria-label={copied ? 'コードをコピーしました' : 'コードをコピー'}
        title={copied ? 'コピーしました' : 'コピー'}
      >
        {copied ? (
          <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="m5 12 4 4L19 6" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="9" y="9" width="11" height="11" rx="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        )}
      </button>
      <code>{code}</code>
    </pre>
  );
}

function renderBlock(block: MdBlock, index: number) {
  switch (block.kind) {
    case 'blank':
      return <div key={index} className="h-3" aria-hidden="true" />;
    case 'code':
      return <CodeBlock key={index} code={block.code} />;
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

function MarkdownBodyImpl({ text }: MarkdownBodyProps) {
  const blocks = tokenizeMarkdown(text);
  return <div>{blocks.map((block, index) => renderBlock(block, index))}</div>;
}

/**
 * 性能（2026-11-21）: 親（ChatPage 等）は入力 1 文字・進捗 1 秒ごとに再描画されるため、
 * text が同じなら Markdown の再トークナイズ・再描画をしない。
 */
export const MarkdownBody = memo(MarkdownBodyImpl);
