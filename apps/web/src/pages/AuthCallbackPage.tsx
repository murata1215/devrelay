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
    if (token) {
      setToken(token);
      // ページリロードで AuthContext が token を読み込み直す
      window.location.href = '/';
    } else {
      navigate('/login?error=no_token');
    }
  }, [searchParams, navigate]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--bg-base)]">
      <div className="text-[var(--text-muted)]">Signing in...</div>
    </div>
  );
}
