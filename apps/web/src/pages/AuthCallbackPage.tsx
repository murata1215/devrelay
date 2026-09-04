import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { setToken } from '../lib/api';
import { resolveNextTarget, maybeRedirectAfterLogin, LOGIN_NEXT_STORAGE_KEY } from '../lib/managerRedirect';

/**
 * Google OAuth コールバックページ
 * サーバーからリダイレクトされ、token をクエリパラメータで受け取る。
 * token を localStorage に保存してホーム画面（または manager）にリダイレクトする。
 */
export function AuthCallbackPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  useEffect(() => {
    const token = searchParams.get('token');
    if (!token) {
      navigate('/login?error=no_token');
      return;
    }

    setToken(token);
    // ログイン画面（LoginPage）で退避しておいた next を回収する。使い捨てのため即座に削除する。
    const stashedNext = resolveNextTarget(sessionStorage.getItem(LOGIN_NEXT_STORAGE_KEY));
    sessionStorage.removeItem(LOGIN_NEXT_STORAGE_KEY);
    // token の保存が確実に反映されてからフルリロードする。
    // 即時リロードだと（PWA Service Worker の有効化と競合して）
    // リロード後の AuthContext が token を読み込めずログイン画面に戻ることがある。
    // manager へ遷移する場合はこの origin を離脱するだけなのでその競合は生じないが、
    // タイミングを揃えるため同じ 200ms 待ちに乗せる。
    const timer = setTimeout(() => {
      void maybeRedirectAfterLogin(stashedNext).then((moved) => {
        if (!moved) window.location.replace('/');
      });
    }, 200);
    return () => clearTimeout(timer);
  }, [searchParams, navigate]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--bg-base)]">
      <div className="text-[var(--text-muted)]">Signing in...</div>
    </div>
  );
}
