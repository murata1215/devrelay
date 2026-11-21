import { createContext, useContext, useState, useEffect } from 'react';
import type { ReactNode } from 'react';
import { isLightTheme, nextTheme, normalizeTheme } from '../lib/theme-rules';
import type { ThemeId } from '../lib/theme-rules';

interface ThemeContextType {
  theme: ThemeId;
  /** 次のテーマへ切り替える（10 パターンを順番に巡回。theme-rules.ts の THEMES 順） */
  toggleTheme: () => void;
}

const STORAGE_KEY = 'devrelay-theme';

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

/**
 * テーマ管理プロバイダ。localStorage で永続化し、<html> に `data-theme` を付与する。
 * 明るい系（theme-rules.ts で light: true のもの）のときは従来の `.light` クラスも付ける（`.light` 前提の既存 CSS 互換）。
 * 保存値は従来の 'dark' / 'light' をそのまま引き継ぎ、廃止した旧テーマ id は normalizeTheme() が読み替える。
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<ThemeId>(() => normalizeTheme(localStorage.getItem(STORAGE_KEY)));

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.classList.toggle('light', isLightTheme(theme));
    localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  const toggleTheme = () => {
    setTheme((prev) => nextTheme(prev));
  };

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme }}>
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
