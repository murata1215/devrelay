// manager.devrelay.io へのログイン後リダイレクトを扱う薄いラッパー。
// URL 組み立て自体の純粋関数は packages/shared 側（テスト済み）にあり、
// ここでは window / localStorage / settings API を繋ぐだけに留める。
import { resolveNextTarget, buildManagerTokenUrl, isManagerRedirectEnabled } from '@devrelay/shared';
import { getToken, settings } from './api';

/** Google OAuth のラウンドトリップ中に `next` を保持する sessionStorage キー */
export const LOGIN_NEXT_STORAGE_KEY = 'devrelay-login-next';

/** ビルド時に固定された manager の URL（vite.config.ts の define で注入） */
export const MANAGER_WEB_URL = __MANAGER_WEB_URL__;

/** 保持しているトークンで manager へ遷移する。履歴を残さないため replace を使う */
export function redirectToManager(): boolean {
  const url = buildManagerTokenUrl(MANAGER_WEB_URL, getToken() ?? '');
  if (!url) return false;
  window.location.replace(url);
  return true;
}

/** 新しいタブで manager を開く（手動切替導線）。トークンを DOM に置かないためクリック時に組み立てる */
export function openManagerInNewTab(): void {
  const url = buildManagerTokenUrl(MANAGER_WEB_URL, getToken() ?? '');
  if (url) window.open(url, '_blank', 'noopener,noreferrer');
}

/**
 * ログイン成功直後の遷移判定。manager へ遷移したら true を返す。
 * ① `?next=manager` が指定されていれば無条件で遷移
 * ② 無ければ managerRedirect トグルを見る（設定取得に失敗してもログイン自体は成功しているので
 *    通常遷移へフォールバックする）
 */
export async function maybeRedirectAfterLogin(
  next: ReturnType<typeof resolveNextTarget>
): Promise<boolean> {
  if (next === 'manager') return redirectToManager();
  try {
    const all = await settings.get();
    if (isManagerRedirectEnabled(all.managerRedirect)) return redirectToManager();
  } catch {
    /* 設定が取れなくてもログインは成立しているのでフォールバック */
  }
  return false;
}

export { resolveNextTarget };
