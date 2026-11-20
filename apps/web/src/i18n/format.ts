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

/**
 * チャットのメッセージ横に出す時刻ラベルを作る。
 * 時刻だけだと過去の会話がどの日のものか分からないため、日付が今日と違う場合だけ日付を前に付ける。
 * - 今日          → `17:38`
 * - 今年の別の日  → `11/18 17:38`（en: `11/18 05:38 PM`）
 * - 去年以前      → `2025/11/18 17:38`（en: `11/18/2025 05:38 PM`）
 * @param value 表示するメッセージの日時
 * @param locale 表示ロケール（`ja-JP` / `en-US` 等）
 * @param now 「今日」の判定に使う現在時刻（テスト用に差し替え可能）
 * @returns 表示用の文字列
 */
export function formatMessageTime(value: Date, locale: string, now: Date = new Date()): string {
  const time = value.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  // 不正な日付（Invalid Date）はそのまま時刻表示に任せる（従来と同じ見え方）
  if (Number.isNaN(value.getTime())) return time;
  const sameYear = value.getFullYear() === now.getFullYear();
  const sameDay = sameYear && value.getMonth() === now.getMonth() && value.getDate() === now.getDate();
  if (sameDay) return time;
  // 今年なら年を省き、去年以前なら年も出す
  const date = value.toLocaleDateString(locale, sameYear
    ? { month: 'numeric', day: 'numeric' }
    : { year: 'numeric', month: 'numeric', day: 'numeric' });
  return `${date} ${time}`;
}

/**
 * マウスを乗せたときに出す詳細な日時（曜日・秒まで）。
 * @param value 表示するメッセージの日時
 * @param locale 表示ロケール
 */
export function formatMessageTimeFull(value: Date, locale: string): string {
  if (Number.isNaN(value.getTime())) return '';
  return value.toLocaleString(locale, {
    year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

export function formatTime(value: string | Date, language: Language, withSeconds = false): string {
  return new Date(value).toLocaleTimeString(localeFor(language), {
    hour: '2-digit', minute: '2-digit', ...(withSeconds ? { second: '2-digit' } : {}),
  });
}
