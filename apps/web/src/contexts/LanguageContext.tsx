/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { settings } from '../lib/api';
import { useAuth } from './AuthContext';
import { messages, type TranslationKey } from '../i18n/messages';

export type Language = 'en' | 'ja';
export const LANGUAGE_STORAGE_KEY = 'devrelay-language';
const DEFAULT_LANGUAGE: Language = 'en';

function isLanguage(value: string | null | undefined): value is Language {
  return value === 'en' || value === 'ja';
}

function initialLanguage(): Language {
  const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY);
  return isLanguage(stored) ? stored : DEFAULT_LANGUAGE;
}

interface LanguageContextType {
  language: Language;
  locale: 'en-US' | 'ja-JP';
  setLanguage: (language: Language) => Promise<void>;
  t: (key: TranslationKey) => string;
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

export function LanguageProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [language, setLanguageState] = useState<Language>(initialLanguage);

  const applyLanguage = useCallback((next: Language) => {
    setLanguageState(next);
    localStorage.setItem(LANGUAGE_STORAGE_KEY, next);
  }, []);

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  // Account-level setting is authoritative after authentication.  The local cache
  // still prevents an English/Japanese flash before the request completes.
  useEffect(() => {
    if (!user) return;
    let active = true;
    settings.get().then((all) => {
      if (active && isLanguage(all.language)) applyLanguage(all.language);
    }).catch(() => { /* keep the local/default preference if settings are unavailable */ });
    return () => { active = false; };
  }, [user, applyLanguage]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === LANGUAGE_STORAGE_KEY && isLanguage(event.newValue)) setLanguageState(event.newValue);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const setLanguage = useCallback(async (next: Language) => {
    applyLanguage(next);
    if (user) await settings.update('language', next);
  }, [applyLanguage, user]);

  const t = useCallback((key: TranslationKey) => messages[key][language], [language]);
  const locale = language === 'ja' ? 'ja-JP' : 'en-US';

  return <LanguageContext.Provider value={{ language, locale, setLanguage, t }}>{children}</LanguageContext.Provider>;
}

export function useLanguage(): LanguageContextType {
  const context = useContext(LanguageContext);
  if (!context) throw new Error('useLanguage must be used within a LanguageProvider');
  return context;
}
