import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { ThemeProvider } from './contexts/ThemeContext';
import { Layout } from './components/Layout';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { DashboardPage } from './pages/DashboardPage';
import { MachinesPage } from './pages/MachinesPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { SettingsPage } from './pages/SettingsPage';
import { ConversationsPage } from './pages/ConversationsPage';
import { ChatPage } from './pages/ChatPage';
import { DevReportsPage } from './pages/DevReportsPage';
import { NotificationBanner } from './components/NotificationBanner';

/**
 * 認証済みページのコンテンツ
 * ChatPage は常時マウントし、display:none で表示/非表示を制御する。
 * これにより画面遷移時にメッセージ state や WebSocket 接続が維持される。
 */
function ProtectedContent() {
  const location = useLocation();
  const isChatRoute = location.pathname === '/chat';

  return (
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
          <Route path="/dev-reports" element={<DevReportsPage />} />
          <Route path="/machines" element={<MachinesPage />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      )}
      <NotificationBanner />
    </Layout>
  );
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--bg-base)]">
        <div className="text-[var(--text-muted)]">Loading...</div>
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

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--bg-base)]">
        <div className="text-[var(--text-muted)]">Loading...</div>
      </div>
    );
  }

  if (user) {
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
          <AppRoutes />
        </AuthProvider>
      </BrowserRouter>
    </ThemeProvider>
  );
}
