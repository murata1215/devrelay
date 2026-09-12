import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  clampWidth,
  readWidth,
  computeResizeWidth,
  THREAD_PANE_WIDTH_STORAGE_KEY,
  THREAD_PANE_WIDTH_DEFAULT,
  THREAD_PANE_WIDTH_MIN,
  THREAD_PANE_WIDTH_MAX,
  resolveThreadPaneShellClass,
  resolveResizeHandleClass,
  RESIZE_OVERLAY_CLASS,
} from '../dist-test/lib/panel-resize-rules.js';
import { RAIL_WIDTH_MIN, RAIL_WIDTH_MAX, RAIL_WIDTH_DEFAULT } from '../dist-test/lib/right-rail-rules.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, '..');
const readSrc = (relPath) => readFileSync(path.join(webRoot, relPath), 'utf8');

// ---------------------------------------------------------------------------
// ユニットテスト
// ---------------------------------------------------------------------------

describe('clampWidth', () => {
  test('範囲内の値はそのまま', () => {
    assert.equal(clampWidth(300, 200, 480), 300);
  });
  test('下限未満は下限に丸める', () => {
    assert.equal(clampWidth(50, 200, 480), 200);
  });
  test('上限超過は上限に丸める', () => {
    assert.equal(clampWidth(999, 200, 480), 480);
  });
  test('境界値ちょうどはそのまま', () => {
    assert.equal(clampWidth(200, 200, 480), 200);
    assert.equal(clampWidth(480, 200, 480), 480);
  });
});

describe('readWidth', () => {
  const args = { min: THREAD_PANE_WIDTH_MIN, max: THREAD_PANE_WIDTH_MAX, fallback: THREAD_PANE_WIDTH_DEFAULT };
  test('null（未保存）は fallback（clamp しない）', () => {
    assert.equal(readWidth(null, args), THREAD_PANE_WIDTH_DEFAULT);
  });
  test('数値変換不能（NaN）は fallback', () => {
    assert.equal(readWidth('abc', args), THREAD_PANE_WIDTH_DEFAULT);
  });
  test('空文字は Number("")===0 のため min にクランプされる（fallback ではない）', () => {
    assert.equal(readWidth('', args), THREAD_PANE_WIDTH_MIN);
  });
  test('上限超過の文字列は max にクランプされる', () => {
    assert.equal(readWidth('9999', args), THREAD_PANE_WIDTH_MAX);
  });
  test('範囲内の正常値はそのまま', () => {
    assert.equal(readWidth('300', args), 300);
  });
});

describe('computeResizeWidth', () => {
  test('edge:left は startX - clientX（右レール: 左にドラッグ = 拡大）', () => {
    const width = computeResizeWidth({ startWidth: 208, startX: 500, clientX: 480, edge: 'left', min: 160, max: 600 });
    assert.equal(width, 228);
  });
  test('edge:right は clientX - startX（スレッド一覧: 右にドラッグ = 拡大）', () => {
    const width = computeResizeWidth({ startWidth: 224, startX: 500, clientX: 520, edge: 'right', min: 200, max: 480 });
    assert.equal(width, 244);
  });
  test('left と right は同じ clientX 移動量に対して符号が逆', () => {
    const left = computeResizeWidth({ startWidth: 300, startX: 500, clientX: 520, edge: 'left', min: 0, max: 1000 });
    const right = computeResizeWidth({ startWidth: 300, startX: 500, clientX: 520, edge: 'right', min: 0, max: 1000 });
    assert.equal(left, 280);
    assert.equal(right, 320);
  });
  test('clientX === startX で幅は不変', () => {
    assert.equal(computeResizeWidth({ startWidth: 300, startX: 500, clientX: 500, edge: 'left', min: 0, max: 1000 }), 300);
    assert.equal(computeResizeWidth({ startWidth: 300, startX: 500, clientX: 500, edge: 'right', min: 0, max: 1000 }), 300);
  });
  test('結果は常に clamp される', () => {
    assert.equal(computeResizeWidth({ startWidth: 208, startX: 500, clientX: 0, edge: 'left', min: 160, max: 600 }), 600);
    assert.equal(computeResizeWidth({ startWidth: 208, startX: 0, clientX: 500, edge: 'left', min: 160, max: 600 }), 160);
  });

  test('等価性証明: edge:left は旧 clampRailWidth(startWidth + (startX - clientX)) と一致する（RightRail 載せ替えの挙動不変証明）', () => {
    const legacyClamp = (w) => Math.min(RAIL_WIDTH_MAX, Math.max(RAIL_WIDTH_MIN, w));
    const cases = [
      { startWidth: RAIL_WIDTH_DEFAULT, startX: 500, clientX: 480 },
      { startWidth: RAIL_WIDTH_DEFAULT, startX: 500, clientX: 520 },
      { startWidth: RAIL_WIDTH_MIN, startX: 300, clientX: 100 },
      { startWidth: RAIL_WIDTH_MAX, startX: 300, clientX: 700 },
      { startWidth: 300, startX: 500, clientX: 500 },
    ];
    for (const c of cases) {
      const legacy = legacyClamp(c.startWidth + (c.startX - c.clientX));
      const next = computeResizeWidth({ ...c, edge: 'left', min: RAIL_WIDTH_MIN, max: RAIL_WIDTH_MAX });
      assert.equal(next, legacy, `mismatch for ${JSON.stringify(c)}`);
    }
  });
});

describe('定数（スレッド一覧ペイン）', () => {
  test('THREAD_PANE_WIDTH_STORAGE_KEY は devrelay-thread-list-width', () => {
    assert.equal(THREAD_PANE_WIDTH_STORAGE_KEY, 'devrelay-thread-list-width');
  });
  test('THREAD_PANE_WIDTH_DEFAULT は 224（= 14rem = 旧 ThreadList.tsx の w-56 と同値。初回表示が現行と同一である根拠）', () => {
    assert.equal(THREAD_PANE_WIDTH_DEFAULT, 224);
  });
  test('THREAD_PANE_WIDTH_MIN/MAX は 200/480', () => {
    assert.equal(THREAD_PANE_WIDTH_MIN, 200);
    assert.equal(THREAD_PANE_WIDTH_MAX, 480);
  });
});

describe('クラス文字列ヘルパー', () => {
  test('resolveThreadPaneShellClass は relative/flex/shrink-0/thread-pane を含む', () => {
    const cls = resolveThreadPaneShellClass();
    assert.ok(cls.includes('relative'));
    assert.ok(cls.includes('flex'));
    assert.ok(cls.includes('shrink-0'));
    assert.ok(cls.includes('thread-pane'));
  });
  test('resolveResizeHandleClass はハンドル目印クラス・モバイル非表示・カーソルを含む', () => {
    const cls = resolveResizeHandleClass('right');
    assert.ok(cls.includes('panel-resize-handle'));
    assert.ok(cls.includes('hidden'));
    assert.ok(cls.includes('md:block'));
    assert.ok(cls.includes('right-0'));
    assert.ok(cls.includes('w-1'));
    assert.ok(cls.includes('cursor-col-resize'));
  });
  test('resolveResizeHandleClass(left) は left-0 を含む', () => {
    assert.ok(resolveResizeHandleClass('left').includes('left-0'));
  });
  test('RESIZE_OVERLAY_CLASS はテキスト選択防止用の全画面オーバーレイ', () => {
    assert.ok(RESIZE_OVERLAY_CLASS.includes('fixed'));
    assert.ok(RESIZE_OVERLAY_CLASS.includes('inset-0'));
    assert.ok(RESIZE_OVERLAY_CLASS.includes('cursor-col-resize'));
  });
});

// ---------------------------------------------------------------------------
// 静的ガード
// ---------------------------------------------------------------------------

describe('ソース静的ガード: panel-resize-rules.ts', () => {
  const src = readSrc('src/lib/panel-resize-rules.ts');
  test('外部 import ゼロ（純ロジックモジュール規約）', () => {
    assert.ok(!/^import /m.test(src));
  });
  test('window / localStorage を直接参照しない', () => {
    assert.ok(!/\bwindow\./.test(src));
    assert.ok(!/\blocalStorage\./.test(src));
  });
});

describe('ソース静的ガード: Lite 無変更（ThreadPane / usePanelResize / 新キーの混入なし）', () => {
  const liteFiles = [
    'src/pages/LitePage.tsx',
    'src/components/lite/LiteHeader.tsx',
    'src/components/lite/LiteComposer.tsx',
    'src/components/lite/LiteMessageList.tsx',
    'src/components/lite/LiteApprovalCard.tsx',
    'src/components/lite/lite-shell-rules.ts',
  ];
  for (const relPath of liteFiles) {
    test(`${relPath}: ThreadPane / thread-pane / usePanelResize / devrelay-thread-list-width を含まない`, () => {
      const source = readSrc(relPath);
      assert.equal(source.includes('ThreadPane'), false);
      assert.equal(source.includes('thread-pane'), false);
      assert.equal(source.includes('usePanelResize'), false);
      assert.equal(source.includes('devrelay-thread-list-width'), false);
    });
  }
});

describe('ソース静的ガード: ThreadList.tsx の契約（CSS 上書きの前提を固定）', () => {
  const src = readSrc('src/components/ThreadList.tsx');
  test('w-56 h-full shrink-0 が残っている', () => {
    assert.ok(src.includes('w-56 h-full shrink-0'));
  });
  test('md:z-auto が残っている（stacking context 維持の前提）', () => {
    assert.ok(src.includes('md:z-auto'));
  });
});

describe('ソース静的ガード: 二重実装なし（リサイズ実装は usePanelResize.ts に一本化）', () => {
  test('document.addEventListener("mousemove" は usePanelResize.ts にちょうど 1 箇所', () => {
    const src = readSrc('src/hooks/usePanelResize.ts');
    const matches = src.match(/document\.addEventListener\(\s*['"]mousemove['"]/g) ?? [];
    assert.equal(matches.length, 1);
  });
  for (const relPath of ['src/components/RightRail.tsx', 'src/components/ThreadPane.tsx']) {
    test(`${relPath}: document.addEventListener("mousemove" が 0 箇所（フックへ移設済み）`, () => {
      const src = readSrc(relPath);
      const matches = src.match(/document\.addEventListener\(\s*['"]mousemove['"]/g) ?? [];
      assert.equal(matches.length, 0);
    });
  }
  test('clampRailWidth / readRailWidth が src/ 全体で 0 件（削除済み）', () => {
    const files = [
      'src/lib/right-rail-rules.ts',
      'src/components/RightRail.tsx',
      'src/lib/panel-resize-rules.ts',
      'src/hooks/usePanelResize.ts',
      'src/components/ThreadPane.tsx',
    ];
    for (const relPath of files) {
      const src = readSrc(relPath);
      assert.equal(/\bclampRailWidth\b/.test(src), false, `${relPath} に clampRailWidth が残っている`);
      assert.equal(/\breadRailWidth\b/.test(src), false, `${relPath} に readRailWidth が残っている`);
    }
  });
});

describe('ソース静的ガード: usePanelResize.ts の算術がテスト可能な場所にある', () => {
  const src = readSrc('src/hooks/usePanelResize.ts');
  test('computeResizeWidth( を呼んでいる', () => {
    assert.ok(src.includes('computeResizeWidth('));
  });
  test('Math.min( / Math.max( を直接呼んでいない（算術は panel-resize-rules.ts に閉じる）', () => {
    assert.equal(/Math\.min\(/.test(src), false);
    assert.equal(/Math\.max\(/.test(src), false);
  });
});

describe('ソース静的ガード: index.css の CSS 上書き', () => {
  const src = readSrc('src/index.css');
  test('.thread-pane を含む', () => {
    assert.ok(src.includes('.thread-pane'));
  });
  test('@media (min-width: 48rem) を含む（Tailwind v4 の md と厳密一致）', () => {
    assert.ok(src.includes('@media (min-width: 48rem)'));
  });
  test(':not(.panel-resize-handle) を含む（ハンドル全面化事故の防止）', () => {
    assert.ok(src.includes(':not(.panel-resize-handle)'));
  });
  test('.thread-pane > div { という危険なセレクタが存在しない（ハンドルも巻き込む事故の再発検知）', () => {
    assert.equal(/\.thread-pane\s*>\s*div\s*\{/.test(src), false);
  });
});

describe('ソース静的ガード: ChatPage.tsx への配線', () => {
  const src = readSrc('src/pages/ChatPage.tsx');
  test('<ThreadPane がちょうど 1 箇所', () => {
    const matches = src.match(/<ThreadPane\b/g) ?? [];
    assert.equal(matches.length, 1);
  });
  test('<ThreadPane ... <ThreadList の入れ子になっている', () => {
    assert.match(src, /<ThreadPane[\s\S]{0,400}?<ThreadList/);
  });
});

describe('ソース静的ガード: モバイル無効化（<768px でリサイズ無効・幅固定）の配線固定', () => {
  test('ThreadPane.tsx のハンドルは resolveResizeHandleClass 経由で hidden md:block になっている', () => {
    const src = readSrc('src/components/ThreadPane.tsx');
    assert.ok(src.includes('resolveResizeHandleClass('));
  });
  test('index.css の .thread-pane 既定値（メディアクエリ外）は 14rem 固定（モバイルは常にこれ）', () => {
    const src = readSrc('src/index.css');
    assert.match(src, /\.thread-pane\s*\{\s*width:\s*14rem;\s*\}/);
  });
});

describe('ソース静的ガード: tsconfig.test.json の include に panel-resize-rules.ts が載っている', () => {
  test('include に含まれる', () => {
    const tsconfigTest = JSON.parse(readSrc('tsconfig.test.json'));
    assert.ok(
      tsconfigTest.include.some((p) => p.includes('panel-resize-rules.ts')),
      'tsconfig.test.json の include に src/lib/panel-resize-rules.ts が無い'
    );
  });
});

describe('ソース静的ガード: ThreadPane.tsx にコメント外 CJK 文字を含まない', () => {
  test('コメント外に CJK 文字が無い', () => {
    const src = readSrc('src/components/ThreadPane.tsx');
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const cjk = stripped.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/g) ?? [];
    assert.equal(cjk.length, 0, `コメント外に CJK 文字が ${cjk.length} 個見つかった`);
  });
});
