import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { setToken } from '../lib/api';

/**
 * Google OAuth コールバックページ
 * サーバーからリダイレクトされ、token をクエリパラメータで受け取る。
 * token を localStorage に保存してホーム画面にリダイレクトする。
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
    // token の保存が確実に反映されてからフルリロードする。
    // 即時リロードだと（PWA Service Worker の有効化と競合して）
    // リロード後の AuthContext が token を読み込めずログイン画面に戻ることがある。
    const timer = setTimeout(() => {
      window.location.replace('/');
    }, 200);
    return () => clearTimeout(timer);
  }, [searchParams, navigate]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--bg-base)]">
      <div className="text-[var(--text-muted)]">Signing in...</div>
    </div>
  );
}
