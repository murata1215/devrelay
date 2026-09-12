import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  RAIL_COLLAPSED_STORAGE_KEY,
  RAIL_WIDTH_STORAGE_KEY,
  RAIL_WIDTH_DEFAULT,
  RAIL_WIDTH_MIN,
  RAIL_WIDTH_MAX,
  readRailCollapsed,
  serializeRailCollapsed,
  countPendingApprovals,
  resolveRailBadge,
  resolveRailSections,
  resolveSidebarShellClass,
} from '../dist-test/lib/right-rail-rules.js';
import { clampWidth, readWidth } from '../dist-test/lib/panel-resize-rules.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const readSrc = (relPath) => readFileSync(path.join(__dirname, '..', relPath), 'utf8');

describe('定数（既存命名との整合）', () => {
  test('RAIL_COLLAPSED_STORAGE_KEY は devrelay-* 命名', () => {
    assert.equal(RAIL_COLLAPSED_STORAGE_KEY, 'devrelay-right-rail-collapsed');
  });
  test('RAIL_WIDTH_STORAGE_KEY は旧 DocPanel 幅キーを流用する', () => {
    assert.equal(RAIL_WIDTH_STORAGE_KEY, 'devrelay-panel-width');
  });
  test('既定値/境界値は旧 DocPanel の値を保つ', () => {
    assert.equal(RAIL_WIDTH_DEFAULT, 208);
    assert.equal(RAIL_WIDTH_MIN, 160);
    assert.equal(RAIL_WIDTH_MAX, 600);
  });
});

describe('readRailCollapsed / serializeRailCollapsed', () => {
  test('null（未保存）は既定で展開（false）', () => {
    assert.equal(readRailCollapsed(null), false);
  });
  test("空文字は展開（false）", () => {
    assert.equal(readRailCollapsed(''), false);
  });
  test("'0' は展開（false）", () => {
    assert.equal(readRailCollapsed('0'), false);
  });
  test("'1' のみ折りたたみ（true）", () => {
    assert.equal(readRailCollapsed('1'), true);
  });
  test("ゴミ値（'true' 等）は展開（false）にフォールバック", () => {
    assert.equal(readRailCollapsed('true'), false);
  });
  test('serializeRailCollapsed は往復する', () => {
    assert.equal(serializeRailCollapsed(true), '1');
    assert.equal(serializeRailCollapsed(false), '0');
    assert.equal(readRailCollapsed(serializeRailCollapsed(true)), true);
    assert.equal(readRailCollapsed(serializeRailCollapsed(false)), false);
  });
});

// clampRailWidth / readRailWidth は panel-resize-rules.ts の clampWidth / readWidth に一本化した
// （right-rail-rules.ts から削除済み）。RAIL_* 定数を渡して同じ契約を検証する。
describe('clampWidth（RAIL_WIDTH_MIN/MAX を渡した場合。旧 clampRailWidth 相当）', () => {
  test('範囲内はそのまま', () => {
    assert.equal(clampWidth(300, RAIL_WIDTH_MIN, RAIL_WIDTH_MAX), 300);
  });
  test('下限未満は下限に丸める', () => {
    assert.equal(clampWidth(0, RAIL_WIDTH_MIN, RAIL_WIDTH_MAX), RAIL_WIDTH_MIN);
    assert.equal(clampWidth(-100, RAIL_WIDTH_MIN, RAIL_WIDTH_MAX), RAIL_WIDTH_MIN);
  });
  test('上限超過は上限に丸める', () => {
    assert.equal(clampWidth(9999, RAIL_WIDTH_MIN, RAIL_WIDTH_MAX), RAIL_WIDTH_MAX);
  });
  test('境界値はそのまま通す', () => {
    assert.equal(clampWidth(RAIL_WIDTH_MIN, RAIL_WIDTH_MIN, RAIL_WIDTH_MAX), RAIL_WIDTH_MIN);
    assert.equal(clampWidth(RAIL_WIDTH_MAX, RAIL_WIDTH_MIN, RAIL_WIDTH_MAX), RAIL_WIDTH_MAX);
  });
});

describe('readWidth（RAIL_WIDTH_MIN/MAX/DEFAULT を渡した場合。旧 readRailWidth 相当）', () => {
  const args = { min: RAIL_WIDTH_MIN, max: RAIL_WIDTH_MAX, fallback: RAIL_WIDTH_DEFAULT };
  test('null（未保存）は既定幅', () => {
    assert.equal(readWidth(null, args), RAIL_WIDTH_DEFAULT);
  });
  test("ゴミ値（'abc'）は既定幅", () => {
    assert.equal(readWidth('abc', args), RAIL_WIDTH_DEFAULT);
  });
  test("'0' は下限へ clamp される（既定幅ではない）", () => {
    assert.equal(readWidth('0', args), RAIL_WIDTH_MIN);
  });
  test("'9999' は上限へ clamp される", () => {
    assert.equal(readWidth('9999', args), RAIL_WIDTH_MAX);
  });
  test("'208' はそのまま", () => {
    assert.equal(readWidth('208', args), 208);
  });
});

describe('countPendingApprovals', () => {
  test('pending のみ数える（allow/deny/auto は含めない）', () => {
    const list = [
      { status: 'pending' },
      { status: 'allow' },
      { status: 'deny' },
      { status: 'auto' },
      { status: 'pending' },
    ];
    assert.equal(countPendingApprovals(list), 2);
  });
  test('空配列は 0', () => {
    assert.equal(countPendingApprovals([]), 0);
  });
});

describe('resolveRailBadge（折りたたみ中のみ・自動展開なし）', () => {
  test('展開中（collapsed: false）は pendingCount があっても非表示', () => {
    const result = resolveRailBadge({ collapsed: false, pendingCount: 5 });
    assert.equal(result.show, false);
    assert.equal(result.label, '');
  });
  test('折りたたみ中・0 件は非表示', () => {
    const result = resolveRailBadge({ collapsed: true, pendingCount: 0 });
    assert.equal(result.show, false);
  });
  test('折りたたみ中・1〜9 件はそのまま表示', () => {
    assert.deepEqual(resolveRailBadge({ collapsed: true, pendingCount: 1 }), { show: true, label: '1' });
    assert.deepEqual(resolveRailBadge({ collapsed: true, pendingCount: 9 }), { show: true, label: '9' });
  });
  test('折りたたみ中・10 件以上は 9+ に打ち切る', () => {
    assert.deepEqual(resolveRailBadge({ collapsed: true, pendingCount: 10 }), { show: true, label: '9+' });
    assert.deepEqual(resolveRailBadge({ collapsed: true, pendingCount: 999 }), { show: true, label: '9+' });
  });
});

describe('resolveRailSections（Servers は常時表示・DocPanel 設定に結合しない）', () => {
  test('docPanelEnabled: false でも Servers は表示', () => {
    const result = resolveRailSections({ docPanelEnabled: false });
    assert.equal(result.showServers, true);
    assert.equal(result.showDocPanel, false);
    assert.equal(result.layout, 'servers-only');
  });
  test('docPanelEnabled: true で両方表示', () => {
    const result = resolveRailSections({ docPanelEnabled: true });
    assert.equal(result.showServers, true);
    assert.equal(result.showDocPanel, true);
    assert.equal(result.layout, 'split');
  });
});

describe('resolveSidebarShellClass（レイアウトの唯一の防波堤・トークン単位で検証）', () => {
  test('drawer: fixed / md:hidden / w-56 を含む', () => {
    const cls = resolveSidebarShellClass('drawer');
    for (const token of ['fixed', 'md:hidden', 'w-56']) {
      assert.ok(cls.includes(token), `drawer クラスに "${token}" が含まれること`);
    }
  });
  test('drawer: md:relative / md:translate-x-0 / md:z-auto を含まない（従来の md 上書きは撤去済み）', () => {
    const cls = resolveSidebarShellClass('drawer');
    for (const token of ['md:relative', 'md:translate-x-0', 'md:z-auto']) {
      assert.ok(!cls.includes(token), `drawer クラスに "${token}" が含まれないこと`);
    }
  });
  test('rail: fixed / translate / w-56 を含まない', () => {
    const cls = resolveSidebarShellClass('rail');
    for (const token of ['fixed', 'translate', 'w-56']) {
      assert.ok(!cls.includes(token), `rail クラスに "${token}" が含まれないこと`);
    }
  });
  test('rail: min-h-0 を含む（flex column の高さ連鎖）', () => {
    const cls = resolveSidebarShellClass('rail');
    assert.ok(cls.includes('min-h-0'));
  });
});

// ---------------------------------------------------------------------------
// ソース静的ガード（Lite の stripComments は import しない。Lite の影響半径をゼロに保つ）
// ---------------------------------------------------------------------------

describe('ソース静的ガード: ChatPage.tsx', () => {
  const src = readSrc('src/pages/ChatPage.tsx');

  test('<Sidebar がちょうど 2 箇所（drawer 用・rail 用）存在する', () => {
    const matches = src.match(/<Sidebar\b/g) ?? [];
    assert.equal(matches.length, 2, `<Sidebar> の出現回数は 2 のはずが ${matches.length}`);
  });

  test('variant="drawer" と variant="rail" が各 1 回存在する', () => {
    assert.equal((src.match(/variant="drawer"/g) ?? []).length, 1);
    assert.equal((src.match(/variant="rail"/g) ?? []).length, 1);
  });

  test('devrelay-panel-width が ChatPage.tsx に残っていない（RightRail.tsx へ移設済み）', () => {
    assert.ok(!src.includes('devrelay-panel-width'));
  });

  test('DocPanel の外側要素に hidden lg:flex が無い（RightRail 側のラッパーへ移設済み）', () => {
    assert.ok(!/hidden lg:flex flex-col border-l/.test(src));
  });
});

describe('ソース静的ガード: RightRail.tsx', () => {
  const src = readSrc('src/components/RightRail.tsx');

  test('devrelay-panel-width（RAIL_WIDTH_STORAGE_KEY）を使用している（幅の所有者として移設済み）', () => {
    assert.ok(src.includes('RAIL_WIDTH_STORAGE_KEY'));
  });

  test('hidden lg:flex と hidden md:flex の両方を含む（DocPanel の可視性保存 + 折りたたみストリップの可視性）', () => {
    assert.ok(src.includes('hidden lg:flex'));
    assert.ok(src.includes('hidden md:flex'));
  });

  test('コメント外に CJK 文字を含まない（i18n 経由の文言のみを表示する規約）', () => {
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    const cjk = stripped.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/g) ?? [];
    assert.equal(cjk.length, 0, `コメント外に CJK 文字が ${cjk.length} 個見つかった`);
  });
});

describe('ソース静的ガード: right-rail-rules.ts', () => {
  const src = readSrc('src/lib/right-rail-rules.ts');

  test('外部 import ゼロ（純ロジックモジュール規約）', () => {
    assert.ok(!/^import /m.test(src));
  });

  test('window / localStorage を直接参照しない（tsconfig.test.json の lib: ["ES2022"] 制約）', () => {
    assert.ok(!/\bwindow\./.test(src));
    assert.ok(!/\blocalStorage\./.test(src));
  });
});
