/**
 * カラーテーマ（2026-11-21）の純関数群。
 *
 * 従来はダーク/ライトの 2 択トグルだったが、10 パターンを「アイコンを押すたびに順番に切り替える」方式にした。
 * 実際の色は index.css の `:root[data-theme="…"]` が持つ。ここではテーマの一覧・巡回順・保存値の正規化と、
 * ヘッダーの色見本アイコン（ThemeSwatchIcon）に使う代表 2 色だけを扱う。DOM / localStorage に依存しないため
 * node:test で検証する（tests/theme-rules.test.mjs）。
 */

export type ThemeId =
  | 'dark'
  | 'light'
  | 'github-light'
  | 'solarized-light'
  | 'catppuccin-latte'
  | 'rose-pine-dawn'
  | 'gruvbox-light'
  | 'github-dark'
  | 'nord'
  | 'dracula';

export interface ThemeDef {
  id: ThemeId;
  name: { ja: string; en: string };
  /** 明るい系か。true のとき <html> に従来の `.light` クラスも付ける（`.light` 前提の既存 CSS を壊さないため） */
  light: boolean;
  /** 色見本アイコン用: 背景色 */
  swatchBg: string;
  /** 色見本アイコン用: アクセント色 */
  swatchAccent: string;
}

/**
 * 巡回順。先頭がダーク（既定値）。末尾の次は先頭に戻る。
 * 2026-11-21 改訂: 独自配色 7 つ（暗い系 4）をやめ、公式パレットが公開されていて利用者数の裏付けがある
 * 有名配色 10 選（明るい系 6・暗い系 4）にした。根拠は VS Code Marketplace のインストール数
 * （GitHub Theme が配色テーマ最多、Dracula 500 万超）と、Solarized / Nord / Catppuccin / Rosé Pine / Gruvbox の公式パレット。
 */
export const THEMES: readonly ThemeDef[] = [
  { id: 'dark', name: { ja: 'ダーク', en: 'Dark' }, light: false, swatchBg: '#2b2d31', swatchAccent: '#5865f2' },
  { id: 'light', name: { ja: 'ライト', en: 'Light' }, light: true, swatchBg: '#f2f3f5', swatchAccent: '#5865f2' },
  { id: 'github-light', name: { ja: 'GitHub ライト', en: 'GitHub Light' }, light: true, swatchBg: '#f6f8fa', swatchAccent: '#0969da' },
  { id: 'solarized-light', name: { ja: 'ソラライズド', en: 'Solarized Light' }, light: true, swatchBg: '#fdf6e3', swatchAccent: '#268bd2' },
  { id: 'catppuccin-latte', name: { ja: 'カプチーノ ラテ', en: 'Catppuccin Latte' }, light: true, swatchBg: '#e6e9ef', swatchAccent: '#8839ef' },
  { id: 'rose-pine-dawn', name: { ja: 'ローズパイン ドーン', en: 'Rosé Pine Dawn' }, light: true, swatchBg: '#fffaf3', swatchAccent: '#a3566d' },
  { id: 'gruvbox-light', name: { ja: 'グルーヴボックス', en: 'Gruvbox Light' }, light: true, swatchBg: '#fbf1c7', swatchAccent: '#af3a03' },
  { id: 'github-dark', name: { ja: 'GitHub ダーク', en: 'GitHub Dark Dimmed' }, light: false, swatchBg: '#2d333b', swatchAccent: '#539bf5' },
  { id: 'nord', name: { ja: 'ノルド', en: 'Nord' }, light: false, swatchBg: '#3b4252', swatchAccent: '#88c0d0' },
  { id: 'dracula', name: { ja: 'ドラキュラ', en: 'Dracula' }, light: false, swatchBg: '#282a36', swatchAccent: '#bd93f9' },
];

export const DEFAULT_THEME: ThemeId = 'dark';

/** 2026-11-21 の入れ替えで廃止した旧テーマ id → 雰囲気の近い新テーマ（保存済みの人が急にダークへ戻らないように） */
const LEGACY_THEME_MAP: Readonly<Record<string, ThemeId>> = {
  midnight: 'github-dark',
  forest: 'dark',
  sakura: 'rose-pine-dawn',
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

/** 次のテーマ（末尾の次は先頭） */
export function nextTheme(id: ThemeId): ThemeId {
  const i = THEMES.findIndex((t) => t.id === id);
  return THEMES[(i + 1) % THEMES.length].id;
}

export function isLightTheme(id: ThemeId): boolean {
  return getTheme(id).light;
}
