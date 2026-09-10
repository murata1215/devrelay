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

// Lite シェル L2/L3: ソース静的走査テスト（node:fs で実ソースを読み、コンパイル成果物には依存しない）。
// 参照プラン `~/.claude/plans/quizzical-zooming-flute.md` :104-122 の WS 二重接続事故、
// F5（`useOrganization()` は `OrganizationProvider` の外で throw する）、
// および `~/.claude/plans/refactored-cooking-thunder.md`（L3: S1/S2/B2/B4）を機械的に固定する。

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, '..');

// F5 トリップワイヤ・生 WebSocket 禁止・namespace import 禁止は Lite 配下の全ファイルに適用する。
const LITE_SOURCE_FILES = [
  'src/pages/LitePage.tsx',
  'src/components/lite/LiteHeader.tsx',
  'src/components/lite/LiteComposer.tsx',
  'src/components/lite/LiteMessageList.tsx',
  'src/components/lite/LiteApprovalCard.tsx',
];

// L3: `useWebSocket` の呼び出し箇所は `LitePage.tsx` の 1 箇所に限定する（B2）。
// 子コンポーネント側がこれを迂回して独自に WS を張る経路が増えないことを固定する。
// `LiteApprovalCard.tsx` は `ToolApprovalPrompt` 型を `hooks/useWebSocket` から type-only import
// するため（値としての `useWebSocket` 束縛やフック呼び出しは含まない）、モジュールパス丸ごとの
// 禁止リストには含めず、下の describe で「フック呼び出し不在」のみを個別に検査する。
const WS_FORBIDDEN_CHILD_FILES = [
  'src/components/lite/LiteHeader.tsx',
  'src/components/lite/LiteComposer.tsx',
  'src/components/lite/LiteMessageList.tsx',
];

const LITE_PAGE_PATH = 'src/pages/LitePage.tsx';

function readLiteSource(relPath) {
  return readFileSync(path.join(webRoot, relPath), 'utf8');
}

describe('lite-source-guards: F5 トリップワイヤ / 生 WebSocket 禁止 / namespace import 禁止（L2+L3 全 Lite ファイル）', () => {
  for (const relPath of LITE_SOURCE_FILES) {
    test(`${relPath}: 恒久リスト（Layout / useOrganization）のヒットが 0（F5 トリップワイヤ）`, () => {
      const source = readLiteSource(relPath);
      const hits = findForbiddenLiteImports(source, FORBIDDEN_LITE_BINDINGS, FORBIDDEN_LITE_MODULES);
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

describe('lite-source-guards: useWebSocket 呼び出しは LitePage.tsx の 1 箇所に限定する（L3, B2）', () => {
  for (const relPath of WS_FORBIDDEN_CHILD_FILES) {
    test(`${relPath}: L2 リスト（useWebSocket / hooks/useWebSocket）のヒットが 0`, () => {
      const source = readLiteSource(relPath);
      const hits = findForbiddenLiteImports(source, L2_FORBIDDEN_LITE_BINDINGS, L2_FORBIDDEN_LITE_MODULES);
      assert.deepEqual(hits, []);
    });
  }

  test('LitePage.tsx: `useWebSocket(` の呼び出しがちょうど 1 箇所', () => {
    const source = readLiteSource(LITE_PAGE_PATH);
    const matches = source.match(/\buseWebSocket\s*\(/g) ?? [];
    assert.equal(matches.length, 1);
  });

  test('LitePage.tsx: `../../hooks/useWebSocket` からの import が存在する（L3 で正規に使用開始）', () => {
    const source = readLiteSource(LITE_PAGE_PATH);
    assert.match(source, /from\s+['"]\.\.\/hooks\/useWebSocket['"]/);
  });

  test('LiteApprovalCard.tsx: `ToolApprovalPrompt` 型は使うが `useWebSocket(` の呼び出しは無い（type-only import の確認）', () => {
    const source = readLiteSource('src/components/lite/LiteApprovalCard.tsx');
    assert.match(source, /from\s+['"].*hooks\/useWebSocket['"]/, 'ToolApprovalPrompt 型の import 元が見つからない');
    const matches = source.match(/\buseWebSocket\s*\(/g) ?? [];
    assert.equal(matches.length, 0, 'LiteApprovalCard.tsx が useWebSocket() を呼び出している');
  });
});

describe('lite-source-guards: LitePage.tsx が送信/承認操作の識別子を一切含まない（L3 では読み取りのみ。L4/L5 のスコープ外）', () => {
  test('sendCommand を含まない', () => {
    const source = readLiteSource(LITE_PAGE_PATH);
    assert.equal(source.includes('sendCommand'), false);
  });

  test("'web:command' を含まない", () => {
    const source = readLiteSource(LITE_PAGE_PATH);
    assert.equal(source.includes('web:command'), false);
  });

  test('sendToolApprovalResponse を含まない', () => {
    const source = readLiteSource(LITE_PAGE_PATH);
    assert.equal(source.includes('sendToolApprovalResponse'), false);
  });
});

describe('lite-source-guards: LitePage.tsx が localStorage/sessionStorage を直接参照しない（tabId はメモリ生成のみ）', () => {
  // メンバーアクセス（`localStorage.foo`）のみを検出する。JSDoc コメント中の「使わない」という
  // 説明文（バッククォート付き識別子への言及）を誤検出しないため、素の substring 判定は使わない。
  test('localStorage. への参照が無い', () => {
    const source = readLiteSource(LITE_PAGE_PATH);
    assert.equal(/\blocalStorage\s*\./.test(source), false);
  });

  test('sessionStorage. への参照が無い', () => {
    const source = readLiteSource(LITE_PAGE_PATH);
    assert.equal(/\bsessionStorage\s*\./.test(source), false);
  });
});

describe('lite-source-guards: LitePage.tsx の URL 状態管理 / スレッド参加登録（S1/S2 の回帰検知）', () => {
  test('useSearchParams を使用している', () => {
    const source = readLiteSource(LITE_PAGE_PATH);
    assert.match(source, /\buseSearchParams\b/);
  });

  test('sessionsApi.switchThread を呼び出している（S1）', () => {
    const source = readLiteSource(LITE_PAGE_PATH);
    assert.match(source, /sessionsApi\.switchThread\s*\(/);
  });
});

describe('lite-source-guards: tabId の唯一絶対規則（useWebSocket と switchThread に同一値を渡す）', () => {
  test('crypto.randomUUID() による tabId 代入はちょうど 1 箇所（複数生成による値の食い違いを防ぐ。JSDoc コメント中の言及は対象外）', () => {
    const source = readLiteSource(LITE_PAGE_PATH);
    const matches = source.match(/\.current\s*=\s*crypto\.randomUUID\(\)/g) ?? [];
    assert.equal(matches.length, 1);
  });

  test('useWebSocket の options には `{ tabId }`（同名変数）が渡されている', () => {
    const source = readLiteSource(LITE_PAGE_PATH);
    assert.match(source, /\{\s*tabId\s*\}/);
  });

  test('switchThread(selectedSessionId, tabId) が同一の tabId 変数で呼ばれている', () => {
    const source = readLiteSource(LITE_PAGE_PATH);
    assert.match(source, /switchThread\(\s*selectedSessionId\s*,\s*tabId\s*\)/);
  });
});

describe('lite-source-guards: ThreadList への readOnly 引き渡し（L3 で外す際の回帰検知）', () => {
  test('LitePage.tsx の <ThreadList 使用箇所に readOnly が含まれる', () => {
    const source = readLiteSource(LITE_PAGE_PATH);
    const match = source.match(/<ThreadList[\s\S]*?\/>/);
    assert.ok(match, '<ThreadList ... /> が見つからない');
    assert.match(match[0], /\breadOnly\b/);
  });
});

describe('lite-source-guards: A3（並び順）の防波堤 — ThreadList.tsx 側の再ソートが残っている', () => {
  test('ThreadList.tsx に sortThreadsDesc( の呼び出しが残っている', () => {
    const source = readFileSync(path.join(webRoot, 'src/components/ThreadList.tsx'), 'utf8');
    assert.match(source, /sortThreadsDesc\(/);
  });
});

describe('lite-source-guards: lite-message-log.ts のビルド設定回帰検知', () => {
  test('lite-message-log.ts の import 文が 0 件（外部 import ゼロの不変条件）', () => {
    const source = readFileSync(path.join(webRoot, 'src/lib/lite-message-log.ts'), 'utf8');
    const matches = source.match(/^import\s/gm) ?? [];
    assert.equal(matches.length, 0);
  });

  test('tsconfig.test.json の include に lite-message-log.ts が載っている（載せ忘れるとスイートごと無言 skip される）', () => {
    const tsconfigTest = JSON.parse(readFileSync(path.join(webRoot, 'tsconfig.test.json'), 'utf8'));
    assert.ok(
      tsconfigTest.include.some((p) => p.includes('lite-message-log.ts')),
      'tsconfig.test.json の include に src/lib/lite-message-log.ts が無い'
    );
  });
});
