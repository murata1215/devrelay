/**
 * チャット本文（classic / Lite 共通）の Markdown トークナイザ。
 *
 * 外部 import ゼロ・DOM 非依存（`knowledge-answer-rules.ts` 等と同じ流儀。
 * `tsconfig.test.json` の `lib:["ES2022"]` には DOM が無いため、ここでは一切参照しない）。
 * React への変換は `components/MarkdownBody.tsx` が担当し、このファイルは
 * 文字列 → トークン配列の純関数のみを持つ。
 *
 * ## 斜体（`*text*` / `_text_`）は意図的に未対応
 * `*.ts` や `agents/*` のような glob や `foo_bar_baz` のようなスネークケース識別子を
 * 誤って装飾してしまう事故がほぼすべて斜体の誤爆に由来するため、実装しない。
 * `*` を見るのは `**bold**` の判定だけで、`**` が閉じていなければ素テキストのまま残る。
 * `_` は常に素のテキスト文字として扱う。将来必要になったら `MdInline` に `italic` を足して
 * `tokenizeInline()` に 1 ケース追加するだけで戻せる。
 *
 * ## 行ベースの単一パスにしている理由
 * サーバーは AI 本文の先頭に `📊 Rate Limit: …` 行を連結してから配信する
 * （`apps/server/src/services/agent-manager.ts` 参照）。GFM 標準パーサは「段落の直後に
 * 空行なしで続くテーブル」を認識しないため、ライブラリ的な厳密 GFM 実装だとこのケースで
 * 表が表示されない。行ベースで「区切り行が揃っていればその場でテーブル」と判定する
 * この実装ならその事故が起きない。
 *
 * ## setext 見出しは実装しない
 * `---` は常に水平線として扱う。直前行＋`---` を見出し化すると、AI が説明文の後によく
 * 置く区切り線が巨大な見出しに化ける事故になるため。
 */

export type MdBlock =
  | { kind: 'blank' }
  | { kind: 'code'; lang: string | null; code: string }
  | { kind: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; inline: MdInline[] }
  | {
      kind: 'table';
      header: MdInline[][];
      aligns: Array<'left' | 'center' | 'right' | null>;
      rows: MdInline[][][];
    }
  | { kind: 'list'; ordered: boolean; start: number; items: { indent: number; inline: MdInline[] }[] }
  | { kind: 'quote'; inline: MdInline[] }
  | { kind: 'hr' }
  | { kind: 'paragraph'; inline: MdInline[] };

// 斜体（italic）は意図的に含めない。上記ファイル冒頭コメント参照。
export type MdInline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'bold'; children: MdInline[] }
  | { kind: 'strike'; children: MdInline[] }
  | { kind: 'link'; href: string; children: MdInline[] };

// ============================================================
// インライン解析
// ============================================================

// 優先順位: コード → リンク → 太字 → 取り消し線。斜体（`*`/`_` 単独）は対象にしない。
// リンクの href 部分は「`(`/`)`/空白以外の文字」または「1 段までの `(...)` を 1 単位」の繰り返しとして
// 許容する（`https://en.wikipedia.org/wiki/Foo_(bar)` のような実在 URL の括弧に対応するため）。
const INLINE_PATTERN = /`([^`]+)`|\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)|\*\*([^*]+)\*\*|~~([^~]+)~~/g;

const ALLOWED_LINK_SCHEMES = new Set(['http', 'https', 'mailto']);

/**
 * リンク先スキームをチェックする。`http:`/`https:`/`mailto:` または相対パス（スキーム無し）
 * のみ許可し、`javascript:` 等は `null` を返す（呼び出し側はリンク化せず素テキストに落とす）。
 */
function sanitizeHref(href: string): string | null {
  const trimmed = href.trim();
  const schemeMatch = trimmed.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (!schemeMatch) return trimmed; // スキーム無し＝相対パスとして許可
  return ALLOWED_LINK_SCHEMES.has(schemeMatch[1].toLowerCase()) ? trimmed : null;
}

/**
 * 1 行分のインライン装飾（`` `code` ``・`[text](url)`・`**bold**`・`~~strike~~`）を
 * トークンに分割する。マッチしない部分は常に `{ kind: 'text' }` として残す（HTML タグも
 * 含め一切解釈せずテキストとして扱う＝実行されない）。閉じていない `**`/`~~` は素テキストのまま。
 *
 * この関数は再帰する（link/bold/strike の children を自分自身で再解析する）ため、
 * `exec` + モジュールレベルの共有 `RegExp.lastIndex` は使わない（再帰呼び出し中に
 * 親フレームの `lastIndex` を書き換えてしまい無限ループ/OOM を起こす）。
 * `matchAll` は呼び出しごとに正規表現の複製を作る（spec 上の挙動）ため再帰安全。
 */
export function tokenizeInline(text: string): MdInline[] {
  const segments: MdInline[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(INLINE_PATTERN)) {
    if (match.index > lastIndex) {
      segments.push({ kind: 'text', text: text.slice(lastIndex, match.index) });
    }
    if (match[1] !== undefined) {
      segments.push({ kind: 'code', text: match[1] });
    } else if (match[2] !== undefined && match[3] !== undefined) {
      const href = sanitizeHref(match[3]);
      if (href === null) {
        segments.push({ kind: 'text', text: match[0] });
      } else {
        segments.push({ kind: 'link', href, children: tokenizeInline(match[2]) });
      }
    } else if (match[4] !== undefined) {
      segments.push({ kind: 'bold', children: tokenizeInline(match[4]) });
    } else if (match[5] !== undefined) {
      segments.push({ kind: 'strike', children: tokenizeInline(match[5]) });
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    segments.push({ kind: 'text', text: text.slice(lastIndex) });
  }
  return segments.length > 0 ? segments : [{ kind: 'text', text }];
}

// ============================================================
// テーブル解析
// ============================================================

/**
 * テーブル行を `|` で分割する。先頭/末尾の `|` は省略可。`\|` エスケープはセル内の
 * 文字としてそのまま残す（分割対象にしない）。
 */
function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);

  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && s[i + 1] === '|') {
      current += '|';
      i++;
      continue;
    }
    if (ch === '|') {
      cells.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  cells.push(current);
  return cells;
}

/** `|---|:--:|---:|` のような区切り行かどうかを判定する。 */
function isTableSeparatorRow(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('-') || !trimmed.includes('|')) return false;
  const cells = splitTableRow(trimmed);
  if (cells.length === 0) return false;
  return cells.every((c) => /^:?-+:?$/.test(c.trim()));
}

function parseAlign(cell: string): 'left' | 'center' | 'right' | null {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return null;
}

/**
 * `lines[startIndex]` がテーブルのヘッダ行、`lines[startIndex + 1]` が区切り行として
 * 揃っている場合にのみテーブルブロックを組み立てる（区切り行必須＝誤検知防止の要）。
 * 揃っていなければ `null` を返し、呼び出し側は他のブロック種別として処理を続ける。
 */
function tryParseTable(
  lines: string[],
  startIndex: number,
): { block: MdBlock & { kind: 'table' }; nextIndex: number } | null {
  const headerLine = lines[startIndex];
  const sepLine = lines[startIndex + 1];
  if (sepLine === undefined || !isTableSeparatorRow(sepLine)) return null;

  const headerCells = splitTableRow(headerLine).map((c) => tokenizeInline(c.trim()));
  const rawAligns = splitTableRow(sepLine).map((c) => parseAlign(c.trim()));
  const aligns: Array<'left' | 'center' | 'right' | null> = headerCells.map((_, i) => rawAligns[i] ?? null);

  const rows: MdInline[][][] = [];
  let i = startIndex + 2;
  while (i < lines.length && lines[i].trim() !== '' && lines[i].includes('|')) {
    const rawCells = splitTableRow(lines[i]);
    // 列数がヘッダと違う行は不足を空セル・余剰を切り捨て
    const cells = headerCells.map((_, idx) => tokenizeInline((rawCells[idx] ?? '').trim()));
    rows.push(cells);
    i++;
  }

  return { block: { kind: 'table', header: headerCells, aligns, rows }, nextIndex: i };
}

// ============================================================
// ブロック解析
// ============================================================

const FENCE_OPEN = /^```\s*(\S*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const LIST_ITEM = /^(\s*)([-*+]|\d+\.)\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;
const HR = /^(?:-{3,}|\*{3,}|_{3,})\s*$/;

/**
 * Markdown テキストをブロックのトークン配列にする。
 * 行ベースの単一パス（先頭から順に走査し、各行を 1 つのブロック種別に確定させる）。
 * 連続する paragraph 行は 1 ブロックに結合しない（既存の `whitespace-pre-wrap` 相当の
 * 「改行がそのまま見える」挙動を維持し、AI 出力の段落内改行が勝手に詰まらないようにする）。
 */
export function tokenizeMarkdown(src: string): MdBlock[] {
  const lines = src.split('\n');
  const blocks: MdBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === '') {
      blocks.push({ kind: 'blank' });
      i++;
      continue;
    }

    const fenceMatch = line.match(FENCE_OPEN);
    if (fenceMatch) {
      const lang = fenceMatch[1] ? fenceMatch[1] : null;
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && lines[i].trim() !== '```') {
        codeLines.push(lines[i]);
        i++;
      }
      // ストリーミング中の未クローズフェンスも末尾までコードブロックとして扱う
      if (i < lines.length) i++; // 閉じフェンス行を読み飛ばす
      blocks.push({ kind: 'code', lang, code: codeLines.join('\n') });
      continue;
    }

    if (line.includes('|')) {
      const table = tryParseTable(lines, i);
      if (table) {
        blocks.push(table.block);
        i = table.nextIndex;
        continue;
      }
    }

    const headingMatch = line.match(HEADING);
    if (headingMatch) {
      const level = headingMatch[1].length as 1 | 2 | 3 | 4 | 5 | 6;
      blocks.push({ kind: 'heading', level, inline: tokenizeInline(headingMatch[2]) });
      i++;
      continue;
    }

    if (HR.test(line.trim())) {
      blocks.push({ kind: 'hr' });
      i++;
      continue;
    }

    const listMatch = line.match(LIST_ITEM);
    if (listMatch) {
      const ordered = /^\d+\.$/.test(listMatch[2]);
      const start = ordered ? parseInt(listMatch[2], 10) : 1;
      const items: { indent: number; inline: MdInline[] }[] = [];
      while (i < lines.length) {
        const m = lines[i].match(LIST_ITEM);
        if (!m) break;
        const isOrdered = /^\d+\.$/.test(m[2]);
        if (isOrdered !== ordered) break; // マーカー種別が変わったら別ブロックとして次の走査に委ねる
        const indent = Math.floor(m[1].length / 2);
        items.push({ indent, inline: tokenizeInline(m[3]) });
        i++;
      }
      blocks.push({ kind: 'list', ordered, start, items });
      continue;
    }

    const quoteMatch = line.match(QUOTE);
    if (quoteMatch) {
      blocks.push({ kind: 'quote', inline: tokenizeInline(quoteMatch[1]) });
      i++;
      continue;
    }

    blocks.push({ kind: 'paragraph', inline: tokenizeInline(line) });
    i++;
  }

  return blocks;
}
