// 高辻ナレッジ サイクル3（WebUI）: ソース静的ガード（node:fs で実ソースを読み、コンパイル成果物には
// 依存しない。lite-source-guards.test.mjs と同じ手口）。
//
// これが無いと、将来のリファクタで以下が黙って外れても気づけない:
// - 新規純ロジック 2 本（knowledge-search-rules.ts / clearance-rules.ts）に import が混入する
// - `tsconfig.test.json` の include 漏れで本サイクルのテストが静かに no-op になる
// - KnowledgePage / components/knowledge/* が ChatPage.tsx / LitePage.tsx / components/lite/* を
//   import してしまう（D2: 他人のスレッドを混ぜる危険、0 行変更の制約違反）
// - `setSearchParams` が KnowledgePage.tsx 以外から呼ばれる、または検索 fetch のコールバックから
//   URL を書く（LitePage で文書化済みの再検索ループの再発）
// - `maxLevel=`/`limit=` の手組みクエリ文字列が復活する（罠の再発）
// - ChatPage.tsx / LitePage.tsx が本サイクルの作業中に意図せず変更される（0 行変更の制約）

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { stripComments } from '../dist-test/components/lite/lite-shell-rules.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, '..');

function readSource(relPath) {
  return readFileSync(path.join(webRoot, relPath), 'utf8');
}

function countLines(relPath) {
  return readSource(relPath).split('\n').length;
}

const PURE_LOGIC_MODULES = ['src/lib/knowledge-search-rules.ts', 'src/lib/clearance-rules.ts'];

const KNOWLEDGE_COMPONENT_DIR = 'src/components/knowledge';
const KNOWLEDGE_COMPONENT_FILES = readdirSync(path.join(webRoot, KNOWLEDGE_COMPONENT_DIR))
  .filter((f) => f.endsWith('.tsx'))
  .map((f) => `${KNOWLEDGE_COMPONENT_DIR}/${f}`);

const KNOWLEDGE_PAGE_FILE = 'src/pages/KnowledgePage.tsx';
const KNOWLEDGE_SOURCE_FILES = [KNOWLEDGE_PAGE_FILE, ...KNOWLEDGE_COMPONENT_FILES];

// ---- 1) 純モジュールは import ゼロ、DOM/React 非依存 ----

describe('純ロジックモジュールは外部 import ゼロ（node:test から dist-test/ を直接 import する流儀）', () => {
  for (const relPath of PURE_LOGIC_MODULES) {
    test(`${relPath}: import 文が無い`, () => {
      const source = readSource(relPath);
      const importLines = source.match(/^import\s/gm) ?? [];
      assert.equal(importLines.length, 0, `${relPath} に import 文がある: ${importLines.join(', ')}`);
    });

    test(`${relPath}: DOM/React 参照が無い（tsconfig.test.json の lib:["ES2022"] には DOM が無い）`, () => {
      // コメント中で「"maxLevel=''" が…」のように罠を説明する地の文が誤検知しないよう、
      // コメント除去後のコード本体だけを対象にする（CJK 検査と同じ考え方）。
      const source = stripComments(readSource(relPath));
      for (const forbidden of ['URLSearchParams', 'window.', 'document.', 'useState', 'useEffect', "from 'react'"]) {
        assert.equal(source.includes(forbidden), false, `${relPath} に禁止参照 "${forbidden}" がある`);
      }
    });
  }
});

// ---- 2) tsconfig.test.json の include 漏れ防止 ----

describe('tsconfig.test.json: 新規純ロジック 2 本が include されている（漏れるとテストが静かに no-op になる）', () => {
  const tsconfig = JSON.parse(readSource('tsconfig.test.json'));
  for (const relPath of PURE_LOGIC_MODULES) {
    test(`include に ${relPath} が含まれる`, () => {
      assert.ok(tsconfig.include.includes(relPath), `tsconfig.test.json の include に ${relPath} が無い`);
    });
  }
});

// ---- 3) 分離: ChatPage / LitePage / components/lite / useWebSocket を import しない ----

describe('KnowledgePage / components/knowledge/*: ChatPage・LitePage・Lite シェル・useWebSocket から分離されている', () => {
  const FORBIDDEN_PATTERN = /ChatPage|LitePage|components\/lite|hooks\/useWebSocket/;
  for (const relPath of KNOWLEDGE_SOURCE_FILES) {
    test(`${relPath}: 禁止参照（ChatPage/LitePage/components/lite/useWebSocket）を import していない`, () => {
      const source = readSource(relPath);
      const importLines = source.match(/^import[^;]+;/gm) ?? [];
      for (const line of importLines) {
        assert.equal(FORBIDDEN_PATTERN.test(line), false, `${relPath} に禁止 import がある: ${line}`);
      }
    });
  }
});

// ---- 4) markdown 非描画・プレーン表示 ----

describe('ナレッジ画面は markdown を描画しない（ChatPage の renderMarkdown は切り出さない方針）', () => {
  for (const relPath of KNOWLEDGE_SOURCE_FILES) {
    test(`${relPath}: dangerouslySetInnerHTML / renderMarkdown を含まない`, () => {
      // 「ChatPage の renderMarkdown は切り出さない」という方針を説明する地の文（コメント）での
      // 言及は許容し、実コードでの使用だけを禁止する。
      const source = stripComments(readSource(relPath));
      assert.equal(source.includes('dangerouslySetInnerHTML'), false);
      assert.equal(source.includes('renderMarkdown'), false);
    });
  }

  test('KnowledgeResultCard.tsx は whitespace-pre-wrap でプレーン表示する', () => {
    assert.ok(readSource('src/components/knowledge/KnowledgeResultCard.tsx').includes('whitespace-pre-wrap'));
  });

  test('KnowledgeThreadViewer.tsx は whitespace-pre-wrap でプレーン表示する', () => {
    assert.ok(readSource('src/components/knowledge/KnowledgeThreadViewer.tsx').includes('whitespace-pre-wrap'));
  });
});

// ---- 5) URL 書き込みの一意性（再検索ループ防止） ----

describe('setSearchParams はKnowledgePage.tsx の apply() にのみ存在する（再検索ループ防止）', () => {
  test('KnowledgePage.tsx 内の setSearchParams(呼び出しは 1 回だけ', () => {
    const source = readSource(KNOWLEDGE_PAGE_FILE);
    const matches = source.match(/\bsetSearchParams\s*\(/g) ?? [];
    assert.equal(matches.length, 1, `setSearchParams( の出現数が想定外: ${matches.length}`);
  });

  for (const relPath of KNOWLEDGE_COMPONENT_FILES) {
    test(`${relPath}: setSearchParams を呼んでいない`, () => {
      const source = readSource(relPath);
      assert.equal(/\bsetSearchParams\s*\(/.test(source), false, `${relPath} が setSearchParams を呼んでいる`);
    });
  }

  test('検索 fetch の useEffect 本体（searchQueryKey に依存するブロック）は setSearchParams を呼ばない', () => {
    const source = readSource(KNOWLEDGE_PAGE_FILE);
    const match = source.match(/useEffect\(\(\) => \{[\s\S]*?knowledgeApi\s*\n?\s*\.search[\s\S]*?\}, \[searchQueryKey\]\);/);
    assert.ok(match, '検索 useEffect ブロックが見つからない（refactor で形が変わった可能性）');
    assert.equal(match[0].includes('setSearchParams'), false, '検索 useEffect 内で setSearchParams を呼んでいる（再検索ループの危険）');
  });
});

// ---- 6) ポーリング禁止 ----

describe('ナレッジ画面はポーリングしない（スレッドのページングはユーザー操作起点のみ）', () => {
  for (const relPath of KNOWLEDGE_SOURCE_FILES) {
    test(`${relPath}: setInterval を使っていない`, () => {
      const source = readSource(relPath);
      assert.equal((source.match(/\bsetInterval\s*\(/g) ?? []).length, 0);
    });
  }
});

// ---- 7) クエリ文字列の手組み禁止（maxLevel/limit の罠は純関数経由のみ） ----

describe('検索クエリの組み立ては純関数（buildKnowledgeSearchQuery）経由のみ（罠の再発防止）', () => {
  test('KnowledgePage.tsx は buildKnowledgeSearchQuery を使っている', () => {
    assert.ok(readSource(KNOWLEDGE_PAGE_FILE).includes('buildKnowledgeSearchQuery('));
  });

  for (const relPath of KNOWLEDGE_SOURCE_FILES) {
    test(`${relPath}: "maxLevel=" / "limit=" を手組みしていない`, () => {
      // コメント中で罠（`maxLevel=''` 等）を説明する地の文はコード断片の引用であって手組みではない
      // ため、コメント除去後のコード本体だけを対象にする。
      const source = stripComments(readSource(relPath));
      assert.equal(source.includes("'maxLevel='"), false);
      assert.equal(source.includes('`maxLevel='), false);
      assert.equal(source.includes("'limit='"), false);
      assert.equal(source.includes('`limit='), false);
    });
  }
});

// ---- 8) ハードコード CJK 禁止（i18n 必須） ----

describe('ナレッジ画面の新規文字列はハードコード日本語ゼロ（i18n/messages.ts の t() 経由）', () => {
  for (const relPath of KNOWLEDGE_SOURCE_FILES) {
    test(`${relPath}: コメント除去後に日本語（CJK）を含まない`, () => {
      const stripped = stripComments(readSource(relPath));
      const match = stripped.match(/[぀-ヿ一-鿿]+/);
      assert.equal(match, null, `${relPath} にハードコード CJK がある: ${match?.[0]}`);
    });
  }
});

// ---- 9) ChatPage.tsx / LitePage.tsx 無変更トリップワイヤ ----
//
// サイクル3.5 で ChatPage / Lite シェルへの機密度表示に着手する際は、このブロックの期待値
// （行数・renderMarkdown 出現数）を実測して更新すること（sha256 ではなく行数＋出現数にしているのは、
// 失敗時に「何が変わったか」をメッセージで名指しできるようにするため。等行数の改変に対する弱さは
// 既存 lite-source-guards.test.mjs の出現数ピン（setSearchParams=4 等）と合わせて補完する）。

describe('ChatPage.tsx / LitePage.tsx は本サイクルで無変更（プラン制約。0 行変更）', () => {
  test('ChatPage.tsx の行数が変わっていない', () => {
    // `split('\n').length` は末尾改行がある場合 `wc -l` より 1 大きくなる（3817 行 + 末尾改行 → 3818）。
    assert.equal(countLines('src/pages/ChatPage.tsx'), 3818, 'ChatPage.tsx の行数が変わっている。本サイクルは 0 行変更の制約');
  });

  test('LitePage.tsx の行数が変わっていない', () => {
    assert.equal(countLines('src/pages/LitePage.tsx'), 682, 'LitePage.tsx の行数が変わっている。本サイクルは 0 行変更の制約');
  });

  test('ChatPage.tsx 内の renderMarkdown 出現数が変わっていない', () => {
    const source = readSource('src/pages/ChatPage.tsx');
    const matches = source.match(/renderMarkdown/g) ?? [];
    assert.equal(matches.length, 3, 'ChatPage.tsx の renderMarkdown 出現数が変わっている');
  });

  test('components/lite/* は本サイクルで新規追加されていない（既存 5 ファイルのまま）', () => {
    const files = readdirSync(path.join(webRoot, 'src/components/lite')).filter((f) => f.endsWith('.tsx') || f.endsWith('.ts'));
    assert.equal(files.length, 5, `components/lite/ 配下のファイル数が想定外: ${files.join(', ')}`);
  });
});
