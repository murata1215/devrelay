/**
 * AI レスポンス完了時・メッセージ送信時の通知音ユーティリティ
 */

const STORAGE_KEY = 'devrelay-notification-sound';

/** 通知音が有効かどうか */
export function isNotificationSoundEnabled(): boolean {
  return localStorage.getItem(STORAGE_KEY) !== 'off';
}

/** 通知音の有効/無効を切り替え */
export function setNotificationSoundEnabled(enabled: boolean): void {
  localStorage.setItem(STORAGE_KEY, enabled ? 'on' : 'off');
}

/** 通知音を再生 */
export function playNotificationSound(): void {
  if (!isNotificationSoundEnabled()) return;

  try {
    const audio = new Audio('/sounds/notification.mp3');
    audio.volume = 0.5;
    audio.play().catch(() => {});
  } catch {
    // 再生失敗は無視
  }
}
