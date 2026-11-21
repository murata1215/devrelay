import { useCallback, useEffect, useState } from 'react';
import { ENTER_LOCK_STORAGE_KEY, parseEnterLock, serializeEnterLock } from './enter-send-rules';

function readStored(): boolean {
  try {
    return parseEnterLock(localStorage.getItem(ENTER_LOCK_STORAGE_KEY));
  } catch {
    return false;
  }
}

/**
 * Enter 送信ロックの状態（localStorage 永続化）。チャット画面・Lite 画面で共用し、
 * 別タブで切り替えた場合も storage イベントで追従する。
 */
export function useEnterSendLock(): [boolean, () => void] {
  const [locked, setLocked] = useState<boolean>(readStored);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === ENTER_LOCK_STORAGE_KEY) setLocked(parseEnterLock(e.newValue));
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const toggle = useCallback(() => {
    setLocked((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(ENTER_LOCK_STORAGE_KEY, serializeEnterLock(next));
      } catch {
        /* localStorage 不可でも画面内では切り替える */
      }
      return next;
    });
  }, []);

  return [locked, toggle];
}
