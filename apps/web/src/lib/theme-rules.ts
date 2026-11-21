/**
 * カラーテーマ（2026-11-21）の純関数群。
 *
 * 変遷: ダーク/ライトの 2 択 → 独自 7 配色の巡回 → 有名配色 10 選の巡回 → 本版「色見本パネルで 30 色から選ぶ」。
 * ヘッダーの色見本アイコン（ThemeSwatchIcon）を押すとパネルが開き、グループ別に並んだ見本から選ぶ。
 *
 * 色の持ち方:
 * - dark / light … index.css の `:root` / `:root.light` がそのまま担う（vars は null。インライン指定を消すだけ）。
 * - 定番の 8 配色 … 公式パレットから手で調整した値（`TUNED`）。
 * - パステル / ビビッド / 濃い色 … 「背景・差し色・明暗」の 3 つだけ決め、`deriveThemeVars()` が残りを自動で作る。
 *   本文・白文字ボタン・リンクは `ensureContrast()` で読める濃さ（WCAG コントラスト比）まで自動補正する。
 * 実際の適用は ThemeContext が <html> の style に CSS 変数を書き込む。DOM / localStorage に依存しないため
 * node:test で検証する（tests/theme-rules.test.mjs）。
 */

export type ThemeGroup = 'classic' | 'pastel' | 'vivid' | 'deep';

/** テーマが上書きする CSS 変数（index.css の :root と同じ 20 個） */
export const THEME_VAR_NAMES = [
  'bg-base',
  'bg-secondary',
  'bg-tertiary',
  'bg-hover',
  'bg-selected',
  'text-primary',
  'text-secondary',
  'text-muted',
  'text-faint',
  'border-color',
  'input-bg',
  'accent-blue',
  'accent-blue-hover',
  'user-bubble',
  'ai-bubble',
  'text-success',
  'text-danger',
  'text-link',
  'bg-danger',
  'border-danger',
] as const;

export type ThemeVarName = (typeof THEME_VAR_NAMES)[number];
export type ThemeVars = Record<ThemeVarName, string>;

export interface ThemeDef {
  id: string;
  name: { ja: string; en: string };
  group: ThemeGroup;
  /** 明るい系か。true のとき <html> に従来の `.light` クラスも付ける（`.light` 前提の既存 CSS を壊さないため） */
  light: boolean;
  /** 色見本: 背景色 */
  swatchBg: string;
  /** 色見本: アクセント色 */
  swatchAccent: string;
  /** 色見本: 名前の文字色 */
  swatchText: string;
  /** <html> に書き込む CSS 変数。null は index.css の既定（dark / light）をそのまま使う */
  vars: ThemeVars | null;
}

export type ThemeId = string;

export const THEME_GROUPS: readonly { id: ThemeGroup; name: { ja: string; en: string } }[] = [
  { id: 'classic', name: { ja: '定番', en: 'Classic' } },
  { id: 'pastel', name: { ja: 'パステル', en: 'Pastel' } },
  { id: 'vivid', name: { ja: 'ビビッド', en: 'Vivid' } },
  { id: 'deep', name: { ja: '濃い色', en: 'Deep' } },
];

// ---------------------------------------------------------------------------
// 色の計算（#rrggbb のみ扱う）
// ---------------------------------------------------------------------------

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function rgbToHex([r, g, b]: [number, number, number]): string {
  return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}

/** a と b を混ぜる（t=0 で a、t=1 で b） */
export function mix(a: string, b: string, t: number): string {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  return rgbToHex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
}

/** WCAG 相対輝度 */
export function luminance(hex: string): number {
  const c = hexToRgb(hex)
    .map((v) => v / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

/** WCAG コントラスト比（1〜21） */
export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** color を toward（黒か白）へ少しずつ寄せ、against とのコントラストが min 以上になる最初の色を返す */
export function ensureContrast(color: string, against: string, min: number, toward: string): string {
  for (let i = 0; i <= 40; i++) {
    const c = mix(color, toward, i / 40);
    if (contrast(c, against) >= min) return c;
  }
  return toward;
}

/** 背景・差し色・明暗から 20 個の CSS 変数を作る */
export function deriveThemeVars(bg: string, accent: string, light: boolean): ThemeVars {
  const ink = light ? '#000000' : '#ffffff';
  if (light) {
    const base = bg;
    const textPrimary = ensureContrast(mix(accent, '#000000', 0.78), base, 7.5, '#000000');
    const accentBtn = ensureContrast(accent, '#ffffff', 4.6, '#000000');
    const danger = ensureContrast('#b91c1c', mix(base, ink, 0.04), 4.6, '#000000');
    return {
      'bg-base': base,
      'bg-secondary': mix(base, ink, 0.04),
      'bg-tertiary': mix(base, ink, 0.09),
      'bg-hover': mix(base, ink, 0.06),
      'bg-selected': mix(base, ink, 0.14),
      'text-primary': textPrimary,
      'text-secondary': ensureContrast(mix(textPrimary, base, 0.25), mix(base, ink, 0.09), 4.6, '#000000'),
      'text-muted': ensureContrast(mix(textPrimary, base, 0.45), mix(base, ink, 0.09), 3.2, '#000000'),
      'text-faint': mix(textPrimary, base, 0.68),
      'border-color': mix(base, ink, 0.13),
      'input-bg': mix(base, '#ffffff', 0.45),
      'accent-blue': accentBtn,
      'accent-blue-hover': mix(accentBtn, '#000000', 0.15),
      'user-bubble': accentBtn,
      'ai-bubble': 'var(--bg-secondary)',
      'text-success': ensureContrast('#15803d', mix(base, ink, 0.04), 4.6, '#000000'),
      'text-danger': danger,
      'text-link': ensureContrast(accent, mix(base, ink, 0.04), 4.6, '#000000'),
      'bg-danger': 'rgba(239, 68, 68, 0.12)',
      'border-danger': danger,
    };
  }
  const secondary = bg;
  const base = mix(bg, '#000000', 0.25);
  const tertiary = mix(bg, ink, 0.06);
  const textPrimary = ensureContrast(mix(accent, '#ffffff', 0.9), tertiary, 7.5, '#ffffff');
  const accentBtn = ensureContrast(accent, '#ffffff', 4.6, '#000000');
  const danger = ensureContrast('#f87171', tertiary, 4.6, '#ffffff');
  return {
    'bg-base': base,
    'bg-secondary': secondary,
    'bg-tertiary': tertiary,
    'bg-hover': mix(bg, ink, 0.09),
    'bg-selected': mix(bg, ink, 0.15),
    'text-primary': textPrimary,
    'text-secondary': ensureContrast(mix(textPrimary, bg, 0.22), tertiary, 4.6, '#ffffff'),
    'text-muted': ensureContrast(mix(textPrimary, bg, 0.42), tertiary, 3.2, '#ffffff'),
    'text-faint': mix(textPrimary, bg, 0.62),
    'border-color': mix(bg, ink, 0.14),
    'input-bg': mix(bg, ink, 0.08),
    'accent-blue': accentBtn,
    'accent-blue-hover': mix(accentBtn, '#000000', 0.15),
    'user-bubble': accentBtn,
    'ai-bubble': 'var(--bg-tertiary)',
    'text-success': ensureContrast('#4ade80', tertiary, 4.6, '#ffffff'),
    'text-danger': danger,
    'text-link': ensureContrast(mix(accent, '#ffffff', 0.25), tertiary, 4.6, '#ffffff'),
    'bg-danger': 'rgba(239, 68, 68, 0.2)',
    'border-danger': danger,
  };
}

// ---------------------------------------------------------------------------
// テーマ一覧
// ---------------------------------------------------------------------------

/**
 * 定番 8 配色（公式パレットから手で調整した値。根拠は VS Code Marketplace のインストール数＝GitHub Theme が配色テーマ最多・
 * Dracula 500 万超と、Solarized / Nord / Catppuccin / Rosé Pine / Gruvbox の公式パレット）。
 * 白文字アクセントは 4.5 以上になるよう、公式色が明るすぎるもの（Solarized の青・Rosé Pine の love・Dracula の紫・Nord の青）だけ同系色で濃くしてある。
 */
const TUNED: Record<string, ThemeVars> = {
  'github-light': {"bg-base":"#ffffff","bg-secondary":"#f6f8fa","bg-tertiary":"#eaeef2","bg-hover":"#f3f4f6","bg-selected":"#d0d7de","text-primary":"#1f2328","text-secondary":"#59636e","text-muted":"#6e7781","text-faint":"#afb8c1","border-color":"#d0d7de","input-bg":"#f6f8fa","accent-blue":"#0969da","accent-blue-hover":"#0550ae","user-bubble":"#0969da","ai-bubble":"var(--bg-secondary)","text-success":"#1a7f37","text-danger":"#d1242f","text-link":"#0969da","bg-danger":"rgba(209, 36, 47, 0.1)","border-danger":"#d1242f"},
  'solarized-light': {"bg-base":"#fdf6e3","bg-secondary":"#eee8d5","bg-tertiary":"#e4dcc4","bg-hover":"#f3ecd7","bg-selected":"#dcd3b8","text-primary":"#073642","text-secondary":"#586e75","text-muted":"#657b83","text-faint":"#93a1a1","border-color":"#ddd6c1","input-bg":"#f5efdc","accent-blue":"#1f6fa8","accent-blue-hover":"#185a8a","user-bubble":"#1f6fa8","ai-bubble":"var(--bg-secondary)","text-success":"#5c6b00","text-danger":"#c4221f","text-link":"#1f6fa8","bg-danger":"rgba(220, 50, 47, 0.1)","border-danger":"#dc322f"},
  'catppuccin-latte': {"bg-base":"#eff1f5","bg-secondary":"#e6e9ef","bg-tertiary":"#dce0e8","bg-hover":"#e4e7ee","bg-selected":"#ccd0da","text-primary":"#4c4f69","text-secondary":"#5c5f77","text-muted":"#6c6f85","text-faint":"#9ca0b0","border-color":"#ccd0da","input-bg":"#e6e9ef","accent-blue":"#8839ef","accent-blue-hover":"#7028d8","user-bubble":"#8839ef","ai-bubble":"var(--bg-secondary)","text-success":"#2f7d1f","text-danger":"#d20f39","text-link":"#1e66f5","bg-danger":"rgba(210, 15, 57, 0.1)","border-danger":"#d20f39"},
  'rose-pine-dawn': {"bg-base":"#fffaf3","bg-secondary":"#faf4ed","bg-tertiary":"#f2e9e1","bg-hover":"#f4ede8","bg-selected":"#dfdad9","text-primary":"#575279","text-secondary":"#797593","text-muted":"#9893a5","text-faint":"#cecacd","border-color":"#dfdad9","input-bg":"#f2e9e1","accent-blue":"#a3566d","accent-blue-hover":"#8e475d","user-bubble":"#a3566d","ai-bubble":"var(--bg-secondary)","text-success":"#286983","text-danger":"#a8354f","text-link":"#286983","bg-danger":"rgba(180, 99, 122, 0.12)","border-danger":"#b4637a"},
  'gruvbox-light': {"bg-base":"#f9f5d7","bg-secondary":"#fbf1c7","bg-tertiary":"#ebdbb2","bg-hover":"#f2e5bc","bg-selected":"#d5c4a1","text-primary":"#3c3836","text-secondary":"#504945","text-muted":"#7c6f64","text-faint":"#bdae93","border-color":"#d5c4a1","input-bg":"#f2e5bc","accent-blue":"#af3a03","accent-blue-hover":"#8f2f02","user-bubble":"#af3a03","ai-bubble":"var(--bg-secondary)","text-success":"#79740e","text-danger":"#9d0006","text-link":"#076678","bg-danger":"rgba(157, 0, 6, 0.1)","border-danger":"#cc241d"},
  'github-dark': {"bg-base":"#1c2128","bg-secondary":"#22272e","bg-tertiary":"#2d333b","bg-hover":"#323942","bg-selected":"#373e47","text-primary":"#cdd9e5","text-secondary":"#adbac7","text-muted":"#768390","text-faint":"#545d68","border-color":"#444c56","input-bg":"#2d333b","accent-blue":"#316dca","accent-blue-hover":"#255ab2","user-bubble":"#316dca","ai-bubble":"var(--bg-tertiary)","text-success":"#57ab5a","text-danger":"#e5534b","text-link":"#539bf5","bg-danger":"rgba(229, 83, 75, 0.2)","border-danger":"#e5534b"},
  'nord': {"bg-base":"#2e3440","bg-secondary":"#3b4252","bg-tertiary":"#434c5e","bg-hover":"#4c566a","bg-selected":"#56607a","text-primary":"#eceff4","text-secondary":"#d8dee9","text-muted":"#a3acbd","text-faint":"#737e94","border-color":"#4c566a","input-bg":"#434c5e","accent-blue":"#4c6e98","accent-blue-hover":"#415f85","user-bubble":"#4c6e98","ai-bubble":"var(--bg-tertiary)","text-success":"#a3be8c","text-danger":"#e5838c","text-link":"#88c0d0","bg-danger":"rgba(191, 97, 106, 0.25)","border-danger":"#bf616a"},
  'dracula': {"bg-base":"#21222c","bg-secondary":"#282a36","bg-tertiary":"#343746","bg-hover":"#3a3c4e","bg-selected":"#44475a","text-primary":"#f8f8f2","text-secondary":"#c9cbd6","text-muted":"#8b93b8","text-faint":"#6272a4","border-color":"#44475a","input-bg":"#343746","accent-blue":"#7c5cc4","accent-blue-hover":"#6a4ab0","user-bubble":"#7c5cc4","ai-bubble":"var(--bg-tertiary)","text-success":"#50fa7b","text-danger":"#ff5555","text-link":"#bd93f9","bg-danger":"rgba(255, 85, 85, 0.2)","border-danger":"#ff5555"},
};

function tuned(id: string, ja: string, en: string, light: boolean, swatchAccent: string): ThemeDef {
  const vars = TUNED[id];
  return { id, name: { ja, en }, group: 'classic', light, swatchBg: vars['bg-secondary'], swatchAccent, swatchText: vars['text-primary'], vars };
}

function seeded(id: string, ja: string, en: string, group: ThemeGroup, light: boolean, bg: string, accent: string): ThemeDef {
  const vars = deriveThemeVars(bg, accent, light);
  return { id, name: { ja, en }, group, light, swatchBg: bg, swatchAccent: vars['accent-blue'], swatchText: vars['text-primary'], vars };
}

/** パネルの並び順。先頭がダーク（既定値） */
export const THEMES: readonly ThemeDef[] = [
  // 定番
  { id: 'dark', name: { ja: 'ダーク', en: 'Dark' }, group: 'classic', light: false, swatchBg: '#2b2d31', swatchAccent: '#5865f2', swatchText: '#f2f3f5', vars: null },
  { id: 'light', name: { ja: 'ライト', en: 'Light' }, group: 'classic', light: true, swatchBg: '#f2f3f5', swatchAccent: '#5865f2', swatchText: '#060607', vars: null },
  tuned('github-light', 'GitHub ライト', 'GitHub Light', true, '#0969da'),
  tuned('solarized-light', 'ソラライズド', 'Solarized Light', true, '#268bd2'),
  tuned('catppuccin-latte', 'カプチーノ ラテ', 'Catppuccin Latte', true, '#8839ef'),
  tuned('rose-pine-dawn', 'ローズパイン', 'Rosé Pine Dawn', true, '#a3566d'),
  tuned('gruvbox-light', 'グルーヴボックス', 'Gruvbox Light', true, '#af3a03'),
  tuned('github-dark', 'GitHub ダーク', 'GitHub Dark Dimmed', false, '#539bf5'),
  tuned('nord', 'ノルド', 'Nord', false, '#88c0d0'),
  tuned('dracula', 'ドラキュラ', 'Dracula', false, '#bd93f9'),
  // パステル
  seeded('peach', 'ピーチ', 'Peach', 'pastel', true, '#ffe8d6', '#c2410c'),
  seeded('orange', 'オレンジ', 'Orange', 'pastel', true, '#ffdcb3', '#c2410c'),
  seeded('pink', 'ピンク', 'Pink', 'pastel', true, '#ffe0ec', '#be185d'),
  seeded('sakura', 'さくら', 'Sakura', 'pastel', true, '#fdf0f3', '#d63f72'),
  seeded('lemon', 'レモン', 'Lemon', 'pastel', true, '#fff8c4', '#a16207'),
  seeded('mint', 'ミント', 'Mint', 'pastel', true, '#dcf5ea', '#047857'),
  seeded('sky', 'スカイ', 'Sky', 'pastel', true, '#dcefff', '#1d4ed8'),
  seeded('lavender', 'ラベンダー', 'Lavender', 'pastel', true, '#ece3ff', '#6d28d9'),
  seeded('coral', 'コーラル', 'Coral', 'pastel', true, '#ffe1d9', '#c2381f'),
  seeded('matcha', '抹茶', 'Matcha', 'pastel', true, '#e6eecf', '#4d7c0f'),
  // ビビッド
  seeded('vivid-orange', 'ビビッドオレンジ', 'Vivid Orange', 'vivid', true, '#ffb357', '#9a3412'),
  seeded('vivid-pink', 'ビビッドピンク', 'Vivid Pink', 'vivid', true, '#ff9cc8', '#9d174d'),
  seeded('vivid-yellow', 'ビビッドイエロー', 'Vivid Yellow', 'vivid', true, '#ffe24a', '#854d0e'),
  seeded('turquoise', 'ターコイズ', 'Turquoise', 'vivid', true, '#7fe3d8', '#115e59'),
  // 濃い色
  seeded('wine', 'ワイン', 'Wine', 'deep', false, '#3a0f1f', '#e11d48'),
  seeded('deep-purple', 'ディープパープル', 'Deep Purple', 'deep', false, '#25133f', '#9333ea'),
  seeded('ocean', 'オーシャン', 'Ocean', 'deep', false, '#0b2a3c', '#0891b2'),
  seeded('chocolate', 'チョコ', 'Chocolate', 'deep', false, '#2b1c13', '#d97706'),
  seeded('forest', 'フォレスト', 'Forest', 'deep', false, '#16251e', '#059669'),
  seeded('neon', 'ネオン', 'Neon', 'deep', false, '#0b0b0f', '#ff2e88'),
];

export const DEFAULT_THEME: ThemeId = 'dark';

/** 廃止した旧テーマ id → 雰囲気の近い現行テーマ（保存済みの人が急にダークへ戻らないように） */
const LEGACY_THEME_MAP: Readonly<Record<string, ThemeId>> = {
  midnight: 'github-dark',
  latte: 'gruvbox-light',
};

/** localStorage の値をテーマ id に正規化する。現行 id はそのまま、廃止した旧 id は読み替え、未知・空は既定（ダーク） */
export function normalizeTheme(stored: string | null | undefined): ThemeId {
  const hit = THEMES.find((t) => t.id === stored);
  if (hit) return hit.id;
  if (stored && Object.prototype.hasOwnProperty.call(LEGACY_THEME_MAP, stored)) return LEGACY_THEME_MAP[stored];
  return DEFAULT_THEME;
}

export function getTheme(id: ThemeId): ThemeDef {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}

export function isLightTheme(id: ThemeId): boolean {
  return getTheme(id).light;
}

/** グループごとのテーマ（パネル表示用。グループの順は THEME_GROUPS、各グループ内は THEMES の順） */
export function themesByGroup(): { group: (typeof THEME_GROUPS)[number]; themes: ThemeDef[] }[] {
  return THEME_GROUPS.map((group) => ({ group, themes: THEMES.filter((t) => t.group === group.id) }));
}
