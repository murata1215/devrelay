import { createContext, useContext, useState, useEffect } from 'react';
import type { ReactNode } from 'react';
import { THEME_VAR_NAMES, getTheme, normalizeTheme } from '../lib/theme-rules';
import type { ThemeId } from '../lib/theme-rules';

interface ThemeContextType {
  theme: ThemeId;
  /** テーマを選ぶ（ヘッダーの色見本パネルから。theme-rules.ts の THEMES のいずれか） */
  setTheme: (id: ThemeId) => void;
}

const STORAGE_KEY = 'devrelay-theme';

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

/**
 * テーマ管理プロバイダ。localStorage で永続化し、<html> に `data-theme` を付与する。
 * テーマの色（20 個の CSS 変数）は <html> の style に書き込む。dark / light は index.css の既定を使うため
 * 書き込んだ変数を消すだけ。明るい系（light: true）のときは従来の `.light` クラスも付ける（`.light` 前提の既存 CSS 互換）。
 * 保存値は従来の 'dark' / 'light' をそのまま引き継ぎ、廃止した旧テーマ id は normalizeTheme() が読み替える。
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeId>(() => normalizeTheme(localStorage.getItem(STORAGE_KEY)));

  useEffect(() => {
    const def = getTheme(theme);
    const root = document.documentElement;
    root.dataset.theme = def.id;
    root.classList.toggle('light', def.light);
    for (const name of THEME_VAR_NAMES) {
      if (def.vars) root.style.setProperty(`--${name}`, def.vars[name]);
      else root.style.removeProperty(`--${name}`);
    }
    localStorage.setItem(STORAGE_KEY, def.id);
  }, [theme]);

  const setTheme = (id: ThemeId) => setThemeState(normalizeTheme(id));

  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}
