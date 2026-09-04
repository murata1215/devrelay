import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation, useSearchParams } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { OrganizationProvider } from './contexts/OrganizationContext';
import { ThemeProvider } from './contexts/ThemeContext';
import { LanguageProvider, useLanguage } from './contexts/LanguageContext';
import { Layout } from './components/Layout';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { DashboardPage } from './pages/DashboardPage';
import { MachinesPage } from './pages/MachinesPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { SettingsPage } from './pages/SettingsPage';
import { ConversationsPage } from './pages/ConversationsPage';
import { MemberActivityPage } from './pages/MemberActivityPage';
import { ChatPage } from './pages/ChatPage';
import { DevReportsPage } from './pages/DevReportsPage';
import { TeamPage } from './pages/TeamPage';
import { AuthCallbackPage } from './pages/AuthCallbackPage';
import { NotificationBanner } from './components/NotificationBanner';
import { resolveNextTarget, redirectToManager } from './lib/managerRedirect';

/**
 * 認証済みページのコンテンツ
 * ChatPage は常時マウントし、display:none で表示/非表示を制御する。
 * これにより画面遷移時にメッセージ state や WebSocket 接続が維持される。
 */
function ProtectedContent() {
  const location = useLocation();
  const isChatRoute = location.pathname === '/chat';

  return (
    <OrganizationProvider>
    <Layout>
      {/* ChatPage: 常時マウント、/chat 以外では非表示 */}
      <div style={{ display: isChatRoute ? undefined : 'none' }}>
        <ChatPage />
      </div>
      {/* 他のページ: /chat 時は非表示 */}
      {!isChatRoute && (
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/conversations" element={<ConversationsPage />} />
          <Route path="/activity" element={<MemberActivityPage />} />
          <Route path="/dev-reports" element={<DevReportsPage />} />
          <Route path="/machines" element={<MachinesPage />} />
          <Route path="/team" element={<TeamPage />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      )}
      <NotificationBanner />
    </Layout>
    </OrganizationProvider>
  );
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const { t } = useLanguage();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--bg-base)]">
        <div className="text-[var(--text-muted)]">{t('common.loading')}</div>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}

function PublicRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const { t } = useLanguage();
  const [searchParams] = useSearchParams();
  const nextTarget = resolveNextTarget(searchParams.get('next'));

  // ログイン済みで /login?next=manager を開いた場合も即座に manager へ遷移する。
  // managerRedirect トグルはここでは見ない（「ログイン成功の瞬間だけ」発火させ、
  // app.devrelay.io を直接開く導線を常に残すため）。
  useEffect(() => {
    if (!loading && user && nextTarget === 'manager') {
      redirectToManager();
    }
  }, [loading, user, nextTarget]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--bg-base)]">
        <div className="text-[var(--text-muted)]">{t('common.loading')}</div>
      </div>
    );
  }

  if (user) {
    if (nextTarget === 'manager') {
      // redirectToManager() が発火するまでの一瞬、ローディング表示を維持する
      return (
        <div className="min-h-screen flex items-center justify-center bg-[var(--bg-base)]">
          <div className="text-[var(--text-muted)]">{t('common.loading')}</div>
        </div>
      );
    }
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}

function AppRoutes() {
  return (
    <Routes>
      <Route
        path="/login"
        element={
          <PublicRoute>
            <LoginPage />
          </PublicRoute>
        }
      />
      <Route
        path="/register"
        element={
          <PublicRoute>
            <RegisterPage />
          </PublicRoute>
        }
      />
      {/* Google OAuth コールバック（認証状態に関係なくアクセス可能） */}
      <Route path="/auth/callback" element={<AuthCallbackPage />} />
      {/* 認証済み: 全 protected routes を ProtectedContent でラップ */}
      <Route
        path="/*"
        element={
          <ProtectedRoute>
            <ProtectedContent />
          </ProtectedRoute>
        }
      />
    </Routes>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <BrowserRouter basename="/">
        <AuthProvider>
          <LanguageProvider>
            <AppRoutes />
          </LanguageProvider>
        </AuthProvider>
      </BrowserRouter>
    </ThemeProvider>
  );
}
