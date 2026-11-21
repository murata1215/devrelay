// カラーテーマ（2026-11-21。色見本パネルで 30 色から選ぶ版）のテスト。
// node:test から dist-test/ を直接 import する（tab-order-rules.test.mjs 等と同じ流儀）。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  THEMES,
  THEME_GROUPS,
  THEME_VAR_NAMES,
  DEFAULT_THEME,
  normalizeTheme,
  isLightTheme,
  getTheme,
  themesByGroup,
  contrast,
  ensureContrast,
  mix,
} from '../dist-test/lib/theme-rules.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const css = readFileSync(path.join(__dirname, '../src/index.css'), 'utf8');
const HEX = /^#[0-9a-f]{6}$/i;

describe('theme-rules: 一覧', () => {
  test('30 テーマ・id 重複なし・先頭はダーク（既定）', () => {
    assert.equal(THEMES.length, 30);
    assert.equal(new Set(THEMES.map((t) => t.id)).size, 30);
    assert.equal(THEMES[0].id, 'dark');
    assert.equal(DEFAULT_THEME, 'dark');
  });

  test('グループ: 定番 10・パステル 10・ビビッド 4・濃い色 6、全テーマがどれかに属する', () => {
    const counts = Object.fromEntries(themesByGroup().map(({ group, themes }) => [group.id, themes.length]));
    assert.deepEqual(counts, { classic: 10, pastel: 10, vivid: 4, deep: 6 });
    const ids = new Set(THEME_GROUPS.map((g) => g.id));
    for (const t of THEMES) assert.ok(ids.has(t.group), t.id);
  });

  test('名前・色見本の 3 色', () => {
    for (const t of THEMES) {
      assert.ok(t.name.ja && t.name.en, t.id);
      assert.match(t.swatchBg, HEX, t.id);
      assert.match(t.swatchAccent, HEX, t.id);
      assert.match(t.swatchText, HEX, t.id);
      assert.ok(contrast(t.swatchText, t.swatchBg) >= 4.5, `${t.id} の色見本の文字が読みにくい`);
    }
  });

  test('dark/light だけが index.css の既定を使い（vars なし）、他は 20 変数すべてを持つ', () => {
    for (const t of THEMES) {
      if (t.id === 'dark' || t.id === 'light') {
        assert.equal(t.vars, null, t.id);
        continue;
      }
      assert.ok(t.vars, t.id);
      assert.deepEqual(Object.keys(t.vars).sort(), [...THEME_VAR_NAMES].sort(), t.id);
      for (const name of THEME_VAR_NAMES) {
        const v = t.vars[name];
        assert.ok(HEX.test(v) || /^rgba\(/.test(v) || /^var\(--/.test(v), `${t.id} --${name}=${v}`);
      }
    }
  });

  test('THEME_VAR_NAMES は index.css の :root の変数と一致する', () => {
    const root = /:root\s*\{([^}]*)\}/.exec(css)[1];
    const names = [...root.matchAll(/--([a-z-]+):/g)].map((m) => m[1]).sort();
    assert.deepEqual([...THEME_VAR_NAMES].sort(), names);
  });

  test('index.css にテーマ別の data-theme ブロックは残っていない（色は theme-rules.ts に一本化）', () => {
    assert.ok(!css.includes(':root[data-theme='));
  });
});

describe('theme-rules: 読みやすさ', () => {
  const withVars = THEMES.filter((t) => t.vars);
  const generated = withVars.filter((t) => t.group !== 'classic');

  test('全テーマ: 白文字のボタン・吹き出しはコントラスト 4.5 以上', () => {
    for (const t of withVars) {
      assert.ok(contrast(t.vars['user-bubble'], '#ffffff') >= 4.5, `${t.id} user-bubble`);
      assert.ok(contrast(t.vars['accent-blue'], '#ffffff') >= 4.5, `${t.id} accent-blue`);
    }
  });

  test('全テーマ: 本文は背景に対して 4.5 以上', () => {
    for (const t of withVars) {
      for (const bg of ['bg-base', 'bg-secondary', 'bg-tertiary']) {
        assert.ok(contrast(t.vars['text-primary'], t.vars[bg]) >= 4.5, `${t.id} text-primary on ${bg}`);
      }
    }
  });

  test('自動生成テーマ: 本文 7 以上・補助文字 4.5 以上・薄い文字 3 以上・リンク/成功/危険 4.5 以上', () => {
    for (const t of generated) {
      const v = t.vars;
      for (const bg of ['bg-base', 'bg-secondary', 'bg-tertiary']) {
        assert.ok(contrast(v['text-primary'], v[bg]) >= 7, `${t.id} text-primary on ${bg}: ${contrast(v['text-primary'], v[bg]).toFixed(2)}`);
        assert.ok(contrast(v['text-secondary'], v[bg]) >= 4.5, `${t.id} text-secondary on ${bg}`);
        assert.ok(contrast(v['text-muted'], v[bg]) >= 3, `${t.id} text-muted on ${bg}`);
      }
      for (const k of ['text-link', 'text-success', 'text-danger']) {
        assert.ok(contrast(v[k], v['bg-secondary']) >= 4.5, `${t.id} ${k}: ${contrast(v[k], v['bg-secondary']).toFixed(2)}`);
      }
    }
  });

  test('ensureContrast は届かない場合でも向かう先の色で止まる', () => {
    assert.ok(contrast(ensureContrast('#ff9cc8', '#ffffff', 4.5, '#000000'), '#ffffff') >= 4.5);
    assert.equal(mix('#000000', '#ffffff', 0), '#000000');
    assert.equal(mix('#000000', '#ffffff', 1), '#ffffff');
  });
});

describe('theme-rules: 保存値', () => {
  test('現行 id は引き継ぎ、未知・空は既定', () => {
    assert.equal(normalizeTheme('dark'), 'dark');
    assert.equal(normalizeTheme('light'), 'light');
    assert.equal(normalizeTheme('neon'), 'neon');
    assert.equal(normalizeTheme(null), 'dark');
    assert.equal(normalizeTheme(''), 'dark');
    assert.equal(normalizeTheme('purple'), 'dark');
    assert.equal(normalizeTheme('toString'), 'dark');
  });

  test('廃止した旧テーマ id の読み替え（さくら・フォレストは復活したのでそのまま）', () => {
    assert.equal(normalizeTheme('midnight'), 'github-dark');
    assert.equal(normalizeTheme('latte'), 'gruvbox-light');
    assert.equal(normalizeTheme('sakura'), 'sakura');
    assert.equal(normalizeTheme('forest'), 'forest');
  });

  test('明るい系の判定（.light クラス互換の対象）', () => {
    assert.equal(isLightTheme('light'), true);
    assert.equal(isLightTheme('vivid-pink'), true);
    assert.equal(isLightTheme('dark'), false);
    assert.equal(isLightTheme('neon'), false);
    assert.equal(getTheme('unknown-id').id, 'dark');
  });
});
