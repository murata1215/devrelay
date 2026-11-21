// カラーテーマ巡回（2026-11-21。同日に独自 7 配色 → 有名配色 10 選へ入れ替え）のテスト。
// node:test から dist-test/ を直接 import する（tab-order-rules.test.mjs 等と同じ流儀）。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { THEMES, DEFAULT_THEME, normalizeTheme, nextTheme, isLightTheme, getTheme } from '../dist-test/lib/theme-rules.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const css = readFileSync(path.join(__dirname, '../src/index.css'), 'utf8');

describe('theme-rules', () => {
  test('10 パターン・id 重複なし・先頭はダーク', () => {
    assert.equal(THEMES.length, 10);
    assert.equal(new Set(THEMES.map((t) => t.id)).size, 10);
    assert.equal(THEMES[0].id, 'dark');
    assert.equal(DEFAULT_THEME, 'dark');
  });

  test('nextTheme で一巡すると元に戻り、全テーマを 1 回ずつ通る', () => {
    const seen = [];
    let cur = 'dark';
    for (let i = 0; i < THEMES.length; i++) {
      seen.push(cur);
      cur = nextTheme(cur);
    }
    assert.equal(cur, 'dark');
    assert.deepEqual(seen, THEMES.map((t) => t.id));
  });

  test('保存値の正規化: 現行 id は引き継ぎ、未知・空は既定', () => {
    assert.equal(normalizeTheme('dark'), 'dark');
    assert.equal(normalizeTheme('light'), 'light');
    assert.equal(normalizeTheme('nord'), 'nord');
    assert.equal(normalizeTheme('dracula'), 'dracula');
    assert.equal(normalizeTheme(null), 'dark');
    assert.equal(normalizeTheme(''), 'dark');
    assert.equal(normalizeTheme('purple'), 'dark');
    assert.equal(normalizeTheme('toString'), 'dark');
  });

  test('廃止した旧テーマ id は雰囲気の近い新テーマへ読み替える', () => {
    assert.equal(normalizeTheme('midnight'), 'github-dark');
    assert.equal(normalizeTheme('forest'), 'dark');
    assert.equal(normalizeTheme('sakura'), 'rose-pine-dawn');
    assert.equal(normalizeTheme('latte'), 'gruvbox-light');
  });

  test('明るい系 6・暗い系 4（.light クラス互換の対象）', () => {
    assert.deepEqual(
      THEMES.filter((t) => isLightTheme(t.id)).map((t) => t.id),
      ['light', 'github-light', 'solarized-light', 'catppuccin-latte', 'rose-pine-dawn', 'gruvbox-light'],
    );
    assert.equal(getTheme('nord').light, false);
    assert.equal(getTheme('dracula').light, false);
  });

  test('色見本の 2 色は #rrggbb', () => {
    for (const t of THEMES) {
      assert.match(t.swatchBg, /^#[0-9a-f]{6}$/i, t.id);
      assert.match(t.swatchAccent, /^#[0-9a-f]{6}$/i, t.id);
      assert.ok(t.name.ja && t.name.en, t.id);
    }
  });

  test('dark/light 以外の全テーマに index.css の定義があり、廃止テーマの定義は残っていない', () => {
    for (const t of THEMES) {
      if (t.id === 'dark' || t.id === 'light') continue;
      assert.ok(css.includes(`:root[data-theme="${t.id}"]`), `index.css に ${t.id} の定義が無い`);
    }
    for (const old of ['midnight', 'forest', 'sakura', 'latte']) {
      assert.ok(!css.includes(`:root[data-theme="${old}"]`), `index.css に廃止テーマ ${old} が残っている`);
    }
  });

  test('各テーマの白文字アクセント（--user-bubble）はコントラスト 4.5 以上', () => {
    const lum = (hex) => {
      const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
        .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const re = /:root\[data-theme="([^"]+)"\]\s*\{([^}]*)\}/g;
    let m;
    let n = 0;
    while ((m = re.exec(css))) {
      const bubble = /--user-bubble:\s*(#[0-9a-f]{6})/i.exec(m[2]);
      if (!bubble) continue;
      n++;
      const ratio = 1.05 / (lum(bubble[1]) + 0.05);
      assert.ok(ratio >= 4.5, `${m[1]} の --user-bubble ${bubble[1]} は白文字とのコントラスト ${ratio.toFixed(2)}`);
    }
    assert.equal(n, 8);
  });
});
