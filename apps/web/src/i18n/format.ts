import type { Language } from '../contexts/LanguageContext';

export function localeFor(language: Language): 'en-US' | 'ja-JP' {
  return language === 'ja' ? 'ja-JP' : 'en-US';
}

export function formatDateTime(value: string | Date, language: Language): string {
  return new Date(value).toLocaleString(localeFor(language));
}

export function formatDate(value: string | Date, language: Language): string {
  return new Date(value).toLocaleDateString(localeFor(language));
}

export function formatTime(value: string | Date, language: Language, withSeconds = false): string {
  return new Date(value).toLocaleTimeString(localeFor(language), {
    hour: '2-digit', minute: '2-digit', ...(withSeconds ? { second: '2-digit' } : {}),
  });
}
