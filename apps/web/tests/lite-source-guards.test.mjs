import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  FORBIDDEN_LITE_BINDINGS,
  FORBIDDEN_LITE_MODULES,
  L2_FORBIDDEN_LITE_BINDINGS,
  L2_FORBIDDEN_LITE_MODULES,
  findForbiddenLiteImports,
  containsNamespaceImport,
  containsRawWebSocketConstruction,
} from '../dist-test/components/lite/lite-shell-rules.js';

// Lite シェル L2: ソース静的走査テスト（node:fs で実ソースを読み、コンパイル成果物には依存しない）。
// 参照プラン `~/.claude/plans/quizzical-zooming-flute.md` :104-122 の WS 二重接続事故と、
// F5（`useOrganization()` は `OrganizationProvider` の外で throw する）を機械的に固定する。

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, '..');

const LITE_SOURCE_FILES = [
  'src/pages/LitePage.tsx',
  'src/components/lite/LiteHeader.tsx',
  'src/components/lite/LiteComposer.tsx',
];

function readLiteSource(relPath) {
  return readFileSync(path.join(webRoot, relPath), 'utf8');
}

describe('lite-source-guards: LitePage / components/lite/*.tsx が WS を生成・接続しない（L2）', () => {
  for (const relPath of LITE_SOURCE_FILES) {
    test(`${relPath}: 恒久リスト（Layout / useOrganization）のヒットが 0（F5 トリップワイヤ）`, () => {
      const source = readLiteSource(relPath);
      const hits = findForbiddenLiteImports(source, FORBIDDEN_LITE_BINDINGS, FORBIDDEN_LITE_MODULES);
      assert.deepEqual(hits, []);
    });

    test(`${relPath}: L2 リスト（useWebSocket / hooks/useWebSocket）のヒットが 0`, () => {
      const source = readLiteSource(relPath);
      const hits = findForbiddenLiteImports(source, L2_FORBIDDEN_LITE_BINDINGS, L2_FORBIDDEN_LITE_MODULES);
      assert.deepEqual(hits, []);
    });

    test(`${relPath}: "new WebSocket" の文字列が現れない`, () => {
      const source = readLiteSource(relPath);
      assert.equal(containsRawWebSocketConstruction(source), false);
    });

    test(`${relPath}: namespace import（import * as）が現れない`, () => {
      const source = readLiteSource(relPath);
      assert.equal(containsNamespaceImport(source), false);
    });
  }
});

describe('lite-source-guards: ThreadList への readOnly 引き渡し（L3 で外す際の回帰検知）', () => {
  test('LitePage.tsx の <ThreadList 使用箇所に readOnly が含まれる', () => {
    const source = readLiteSource('src/pages/LitePage.tsx');
    const match = source.match(/<ThreadList[\s\S]*?\/>/);
    assert.ok(match, '<ThreadList ... /> が見つからない');
    assert.match(match[0], /\breadOnly\b/);
  });
});
