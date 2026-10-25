// チャット本文 Markdown トークナイザ（apps/web/src/lib/markdown-rules.ts）の単体テスト。
// 外部 import ゼロの純関数をコンパイル済み dist-test から直接 import する
// （knowledge-answer-rules.test.mjs と同じ流儀）。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { tokenizeMarkdown, tokenizeInline } from '../dist-test/lib/markdown-rules.js';

/** ブロック配列からテキストだけを再構成する簡易ヘルパ（アサーション用）。 */
function inlineText(nodes) {
  return nodes
    .map((n) => {
      if (n.kind === 'text' || n.kind === 'code') return n.text;
      if (n.kind === 'bold' || n.kind === 'strike' || n.kind === 'link') return inlineText(n.children);
      return '';
    })
    .join('');
}

describe('tokenizeMarkdown: テーブル', () => {
  test('基本形（ヘッダ + 区切り行 + データ行）を認識する', () => {
    const blocks = tokenizeMarkdown('| a | b |\n|---|---|\n| 1 | 2 |');
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].kind, 'table');
    assert.equal(inlineText(blocks[0].header[0]), 'a');
    assert.equal(inlineText(blocks[0].header[1]), 'b');
    assert.equal(blocks[0].rows.length, 1);
    assert.equal(inlineText(blocks[0].rows[0][0]), '1');
    assert.equal(inlineText(blocks[0].rows[0][1]), '2');
  });

  test('先頭/末尾の | 省略に対応する', () => {
    const blocks = tokenizeMarkdown('a | b\n---|---\n1 | 2');
    assert.equal(blocks[0].kind, 'table');
    assert.equal(inlineText(blocks[0].header[0]), 'a');
    assert.equal(inlineText(blocks[0].header[1]), 'b');
  });

  test('アラインメント（left/center/right/未指定）を認識する', () => {
    const blocks = tokenizeMarkdown('| a | b | c | d |\n|---|:---|:---:|---:|\n| 1 | 2 | 3 | 4 |');
    assert.deepEqual(blocks[0].aligns, [null, 'left', 'center', 'right']);
  });

  test('列数がヘッダより少ない行は不足を空セルで埋める', () => {
    const blocks = tokenizeMarkdown('| a | b | c |\n|---|---|---|\n| 1 |');
    assert.equal(blocks[0].rows[0].length, 3);
    assert.equal(inlineText(blocks[0].rows[0][0]), '1');
    assert.equal(inlineText(blocks[0].rows[0][1]), '');
    assert.equal(inlineText(blocks[0].rows[0][2]), '');
  });

  test('列数がヘッダより多い行は余剰を切り捨てる', () => {
    const blocks = tokenizeMarkdown('| a |\n|---|\n| 1 | 2 | 3 |');
    assert.equal(blocks[0].rows[0].length, 1);
    assert.equal(inlineText(blocks[0].rows[0][0]), '1');
  });

  test('セル内の \\| エスケープを文字として保持する', () => {
    const blocks = tokenizeMarkdown('| a |\n|---|\n| x\\|y |');
    assert.equal(inlineText(blocks[0].rows[0][0]), 'x|y');
  });

  test('区切り行が無い | 入り行はテーブルにしない（誤検知防止）', () => {
    const blocks = tokenizeMarkdown('status: ok | pending | failed');
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].kind, 'paragraph');
  });

  test('📊 Rate Limit 行の直後（空行なし）に続くテーブルも認識する', () => {
    const blocks = tokenizeMarkdown('📊 Rate Limit: 5h: 0% | 7d: 0%\n| a | b |\n|---|---|\n| 1 | 2 |');
    assert.equal(blocks[0].kind, 'paragraph');
    assert.equal(blocks[1].kind, 'table');
  });
});

describe('tokenizeMarkdown: コードブロック', () => {
  test('言語指定ありのフェンスを認識し lang を保持する', () => {
    const blocks = tokenizeMarkdown('```ts\nconst x = 1;\n```');
    assert.equal(blocks[0].kind, 'code');
    assert.equal(blocks[0].lang, 'ts');
    assert.equal(blocks[0].code, 'const x = 1;');
  });

  test('未クローズのフェンス（ストリーミング途中）も末尾までコードブロックにする', () => {
    const blocks = tokenizeMarkdown('```ts\nconst x = 1;\nconst y = 2;');
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].kind, 'code');
    assert.equal(blocks[0].code, 'const x = 1;\nconst y = 2;');
  });

  test('コードブロック内の | や # は解釈しない', () => {
    const blocks = tokenizeMarkdown('```\n| a | b |\n# not a heading\n```');
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].kind, 'code');
    assert.equal(blocks[0].code, '| a | b |\n# not a heading');
  });
});

describe('tokenizeMarkdown: 見出し・リスト・引用・水平線', () => {
  test('見出し #〜###### を認識する', () => {
    const blocks = tokenizeMarkdown('# h1\n## h2\n###### h6');
    assert.equal(blocks[0].level, 1);
    assert.equal(blocks[1].level, 2);
    assert.equal(blocks[2].level, 6);
  });

  test('# の直後に空白が無い行は見出しにしない', () => {
    const blocks = tokenizeMarkdown('#123 issue');
    assert.equal(blocks[0].kind, 'paragraph');
  });

  test('番号なしリスト（- / * / +）を認識する', () => {
    const blocks = tokenizeMarkdown('- item1\n* item2\n+ item3');
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].kind, 'list');
    assert.equal(blocks[0].ordered, false);
    assert.equal(blocks[0].items.length, 3);
  });

  test('番号付きリストの start を保持する', () => {
    const blocks = tokenizeMarkdown('3. three\n4. four');
    assert.equal(blocks[0].kind, 'list');
    assert.equal(blocks[0].ordered, true);
    assert.equal(blocks[0].start, 3);
  });

  test('インデント（2 スペース単位）を認識する', () => {
    const blocks = tokenizeMarkdown('- top\n  - nested');
    assert.equal(blocks[0].items[0].indent, 0);
    assert.equal(blocks[0].items[1].indent, 1);
  });

  test('マーカー種別（番号つき/なし）が変わると別ブロックになる', () => {
    const blocks = tokenizeMarkdown('- a\n1. b');
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].ordered, false);
    assert.equal(blocks[1].ordered, true);
  });

  test('引用 > を認識する', () => {
    const blocks = tokenizeMarkdown('> quoted text');
    assert.equal(blocks[0].kind, 'quote');
    assert.equal(inlineText(blocks[0].inline), 'quoted text');
  });

  test('水平線（---/***/___）を認識する', () => {
    const blocks = tokenizeMarkdown('---\n***\n___');
    assert.equal(blocks[0].kind, 'hr');
    assert.equal(blocks[1].kind, 'hr');
    assert.equal(blocks[2].kind, 'hr');
  });

  test('--- は常に hr になり setext 見出しにならない', () => {
    const blocks = tokenizeMarkdown('説明文\n---\n続きの文');
    assert.equal(blocks[0].kind, 'paragraph');
    assert.equal(blocks[1].kind, 'hr');
    assert.equal(blocks[2].kind, 'paragraph');
  });
});

describe('tokenizeInline: コード・リンク・太字・取り消し線', () => {
  test('インラインコードの中身は一切解釈しない', () => {
    const nodes = tokenizeInline('`*.ts` と `**not bold**`');
    assert.equal(nodes[0].kind, 'code');
    assert.equal(nodes[0].text, '*.ts');
  });

  test('太字 **bold** を認識する', () => {
    const nodes = tokenizeInline('これは **重要** です');
    assert.ok(nodes.some((n) => n.kind === 'bold' && inlineText(n.children) === '重要'));
  });

  test('取り消し線 ~~strike~~ を認識する', () => {
    const nodes = tokenizeInline('これは ~~古い~~ 情報です');
    assert.ok(nodes.some((n) => n.kind === 'strike' && inlineText(n.children) === '古い'));
  });

  test('リンク [text](url) を認識する', () => {
    const nodes = tokenizeInline('[DevRelay](https://example.com/docs)');
    const link = nodes.find((n) => n.kind === 'link');
    assert.ok(link);
    assert.equal(link.href, 'https://example.com/docs');
    assert.equal(inlineText(link.children), 'DevRelay');
  });

  test('javascript: スキームはリンク化せず素テキストに落とす', () => {
    const nodes = tokenizeInline('[click](javascript:alert(1))');
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].kind, 'text');
    assert.equal(nodes[0].text, '[click](javascript:alert(1))');
  });

  test('相対パスのリンクは許可する', () => {
    const nodes = tokenizeInline('[here](/sites/foo)');
    const link = nodes.find((n) => n.kind === 'link');
    assert.ok(link);
    assert.equal(link.href, '/sites/foo');
  });

  test('URL 内の 1 段の括弧を href として正しく取り込む（Wikipedia 形式）', () => {
    const nodes = tokenizeInline('[Foo](https://en.wikipedia.org/wiki/Foo_(bar))');
    assert.equal(nodes.length, 1);
    const link = nodes[0];
    assert.equal(link.kind, 'link');
    assert.equal(link.href, 'https://en.wikipedia.org/wiki/Foo_(bar)');
  });

  test('** が閉じていない行は素テキストのまま', () => {
    const nodes = tokenizeInline('value ** 2 の指数');
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].kind, 'text');
    assert.equal(nodes[0].text, 'value ** 2 の指数');
  });
});

describe('斜体を解釈しないことの回帰テスト', () => {
  const fixtures = ['*.ts', 'agents/*', 'foo_bar_baz', 'DEVRELAY_AGENT_REPO_TOKEN', '__dirname'];

  for (const fixture of fixtures) {
    test(`"${fixture}" が素テキストのまま 1 トークンで出る`, () => {
      const nodes = tokenizeInline(fixture);
      assert.equal(nodes.length, 1);
      assert.equal(nodes[0].kind, 'text');
      assert.equal(nodes[0].text, fixture);
    });
  }

  test('ブロック解析を通しても glob やスネークケースが壊れない', () => {
    const blocks = tokenizeMarkdown('設定は *.ts を見る。env は foo_bar_baz。');
    assert.equal(blocks[0].kind, 'paragraph');
    assert.equal(inlineText(blocks[0].inline), '設定は *.ts を見る。env は foo_bar_baz。');
  });
});

describe('既存退行防止', () => {
  test('段落内の改行は 1 行 1 ブロックのまま保持される（結合しない）', () => {
    const blocks = tokenizeMarkdown('1行目\n2行目\n3行目');
    assert.equal(blocks.length, 3);
    assert.ok(blocks.every((b) => b.kind === 'paragraph'));
    assert.equal(inlineText(blocks[0].inline), '1行目');
    assert.equal(inlineText(blocks[1].inline), '2行目');
    assert.equal(inlineText(blocks[2].inline), '3行目');
  });

  test('空行は blank ブロックとして残る', () => {
    const blocks = tokenizeMarkdown('text1\n\ntext2');
    assert.equal(blocks.length, 3);
    assert.equal(blocks[1].kind, 'blank');
  });
});
